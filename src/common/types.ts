/**
 * Jarvis V1 —— 公共类型与 IPC 契约（主进程 / 渲染进程 / preload 共用）
 *
 * 设计约束（来自架构评审）：
 * 1. 助手六态是唯一真源，由主进程状态机持有，其余模块只订阅。
 * 2. 所有外部网络调用（实时语音 WebSocket、视觉 HTTP、MCP 子进程）都在主进程，
 *    渲染进程永不接触 API Key。
 * 3. 球体只能通过 window.liquidOrb 的 4 个方法控制，不得注入样式或 DOM。
 */

/** 助手六态（与 Orb 源码 orbStateNames 一一对应，全小写） */
export const ASSISTANT_STATES = [
  "idle",
  "listening",
  "thinking",
  "executing",
  "speaking",
  "error",
] as const;

export type AssistantState = (typeof ASSISTANT_STATES)[number];

/** 球体四频段音频能量（0–1） */
export interface AudioBands {
  low: number;
  mid: number;
  high: number;
  all: number;
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GpuCheckResult {
  supported: boolean;
  adapterInfo?: {
    vendor?: string;
    architecture?: string;
    device?: string;
    description?: string;
  };
  error?: string;
}

/** 聊天消息（主进程 → 聊天面板渲染） */
export interface ChatMessage {
  messageId: string;
  role: "user" | "assistant" | "system" | "tool";
  /** 正文（流式时会增量更新） */
  content: string;
  /** 思考内容（模型的 response.thinking.* 事件），可为空 */
  thinking?: string;
  timestamp: number;
  toolCall?: ToolCallView;
}

export interface ToolCallView {
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
  status: "pending" | "executing" | "success" | "failed" | "rejected";
  result?: string;
  durationMs?: number;
}

/** 实时会话连接状态（主进程 → 界面） */
export interface SessionStatus {
  connection: "disconnected" | "connecting" | "connected" | "reconnecting" | "error";
  model: string;
  /** 距离官方 30 分钟硬上限的剩余秒数 */
  remainingSeconds: number;
  /** 距离主动重建（28 分钟）的剩余秒数 */
  rebuildInSeconds: number;
  hasApiKey: boolean;
  detail?: string;
}

/** 高风险操作人工确认请求 */
export interface SecurityConfirmRequest {
  requestId: string;
  riskLevel: "medium" | "high" | "critical";
  actionType:
    | "file_write"
    | "file_delete"
    | "terminal_command"
    | "kill_process"
    | "desktop_control"
    | "config_change";
  title: string;
  target: string;
  explanation: string;
}

export interface SecurityConfirmResponse {
  requestId: string;
  approved: boolean;
}

/** 屏幕视觉结果 */
export interface VisionResult {
  success: boolean;
  /** 供界面展示缩略图（data URL） */
  previewDataUrl?: string;
  analysisText: string;
  errorMessage?: string;
  /** 视觉模型给出的可执行定位（图像像素空间，T07 第 3 节） */
  target?: { x: number; y: number; label?: string; confidence?: number };
  /** 截图对应的屏幕物理区域（坐标换算依据） */
  region?: { x: number; y: number; width: number; height: number };
  /** 截图自身像素尺寸 */
  imageSize?: { width: number; height: number };
}

/** 运行时可调配置（保存在 userData/config.json） */
export interface JarvisConfig {
  /** 配置结构版本，用于一次性迁移旧配置（当前为 2：全自动执行模式） */
  configVersion?: number;
  apiKey: string;
  realtimeModel: string;
  realtimeBaseUrl: string;
  voice: string;
  instructions: string;
  visionModel: string;
  visionBaseUrl: string;
  /** 自定义视觉 API Key（可选，为空则默认沿用主 apiKey） */
  visionApiKey?: string;
  /** MCP 允许访问的目录白名单（空数组视为未配置，将拒绝启动 MCP） */
  allowedDirectories: string[];
  /** 是否启用 MCP 工具执行 */
  mcpEnabled: boolean;
  /** 高风险操作是否必须人工确认 */
  confirmHighRisk: boolean;
  /** 鼠标操作前的高亮预览延时（毫秒，T07 第 6 节） */
  previewDelayMs: number;
  /** 是否允许助手代填密码/验证码等敏感输入（默认 false，T07 第 5 节） */
  allowSensitiveInput: boolean;
  /** 全局急停快捷键（Electron accelerator，T07 第 6 节） */
  emergencyStopAccelerator: string;
}

/* ------------------------------------------------------------------ */
/* IPC 通道名                                                          */
/* ------------------------------------------------------------------ */

export const IPC = {
  // —— 球体：渲染进程 → 主进程的探测与事件 ——
  ORB_ON_READY: "orb:on-ready",
  ORB_ON_ERROR: "orb:on-error",
  ORB_GET_STATE: "orb:get-state",
  ORB_SET_STATE: "orb:set-state",
  ORB_SET_AUDIO_BANDS: "orb:set-audio-bands",

  // —— 窗口交互 ——
  WINDOW_SET_IGNORE_MOUSE: "window:set-ignore-mouse",
  WINDOW_START_DRAG: "window:start-drag",
  WINDOW_STOP_DRAG: "window:stop-drag",
  WINDOW_TOGGLE_PANEL: "window:toggle-panel",
  WINDOW_QUIT: "window:quit",

  // —— 音频（渲染进程采集/播放 ↔ 主进程转发）——
  AUDIO_CAPTURE_START: "audio:capture-start",
  AUDIO_CAPTURE_STOP: "audio:capture-stop",
  AUDIO_CHUNK_UP: "audio:chunk-up", // 渲染 → 主：麦克风 PCM16 base64
  AUDIO_CHUNK_DOWN: "audio:chunk-down", // 主 → 渲染：模型音频 PCM16 base64
  AUDIO_FLUSH: "audio:flush", // 主 → 渲染：立即清空播放缓冲（打断）
  AUDIO_BANDS: "audio:bands", // 渲染 → 主：算好的四频段
  AUDIO_STATE: "audio:state", // 主 → 渲染：采集/播放开关

  // —— 会话 ——
  SESSION_STATUS: "session:status",
  SESSION_RECONNECT: "session:reconnect",
  SESSION_START: "session:start",
  SESSION_STOP: "session:stop",

  // —— 状态机广播 ——
  STATE_CHANGED: "state:changed",

  // —— 聊天 ——
  CHAT_SEND_TEXT: "chat:send-text",
  CHAT_MESSAGE: "chat:message",
  CHAT_INTERRUPT: "chat:interrupt",

  // —— 工具（MCP）——
  TOOL_CONFIRM_REQUEST: "tool:confirm-request",
  TOOL_CONFIRM_RESPONSE: "tool:confirm-response",
  TOOL_LIST: "tool:list",

  // —— 视觉 ——
  VISION_CAPTURE: "vision:capture",

  // —— 配置 ——
  CONFIG_GET: "config:get",
  CONFIG_SET: "config:set",

  // —— WebGPU 自检 ——
  GPU_CHECK: "gpu:check",
} as const;
