import { app, BrowserWindow } from "electron";
import { logger } from "./logger";

/**
 * WebGPU 自检探针（独立的一次性渲染进程）。
 *
 * 为什么必须独立开窗（而不是在球体渲染进程里自检）：
 *   球体渲染器（vendor/orb/src/orb-renderer.ts）正在用同一个 GPUAdapter
 *   维持一个**长期活跃**的 GPUDevice 做持续渲染。旧的 checkWebGPU() 通过
 *   orbController.evalJs() 把探测表达式塞进球体自己的 realm，会在同一
 *   adapter 上再 requestDevice() 出第二个 device 并立刻 destroy()。
 *   这既是 docs/TODO-ORB-WEBGPU.md 与 docs/ORB-WEBGPU-RECOVERY.md 里
 *   P1 明确要求排查的「自检副作用」，也与日志中 Dawn 的
 *   `WebGPU device lost: A valid external Instance reference no longer exists`
 *   这类 instance 生命周期错误相关。
 *
 *   因此这里用一个隐藏的、无 preload/无 nodeIntegration 的临时 BrowserWindow
 *   加载极简探针页 src/renderer/gpu-probe.html（经 app://panel/ 协议，见 protocol.ts），
 *   在其独立 realm 里完成探测，拿到结果立即 destroy，**永不复用**。
 *   探针进程里的 requestDevice/destroy 与球体的活跃设备完全隔离。
 */

export interface GpuProbeResult {
  supported: boolean;
  adapterInfo?: Record<string, string>;
  error?: string;
}

/** 探针页：放在 src/renderer 下，构建脚本会整目录拷贝到 dist/renderer */
const PROBE_URL = "app://panel/gpu-probe.html";

/** 结果缓存 TTL：避免用户在设置面板反复点按钮时反复开窗 */
const CACHE_TTL_MS = 60_000;

/**
 * 单次探测整体超时。
 *
 * 定为 30s 是实测结论：全新安装后的**首次**启动，Chromium 的 GPU 进程是冷的、
 * 着色器缓存也是空的，隐藏窗口里 requestAdapter 实测超过 10s；此时超时就会在
 * 球体明明能正常渲染的情况下误报「WebGPU 不可用」。缓存预热后同一台机器实测
 * 只需约 0.5s。因此这里放宽到 30s，宁可慢也不误报。
 */
const PROBE_TIMEOUT_MS = 30_000;

/**
 * 探测表达式：与原 orb-control.checkWebGPU() 中的那段逐字段等价
 * （supported / adapterInfo / error 字段与「未知」兜底文案完全一致），
 * 只是改到探针进程里执行。主进程用 executeJavaScript 拉取结果。
 */
const PROBE_EXPRESSION = `
  (async () => {
    if (!navigator.gpu) return { supported: false, error: "当前环境未检测到 navigator.gpu 接口" };
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return { supported: false, error: "未找到兼容的 WebGPU 适配器" };
      const info = adapter.info || {};
      const device = await adapter.requestDevice();
      if (!device) return { supported: false, error: "创建 WebGPU 设备失败" };
      device.destroy();
      return { supported: true, adapterInfo: {
        vendor: info.vendor || "未知", architecture: info.architecture || "未知",
        device: info.device || "未知", description: info.description || "" } };
    } catch (e) { return { supported: false, error: e && e.message ? e.message : String(e) }; }
  })()
`;

class GpuProbe {
  /** 成功结果的缓存（supported 为 false 时不缓存，失败要能立即重试） */
  private cache: { at: number; result: GpuProbeResult } | null = null;
  /** 并发去重：同一时刻只允许一个探针在跑 */
  private inflight: Promise<GpuProbeResult> | null = null;

  /**
   * 执行（或复用）一次 WebGPU 自检。
   * 永不抛错：任何异常都会被收敛为 `{ supported:false, error }`。
   */
  async check(): Promise<GpuProbeResult> {
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) {
      return this.cache.result;
    }
    if (this.inflight) return this.inflight;

    const p = this.runOnce()
      .then((result) => {
        // 仅缓存成功结果；失败不缓存，以便调用方立即重试
        if (result.supported) this.cache = { at: Date.now(), result };
        return result;
      })
      .finally(() => {
        this.inflight = null;
      });
    this.inflight = p;
    return p;
  }

  private async runOnce(): Promise<GpuProbeResult> {
    // 探针依赖 BrowserWindow，必须等 app ready 之后
    if (!app.isReady()) {
      logger.warn("[GpuProbe] 应用尚未就绪，跳过 WebGPU 自检");
      return { supported: false, error: "应用尚未就绪，无法执行 WebGPU 自检" };
    }

    let win: BrowserWindow | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      win = new BrowserWindow({
        show: false,
        width: 1,
        height: 1,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
        },
      });

      const target = win;
      const timeout = new Promise<GpuProbeResult>((resolve) => {
        timer = setTimeout(() => resolve({ supported: false, error: "WebGPU 自检超时" }), PROBE_TIMEOUT_MS);
      });

      const work = (async (): Promise<GpuProbeResult> => {
        await target.loadURL(PROBE_URL);
        const raw: unknown = await target.webContents.executeJavaScript(PROBE_EXPRESSION);
        if (!raw || typeof raw !== "object" || typeof (raw as GpuProbeResult).supported !== "boolean") {
          return { supported: false, error: "WebGPU 自检返回了非法结果" };
        }
        return raw as GpuProbeResult;
      })();
      // 即便超时先返回，work 也可能在窗口已经销毁后才拒绝；这里挂一个 handler 兜底，避免未处理的 rejection
      work.catch(() => {
        /* 超时/销毁竞态产生的拒绝已由 Promise.race 与这里消化，忽略 */
      });

      const result = await Promise.race([work, timeout]);
      if (result.supported) {
        logger.info("[GpuProbe] WebGPU 自检通过:", result.adapterInfo);
      } else {
        logger.warn("[GpuProbe] WebGPU 自检未通过:", result.error);
      }
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error("[GpuProbe] WebGPU 自检异常:", msg);
      return { supported: false, error: msg };
    } finally {
      if (timer) clearTimeout(timer);
      // 一次性窗口：拿到结果立即销毁，永不复用
      if (win && !win.isDestroyed()) win.destroy();
    }
  }
}

/** 模块级单例 */
export const gpuProbe = new GpuProbe();
