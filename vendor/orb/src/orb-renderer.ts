import { particleRibbonInstanceCount } from "./particle-ribbon";
import { styleFlowIndexes, type OrbParams } from "./presets";
import {
  createOrbTransitionController,
  type OrbRenderTarget,
} from "./orb-states";
import { orbUniformFloatCount, writeOrbUniforms } from "./orb-uniforms";
import { orbShaderSource } from "./shader-source";
import { applyAudioUniforms, type AudioBands } from "./orb-audio";

export type OrbRendererOptions = {
  canvas: HTMLCanvasElement;
  getTarget: () => OrbRenderTarget;
  getAudioBands?: (dt: number) => AudioBands;
  onError: (error: Error) => void;
  onReady: () => void;
};

/**
 * 设备丢失后的重建上限与退避参数（0.5 + 1 + 2 + 4 + 8 ≈ 15s）。
 *
 * 渲染器只做少量快速重试，覆盖瞬时抖动；若仍失败则上报宿主，由宿主重载
 * 球体页面做更彻底的重建（GPU 进程被系统/驱动回收时只有重载页面才能恢复）。
 * 因此这里不必覆盖 GPU 进程重启的完整耗时，避免宿主兜底被拖得太晚。
 */
const maxRestartAttempts = 5;
const restartBaseDelayMs = 500;
const restartMaxDelayMs = 8000;

