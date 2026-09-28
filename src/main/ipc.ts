import { ipcMain, BrowserWindow, shell } from "electron";
import { logger } from "./logger";
import { configManager } from "./config";
import { safetyManager } from "./safety";
import { orbController } from "./orb-control";
import { orbSizeManager } from "./orb-size";
import { orchestrator } from "./orchestrator";
import { realtimeClient } from "./realtime";
import { mcpClient } from "./mcp";
import { visionManager } from "./vision";
import { sessionStore } from "./session-store";
import { stateMachine } from "./state";
import { memoryStore } from "./memory";
import { externalMcp } from "./mcp-external";
import { MCP_PRESETS } from "./mcp-presets";
import { isStopped, reset as resetEmergencyStop, trigger as triggerEmergencyStop, getStatus as emergencyStatus } from "./emergency-stop";
import { taskRunner } from "./task-runner";
import { taskArtifacts } from "./task-artifacts";
import { getProfiles, saveProfiles } from "./app-profiles";
import { getAuthzState, grantAuthorization, revokeAuthorization } from "./authorization";
import type { Capability } from "./authorization";
import { wmcpInstaller } from "./wmcp-installer";
import { IPC } from "../common/types";
import type { JarvisConfig, AppProfile, TaskKind } from "../common/types";

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

  // 球体渲染失败后的宿主侧兜底恢复。
  //
  // 渲染器内部先做约 15s 的快速重试；仍失败才来到这里。GPU 进程被驱动复位
  // 或系统回收后，Chromium 重启它需要一定时间（实测约 60s），期间任何页面内
  // 重建都拿不到 adapter。因此宿主重载需要比渲染器更持久：间隔 10s、最多 6 次，
  // 覆盖约 60s，既能等到 GPU 进程回来，又能避免无限重载。
  let orbRecoverAttempts = 0;
  let orbRecoverTimer: NodeJS.Timeout | null = null;
  const ORB_RECOVER_MAX = 6;
  const ORB_RECOVER_DELAY_MS = 10000;

  function scheduleOrbRecovery(reason: string): void {
    if (orbRecoverTimer) return;
    if (orbRecoverAttempts >= ORB_RECOVER_MAX) {
      logger.warn(`[IPC] 球体恢复已达上限（${ORB_RECOVER_MAX} 次），停止自动重载：${reason}`);
      return;
    }
    orbRecoverAttempts += 1;
    logger.warn(`[IPC] 将在 ${ORB_RECOVER_DELAY_MS}ms 后重载球体页面（第 ${orbRecoverAttempts} 次）：${reason}`);
    orbRecoverTimer = setTimeout(async () => {
      orbRecoverTimer = null;
      const win = deps.getOrbWindow();
      if (!win || win.isDestroyed()) {
        logger.warn("[IPC] 球体恢复失败：窗口不可用");
        return;
      }
      orbController.attachTarget(win);
      const theme = configManager.get().orbTheme || "siri";
      const ok = await orbController.reloadWithTheme(theme);
      logger.info(`[IPC] 球体恢复重载${ok ? "成功" : "失败"}`);
    }, ORB_RECOVER_DELAY_MS);
  }

  ipcMain.on(IPC.ORB_ON_READY, (_e, state: string) => {
    logger.info(`[IPC] 球体已就绪，初始状态：${state}`);
    // 渲染恢复正常，清空恢复计数与待执行的恢复定时器。
    orbRecoverAttempts = 0;
    if (orbRecoverTimer) {
      clearTimeout(orbRecoverTimer);
      orbRecoverTimer = null;
    }
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
    // 渲染器自身重建失败或 GPU 进程级故障时，由宿主重载页面兜底。
    scheduleOrbRecovery(msg);
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

  // 悬浮球尺寸：设置基准尺寸（保持球心、持久化、广播）。窗口 resizable:false，
  // 尺寸只能经此通道由代码设置，用户无法拖边框。
  ipcMain.handle(IPC.ORB_SET_SIZE, async (_e, size: number) => {
    const win = deps.getOrbWindow();
    if (!win || win.isDestroyed()) return { ok: false, size: null };
    orbSizeManager.attach(win);
    const applied = orbSizeManager.setBase(size);
    return { ok: true, size: applied };
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

    const prevOrbTheme = configManager.get().orbTheme || "siri";
    configManager.set(safe);
    safetyManager.audit("config_change", {
      keys: Object.keys(safe),
      // 绝不把 Key 写进审计
      apiKeyChanged: safe.apiKey !== undefined,
    });

    // 悬浮球尺寸 / 自适应开关：配置落盘后立即同步到窗口（保持球心）
    const orbWin = deps.getOrbWindow();
    if (orbWin && !orbWin.isDestroyed()) {
      orbSizeManager.attach(orbWin);
      if (safe.orbSize !== undefined) orbSizeManager.setBase(safe.orbSize);
      if (safe.orbAutoScale !== undefined) orbSizeManager.setAutoScale(Boolean(safe.orbAutoScale));
    }

    // 悬浮球主题变更：热重载球体页面（构建期已注入全部主题）
    if (typeof safe.orbTheme === "string" && safe.orbTheme && safe.orbTheme !== prevOrbTheme) {
      const win = deps.getOrbWindow();
      if (win && !win.isDestroyed()) {
        orbController.attachTarget(win);
        const ok = await orbController.reloadWithTheme(safe.orbTheme);
        safetyManager.audit("orb_theme_changed", { from: prevOrbTheme, to: safe.orbTheme, reloaded: ok });
        logger.info(`[IPC] 悬浮球主题：${prevOrbTheme} -> ${safe.orbTheme}（重载${ok ? "成功" : "失败，保持原画面"}）`);
      }
    }

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

  /* ---------------- 全局急停 ---------------- */

  ipcMain.handle(IPC.EMERGENCY_STOP_STATUS, async () => emergencyStatus());

  // 急停是「一次性闩锁」：触发后所有桌面操作都会抛 EMERGENCY_STOP，
  // 若没有这条恢复通路，用户只能重启应用才能重新使用鼠标键盘控制。
  ipcMain.handle(IPC.EMERGENCY_STOP_RESET, async () => {
    resetEmergencyStop();
    safetyManager.audit("emergency_stop_reset", {});
    logger.info("[IPC] 用户已解除全局急停，桌面控制恢复可用");
    const p = deps.getPanelWindow();
    if (p && !p.isDestroyed()) {
      p.webContents.send(IPC.CHAT_MESSAGE, { systemNotice: "全局急停已解除，桌面控制恢复可用。" });
    }
    return { ok: true, stopped: isStopped() };
  });

  /* ---------------- 桌面任务（跨软件长任务） ---------------- */

  ipcMain.handle(IPC.TASK_LIST, async () => ({
    tasks: taskRunner.list(),
    busy: taskRunner.isBusy(),
  }));

  ipcMain.handle(IPC.TASK_CREATE, async (_e, input: { kind: TaskKind; goal: string; params?: Record<string, unknown> }) => {
    if (!input || !input.kind) return { ok: false, reason: "缺少任务类型" };
    const t = taskRunner.createTask({
      kind: input.kind,
      goal: String(input.goal || ""),
      params: input.params || {},
      source: "panel",
    });
    return { ok: true, taskId: t.taskId };
  });

  // action: pause | resume | cancel | retry | confirm
  ipcMain.handle(IPC.TASK_ACTION, async (_e, payload: { taskId: string; action: string; requestId?: string; approve?: boolean }) => {
    const { taskId, action } = payload || ({} as any);
    if (!taskId || !action) return { ok: false, reason: "缺少 taskId/action" };
    safetyManager.audit("task_action", { taskId, action });
    switch (action) {
      case "pause":
        return taskRunner.pause(taskId);
      case "resume":
        return taskRunner.resume(taskId);
      case "cancel":
        return taskRunner.cancel(taskId);
      case "retry":
        return taskRunner.retry(taskId);
      case "confirm":
        if (!payload.requestId) return { ok: false, reason: "缺少 requestId" };
        return taskRunner.respondConfirm(taskId, payload.requestId, payload.approve === true);
      default:
        return { ok: false, reason: `未知操作 ${action}` };
    }
  });

  ipcMain.handle(IPC.TASK_RESULT_PAGE, async (_e, payload: { taskId: string; file: string; page?: number }) => {
    if (!payload?.taskId || !payload.file) return null;
    return taskArtifacts.readPage(payload.taskId, payload.file, payload.page || 1, 4000);
  });

  // 「停止所有桌面任务」：与全局急停同一闩锁（A4），按钮位于面板任务区
  ipcMain.handle(IPC.TASKS_STOP_ALL, async () => {
    triggerEmergencyStop("面板停止所有桌面任务");
    return { ok: true, ...emergencyStatus() };
  });

  /* ---------------- 目标软件档案 ---------------- */

  ipcMain.handle(IPC.APP_PROFILES_GET, async () => ({ profiles: getProfiles() }));

  ipcMain.handle(IPC.APP_PROFILES_SET, async (_e, profiles: AppProfile[]) => {
    const clean = saveProfiles(Array.isArray(profiles) ? profiles : []);
    safetyManager.audit("app_profiles_saved", { count: clean.length });
    return { ok: true, profiles: clean };
  });

  /* ---------------- 能力授权（撤回持久化） ---------------- */

  ipcMain.handle(IPC.AUTHZ_GET, async () => getAuthzState());

  ipcMain.handle(IPC.AUTHZ_GRANT, async (_e, scope: Capability[]) => {
    const caps = (Array.isArray(scope) ? scope : []).filter((c) =>
      ["screen-capture", "mouse-control", "keyboard-control", "external-send"].includes(c)
    );
    grantAuthorization(caps);
    return { ok: true, state: getAuthzState() };
  });

  ipcMain.handle(IPC.AUTHZ_REVOKE, async (_e, scope?: Capability[]) => {
    revokeAuthorization(Array.isArray(scope) && scope.length ? scope : undefined);
    return { ok: true, state: getAuthzState() };
  });

  /* ---------------- 长期记忆 ---------------- */

  ipcMain.handle(IPC.MEMORY_GET, async () => ({
    facts: memoryStore.getFacts(),
    turns: memoryStore.getTurns(20),
    path: memoryStore.getPath(),
  }));

  ipcMain.handle(IPC.MEMORY_ADD, async (_e, text: string) => {
    const t = String(text || "").trim();
    if (!t) return { ok: false, reason: "内容为空" };
    const added = memoryStore.addFact(t);
    safetyManager.audit("memory_write", { fact: t, via: "panel" });
    return { ok: true, added };
  });

  ipcMain.handle(IPC.MEMORY_REMOVE, async (_e, text: string) => {
    const removed = memoryStore.removeFact(String(text || ""));
    safetyManager.audit("memory_remove", { fact: String(text || "").slice(0, 200), removed });
    return { ok: true, removed };
  });

  ipcMain.handle(IPC.MEMORY_CLEAR, async () => {
    memoryStore.clear();
    safetyManager.audit("memory_clear", {});
    return { ok: true };
  });

  /* ---------------- 诊断：分类错误日志 ---------------- */

  ipcMain.handle(IPC.DIAG_ERRORS, async () => ({
    summary: logger.summarizeErrors(300),
    recent: logger.recentErrors(60),
    errorPath: logger.getErrorPath(),
    logDir: logger.getLogDir(),
    logPath: logger.getLogPath(),
  }));

  ipcMain.handle(IPC.DIAG_CLEAR_ERRORS, async () => {
    logger.clearErrors();
    return { ok: true };
  });

  ipcMain.handle(IPC.DIAG_OPEN_DIR, async () => {
    shell.openPath(logger.getLogDir());
    return { ok: true, dir: logger.getLogDir() };
  });

  /* ---------------- 音色 ---------------- */

  ipcMain.handle(IPC.VOICE_LIST, async () => realtimeClient.listVoices());
  ipcMain.handle(IPC.VOICE_VALIDATE, async (_e, voice: string) => realtimeClient.validateVoice(String(voice || "")));

  /* ---------------- 外部 MCP ---------------- */

  ipcMain.handle(IPC.MCP_EXT_STATUS, async () => ({
    servers: externalMcp.status(),
    // [secret-guard patch] 走脱敏视图，env/args 中的密钥不下发明文
    configured: configManager.getMasked().mcpServers || [],
    tools: externalMcp.toModelTools().map((t: any) => t.function.name),
  }));

  ipcMain.handle(IPC.MCP_EXT_LIST_PRESETS, async () => MCP_PRESETS);

  // 保存外部 MCP 配置并立即重连（用户不必重启应用）
  ipcMain.handle(IPC.MCP_EXT_RELOAD, async (_e, servers) => {
    configManager.set({ mcpServers: Array.isArray(servers) ? servers : [] });
    safetyManager.audit("mcp_ext_reload", { count: Array.isArray(servers) ? servers.length : 0 });
    const r = await externalMcp.startAll();
    // 重连后把新工具集下发给模型
    orchestrator.pushToolsNow();
    return { ok: true, ...r, status: externalMcp.status() };
  });

  // 试运行一个服务器配置（不落盘），验证能否握手并列出工具
  ipcMain.handle(IPC.MCP_EXT_TEST, async (_e, cfg) => {
    if (!cfg || !cfg.command) return { ok: false, reason: "缺少 command" };
    return externalMcp.testConfig(cfg);
  });

  // 一键安装 Windows 桌面控制（Windows-MCP）：面板按钮触发，安装后写入配置
  ipcMain.handle(IPC.MCP_EXT_INSTALL_WMCP, async () => {
    safetyManager.audit("wmcp_install_requested", {});
    const r = await wmcpInstaller.install();
    if (r.ok) {
      // 装完立即拉起外部 MCP 并把新工具集下发给模型
      const started = await externalMcp.startAll().catch(() => ({ started: 0, failed: 0 }));
      orchestrator.pushToolsNow();
      logger.info(`[IPC] Windows-MCP 安装流程完成，外部 MCP 重连：成功 ${started.started}，失败 ${started.failed}`);
    }
    return r;
  });

  logger.info("[IPC] 全部通道已注册");
}
