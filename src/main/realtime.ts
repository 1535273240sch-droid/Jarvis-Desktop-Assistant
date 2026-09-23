import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { logger } from "./logger";
import { configManager } from "./config";
import { sessionStore } from "./session-store";
import { memoryStore } from "./memory";
import { appCatalog } from "./app-catalog";
import type { SessionStatus } from "../common/types";

/**
 * 阶跃星辰实时语音客户端（跑在主进程）。
 *
 * 关键实现决定（均依据已核实的官方文档）：
 * 1. **鉴权用 Authorization 请求头** —— 官方方式。放主进程用 `ws` 库实现；
 *    浏览器原生 WebSocket 无法设请求头，且用 Sec-WebSocket-Protocol 携带 token 属于猜测，不采用。
 * 2. **端点** wss://api.stepfun.com/v1/realtime（模型名走查询参数）。
 * 3. **音频在本进程之外采集/播放**：Web Audio 只能在渲染进程，故音频由渲染进程处理，
 *    本客户端只负责「把上行 PCM 发出去 / 把下行 PCM 交给渲染进程播 / 下发打断指令」。
 * 4. **30 分钟硬上限**：提前在 28 分钟主动重建，并回注上下文。
 * 5. **音色锁定**：一旦本会话产出过音频，拒绝任何 voice 变更。
 *
 * 已知边界：本实现按官方文档中的事件名与字段编写；由于审查阶段无 API Key，
 * 未做真机连通性验证。首次联调请核对 `error` 事件与握手是否按预期返回。
 */

export interface RealtimeEvents {
  audioDelta: (base64Pcm: string) => void;
  userTranscript: (text: string) => void;
  /** 用户语音的增量转写（实时字幕），done 表示该句已定稿 */
  userTranscriptDelta: (delta: string, done: boolean) => void;
  assistantText: (delta: string, done: boolean) => void;
  assistantTranscript: (delta: string, done: boolean) => void;
  thinking: (delta: string, done: boolean) => void;
  speechStarted: () => void;
  speechStopped: () => void;
  /**
   * 服务端检测到用户开始说话并已打断上一轮响应。
   * 本端点是 StepFun 实现：它**不发送** OpenAI 的 input_audio_buffer.speech_started，
   * 而是发送 input_audio_buffer.speech_interrupted 并附上已经转写出的文字。
   * 本地必须据此立即清空播放缓冲，否则 AI 会把自己那段话播完才轮到用户指令。
   */
  bargeIn: (partialTranscript: string) => void;
  responseCreated: () => void;
  responseDone: () => void;
  toolCall: (callId: string, name: string, argsJson: string) => void;
  error: (message: string, fatal: boolean) => void;
  status: (status: SessionStatus) => void;
}

const SESSION_HARD_LIMIT_MS = 30 * 60 * 1000; // 官方硬上限
const SESSION_REBUILD_MS = 28 * 60 * 1000; // 主动重建阈值

