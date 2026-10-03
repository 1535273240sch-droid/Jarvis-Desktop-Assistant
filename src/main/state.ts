import { EventEmitter } from "node:events";
import { logger } from "./logger";
import type { AssistantState } from "../common/types";

/**
 * 六态状态机 —— 全系统唯一真源。
 *
 * 依据架构评审（T02 §4）：
 * - 优先级：Error > 用户打断 > Executing > Thinking > Listening > Idle
 * - 每个非空闲态都有 Watchdog 超时，超时后回退，杜绝死锁
 * - 打断必须「先本地静音，后取消服务端」——本类只负责状态，具体动作由调用方按序执行
 * - 球体没有「过渡完成」事件，故本状态机完全由业务事件驱动，不依赖球体回调
 */

/** 各状态的 Watchdog 超时（毫秒）。null = 不设超时 */
const WATCHDOG_MS: Record<AssistantState, number | null> = {
  idle: null,
  listening: 15_000, // 用户一直没说完（比任务书的 10s 稍宽，给长句留余地）
  thinking: 20_000, // 模型思考/首包超时
  /**
   * 工具执行：不再用固定 60s。
   * 实测问题：编译、npm install、git clone、训练这类命令经常跑几分钟，
   * 固定 60s 到点会无条件把状态打回 idle，表现为「命令还在跑，助手却说做完了」
   * 并停止继续下一步 —— 长任务必然断的直接原因。
   * 现在默认 10 分钟，且可由用户配置（configManager.get().toolWatchdogMs）调整。
   * 注意：执行中若有工具在运行，extend() 会在每次工具心跳/新工具开始时续期。
   */
  executing: 600_000,
  speaking: 60_000, // 播报中；正常由播放结束事件收敛
  error: 5_000, // 瞬态错误自动恢复
};

/** 状态优先级，数值越大越优先 */
const PRIORITY: Record<AssistantState, number> = {
  idle: 0,
  listening: 1,
  thinking: 2,
  executing: 3,
  speaking: 4,
  error: 5,
};

interface ChangeEvent {
  from: AssistantState;
  to: AssistantState;
  reason: string;
}

export class StateMachine extends EventEmitter {
  private state: AssistantState = "idle";
  private watchdog: NodeJS.Timeout | null = null;
  /** 致命错误时不自动恢复，需用户手动重试 */
  private fatal = false;
  /**
   * executing 态的覆盖时长（毫秒），由 orchestrator 从配置注入。
   * null/undefined/非正数时回退到 WATCHDOG_MS.executing。
   */
  private executingTimeoutOverride: number | null = null;

  /** 设置 executing 态看门狗时长；传 null/非正数恢复默认 10 分钟 */
  setExecutingTimeout(ms: number | null | undefined): void {
    if (ms === null || ms === undefined || !Number.isFinite(Number(ms)) || Number(ms) <= 0) {
      this.executingTimeoutOverride = null;
    } else {
      // 下限 30s，避免误配成极小值导致执行态瞬间超时
      this.executingTimeoutOverride = Math.max(30_000, Math.floor(Number(ms)));
    }
    if (this.state === "executing") this.armWatchdog("executing");
  }

  /**
   * 续期当前态的看门狗。用于「工具仍在正常产出进展」的场景：
   * 长命令每产出一段输出就调一次，既不误杀长任务，也保留彻底卡死的兜底。
   */
  extend(reason = "工具仍在执行，续期看门狗"): void {
    if (this.state === "idle") return;
    this.armWatchdog(this.state);
    logger.info(`[FSM] 续期 ${this.state} 态看门狗（${reason}）`);
  }

  /** 当前态生效的看门狗时长（null = 不设超时） */
  timeoutMsFor(state: AssistantState): number | null {
    if (state === "executing" && this.executingTimeoutOverride !== null) return this.executingTimeoutOverride;
    return WATCHDOG_MS[state];
  }

  getState(): AssistantState {
    return this.state;
  }

  isFatal(): boolean {
    return this.fatal;
  }

  /**
   * 请求状态迁移。
   * @param to 目标状态
   * @param reason 迁移原因（写入日志，便于排查）
   * @param opts.force 忽略优先级（用于用户手动打断、强制重置）
   * @param opts.fatal 标记为致命错误：进入 error 后不自动恢复
   */
  transition(to: AssistantState, reason: string, opts: { force?: boolean; fatal?: boolean } = {}): boolean {
    if (opts.fatal) this.fatal = true;

    if (to === this.state && !opts.force) return false;

    // 致命错误态下，除强制重置外不接受其它迁移
    if (this.fatal && this.state === "error" && to !== "error" && !opts.force) {
      logger.info(`[FSM] 处于致命错误态，忽略迁移请求 ${this.state} -> ${to} (${reason})`);
      return false;
    }

    // 低优先级不能抢占高优先级（error 与用户打断除外，由 force 控制）
    if (!opts.force && PRIORITY[to] < PRIORITY[this.state]) {
      // 允许高优先级态自然收敛到低优先级态（如 speaking -> idle）
      const allowedFallback =
        (this.state === "speaking" && (to === "idle" || to === "listening")) ||
        (this.state === "executing" && to === "thinking") ||
        (this.state === "thinking" && (to === "speaking" || to === "listening")) ||
        (this.state === "listening" && to === "idle") ||
        (this.state === "error" && to === "idle");
      if (!allowedFallback) {
        logger.info(`[FSM] 优先级不足，忽略 ${this.state} -> ${to} (${reason})`);
        return false;
      }
    }

    const from = this.state;
    this.state = to;
    if (to !== "error") {
      // 非错误态解除致命标记
      if (to === "idle") this.fatal = false;
    }

    this.armWatchdog(to);
    logger.info(`[FSM] ${from} -> ${to}  (${reason})`);
    this.emit("change", { from, to, reason } as ChangeEvent);
    return true;
  }

  /** 手动重置（用户点击「重试」） */
  reset(reason = "用户手动重置"): void {
    this.fatal = false;
    this.transition("idle", reason, { force: true });
  }

  /** 清除致命标记 */
  clearFatal(): void {
    this.fatal = false;
  }

  private armWatchdog(state: AssistantState): void {
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
    const ms = this.timeoutMsFor(state);
    if (ms === null) return;

    this.watchdog = setTimeout(() => {
      // 超时兜底：只有仍停在该状态时才回退，避免误伤已迁移的状态
      if (this.state !== state) return;
      if (state === "error") {
        if (this.fatal) {
          logger.warn("[FSM] 致命错误态不自动恢复，等待用户处理");
          return;
        }
        this.transition("idle", "错误态超时自动恢复", { force: true });
      } else {
        logger.warn(`[FSM] 状态 ${state} 超时（${ms}ms），回退到 idle`);
        this.emit("timeout", state);
        this.transition("idle", `状态 ${state} 看门狗超时`, { force: true });
      }
    }, ms);
  }

  dispose(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
    this.removeAllListeners();
  }
}

export const stateMachine = new StateMachine();
