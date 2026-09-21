import { ipcMain, BrowserWindow, shell } from "electron";
import { logger } from "./logger";
import { configManager } from "./config";
import { safetyManager } from "./safety";
import { orbController } from "./orb-control";
import { orchestrator } from "./orchestrator";
import { realtimeClient } from "./realtime";
import { mcpClient } from "./mcp";
import { visionManager } from "./vision";
import { sessionStore } from "./session-store";
import { stateMachine } from "./state";
import { IPC } from "../common/types";
import type { JarvisConfig } from "../common/types";

/**
 * IPC 中枢：把渲染进程的请求路由到各主进程模块。
 * 渲染进程只发意图，不接触 API Key、不直接联网。
 */

interface Deps {
  getOrbWindow: () => BrowserWindow | null;
  getPanelWindow: () => BrowserWindow | null;
  togglePanel: (show?: boolean) => void;
  quit: () => void;
}

export function registerIpcHandlers(deps: Deps): void {
  /* ---------------- 球体窗口事件 ---------------- */

  ipcMain.on(IPC.ORB_ON_READY, (_e, state: string) => {
    logger.info(`[IPC] 球体已就绪，初始状态：${state}`);
    orbController.markReady();
  });

  ipcMain.on(IPC.ORB_ON_ERROR, (_e, msg: string) => {
    logger.error(`[IPC] 球体渲染器报错：${msg}`);
    stateMachine.transition("error", `渲染错误：${msg}`);
    const p = deps.getPanelWindow();
    if (p && !p.isDestroyed()) {
      p.webContents.send(IPC.CHAT_MESSAGE, {
        systemNotice: `⚠️ 球体渲染异常：${msg}\n（若为 WebGPU 相关，请检查显卡驱动）`,
      });
    }
  });

  /* ---------------- 球体控制 ---------------- */

  ipcMain.handle(IPC.ORB_GET_STATE, async () => {
    const win = deps.getOrbWindow();
    if (!win) return null;
    orbController.attachTarget(win);
    return orbController.getState();
  });

  ipcMain.handle(IPC.ORB_SET_STATE, async (_e, state: string) => {
    const win = deps.getOrbWindow();
    if (!win) throw new Error("球体窗口不可用");
    orbController.attachTarget(win);
    return orbController.setState(state as any);
  });

  ipcMain.handle(IPC.ORB_SET_AUDIO_BANDS, async (_e, bands?: unknown) => {
    const win = deps.getOrbWindow();
    if (!win) return false;
    orbController.attachTarget(win);
    return orbController.setAudioBands(bands as any);
  });

  /* ---------------- 窗口交互 ---------------- */

  ipcMain.on(IPC.WINDOW_SET_IGNORE_MOUSE, (_e, ignore: boolean) => {
    const win = deps.getOrbWindow();
    if (!win || win.isDestroyed()) return;
    if (ignore) win.setIgnoreMouseEvents(true, { forward: true });
    else win.setIgnoreMouseEvents(false);
  });

  let dragging = false;
  let dragOffset = { x: 0, y: 0 };
  ipcMain.on(IPC.WINDOW_START_DRAG, (_e, data: { screenX: number; screenY: number }) => {
    const win = deps.getOrbWindow();
    if (!win || win.isDestroyed()) return;
    dragging = true;
    const [wx, wy] = win.getPosition();
    dragOffset = { x: data.screenX - wx, y: data.screenY - wy };
    const follow = () => {
      if (!dragging) return;
      const w = deps.getOrbWindow();
      if (!w || w.isDestroyed()) return;
      const { screen } = require("electron");
      const pt = screen.getCursorScreenPoint();
      w.setPosition(pt.x - dragOffset.x, pt.y - dragOffset.y);
      setTimeout(follow, 16);
    };
    follow();
  });

  ipcMain.on(IPC.WINDOW_STOP_DRAG, () => {
    dragging = false;
    const win = deps.getOrbWindow();
    if (win && !win.isDestroyed()) {
      const [x, y] = win.getPosition();
      const { windowStore } = require("./store");
      windowStore.save({ x, y, width: win.getBounds().width, height: win.getBounds().height });
    }
  });

  ipcMain.handle(IPC.WINDOW_TOGGLE_PANEL, (_e, show?: boolean) => {
    deps.togglePanel(show);
    const p = deps.getPanelWindow();
    return Boolean(p && p.isVisible());
  });

  ipcMain.on(IPC.WINDOW_QUIT, () => deps.quit());

  /* ---------------- 会话 ---------------- */

  ipcMain.handle(IPC.SESSION_START, async () => {
    const r = await orchestrator.startSession();
    return r;
  });

  ipcMain.handle(IPC.SESSION_STOP, async () => {
    orchestrator.stopSession();
    return { ok: true };
  });

  ipcMain.handle(IPC.SESSION_RECONNECT, async () => {
    await realtimeClient.rebuildSession();
    return { ok: true };
  });

  /* ---------------- 音频（主进程只做转发与状态机联动） ---------------- */

  ipcMain.on(IPC.AUDIO_CHUNK_UP, (_e, pcmBase64: string) => {
    realtimeClient.appendAudio(pcmBase64);
  });

  ipcMain.on(IPC.AUDIO_BANDS, (_e, bands: { low: number; mid: number; high: number; all: number }) => {
    orchestrator.feedAudioBands(bands);
  });

  ipcMain.handle(IPC.AUDIO_CAPTURE_START, async () => {
    const p = deps.getPanelWindow();
    if (p && !p.isDestroyed()) p.webContents.send(IPC.AUDIO_STATE, { capturing: true });
    return { ok: true };
  });

  ipcMain.handle(IPC.AUDIO_CAPTURE_STOP, async () => {
    const p = deps.getPanelWindow();
    if (p && !p.isDestroyed()) p.webContents.send(IPC.AUDIO_STATE, { capturing: false });
    return { ok: true };
  });

  /** 渲染进程播放结束 -> 回 idle */
  ipcMain.on("audio:playback-finished", () => {
    orchestrator.onPlaybackFinished();
  });

  /* ---------------- 聊天 ---------------- */

  ipcMain.handle(IPC.CHAT_SEND_TEXT, async (_e, text: string) => {
    orchestrator.sendUserText(String(text || ""));
    return { ok: true };
  });

  ipcMain.handle(IPC.CHAT_INTERRUPT, async () => {
    orchestrator.interrupt("用户点击打断");
    return { ok: true };
  });

  /* ---------------- 视觉 ---------------- */

  ipcMain.handle(IPC.VISION_CAPTURE, async (_e, payload: { prompt?: string; target?: "entire_screen" | "active_window" } = {}) => {
    const prompt = payload.prompt || "请描述这张屏幕截图的内容，如果有报错请解释原因。";
    const target = payload.target || "active_window";
    const result = await visionManager.captureAndUnderstand(prompt, target);
    safetyManager.audit("vision_capture_manual", { target, ok: result.success });
    return result;
  });

  /* ---------------- 配置 ---------------- */

  ipcMain.handle(IPC.CONFIG_GET, async () => {
    // 只下发脱敏视图，Key 不出主进程
    const masked = configManager.getMasked();
    const cfg = configManager.get();
    return {
      ...masked,
      apiKeyMasked: cfg.apiKey ? `***${cfg.apiKey.slice(-4)}` : "",
      configPath: configManager.getConfigPath(),
      auditPath: safetyManager.getAuditPath(),
      mcp: {
        ready: mcpClient.isReady(),
        toolCount: mcpClient.getTools().length,
        tools: mcpClient.getTools().map((t) => t.name),
      },
    };
  });

  ipcMain.handle(IPC.CONFIG_SET, async (_e, patch: Partial<JarvisConfig>) => {
    const safe: Partial<JarvisConfig> = { ...patch };
    // 空字符串表示「不修改 Key」，避免误清除
    if (safe.apiKey !== undefined && !String(safe.apiKey).trim()) delete safe.apiKey;

    configManager.set(safe);
    safetyManager.audit("config_change", {
      keys: Object.keys(safe),
      // 绝不把 Key 写进审计
      apiKeyChanged: safe.apiKey !== undefined,
    });

    // 模型或 Key 变更后刷新会话状态提示
    realtimeClient.refreshStatus();
    logger.info(`[IPC] 配置已更新：${Object.keys(safe).join(", ")}`);
    return { ok: true };
  });

  /* ---------------- 其他 ---------------- */

  ipcMain.handle(IPC.GPU_CHECK, async () => {
    const win = deps.getOrbWindow();
    if (!win) return { supported: false, error: "球体窗口不可用" };
    orbController.attachTarget(win);
    return orbController.checkWebGPU();
  });

  ipcMain.handle(IPC.TOOL_LIST, async () => ({
    tools: mcpClient.getTools().map((t) => t.name),
  }));

  logger.info("[IPC] 全部通道已注册");
}
