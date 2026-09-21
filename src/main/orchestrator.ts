import { BrowserWindow } from "electron";
import { logger } from "./logger";
import { stateMachine } from "./state";
import { sessionStore } from "./session-store";
import { realtimeClient } from "./realtime";
import { mcpClient } from "./mcp";
import { visionManager } from "./vision";
import { desktopController } from "./desktop-control";
import { safetyManager } from "./safety";
import { orbController } from "./orb-control";
import { configManager } from "./config";
import { onEmergencyStopInterrupt } from "./emergency-stop";
import { isAuthorized, ensureAutoAuthorized } from "./authorization";
import { IPC } from "../common/types";
import type { AssistantState, SessionStatus, ToolCallView } from "../common/types";

/**
 * 中枢编排器：把「语音 / 文本 -> 模型 -> 工具 -> 结果回注 -> 语音回复」
 * 串成一条闭环，并驱动六态状态机与球体视觉。
 *
 * 六态映射（唯一真源在本类持有）：
 *   speech_started           -> listening
 *   response.created         -> thinking
 *   工具调用开始              -> executing
 *   首个音频分片              -> speaking
 *   播放结束 / response.done  -> idle
 *   任意错误                  -> error
 *
 * 打断（interrupt）严格按序：先本地清空播放缓冲 -> 再 response.cancel
 * -> 再 input_audio_buffer.clear -> 最后切状态。顺序反了会有残余音频。
 */

