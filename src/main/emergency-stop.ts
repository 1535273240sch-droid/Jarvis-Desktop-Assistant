import { globalShortcut } from "electron";
import { logger } from "./logger";
import { safetyManager } from "./safety";
import { configManager } from "./config";

/**
 * 全局急停（T07 第 6 节 + 项目书 P0 统一改造）。
 *
 * 一个全局快捷键（默认 Ctrl+Alt+X，可在配置里改），随时中断所有自动化操作：
 *  - 触发后置位 stopped：
 *      · 内置桌面动作的每一步执行前检查（checkPoint），命中即中止；
 *      · 外部/内置 MCP 工具调用入口直接拒绝（阻断后续动作）；
 *      · 正在等待的 MCP 调用被标记「等待不可中断调用结束」，不再排新动作；
 *      · 桌面任务队列收到 onStop 回调，取消排队任务、停止调度（task-runner 注册）；
 *  - 同时打断语音播报（语音 interrupt 与任务取消分开触发，二者不混淆）；
 *  - 已注册的热键在退出时注销。
 *
 * 急停触发顺序（onStop 处理器之间互不依赖）：
 *   1) taskRunner.cancelAll（取消队列与等待）
 *   2) externalMcp/mcpClient 阻断 + 挂起调用标记
 *   3) 语音 interrupt（清音频、cancel response）
 */

type StopHandler = (reason: string) => void;

let armed = false;
let stopped = false;
let triggerCount = 0;

const stopHandlers: StopHandler[] = [];
let interruptHandler: ((reason: string) => void) | null = null;

/** 注册「急停时取消任务队列/挂起调用」的处理器（task-runner、mcp 等各自注册） */
export function onStop(fn: StopHandler): void {
  if (!stopHandlers.includes(fn)) stopHandlers.push(fn);
}

/** 注册「急停时顺便打断语音」的回调（由 orchestrator 注册，避免循环依赖） */
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

/** 触发急停：任务队列、挂起 MCP 调用、内置桌面动作、语音一并处理 */
export function trigger(reason = "全局急停"): void {
  stopped = true;
  triggerCount += 1;
  logger.warn(`[EmergencyStop] 全局急停已触发（第 ${triggerCount} 次），所有自动化操作立即中断`);
  safetyManager.audit("emergency_stop", { count: triggerCount, reason });
  // 1) 任务队列与挂起调用（先取消，避免处理器之间又触发新动作）
  for (const fn of stopHandlers) {
    try {
      fn(reason);
    } catch (e) {
      logger.error("[EmergencyStop] stop 处理器异常:", e);
    }
  }
  // 2) 语音播报打断
  try {
    interruptHandler?.(reason);
  } catch (e) {
    logger.error("[EmergencyStop] 语音打断回调异常:", e);
  }
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

/** 面板展示用状态 */
export function getStatus(): { stopped: boolean; triggerCount: number; hotkeyArmed: boolean } {
  return { stopped, triggerCount, hotkeyArmed: armed };
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
