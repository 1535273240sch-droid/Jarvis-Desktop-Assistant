import { BrowserWindow } from "electron";
import { logger } from "./logger";
import { ASSISTANT_STATES } from "../common/types";
import type { AssistantState, AudioBands } from "../common/types";

/**
 * 与 Orb 球体的唯一通信层。
 *
 * 硬约束（已核实源码）：
 * - 球体只暴露 4 个方法：getState / setState / setAudioBands / onError
 * - 没有「过渡完成」事件，没有 resize 接口，运行时不能换预设
 * - **严禁**注入 CSS、改 canvas 尺寸或覆盖 DOM —— 那会触碰「禁止替换 UI」红线
 * - 状态名受白名单校验，传未知状态会抛错；本项目使用的 6 个状态
 *   已通过扩展 orb-states.ts 落地（见 docs/ORB_CHANGES.md）
 */
class OrbController {
  private win: BrowserWindow | null = null;
  private readyFlag = false;
  private readyWaiters: Array<() => void> = [];

  attach(win: BrowserWindow): void {
    this.win = win;
  }

  attachTarget(win: BrowserWindow | null): void {
    this.win = win;
  }

  markReady(): void {
    this.readyFlag = true;
    for (const w of this.readyWaiters) w();
    this.readyWaiters = [];
  }

  isReady(): boolean {
    return this.readyFlag;
  }

  /** 等待球体就绪（轮询 + 事件双保险，避免竞态） */
  async waitReady(timeoutMs = 8000): Promise<boolean> {
    if (this.readyFlag) return true;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.readyFlag) return true;
      try {
        if (this.win && !this.win.isDestroyed()) {
          const ok = await this.win.webContents.executeJavaScript(
            `Boolean(window.liquidOrb && typeof window.liquidOrb.getState === "function")`
          );
          if (ok) {
            this.readyFlag = true;
            logger.info("[OrbControl] 轮询确认 window.liquidOrb 已就绪");
            return true;
          }
        }
      } catch {
        /* 页面尚未加载完，继续等 */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    logger.warn(`[OrbControl] 等待球体就绪超时（${timeoutMs}ms）`);
    return false;
  }

  private async evalJs(expr: string): Promise<unknown> {
    if (!this.win || this.win.isDestroyed()) throw new Error("球体窗口不可用");
    return this.win.webContents.executeJavaScript(expr);
  }

  async getState(): Promise<string | null> {
    try {
      return (await this.evalJs(`window.liquidOrb ? window.liquidOrb.getState() : null;`)) as string | null;
    } catch (e) {
      logger.warn("[OrbControl] getState 失败:", e);
      return null;
    }
  }

  async setState(state: AssistantState): Promise<boolean> {
    if (!ASSISTANT_STATES.includes(state)) {
      throw new Error(`非法状态 "${state}"，允许值：${ASSISTANT_STATES.join(", ")}`);
    }
    try {
      await this.evalJs(
        `if (window.liquidOrb) { window.liquidOrb.setState(${JSON.stringify(state)}); } else { throw new Error("liquidOrb 未初始化"); }`
      );
      return true;
    } catch (e) {
      // 球体未就绪时不算致命：下次状态变化会再试
      logger.warn(`[OrbControl] setState("${state}") 失败:`, (e as Error).message);
      return false;
    }
  }

  async setAudioBands(bands?: AudioBands): Promise<boolean> {
    try {
      if (bands) {
        const clamp = (v: unknown) => Math.max(0, Math.min(1, Number(v) || 0));
        const safe: AudioBands = {
          low: clamp(bands.low),
          mid: clamp(bands.mid),
          high: clamp(bands.high),
          all: clamp(bands.all),
        };
        await this.evalJs(`if (window.liquidOrb) { window.liquidOrb.setAudioBands(${JSON.stringify(safe)}); }`);
      } else {
        await this.evalJs(`if (window.liquidOrb) { window.liquidOrb.setAudioBands(); }`);
      }
      return true;
    } catch {
      return false;
    }
  }

  /** WebGPU 运行时自检，返回可读结果 */
  async checkWebGPU(): Promise<{ supported: boolean; adapterInfo?: Record<string, string>; error?: string }> {
    try {
      const r: any = await this.evalJs(`
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
      `);
      return r;
    } catch (e) {
      return { supported: false, error: (e as Error).message };
    }
  }
}

export const orbController = new OrbController();
