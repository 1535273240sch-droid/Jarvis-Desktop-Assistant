import { BrowserWindow } from "electron";
import { logger } from "./logger";
import { windowStore } from "./store";
import { ORB_SIZE_DEFAULT, clampOrbSize } from "./config";
import { IPC } from "../common/types";
import type { AssistantState } from "../common/types";

/**
 * 悬浮球尺寸管理：手动基准尺寸 + 随助手状态自适应缩放。
 *
 * 硬约束与设计取舍：
 * - 窗口 resizable:false，尺寸只由代码设置，绝不开放边框拖拽；
 * - 自适应只在「手动基准」上乘倍率，绝不改写基准，避免滑块与自适应互相覆盖；
 * - 每次 setBounds 都会让 orb.html 的渲染循环重建渲染目标
 *   （见 orb.html frame() 中 canvas.width/height 变化分支），一次性大跳变会明显卡顿，
 *   故过渡固定为 6 步 × 18ms（约 110ms），在平滑与重建开销之间取平衡；
 * - 改尺寸时保持球心不动（按中心重算左上角），否则球会视觉「跳走」。
 */
class OrbSizeManager {
  private win: BrowserWindow | null = null;
  /** 手动基准尺寸（= 配置 orbSize） */
  private base = ORB_SIZE_DEFAULT;
  /** 当前窗口实际尺寸（基准或基准 × 状态倍率） */
  private current = ORB_SIZE_DEFAULT;
  private autoScale = false;
  private lastState: AssistantState = "idle";
  private animTimer: NodeJS.Timeout | null = null;

  attach(win: BrowserWindow | null): void {
    this.win = win;
  }

  /** 启动时按配置初始化：应用基准尺寸并记录自适应开关 */
  init(baseSize: unknown, autoScale: boolean): void {
    this.base = clampOrbSize(baseSize);
    this.autoScale = Boolean(autoScale);
    this.current = this.base;
    this.applyWindowSize(this.base, true);
  }

  /** 手动设置基准尺寸（滑块 / 配置变更）。立即生效并持久化，取消进行中的自适应动画 */
  setBase(size: unknown): number {
    this.base = clampOrbSize(size);
    this.stopAnim();
    // 自适应开启时，拖动滑块也应保持当前状态的倍率，避免尺寸在两种值之间来回跳
    const target = this.autoScale ? this.targetForState(this.lastState) : this.base;
    this.applyWindowSize(target, true);
    return this.base;
  }

  /** 切换自适应开关；关闭时立即恢复基准尺寸 */
  setAutoScale(on: boolean): void {
    this.autoScale = Boolean(on);
    this.stopAnim();
    if (!this.autoScale) {
      this.applyWindowSize(this.base, true);
    } else {
      // 打开时按当前状态平滑过渡到对应倍率
      this.animateTo(this.targetForState(this.lastState));
    }
  }

  /** 状态机变化回调：仅在开启自适应时按倍率平滑缩放 */
  onStateChanged(state: AssistantState): void {
    this.lastState = state;
    if (!this.autoScale) return;
    this.animateTo(this.targetForState(state));
  }

  getBase(): number {
    return this.base;
  }

  dispose(): void {
    this.stopAnim();
  }

  private targetForState(state: AssistantState): number {
    // speaking/listening 轻微放大，其余状态回到基准；倍率很小以免破坏视觉重心
    const scale = state === "speaking" ? 1.12 : state === "listening" ? 1.06 : 1;
    return clampOrbSize(this.base * scale);
  }

  /** 分步过渡到目标尺寸，避免一次性跳变造成渲染卡顿 */
  private animateTo(target: number): void {
    if (!this.win || this.win.isDestroyed()) return;
    const to = clampOrbSize(target);
    if (to === this.current) return;
    this.stopAnim();
    const from = this.current;
    const steps = 6;
    const stepMs = 18;
    let i = 0;
    const tick = () => {
      i += 1;
      const done = i >= steps;
      const v = done ? to : Math.round(from + (to - from) * (i / steps));
      // 过渡中间态不落盘，只有最终尺寸才持久化，避免配置文件被写成一串中间值
      this.applyWindowSize(v, done);
      if (done) {
        this.animTimer = null;
        return;
      }
      this.animTimer = setTimeout(tick, stepMs);
    };
    this.animTimer = setTimeout(tick, stepMs);
  }

  private stopAnim(): void {
    if (this.animTimer) {
      clearTimeout(this.animTimer);
      this.animTimer = null;
    }
  }

  /** 应用窗口尺寸：保持球心不变，可选持久化，并向渲染层广播当前尺寸 */
  private applyWindowSize(size: number, persist: boolean): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    const next = clampOrbSize(size);
    const b = win.getBounds();
    if (b.width === next && b.height === next) {
      // 尺寸未变也同步 current，防止状态漂移
      this.current = next;
      return;
    }
    const x = Math.round(b.x + (b.width - next) / 2);
    const y = Math.round(b.y + (b.height - next) / 2);
    win.setBounds({ x, y, width: next, height: next });
    const nb = win.getBounds();
    this.current = nb.width;
    if (persist) {
      windowStore.save({ x: nb.x, y: nb.y, width: nb.width, height: nb.height });
    }
    if (!win.webContents.isDestroyed()) {
      win.webContents.send(IPC.ORB_SIZE_CHANGED, nb.width);
    }
    logger.info(`[OrbSize] 尺寸 -> ${nb.width}px（基准 ${this.base}${this.autoScale ? "，自适应开" : ""}）`);
  }
}

export const orbSizeManager = new OrbSizeManager();