export function createOrbRenderer({
  canvas,
  getTarget,
  getAudioBands,
  onError,
  onReady,
}: OrbRendererOptions): () => void {
  let disposed = false;
  let animationFrame = 0;
  let device: GPUDevice | null = null;
  let ribbonTarget: GPUTexture | null = null;
  let readyNotified = false;
  let lastFrameAt: number | null = null;
  let motionPhase = 0;

  /**
   * 持有 adapter 引用。
   *
   * 不保留引用时，Dawn 的 GPUAdapter/instance 会在 GC 后失效，随后设备报
   * "A valid external Instance reference no longer exists" 并永久断开。
   * 这里显式持有，既避免被提前回收，也让设备丢失后可以基于同一 adapter 重建。
   */
  let adapter: GPUAdapter | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let restartAttempts = 0;
  let starting = false;
  let exhausted = false;

  function teardownGpu(): void {
    cancelAnimationFrame(animationFrame);
    animationFrame = 0;
    ribbonTarget?.destroy();
    ribbonTarget = null;
    device?.destroy();
    device = null;
    readyNotified = false;
    lastFrameAt = null;
  }

  /**
   * 设备丢失/渲染异常后安排重建。
   *
   * 原实现遇到 device.lost 直接置 failed 并销毁设备，没有任何重建路径，
   * 结果是球体一旦断连就永久黑屏，只能重启整个应用。这里改为有限次退避重建。
   */
  function scheduleRestart(reason: string): void {
    if (disposed || restartTimer) return;

    if (restartAttempts >= maxRestartAttempts) {
      exhausted = true;
      onError(
        new Error(`WebGPU 设备反复断开，已停止重建（${maxRestartAttempts} 次）：${reason}`),
      );
      return;
    }

    const delay = Math.min(
      restartMaxDelayMs,
      restartBaseDelayMs * 2 ** restartAttempts,
    );
    restartAttempts += 1;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (disposed) return;
      void start();
    }, delay);
  }

  async function start(): Promise<void> {
    if (disposed || starting || exhausted) return;
    starting = true;

    try {
      if (!navigator.gpu) {
        throw new Error("当前浏览器不支持 WebGPU");
      }

      // GPU 进程重启期间 requestAdapter 可能返回 null，或返回一个已失效的
      // 缓存 adapter。每次重建都重新申请，避免一直复用坏引用。
      adapter = await navigator.gpu.requestAdapter();
      if (!adapter) {
        throw new Error("未找到可用的 WebGPU 适配器");
      }
      if (disposed) return;

      const activeAdapter = adapter;
      const nextDevice = await activeAdapter.requestDevice();
      if (disposed) {
        nextDevice.destroy();
        return;
      }
      device = nextDevice;

      const context = canvas.getContext("webgpu");
      if (!context) {
        throw new Error("无法创建 WebGPU 画布上下文");
      }
      const gpuContext: GPUCanvasContext = context;

      const format = navigator.gpu.getPreferredCanvasFormat();
      gpuContext.configure({ device, format, alphaMode: "premultiplied" });

      const shader = device.createShaderModule({
        label: "orb-glass-liquid",
        code: orbShaderSource,
      });
      const compilation = await shader.getCompilationInfo();
      const compilationErrors = compilation.messages.filter(
        (message) => message.type === "error",
      );
      if (compilationErrors.length > 0) {
        throw new Error(
          compilationErrors
            .map((message) => `${message.lineNum}:${message.linePos} ${message.message}`)
            .join("\n"),
        );
      }

      const pipeline = device.createRenderPipeline({
        label: "orb-glass-liquid-pipeline",
        layout: "auto",
        vertex: { module: shader, entryPoint: "vs_main" },
        fragment: {
          module: shader,
          entryPoint: "fs_main",
          targets: [{
            format,
            blend: {
              color: {
                srcFactor: "one",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
              alpha: {
                srcFactor: "one",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
            },
          }],
        },
        primitive: { topology: "triangle-list" },
      });
      const ribbonPipeline = device.createRenderPipeline({
        label: "particle-ribbon-pipeline",
        layout: "auto",
        vertex: { module: shader, entryPoint: "ribbon_vs_main" },
        fragment: {
          module: shader,
          entryPoint: "ribbon_fs_main",
          targets: [{
            format,
            blend: {
              color: { srcFactor: "one", dstFactor: "one", operation: "add" },
              alpha: {
                srcFactor: "one",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
            },
          }],
        },
        primitive: { topology: "triangle-list" },
      });
      const ribbonCompositePipeline = device.createRenderPipeline({
        label: "particle-ribbon-glass-composite-pipeline",
        layout: "auto",
        vertex: { module: shader, entryPoint: "vs_main" },
        fragment: {
          module: shader,
          entryPoint: "ribbon_composite_fs_main",
          targets: [{
            format,
            blend: {
              color: {
                srcFactor: "one",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
              alpha: {
                srcFactor: "one",
                dstFactor: "one-minus-src-alpha",
                operation: "add",
              },
            },
          }],
        },
        primitive: { topology: "triangle-list" },
      });
      const values = new Float32Array(orbUniformFloatCount);
      const uniformBuffer = device.createBuffer({
        size: values.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
      });
      const ribbonBindGroup = device.createBindGroup({
        layout: ribbonPipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
      });
      const ribbonSampler = device.createSampler({
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
        magFilter: "linear",
        minFilter: "linear",
      });
      let ribbonCompositeBindGroup: GPUBindGroup | null = null;
      const transition = createOrbTransitionController(getTarget());

      // 设备丢失：区分「我们自己销毁」与「运行时意外断开」。
      // 意外断开时清理并安排重建，而不是永久停摆。
      // 中间的重试失败只写控制台，不上报宿主——避免宿主对每次重试都做一次
      // 页面重载；只有重试耗尽（见 scheduleRestart）才上报，交由宿主兜底。
      const boundDevice = device;
      boundDevice.lost.then((info) => {
        if (disposed || device !== boundDevice) return;
        if (info.reason === "destroyed") return;

        const reason = info.message || info.reason;
        teardownGpu();
        scheduleRestart(reason);
      });
      boundDevice.addEventListener("uncapturederror", (event) => {
        // 未捕获的 WebGPU 校验错误多数是良性的（且已被 preventDefault 抑制），
        // 真正的设备故障会走 device.lost。这里只记录，不上报宿主，
        // 避免宿主因一次校验告警就重载整个球体页面。
        event.preventDefault();
        console.error(`[orb] WebGPU uncaptured error: ${event.error.message}`);
      });

      function resize(): void {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
        const height = Math.max(1, Math.floor(canvas.clientHeight * dpr));

        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
          ribbonTarget?.destroy();
          ribbonTarget = null;
          ribbonCompositeBindGroup = null;
        }
      }

      function ensureRibbonTarget(): void {
        if (ribbonTarget && ribbonCompositeBindGroup) return;

        ribbonTarget = device!.createTexture({
          label: "particle-ribbon-offscreen-texture",
          size: { width: canvas.width, height: canvas.height },
          format,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        ribbonCompositeBindGroup = device!.createBindGroup({
          layout: ribbonCompositePipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: uniformBuffer } },
            { binding: 1, resource: ribbonTarget.createView() },
            { binding: 2, resource: ribbonSampler },
          ],
        });
      }

      function frame(now: number): void {
        if (disposed || !device || device !== boundDevice) {
          return;
        }

        try {
          resize();
          const params: OrbParams = transition.sample(getTarget(), now);
          const frameDelta = lastFrameAt === null
            ? 0
            : Math.min(0.1, Math.max(0, (now - lastFrameAt) / 1000));
          lastFrameAt = now;
          writeOrbUniforms(
            values,
            canvas.width,
            canvas.height,
            0,
            params,
          );
          if (getAudioBands) applyAudioUniforms(values, getAudioBands(frameDelta));
          motionPhase += frameDelta * Math.max(values[3], 0);
          values[2] = motionPhase / Math.max(values[3], 0.001);
          device.queue.writeBuffer(uniformBuffer, 0, values);

          const isParticleRibbon =
            styleFlowIndexes[params.style] === styleFlowIndexes.particleRibbon;
          const encoder = device.createCommandEncoder();
          if (isParticleRibbon) {
            ensureRibbonTarget();
            const particlePass = encoder.beginRenderPass({
              colorAttachments: [{
                view: ribbonTarget!.createView(),
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
                loadOp: "clear",
                storeOp: "store",
              }],
            });
            particlePass.setPipeline(ribbonPipeline);
            particlePass.setBindGroup(0, ribbonBindGroup);
            particlePass.draw(6, particleRibbonInstanceCount, 0, 0);
            particlePass.end();
          }
          const pass = encoder.beginRenderPass({
            colorAttachments: [{
              view: gpuContext.getCurrentTexture().createView(),
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
              loadOp: "clear",
              storeOp: "store",
            }],
          });
          if (isParticleRibbon) {
            pass.setPipeline(ribbonCompositePipeline);
            pass.setBindGroup(0, ribbonCompositeBindGroup!);
          } else {
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, bindGroup);
          }
          pass.draw(3, 1, 0, 0);
          pass.end();
          device.queue.submit([encoder.finish()]);
          if (!readyNotified) {
            readyNotified = true;
            // 渲染恢复正常，重置退避计数，避免历史失败累积导致后续不再重建。
            restartAttempts = 0;
            onReady();
          }
          animationFrame = requestAnimationFrame(frame);
        } catch (error) {
          // 渲染循环内抛出通常意味着设备已不可用：清理并尝试重建。
          // 中间失败只写日志，重试耗尽时 scheduleRestart 会上报宿主兜底。
          teardownGpu();
          scheduleRestart(error instanceof Error ? error.message : String(error));
        }
      }

      animationFrame = requestAnimationFrame(frame);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      // 初始化失败：丢弃 adapter 以便下次重新申请（例如驱动/适配器状态变化）。
      adapter = null;
      teardownGpu();
      onError(err);
      scheduleRestart(err.message);
    } finally {
      starting = false;
    }
  }

  void start();

  return () => {
    disposed = true;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    cancelAnimationFrame(animationFrame);
    ribbonTarget?.destroy();
    device?.destroy();
  };
}