export class RealtimeClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private sessionStartAt = 0;
  private rebuildTimer: NodeJS.Timeout | null = null;
  private statusTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private shouldReconnect = false;
  /** 本会话是否已产出过音频（用于音色锁定） */
  private producedAudio = false;
  /** 刚发过 response.cancel：用于忽略"没有可取消的响应"这类正常回执 */
  private expectNoResponseToCancel = false;
  private connecting = false;
  private intentionalClose = false;
  /** 当前是否有进行中的响应（用于避免 response.create 冲突） */
  private responseActive = false;
  /** 有进行中的响应时挂起的生成请求，待 response.done 后补发 */
  private pendingResponseRequest = false;

  /** 本轮响应内待处理的工具调用累积（function_call 的 arguments 是流式拼接的） */
  private pendingToolCalls = new Map<string, { name: string; argsBuffer: string; itemId: string }>();
  private assistantMsgId: string | null = null;
  /** 用户这一句话的增量转写（用于实时字幕与打断判断） */
  private userTranscriptBuffer = "";

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /* ---------------- 连接 ---------------- */

  connect(): void {
    if (this.connecting || this.isConnected()) return;
    const cfg = configManager.get();
    if (!cfg.apiKey) {
      this.emit("error", "未配置 STEPFUN API Key，实时语音不可用。请在设置中填写。", true);
      this.emitStatus("error", "缺少 API Key");
      return;
    }

    this.connecting = true;
    this.intentionalClose = false;
    this.emitStatus("connecting");

    const url = `${cfg.realtimeBaseUrl}?model=${encodeURIComponent(cfg.realtimeModel)}`;
    logger.info(`[Realtime] 正在连接 ${cfg.realtimeBaseUrl} (model=${cfg.realtimeModel})`);

    try {
      this.ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
      });
    } catch (e) {
      this.connecting = false;
      this.emit("error", `WebSocket 创建失败: ${(e as Error).message}`, true);
      this.emitStatus("error", "WebSocket 创建失败");
      return;
    }

    this.ws.on("open", () => {
      this.connecting = false;
      this.reconnectAttempts = 0;
      logger.info("[Realtime] WebSocket 已连接，等待 session.created");
    });

    this.ws.on("message", (raw: WebSocket.RawData) => {
      let evt: any;
      try {
        evt = JSON.parse(raw.toString());
      } catch {
        logger.warn("[Realtime] 无法解析服务端消息");
        return;
      }
      this.handleServerEvent(evt);
    });

    this.ws.on("error", (err: Error) => {
      this.connecting = false;
      logger.error("[Realtime] WebSocket 错误:", err.message);
      this.emit("error", `连接异常：${err.message}`, false);
    });

    this.ws.on("close", (code: number, reason: Buffer) => {
      this.connecting = false;
      this.ws = null;
      const r = reason?.toString?.() || "";
      logger.warn(`[Realtime] 连接关闭 code=${code} reason=${r}`);
      this.stopTimers();

      if (this.intentionalClose) {
        this.emitStatus("disconnected");
        return;
      }

      // 鉴权类错误不重试
      const fatalAuth = code === 4001 || code === 4003 || code === 4401 || code === 1008;
      if (fatalAuth) {
        this.emit("error", `鉴权失败或权限不足（code=${code}）。请检查 API Key 与模型权限。`, true);
        this.emitStatus("error", "鉴权失败");
        return;
      }

      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    const cfg = configManager.get();
    const r = cfg as any;
    const maxAttempts = 5;
    const base = 1000;
    const cap = 16000;

    if (this.reconnectAttempts >= maxAttempts) {
      logger.error("[Realtime] 重连次数已达上限，停止自动重连");
      this.emit("error", "网络连接反复失败，已停止自动重连。请检查网络后手动重试。", false);
      this.emitStatus("error", "重连失败");
      return;
    }

    const delay = Math.min(cap, base * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.emitStatus("reconnecting", `第 ${this.reconnectAttempts} 次重连将在 ${Math.round(delay / 1000)} 秒后进行`);
    logger.info(`[Realtime] ${delay}ms 后尝试第 ${this.reconnectAttempts} 次重连`);

    setTimeout(() => {
      if (this.shouldReconnect || this.reconnectAttempts > 0) this.connect();
    }, delay);
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.shouldReconnect = false;
    this.stopTimers();
    if (this.ws) {
      try {
        this.ws.close(1000, "client disconnect");
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.emitStatus("disconnected");
  }

  /* ---------------- 会话配置 ---------------- */

  /**
   * 组装发给服务端的 instructions：用户配置 + 本机环境事实 + 跨会话记忆。
   * 记忆/环境为空时跳过对应段落，避免无谓污染提示词。
   */
  private composeInstructions(): string {
    const base = configManager.get().instructions;
    const parts = [base];

    // 本机实际可用的程序清单：不注入的话模型只能靠猜，
    // 实测会出现「打开浏览器」时执行 explorer.exe 或去单击桌面图标。
    try {
      const env = this.envPromptCache;
      if (env) parts.push(env);
    } catch (e) {
      logger.warn("[Realtime] 读取本机程序清单失败:", e);
    }

    try {
      const block = memoryStore.buildPromptBlock();
      if (block) parts.push(block);
    } catch (e) {
      logger.warn("[Realtime] 读取长期记忆失败:", e);
    }
    return parts.filter(Boolean).join("\n\n");
  }

  /** 本机程序清单缓存（扫描较慢，会话内复用） */
  private envPromptCache = "";

  /** 刷新本机程序清单（由 orchestrator 在建立会话前调用） */
  async refreshEnvPrompt(): Promise<void> {
    try {
      this.envPromptCache = await appCatalog.buildPromptSection();
      if (this.envPromptCache) logger.info("[Realtime] 已注入本机程序清单到提示词");
    } catch (e) {
      logger.warn("[Realtime] 生成本机程序清单失败:", (e as Error).message);
    }
  }

  /**
   * 语音活动检测（VAD）配置。
   *
   * 关键点：`interrupt_response` 必须显式写出来。
   * 本项目的实时端点是 StepFun（非 OpenAI 官方），跨实现时「依赖对方默认值」很脆：
   * 一旦服务端默认不打断，就会出现「AI 一定要把话说完才开始听你说」的半双工体感。
   * create_response 同理：显式声明由服务端在检测到语音结束后自动生成回复，
   * 避免依赖默认值导致「说完没反应」。
   */
  private turnDetectionConfig(): Record<string, unknown> {
    return {
      type: "server_vad",
      prefix_padding_ms: 500,
      silence_duration_ms: 100,
      energy_awakeness_threshold: 2500,
      create_response: true,
      interrupt_response: true,
    };
  }

  private sendSessionUpdate(): void {
    const cfg = configManager.get();
    this.send({
      type: "session.update",
      session: {
        // modalities 在会话配置里显式声明，确保服务端自动创建响应时也带音频输出。
        // （实测：不声明时，server_vad 自动触发的响应可能只产出文本，没有 audio.delta）
        modalities: ["text", "audio"],
        instructions: this.composeInstructions(),
        voice: cfg.voice,
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        turn_detection: this.turnDetectionConfig(),
      },
    });
    logger.info("[Realtime] 已下发 session.update");
  }

  /**
   * 音色变更（受锁定约束保护）
   * 官方规定：一旦会话内生成了音频，voice 不可再修改。
   */
  updateVoice(voice: string): boolean {
    if (this.producedAudio) {
      logger.warn("[Realtime] 本会话已产出音频，拒绝修改 voice（官方约束）");
      this.emit("error", "本次会话已开始播报，音色在本会话内不可更改。请重开会话后再试。", false);
      return false;
    }
    configManager.set({ voice });
    if (this.isConnected()) {
      this.send({
        type: "session.update",
        session: {
          instructions: this.composeInstructions(),
          voice,
          input_audio_format: "pcm16",
          output_audio_format: "pcm16",
        },
      });
    }
    return true;
  }

  /* ---------------- 发送 ---------------- */

  private send(obj: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // 未连接时静默丢弃音频分片，避免刷屏
      if (obj.type !== "input_audio_buffer.append") {
        logger.warn(`[Realtime] 发送失败（未连接）: ${obj.type}`);
      }
      return;
    }
    try {
      this.ws.send(JSON.stringify(obj));
    } catch (e) {
      logger.error("[Realtime] 发送异常:", e);
    }
  }

  /** 上行：麦克风 PCM16 base64（渲染进程已按 24kHz 单声道切片） */
  appendAudio(base64Pcm: string): void {
    if (!base64Pcm) return;
    this.send({ type: "input_audio_buffer.append", audio: base64Pcm });
  }

  /** 提交缓冲（手动断句模式） */
  commitAudio(): void {
    this.send({ type: "input_audio_buffer.commit" });
  }

  /** 清空服务端输入缓冲 */
  clearInputBuffer(): void {
    this.send({ type: "input_audio_buffer.clear" });
  }

  /**
   * 取消进行中的响应（打断的服务端一步）。
   *
   * 实测注意：若当前没有进行中的响应，服务端会回
   *   error: "no ongoing response to cancel" (invalid_request_error)
   * 这属于**正常情况**（用户打断时可能刚好没有响应在跑），不是故障。
   * 因此这里加一个标志，让错误处理忽略这一条，避免把状态机误推到 error。
   */
  cancelResponse(): void {
    this.expectNoResponseToCancel = true;
    this.send({ type: "response.cancel" });
    // 若服务端不报错（确实取消了），2 秒后自动清除该标志
    setTimeout(() => { this.expectNoResponseToCancel = false; }, 2000);
  }

  /** 文本输入：注入用户消息并触发生成 */
  sendUserText(text: string): void {
    sessionStore.addContext("user", text);
    this.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
    this.requestResponse();
  }

  /** 工具执行结果回注，并要求模型继续 */
  sendToolResult(callId: string, output: string): void {
    this.send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output,
      },
    });
    this.requestResponse();
  }

  /**
   * 请求模型继续生成。
   *
   * 关键时序（实测踩过的坑）：模型在流式产出 function_call 的同一轮里，
   * 上一轮 response 可能尚未结束（还没收到 response.done）。此时立即发
   * response.create 会被服务端以 `invalid_request_error: ongoing response
   * already exists` 拒绝，导致工具结果回注后模型永远不继续说话。
   *
   * 因此这里跟踪当前是否已有进行中的响应：有则挂起，等 response.done 到达后自动补发。
   */
  private requestResponse(): void {
    if (this.responseActive) {
      this.pendingResponseRequest = true;
      logger.info("[Realtime] 已有进行中的响应，已排队等待其结束后再请求生成");
      return;
    }
    this.responseActive = true;
    this.send({ type: "response.create", response: { modalities: ["text", "audio"] } });
  }

  /** 把工具定义下发给模型（由 MCP 模块提供） */
  updateTools(tools: Array<Record<string, unknown>>): void {
    const cfg = configManager.get();
    this.send({
      type: "session.update",
      session: {
        instructions: this.composeInstructions(),
        voice: cfg.voice,
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        // 一并重申 turn_detection：若服务端把 session.update 当作整体替换，
        // 只带 tools 会把 VAD 配置（含 interrupt_response）重置回默认值。
        turn_detection: this.turnDetectionConfig(),
        tools,
      },
    });
    logger.info(`[Realtime] 已下发 ${tools.length} 个工具定义`);
  }

  /* ---------------- 服务端事件 ---------------- */

  /** 未处理事件类型的去重记录（每种类型只写一次日志，避免刷屏与同步写盘阻塞） */
  private loggedEventTypes = new Set<string>();

  private logUnknownEventOnce(type: string): void {
    if (this.loggedEventTypes.has(type)) return;
    this.loggedEventTypes.add(type);
    logger.info(`[Realtime] 事件: ${type}（同类后续事件不再逐条记录）`);
  }

  private handleServerEvent(evt: any): void {
    switch (evt.type) {
      case "session.created":
        logger.info(`[Realtime] session.created`);
        this.sessionStartAt = Date.now();
        this.producedAudio = false;
        // 新会话没有任何进行中的响应，必须复位。否则若重建发生在某轮响应途中
        // （responseActive 仍为 true），此后每次 requestResponse 都会被当成"已有响应"
        // 而挂起等待一个永不到来的 response.done，表现为重建后助手彻底不再回应。
        this.responseActive = false;
        this.pendingResponseRequest = false;
        this.sendSessionUpdate();
        // 重建场景：回注上下文（connect 前注册的监听会在这里触发）
        this.emit("sessionCreated");
        this.startTimers();
        this.emitStatus("connected");
        break;

      case "session.updated":
        logger.info("[Realtime] session.updated");
        break;

      case "input_audio_buffer.speech_started":
        this.emit("speechStarted");
        break;

      case "input_audio_buffer.speech_stopped":
        this.emit("speechStopped");
        break;

      /**
       * StepFun 端点的打断事件（本项目的实际打断触发点）。
       *
       * 本端点不发 OpenAI 的 speech_started，只发这个 event；收到它说明服务端
       * 已经检测到用户开口并中止了上一轮响应，但**本地播放队列还在继续出声**。
       * 必须立刻把这件事告诉上层（清空播放缓冲 + 收敛状态），
       * 否则表现为「AI 非要把自己那段话说完，我说话它没反应」。
       *
       * 事件里可能带已转写文字（不同版本字段名不同，逐个兜底取）。
       */
      case "input_audio_buffer.speech_interrupted":
      case "input_audio_buffer.speech_started_interrupted": {
        const partial = String(evt.transcript || evt.text || evt.delta || this.userTranscriptBuffer || "");
        logger.info(`[Realtime] 检测到用户打断（speech_interrupted），已转写片段="${partial.slice(0, 60)}"`);
        this.emit("bargeIn", partial);
        break;
      }

      /** 用户语音的增量转写：既用于实时字幕，也用于「用户是否已开口」的判断 */
      case "conversation.item.input_audio_transcription.delta": {
        const d = String(evt.delta || "");
        if (d) {
          this.userTranscriptBuffer += d;
          this.emit("userTranscriptDelta", d, false);
        }
        break;
      }

      case "conversation.item.input_audio_transcription.completed": {
        const t = String(evt.transcript || this.userTranscriptBuffer || "").trim();
        this.userTranscriptBuffer = "";
        if (t) {
          sessionStore.addMessage({ role: "user", content: t });
          sessionStore.addContext("user", t);
          this.emit("userTranscriptDelta", t, true);
          this.emit("userTranscript", t);
        } else {
          this.emit("userTranscriptDelta", "", true);
        }
        break;
      }

      case "conversation.item.input_audio_transcription.failed":
        logger.warn(`[Realtime] 用户语音转写失败: ${JSON.stringify(evt.error || {})}`);
        this.emit("userTranscriptDelta", "", true);
        break;

      case "response.created":
        this.assistantMsgId = sessionStore.createAssistantPlaceholder();
        this.pendingToolCalls.clear();
        this.responseActive = true;
        this.emit("responseCreated");
        break;

      case "response.audio.delta":
        this.producedAudio = true; // 音色锁定点
        if (evt.delta) this.emit("audioDelta", evt.delta as string);
        break;

      case "response.audio.done":
        this.emit("audioDone");
        break;

      case "response.audio_transcript.delta":
        if (this.assistantMsgId && evt.delta) {
          const cur = sessionStore.getMessages().find((m) => m.messageId === this.assistantMsgId);
          sessionStore.updateMessage(this.assistantMsgId, { content: (cur?.content || "") + evt.delta });
        }
        this.emit("assistantTranscript", evt.delta || "", false);
        break;

      case "response.audio_transcript.done":
        if (evt.transcript && this.assistantMsgId) {
          sessionStore.updateMessage(this.assistantMsgId, { content: evt.transcript });
          sessionStore.addContext("assistant", evt.transcript);
        }
        this.emit("assistantTranscript", evt.transcript || "", true);
        break;

      case "response.text.delta":
        this.emit("assistantText", evt.delta || "", false);
        break;

      case "response.text.done":
        this.emit("assistantText", evt.text || "", true);
        break;

      case "response.thinking.delta":
        if (this.assistantMsgId && evt.delta) {
          const cur = sessionStore.getMessages().find((m) => m.messageId === this.assistantMsgId);
          sessionStore.updateMessage(this.assistantMsgId, { thinking: (cur?.thinking || "") + evt.delta });
        }
        this.emit("thinking", evt.delta || "", false);
        break;

      case "response.thinking.done":
        this.emit("thinking", evt.thinking || "", true);
        break;

      /* —— 工具调用（流式参数拼接）—— */
      case "response.output_item.added":
        if (evt.item?.type === "function_call" && evt.item.call_id) {
          this.pendingToolCalls.set(evt.item.call_id, {
            name: evt.item.name || "",
            argsBuffer: evt.item.arguments || "",
            itemId: evt.item.id || "",
          });
        }
        break;

      case "response.function_call_arguments.delta":
        if (evt.call_id && this.pendingToolCalls.has(evt.call_id)) {
          const t = this.pendingToolCalls.get(evt.call_id)!;
          t.argsBuffer += evt.delta || "";
        }
        break;

      case "response.function_call_arguments.done": {
        const callId = evt.call_id;
        const pending = callId ? this.pendingToolCalls.get(callId) : undefined;
        const name = evt.name || pending?.name || "";
        const argsJson = evt.arguments || pending?.argsBuffer || "{}";
        if (callId && name) {
          logger.info(`[Realtime] 收到工具调用: ${name} (call_id=${callId})`);
          this.emit("toolCall", callId, name, argsJson);
          this.pendingToolCalls.delete(callId);
        }
        break;
      }

      case "response.output_item.done":
        // 某些服务端实现只在 done 里给完整 function_call
        if (evt.item?.type === "function_call" && evt.item.call_id && this.pendingToolCalls.has(evt.item.call_id)) {
          const t = this.pendingToolCalls.get(evt.item.call_id)!;
          logger.info(`[Realtime] 收到工具调用(done): ${t.name}`);
          this.emit("toolCall", evt.item.call_id, t.name, t.argsBuffer || "{}");
          this.pendingToolCalls.delete(evt.item.call_id);
        }
        break;

      case "response.done":
        this.responseActive = false;
        this.emit("responseDone");
        // 若期间有被挂起的生成请求（典型场景：工具结果回注撞上上一轮响应），
        // 此刻上一轮已结束，立即补发，让模型接着把工具结果总结出来。
        if (this.pendingResponseRequest) {
          this.pendingResponseRequest = false;
          this.responseActive = true;
          logger.info("[Realtime] 上一轮响应已结束，补发挂起的生成请求");
          this.send({ type: "response.create", response: { modalities: ["text", "audio"] } });
        }
        break;

      case "error": {
        const e = evt.error || {};
        const msg = `${e.code || e.type || "unknown"}: ${e.message || "服务端返回错误"}`;

        // 情况 1：打断时没有进行中的响应 —— 正常，不当作故障
        if (this.expectNoResponseToCancel && /no ongoing response to cancel/i.test(String(e.message || ""))) {
          this.expectNoResponseToCancel = false;
          logger.info("[Realtime] 打断时无进行中的响应（正常，忽略）");
          break;
        }

        // 情况 2：server_vad 模式下发了 commit —— 我们的实现不会这么做，
        // 但若因外部调用发生，降级为警告而不是错误
        if (/commit when server vad/i.test(String(e.message || ""))) {
          logger.warn("[Realtime] server_vad 模式下不应 commit（已忽略该回执）");
          break;
        }

        // 情况 3：已有进行中的响应时又请求生成 —— 属正常时序竞争，
        // 已由 requestResponse() 排队机制处理，这里仅记录并等待自动补发
        if (/ongoing response already exists/i.test(String(e.message || ""))) {
          this.responseActive = true;
          logger.info("[Realtime] 已有进行中的响应（正常，结果将在其结束后自动补发）");
          break;
        }

        logger.error("[Realtime] 服务端 error 事件:", msg);
        const fatal = ["invalid_api_key", "authentication_error", "permission_denied", "insufficient_quota"].includes(
          String(e.code || e.type || "")
        );
        this.emit("error", msg, fatal);
        break;
      }

      default:
        // 其余事件（如 response.content_part.*）不影响主流程。
        //
        // 这里**必须限流**：服务端在一次对话里会发大量同类事件
        // （实测仅 input_audio_transcription.delta 就有 134 条），
        // 而 logger 是每条同步写盘。逐条记录会让日志文件迅速膨胀
        // （本机实测单文件涨到近 2MB、WARN 逾 1.5 万条），
        // 并在高频事件下阻塞主进程。改为「每个事件类型每种状态只记一次」。
        this.logUnknownEventOnce(evt.type);
        break;
    }
  }

  /* ---------------- 会话生命周期 ---------------- */

  private startTimers(): void {
    this.stopTimers();

    // 28 分钟主动重建
    this.rebuildTimer = setTimeout(() => {
      logger.info("[Realtime] 距 30 分钟硬上限不足 2 分钟，开始主动重建会话");
      this.rebuildSession().catch((e) => logger.error("[Realtime] 会话重建失败:", e));
    }, SESSION_REBUILD_MS);

    // 状态广播（每秒一次，供界面显示剩余时间）
    this.statusTimer = setInterval(() => {
      this.emitStatus(this.isConnected() ? "connected" : "disconnected");
    }, 1000);
  }

  private stopTimers(): void {
    if (this.rebuildTimer) {
      clearTimeout(this.rebuildTimer);
      this.rebuildTimer = null;
    }
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
  }

  /**
   * 会话重建 + 上下文迁移。
   * 注意执行顺序：**先注册监听，再发起连接** —— 否则 session.created 可能在
   * 监听器注册之前就到达，导致迁移被跳过（此前的实现缺陷，已修正）。
   */
  async rebuildSession(): Promise<void> {
    logger.info("[Realtime] 开始会话重建与上下文迁移");

    const digest = sessionStore.buildMigrationDigest();

    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };

      // 1) 先注册：新会话建立后回注历史
      this.once("sessionCreated", () => {
        try {
          for (const item of digest) {
            this.send({
              type: "conversation.item.create",
              item: {
                type: "message",
                role: item.role,
                content: [{ type: item.role === "user" ? "input_text" : "text", text: item.text }],
              },
            });
          }
          logger.info(`[Realtime] 已向新会话回注 ${digest.length} 条历史上下文`);
        } catch (e) {
          logger.error("[Realtime] 上下文回注失败:", e);
        }
        setTimeout(finish, 300);
      });

      // 2) 再断开并重连
      this.intentionalClose = false;
      this.shouldReconnect = true;
      if (this.ws) {
        this.intentionalClose = true;
        try {
          this.ws.close(1000, "session rebuild");
        } catch {
          /* ignore */
        }
        this.ws = null;
      }
      setTimeout(() => {
        this.intentionalClose = false;
        this.connect();
      }, 400);

      // 兜底：最多等 12 秒
      setTimeout(finish, 12_000);
    });

    logger.info("[Realtime] 会话重建流程结束");
  }

  /* ---------------- 状态广播 ---------------- */

  private emitStatus(
    connection: SessionStatus["connection"],
    detail?: string
  ): void {
    const cfg = configManager.get();
    const elapsed = this.sessionStartAt ? Date.now() - this.sessionStartAt : 0;
    const remainingHard = this.sessionStartAt
      ? Math.max(0, Math.round((SESSION_HARD_LIMIT_MS - elapsed) / 1000))
      : Math.round(SESSION_HARD_LIMIT_MS / 1000);
    const rebuildIn = this.sessionStartAt
      ? Math.max(0, Math.round((SESSION_REBUILD_MS - elapsed) / 1000))
      : Math.round(SESSION_REBUILD_MS / 1000);

    this.emit("status", {
      connection,
      model: cfg.realtimeModel,
      remainingSeconds: remainingHard,
      rebuildInSeconds: rebuildIn,
      hasApiKey: cfg.apiKey.length > 0,
      detail,
    } as SessionStatus);
  }

  /** 强制广播一次当前状态（配置变更后调用） */
  refreshStatus(): void {
    this.emitStatus(this.isConnected() ? "connected" : "disconnected");
  }

  /**
   * 音色列表（供面板「一键获取音色」使用）。
   *
   * 本端点的 /v1/audio/voices 只返回**自定义/克隆音色**（本机实测为空数组），
   * 内置音色不在接口里。因此策略是：
   *   1. 先调接口拿自定义音色；
   *   2. 再合并一份**逐项实测被服务端接受**的内置音色清单。
   * 这样用户看到的是「确实可用」的完整列表，而不是靠猜。
   */
  async listVoices(): Promise<{
    builtin: Array<{ id: string; label: string; verified: boolean }>;
    custom: Array<{ id: string; label: string }>;
    error?: string;
  }> {
    // 内置音色：这批已在本机用真实 Key 逐个建会话验证过会被接受
    const VERIFIED: Array<{ id: string; label: string }> = [
      { id: "cixingnansheng", label: "磁性男声" },
      { id: "zhengpaiqingnian", label: "正派青年" },
      { id: "wenrounvsheng", label: "温柔女声" },
      { id: "wenrounansheng", label: "温柔男声" },
      { id: "qinqienvsheng", label: "亲切女声" },
      { id: "qingniandaxuesheng", label: "青年大学生" },
      { id: "shenchennanyin", label: "深沉男音" },
      { id: "jilingshaonv", label: "机灵少女" },
      { id: "yuanqinansheng", label: "元气男声" },
      { id: "wenjingxuejie", label: "文静学姐" },
    ];

    const out = {
      builtin: VERIFIED.map((v) => ({ ...v, verified: true })),
      custom: [] as Array<{ id: string; label: string }>,
      error: undefined as string | undefined,
    };

    // 再尝试拉取自定义音色（失败不影响内置清单）
    const cfg = configManager.get();
    if (!cfg.apiKey) {
      out.error = "未配置 API Key，仅显示内置音色";
      return out;
    }
    const base = cfg.realtimeBaseUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:").replace(/\/realtime\/?$/, "");
    const endpoints = [`${base}/audio/voices`, `${base}/voices`];
    for (const url of endpoints) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 10000);
        const res = await fetch(url, { headers: { Authorization: `Bearer ${cfg.apiKey}` }, signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) continue;
        const j: any = await res.json();
        const arr: any[] = Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : [];
        out.custom = arr
          .map((x) => {
            const id = String(x?.id ?? x?.voice ?? x?.voice_id ?? "");
            const label = String(x?.name ?? x?.label ?? id);
            return id ? { id, label } : null;
          })
          .filter(Boolean) as Array<{ id: string; label: string }>;
        logger.info(`[Realtime] 音色列表：内置 ${out.builtin.length} 个，自定义 ${out.custom.length} 个`);
        return out;
      } catch (e) {
        out.error = `拉取自定义音色失败：${(e as Error).message}`;
      }
    }
    return out;
  }

  /** 校验某个音色是否被服务端接受（供自定义音色「测一下」） */
  async validateVoice(voice: string): Promise<{ ok: boolean; reason?: string }> {
    const cfg = configManager.get();
    if (!cfg.apiKey) return { ok: false, reason: "未配置 API Key" };
    return new Promise((resolve) => {
      let settled = false;
      const finish = (r: { ok: boolean; reason?: string }) => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        resolve(r);
      };
      let ws: WebSocket;
      try {
        ws = new WebSocket(`${cfg.realtimeBaseUrl}?model=${encodeURIComponent(cfg.realtimeModel)}`, {
          headers: { Authorization: `Bearer ${cfg.apiKey}` },
        });
      } catch (e) {
        resolve({ ok: false, reason: (e as Error).message });
        return;
      }
      const timer = setTimeout(() => finish({ ok: false, reason: "校验超时" }), 12000);
      ws.on("message", (raw: WebSocket.RawData) => {
        let e: any;
        try {
          e = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (e.type === "session.created") {
          ws.send(
            JSON.stringify({
              type: "session.update",
              session: {
                modalities: ["text", "audio"],
                instructions: "hi",
                voice,
                input_audio_format: "pcm16",
                output_audio_format: "pcm16",
              },
            })
          );
        } else if (e.type === "session.updated") {
          clearTimeout(timer);
          finish({ ok: true });
        } else if (e.type === "error") {
          clearTimeout(timer);
          finish({ ok: false, reason: String(e.error?.message || "服务端拒绝该音色").slice(0, 160) });
        }
      });
      ws.on("error", (err: Error) => {
        clearTimeout(timer);
        finish({ ok: false, reason: err.message });
      });
    });
  }

  dispose(): void {
    this.stopTimers();
    this.disconnect();
    this.removeAllListeners();
  }
}

export const realtimeClient = new RealtimeClient();