/** 内置工具（不属于 MCP，由本项目主进程直接提供） */
const BUILTIN_TOOLS = [
  {
    type: "function",
    function: {
      name: "look_at_screen",
      description:
        "查看屏幕内容并理解。当用户说「看看这个报错」「屏幕上是什么」「帮我看看当前窗口」时调用。会截取当前活动窗口（或整屏）并交给视觉模型分析。",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "想从屏幕中了解什么，例如「这个报错是什么意思」" },
          target: { type: "string", enum: ["active_window", "entire_screen"], description: "截图范围，默认当前活动窗口" },
        },
        required: ["question"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "click_on_screen",
      description: "在屏幕上执行鼠标点击。当用户说「帮我点击登录按钮」「点一下那个确定」时调用。建议先用 look_at_screen 确认目标坐标；如果视觉结果里给了目标标签，把它一并传入以便风险判定。",
      parameters: {
        type: "object",
        properties: {
          x: { type: "number", description: "屏幕横向坐标（物理像素，多显示器下左侧副屏为负）" },
          y: { type: "number", description: "屏幕纵向坐标（物理像素）" },
          button: { type: "string", enum: ["left", "right", "double"], description: "点击方式，默认左键单击" },
          label: { type: "string", description: "目标标签（如「登录按钮」「提交订单」），用于高风险判定与确认文案" },
        },
        required: ["x", "y"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "type_text",
      description: "向当前前台窗口输入文字。当用户说「帮我输入…」「打字…」时调用。密码/验证码类内容会被拒绝代填。",
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: "要输入的文本" } },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "press_keys",
      description: "发送按键或组合键，例如 ctrl+c、alt+f4、enter、esc。当用户说「帮我关闭当前窗口」（alt+f4）「帮我复制」时调用。",
      parameters: {
        type: "object",
        properties: { combo: { type: "string", description: "按键组合，如 ctrl+c、alt+f4、enter" } },
        required: ["combo"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "close_current_window",
      description: "关闭当前前台窗口。当用户说「帮我关闭当前窗口」「关掉这个窗口」时调用。会先识别窗口、请用户确认、发送 Alt+F4 并复核是否真的关闭。",
      parameters: { type: "object", properties: {} },
    },
  },
];

class Orchestrator {
  private panelGetter: (() => BrowserWindow | null) | null = null;
  private started = false;
  /** 正在执行的工具调用（用于状态机与面板展示） */
  private activeToolCalls = new Map<string, ToolCallView>();

  init(panelGetter: () => BrowserWindow | null): void {
    this.panelGetter = panelGetter;

    // —— 全局急停：中断所有自动化并打断语音（T07 第 6 节）——
    onEmergencyStopInterrupt((reason) => this.interrupt(reason));

    // —— 状态机 -> 球体 + 面板 ——
    stateMachine.on("change", ({ from, to, reason }: { from: AssistantState; to: AssistantState; reason: string }) => {
      orbController.setState(to).catch((e) => logger.warn("[Orchestrator] 同步球体状态失败:", e));
      this.broadcast(IPC.STATE_CHANGED, { state: to, from, reason });
    });

    // —— 实时客户端事件 -> 状态机 / 面板 ——
    realtimeClient.on("speechStarted", () => {
      // 用户开口：若正在播报则先打断，再进入聆听
      if (stateMachine.getState() === "speaking") {
        this.interrupt("用户语音打断");
      } else {
        stateMachine.transition("listening", "检测到用户开始说话");
      }
    });

    realtimeClient.on("speechStopped", () => {
      // server_vad 模式下服务端会自动生成响应；这里只做状态提示
      if (stateMachine.getState() === "listening") {
        stateMachine.transition("thinking", "用户语音结束，等待模型响应");
      }
    });

    realtimeClient.on("responseCreated", () => {
      stateMachine.transition("thinking", "模型响应已创建");
      this.broadcast(IPC.CHAT_MESSAGE, { reset: true });
    });

    realtimeClient.on("audioDelta", (b64: string) => {
      stateMachine.transition("speaking", "收到首个音频分片");
      // 音频交给渲染进程播放（Web Audio 只能在渲染进程）
      this.broadcast(IPC.AUDIO_CHUNK_DOWN, { pcmBase64: b64 });
    });

    realtimeClient.on("audioDone", () => {
      this.broadcast(IPC.AUDIO_CHUNK_DOWN, { pcmBase64: "", done: true });
    });

    realtimeClient.on("userTranscript", (text: string) => {
      logger.info(`[Orchestrator] 用户: ${text}`);
    });

    realtimeClient.on("thinking", (delta: string, done: boolean) => {
      this.broadcast(IPC.CHAT_MESSAGE, { thinkingDelta: delta, thinkingDone: done });
    });

    realtimeClient.on("assistantTranscript", (delta: string, done: boolean) => {
      this.broadcast(IPC.CHAT_MESSAGE, { assistantDelta: delta, assistantDone: done });
    });

    realtimeClient.on("assistantText", (delta: string, done: boolean) => {
      this.broadcast(IPC.CHAT_MESSAGE, { assistantDelta: delta, assistantDone: done });
    });

    realtimeClient.on("responseDone", () => {
      // 播放可能还在排队，等渲染进程的播放结束事件再回 idle；这里作兜底
      setTimeout(() => {
        if (stateMachine.getState() === "speaking") {
          stateMachine.transition("idle", "响应结束且播放完成");
        } else if (stateMachine.getState() === "thinking") {
          stateMachine.transition("idle", "响应结束（无音频输出）");
        }
      }, 400);
    });

    realtimeClient.on("toolCall", (callId: string, name: string, argsJson: string) => {
      this.handleToolCall(callId, name, argsJson).catch((e) => {
        logger.error("[Orchestrator] 工具调用处理失败:", e);
        realtimeClient.sendToolResult(callId, `工具执行失败：${(e as Error).message}`);
        stateMachine.transition("thinking", "工具异常，回到思考态");
      });
    });

    realtimeClient.on("error", (msg: string, fatal: boolean) => {
      logger.error(`[Orchestrator] 实时链路错误: ${msg}`);
      if (fatal) {
        stateMachine.transition("error", `致命错误：${msg}`, { fatal: true });
      } else {
        stateMachine.transition("error", `错误：${msg}`);
      }
      this.broadcast(IPC.CHAT_MESSAGE, { systemNotice: `⚠️ ${msg}` });
    });

    realtimeClient.on("status", (st: SessionStatus) => {
      this.broadcast(IPC.SESSION_STATUS, st);
    });

    // —— MCP ——
    mcpClient.on("unavailable", (reason: string) => {
      logger.warn(`[Orchestrator] 工具能力不可用：${reason}`);
      this.broadcast(IPC.CHAT_MESSAGE, { systemNotice: `工具执行不可用：${reason}` });
    });
    mcpClient.on("tools", () => {
      this.pushToolsToModel();
    });
  }

  /** 启动会话（无 Key 时给出明确提示而非静默失败） */
  async startSession(): Promise<{ ok: boolean; reason?: string }> {
    if (!configManager.hasApiKey()) {
      const reason = "尚未配置 StepFun API Key。请在「设置」中填写后重试。";
      this.broadcast(IPC.CHAT_MESSAGE, { systemNotice: `⚠️ ${reason}` });
      return { ok: false, reason };
    }

    // 1) 先在连接**之前**启动 MCP（工具清单要在会话建立后立刻下发，
    //    否则模型在头几轮没有工具可调）
    let toolsReady = false;
    if (configManager.get().mcpEnabled && !mcpClient.isReady()) {
      const r = await mcpClient.start();
      if (!r.ok) {
        logger.warn(`[Orchestrator] MCP 未启动：${r.reason}`);
      } else {
        toolsReady = true;
      }
    } else if (mcpClient.isReady()) {
      toolsReady = true;
    }

    // 2) 连接实时会话。
    //    注意：session.update（含工具定义）必须在**收到 session.created 之后**下发，
    //    否则 WebSocket 还没 open，消息会被丢弃（此前正是在连接前下发，导致工具丢失）。
    realtimeClient.once("sessionCreated", () => {
      if (toolsReady) {
        this.pushToolsToModel();
      } else {
        logger.info("[Orchestrator] MCP 不可用，仅下发内置工具");
        this.broadcast(IPC.TOOL_LIST, { tools: BUILTIN_TOOLS.map((t: any) => t.function.name) });
      }
    });

    realtimeClient.connect();
    this.started = true;
    return { ok: true };
  }

  stopSession(): void {
    // 顺序很重要：先让渲染进程立刻静音并停掉麦克风采集，
    // 再断服务端连接，最后收敛状态。否则已排入播放队列的音频会继续响。
    this.broadcast(IPC.AUDIO_FLUSH, {});
    this.broadcast(IPC.AUDIO_STATE, { capture: false, playback: false });
    realtimeClient.disconnect();
    this.started = false;
    orbController.setAudioBands().catch(() => undefined);
    stateMachine.transition("idle", "会话已停止", { force: true });
  }

  /**
   * 进程退出前的彻底静音与清理。
   * 面板隐藏/退出时若只断 WebSocket，渲染进程播放队列里已排定的音频仍会继续出声，
   * 这里显式清空，确保"退出了就不该再说话"。
   */
  shutdown(): void {
    try {
      this.broadcast(IPC.AUDIO_FLUSH, {});
      this.broadcast(IPC.AUDIO_STATE, { capture: false, playback: false });
    } catch {
      /* 窗口可能已销毁，忽略 */
    }
    realtimeClient.disconnect();
    this.started = false;
  }

  isStarted(): boolean {
    return this.started;
  }

  /** 把内置工具 + MCP 工具一起下发给模型 */
  private pushToolsToModel(): void {
    const tools = [...BUILTIN_TOOLS, ...mcpClient.toModelTools()];
    realtimeClient.updateTools(tools);
    this.broadcast(IPC.TOOL_LIST, { tools: tools.map((t: any) => t.function.name) });
    logger.info(`[Orchestrator] 已下发工具集：${tools.map((t: any) => t.function.name).join(", ")}`);
  }

  /* ---------------- 工具执行闭环 ---------------- */

  private async handleToolCall(callId: string, name: string, argsJson: string): Promise<void> {
    let args: Record<string, unknown> = {};
    try {
      args = argsJson ? JSON.parse(argsJson) : {};
    } catch {
      logger.warn(`[Orchestrator] 工具参数解析失败: ${argsJson.slice(0, 200)}`);
      args = {};
    }

    logger.info(`[Orchestrator] 执行工具 ${name} 参数=${JSON.stringify(args).slice(0, 300)}`);
    stateMachine.transition("executing", `执行工具 ${name}`);

    const view: ToolCallView = { callId, toolName: name, args, status: "executing" };
    this.activeToolCalls.set(callId, view);
    this.broadcast(IPC.CHAT_MESSAGE, { toolCall: view });

    const started = Date.now();
    let output = "";
    let ok = false;

    try {
      // 先看内置工具
      const builtin = await this.runBuiltinTool(name, args);
      if (builtin !== null) {
        ok = builtin.ok;
        output = builtin.output;
      } else {
        // 再交给 MCP
        const r = await mcpClient.callTool(name, args);
        ok = r.ok;
        output = r.output;
        if (r.rejected) view.status = "rejected";
      }
      if (view.status !== "rejected") view.status = ok ? "success" : "failed";
    } catch (e) {
      ok = false;
      output = `工具执行异常：${(e as Error).message}`;
      view.status = "failed";
      logger.error(`[Orchestrator] 工具 ${name} 异常:`, e);
    }

    view.result = output.slice(0, 2000);
    view.durationMs = Date.now() - started;
    this.broadcast(IPC.CHAT_MESSAGE, { toolCall: view });
    this.activeToolCalls.delete(callId);

    // 结果回注模型，让它继续说话
    realtimeClient.sendToolResult(callId, output.slice(0, 8000));
    stateMachine.transition("thinking", `工具 ${name} 执行完毕，等待模型继续`);
  }

  /**
   * 内置工具实现。返回 null 表示「不是内置工具」，交给 MCP。
   */
  private async runBuiltinTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<{ ok: boolean; output: string } | null> {
    switch (name) {
      case "look_at_screen": {
        const question = String(args.question || "屏幕上显示了什么？");
        const target = (args.target as "entire_screen" | "active_window") || "active_window";
        // 视觉是往返 HTTP，有额外延迟：先切 thinking 给用户「正在查看屏幕」的反馈
        stateMachine.transition("thinking", "正在查看屏幕…");
        const win = await visionManager.getActiveWindow();
        const ctx = win ? `（当前活动窗口：${win.title}，进程 ${win.processName}）` : "";
        const r = await visionManager.captureAndUnderstand(`${question}\n${ctx}`, target);
        if (!r.success) return { ok: false, output: `看屏幕失败：${r.errorMessage}` };
        if (r.previewDataUrl) this.broadcast(IPC.CHAT_MESSAGE, { screenshot: r.previewDataUrl });

        // 定位结果：图像像素坐标 -> 屏幕物理坐标（T07 第 4 节坐标换算）
        let output = r.analysisText;
        if (r.target && r.region && r.imageSize) {
          const mapped = desktopController.mapVisionPoint(
            { x: r.target.x, y: r.target.y },
            { width: r.imageSize.width, height: r.imageSize.height, region: r.region }
          );
          output +=
            `\n\n【定位结果】目标「${r.target.label ?? "未命名"}」在屏幕上的物理坐标约为 (${mapped.point.x}, ${mapped.point.y})。` +
            (mapped.clamped ? "（该坐标由模型估算且已修正到可见区域，执行点击前必须经用户确认）" : "");
          safetyManager.audit("vision_target_mapped", {
            imagePoint: { x: r.target.x, y: r.target.y },
            screenPoint: mapped.point,
            clamped: mapped.clamped,
            label: r.target.label,
          });
        }
        return { ok: true, output };
      }

      case "click_on_screen": {
        const x = Number(args.x);
        const y = Number(args.y);
        const button = (args.button as "left" | "right" | "double") || "left";
        const label = typeof args.label === "string" ? args.label : undefined;
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          return { ok: false, output: "点击坐标无效，需要提供数字型的 x 与 y。" };
        }
        const msg = await desktopController.click(x, y, button, label);
        return { ok: !msg.includes("拒绝"), output: msg };
      }

      case "type_text": {
        const text = String(args.text || "");
        if (!text) return { ok: false, output: "没有要输入的文本。" };
        const msg = await desktopController.typeText(text);
        return { ok: !msg.includes("拒绝"), output: msg };
      }

      case "press_keys": {
        const combo = String(args.combo || "");
        if (!combo) return { ok: false, output: "没有指定按键。" };
        const msg = await desktopController.pressKeys(combo);
        return { ok: !msg.includes("拒绝"), output: msg };
      }

      case "close_current_window": {
        if (!isAuthorized("keyboard-control")) {
          ensureAutoAuthorized();
        }
        const win = await visionManager.getActiveWindow();
        if (!win) return { ok: false, output: "当前没有可操作的前台窗口（焦点可能在桌面）。" };
        const cfgClose = configManager.get();
        if (cfgClose.confirmHighRisk) {
          const confirmed = await safetyManager.requestConfirmation({
            requestId: `cfm_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6)}`,
            riskLevel: "high",
            actionType: "desktop_control",
            title: "关闭当前窗口",
            target: `${win.title}（${win.processName}）`,
            explanation: `将关闭当前前台窗口「${win.title}」（进程 ${win.processName}）。未保存的内容可能丢失，请确认。`,
          });
          if (!confirmed) return { ok: false, output: "用户拒绝了关闭窗口的操作。" };
        } else {
          safetyManager.audit("auto_approved", { action: "close_current_window", title: win.title });
        }
        const msg = await desktopController.pressKeys("alt+f4");
        safetyManager.audit("close_current_window", { title: win.title, processName: win.processName, confirmed: true });
        return { ok: !msg.includes("拒绝"), output: `已请求关闭窗口「${win.title}」：${msg}` };
      }

      default:
        return null;
    }
  }

  /* ---------------- 打断 ---------------- */

  /**
   * 原子打断。顺序不可调换：
   *   1) 本地立即静音（清空渲染进程播放缓冲）
   *   2) response.cancel（取消服务端生成）
   *   3) input_audio_buffer.clear（清空服务端输入缓冲）
   *   4) 音频频段归零
   *   5) 状态切到 listening
   */
  interrupt(reason = "用户打断"): void {
    logger.info(`[Orchestrator] 触发打断：${reason}`);

    // 1) 本地静音（必须最先）
    this.broadcast(IPC.AUDIO_FLUSH, {});

    // 2) 取消服务端响应
    realtimeClient.cancelResponse();

    // 3) 清空服务端输入缓冲，避免把打断时说的话和上一轮混淆
    realtimeClient.clearInputBuffer();

    // 4) 球体频段归零
    orbController.setAudioBands().catch(() => undefined);

    // 5) 状态收敛
    stateMachine.transition("listening", `打断：${reason}`, { force: true });
    safetyManager.audit("interrupt", { reason });
  }

  /** 用户发的文本 */
  sendUserText(text: string): void {
    const t = text.trim();
    if (!t) return;
    if (!realtimeClient.isConnected()) {
      this.broadcast(IPC.CHAT_MESSAGE, { systemNotice: "⚠️ 尚未连接实时服务，请先启动会话（并在设置中配置 API Key）。" });
      return;
    }
    sessionStore.addMessage({ role: "user", content: t });
    this.broadcast(IPC.CHAT_MESSAGE, { userText: t });
    stateMachine.transition("thinking", "用户提交文本");
    realtimeClient.sendUserText(t);
  }

  /** 渲染进程算好的四频段 -> 球体 */
  feedAudioBands(bands: { low: number; mid: number; high: number; all: number }): void {
    orbController.setAudioBands(bands).catch(() => undefined);
  }

  /** 播报结束（由渲染进程播放器上报） */
  onPlaybackFinished(): void {
    if (stateMachine.getState() === "speaking") {
      stateMachine.transition("idle", "播放完成");
    }
  }

  private broadcast(channel: string, payload: unknown): void {
    const win = this.panelGetter?.();
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

export const orchestrator = new Orchestrator();
