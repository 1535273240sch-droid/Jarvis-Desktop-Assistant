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
  let failed = false;
  let lastFrameAt: number | null = null;
  let motionPhase = 0;

  function fail(error: Error): void {
    if (disposed || failed) return;
    failed = true;
    cancelAnimationFrame(animationFrame);
    ribbonTarget?.destroy();
    device?.destroy();
    onError(error);
  }

  async function start(): Promise<void> {
    if (!navigator.gpu) {
      throw new Error("当前浏览器不支持 WebGPU");
    }

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error("未找到可用的 WebGPU 适配器");
    }

    device = await adapter.requestDevice();
    if (disposed) {
      device.destroy();
      return;
    }

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

    device.lost.then((info) => {
      fail(new Error(`WebGPU 设备已断开：${info.message || info.reason}`));
    });
    device.addEventListener("uncapturederror", (event) => {
      event.preventDefault();
      fail(new Error(`WebGPU 渲染错误：${event.error.message}`));
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
      if (disposed || failed || !device) {
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
          onReady();
        }
        animationFrame = requestAnimationFrame(frame);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    }

    animationFrame = requestAnimationFrame(frame);
  }

  start().catch((error: unknown) => {
    fail(error instanceof Error ? error : new Error(String(error)));
  });

  return () => {
    disposed = true;
    cancelAnimationFrame(animationFrame);
    ribbonTarget?.destroy();
    device?.destroy();
  };
}
