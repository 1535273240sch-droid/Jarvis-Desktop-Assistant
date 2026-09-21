import { globalShortcut } from "electron";
import { logger } from "./logger";
import { safetyManager } from "./safety";
import { configManager } from "./config";

/**
 * 全局急停（T07 第 6 节）。
 *
 * 一个全局快捷键（默认 Ctrl+Alt+X，可在配置里改），随时中断所有自动化操作：
 *  - 触发后置位 stopped，鼠标/键盘序列的每一步执行前都会检查，命中即中止；
 *  - 同时打断语音播报（复用 orchestrator 的 interrupt，顺序由 orchestrator 保证）；
 *  - 已注册的热键在退出时注销。
 */

let armed = false;
let stopped = false;
let triggerCount = 0;

/** 打断回调（由 orchestrator 注册，避免循环依赖） */
let interruptHandler: ((reason: string) => void) | null = null;

/** 注册「急停时顺便打断语音」的回调 */
export function onEmergencyStopInterrupt(fn: (reason: string) => void): void {
  interruptHandler = fn;
}

/** 注册全局急停热键。返回是否成功（被占用时返回 false，调用方应提示用户） */
export function armEmergencyStop(): boolean {
  const acc = configManager.get().emergencyStopAccelerator || "Control+Alt+X";
  try {
    const ok = globalShortcut.register(acc, () => trigger());
    armed = ok;
    if (ok) {
      logger.info(`[EmergencyStop] 全局急停已注册：${acc}`);
    } else {
      logger.warn(`[EmergencyStop] 全局急停注册失败（热键可能被占用）：${acc}`);
    }
    return ok;
  } catch (e) {
    logger.error("[EmergencyStop] 注册异常:", e);
    return false;
  }
}

/** 注销热键（应用退出时） */
export function disposeEmergencyStop(): void {
  if (armed) {
    const acc = configManager.get().emergencyStopAccelerator || "Control+Alt+X";
    globalShortcut.unregister(acc);
    armed = false;
  }
}

/** 触发急停 */
export function trigger(): void {
  stopped = true;
  triggerCount += 1;
  logger.warn(`[EmergencyStop] 全局急停已触发（第 ${triggerCount} 次），所有自动化操作立即中断`);
  safetyManager.audit("emergency_stop", { count: triggerCount });
  interruptHandler?.("全局急停");
}

/** 恢复自动化（用户在面板确认后） */
export function reset(): void {
  stopped = false;
}

export function isStopped(): boolean {
  return stopped;
}

export function getTriggerCount(): number {
  return triggerCount;
}

/** 自动化序列每一步前调用；已触发则抛错 */
export function checkPoint(): void {
  if (stopped) {
    throw new Error("EMERGENCY_STOP");
  }
}

/** 判断一个错误是否来自急停（调用方据此返回可读信息而不是崩溃） */
export function isEmergencyStopError(e: unknown): boolean {
  return e instanceof Error && e.message === "EMERGENCY_STOP";
}
