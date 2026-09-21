import { contextBridge, ipcRenderer } from "electron";

/**
 * preload：向渲染进程暴露受限 API。
 *
 * 安全原则：
 * - 渲染进程**永远拿不到 API Key**（所有外部调用都在主进程）
 * - 只暴露白名单方法，不透传 ipcRenderer 本体
 * - 球体页面与聊天面板共用本 preload，但按窗口类型分流
 */

type Listener = (...args: any[]) => void;

function on(channel: string, cb: Listener): () => void {
  const wrapped = (_e: unknown, ...args: any[]) => cb(...args);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const invoke = (channel: string, payload?: unknown) => ipcRenderer.invoke(channel, payload);
const send = (channel: string, payload?: unknown) => ipcRenderer.send(channel, payload);

/** 球体页面用的桥：就绪上报、错误上报、鼠标穿透、拖拽 */
const orbBridge = {
  onOrbReady: (state: string) => send("orb:on-ready", state),
  onOrbError: (msg: string) => send("orb:on-error", msg),
  setIgnoreMouseEvents: (ignore: boolean) => send("window:set-ignore-mouse", ignore),
  startDrag: (screenX: number, screenY: number) => send("window:start-drag", { screenX, screenY }),
  stopDrag: () => send("window:stop-drag", {}),
  quit: () => send("window:quit", {}),
};

/** 聊天面板用的 API */
const panelApi = {
  // 球体
  orbGetState: () => invoke("orb:get-state"),
  orbSetState: (state: string) => invoke("orb:set-state", state),
  orbSetAudioBands: (bands?: unknown) => invoke("orb:set-audio-bands", bands),

  // 会话
  sessionStart: () => invoke("session:start"),
  sessionStop: () => invoke("session:stop"),
  sessionReconnect: () => invoke("session:reconnect"),
  onSessionStatus: (cb: Listener) => on("session:status", cb),

  // 状态机
  onStateChanged: (cb: Listener) => on("state:changed", cb),

  // 聊天
  sendText: (text: string) => invoke("chat:send-text", text),
  interrupt: () => invoke("chat:interrupt"),
  onMessage: (cb: Listener) => on("chat:message", cb),

  // 音频（渲染进程负责 Web Audio 采集与播放）
  startCapture: () => invoke("audio:capture-start"),
  stopCapture: () => invoke("audio:capture-stop"),
  sendAudioChunkUp: (pcmBase64: string) => send("audio:chunk-up", pcmBase64),
  sendAudioBands: (bands: unknown) => send("audio:bands", bands),
  onAudioChunkDown: (cb: Listener) => on("audio:chunk-down", cb),
  onAudioFlush: (cb: Listener) => on("audio:flush", cb),
  onAudioState: (cb: Listener) => on("audio:state", cb),

  // 工具确认
  onConfirmRequest: (cb: Listener) => on("tool:confirm-request", cb),
  respondConfirm: (res: unknown) => send("tool:confirm-response", res),
  onToolList: (cb: Listener) => on("tool:list", cb),

  // 视觉
  visionCapture: (payload: unknown) => invoke("vision:capture", payload),

  // 配置
  getConfig: () => invoke("config:get"),
  setConfig: (patch: unknown) => invoke("config:set", patch),

  // 其他
  togglePanel: () => invoke("window:toggle-panel"),
  gpuCheck: () => invoke("gpu:check"),
  quit: () => send("window:quit", {}),
};

contextBridge.exposeInMainWorld("electronBridge", orbBridge);
contextBridge.exposeInMainWorld("jarvis", panelApi);

export type JarvisApi = typeof panelApi;
export type OrbBridge = typeof orbBridge;
