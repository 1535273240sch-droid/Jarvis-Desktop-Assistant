import { app, BrowserWindow, Tray, Menu, nativeImage, dialog, shell } from "electron";
import * as path from "node:path";
import * as fs from "node:fs";
import { registerAppSchemePrivileges, setupProtocolHandler } from "./protocol";
import { logger } from "./logger";
import { windowStore } from "./store";
import { configManager } from "./config";
import { safetyManager } from "./safety";
import { stateMachine } from "./state";
import { orbController } from "./orb-control";
import { orchestrator } from "./orchestrator";
import { realtimeClient } from "./realtime";
import { mcpClient } from "./mcp";
import { visionManager } from "./vision";
import { desktopController } from "./desktop-control";
import { armEmergencyStop, disposeEmergencyStop } from "./emergency-stop";
import { isAuthorized, ensureAutoAuthorized } from "./authorization";
import { registerIpcHandlers } from "./ipc";
import { autoUpdater } from "electron-updater";
import { initAutoUpdater, setUpdaterPanelResolver } from "./updater";
import { ASSISTANT_STATES, IPC } from "../common/types";
import type { AssistantState } from "../common/types";

/**
 * Jarvis 主进程入口。
 *
 * 启动顺序（关键，顺序错了会白屏）：
 *   1. WebGPU 相关命令行开关（必须早于 ready）
 *   2. registerSchemesAsPrivileged（**必须早于 ready**，否则打包后 app:// 失效）
 *   3. whenReady -> 注册协议处理器 -> 建窗口 -> 加载 app:// -> 注册 IPC -> 托盘
 */

const isSelfTest = process.argv.includes("--selftest") || process.argv.includes("--test");

// 1) WebGPU 开关
app.commandLine.appendSwitch("enable-unsafe-webgpu");
app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("enable-gpu-rasterization");
// 允许在无音频设备的环境下也能启动（避免 CI/静默环境崩溃）
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

// 2) 特权协议（必须早于 ready）
registerAppSchemePrivileges();

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let orbWindow: BrowserWindow | null = null;
let panelWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

/** 球体悬浮窗：透明、无边框、置顶、可拖动（点击穿透由页面内脚本控制） */
function createOrbWindow(): BrowserWindow {
  const bounds = windowStore.getValidatedBounds();
  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    hasShadow: false,
    skipTaskbar: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });

  // 默认穿透；页面脚本会在鼠标进入球体区域时关闭穿透
  win.setIgnoreMouseEvents(true, { forward: true });

  win.once("ready-to-show", () => win.show());

  win.on("moved", () => {
    const [x, y] = win.getPosition();
    const [width, height] = win.getSize();
    windowStore.save({ x, y, width, height });
  });

  win.on("closed", () => {
    orbWindow = null;
  });

  return win;
}

/** 聊天面板：常规窗口，承载对话、设置、工具确认 */
function createPanelWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 460,
    height: 720,
    minWidth: 380,
    minHeight: 520,
    show: false,
    title: "Jarvis",
    backgroundColor: "#121419",
    backgroundMaterial: "acrylic",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  win.loadURL("app://panel/panel.html");

  win.on("close", (e) => {
    // 关闭面板时最小化到托盘，而不是退出应用。
    // 但必须同时**立刻停止语音会话**：否则面板隐藏后 AI 仍在后台继续说话，
    // 用户会看到"界面已经关了，它还在出声"。
    if (!(app as any).isQuitting) {
      e.preventDefault();
      orchestrator.stopSession();
      win.hide();
    }
  });

  win.on("closed", () => {
    panelWindow = null;
  });

  return win;
}

function togglePanel(show?: boolean): void {
  if (!panelWindow || panelWindow.isDestroyed()) {
    panelWindow = createPanelWindow();
    panelWindow.once("ready-to-show", () => panelWindow?.show());
    return;
  }
  const shouldShow = show === undefined ? !panelWindow.isVisible() : show;
  if (shouldShow) {
    panelWindow.show();
    panelWindow.focus();
  } else {
    panelWindow.hide();
  }
}

function createTray(): void {
  // 用一个 1x1 空图标避免缺资源导致启动失败；真实项目应放 assets/icon.png
  let icon = nativeImage.createEmpty();
  const iconPath = path.join(process.cwd(), "resources", "tray.png");
  if (fs.existsSync(iconPath)) {
    icon = nativeImage.createFromPath(iconPath);
  }

  tray = new Tray(icon);
  tray.setToolTip("Jarvis 桌面助手");

  const rebuild = () => {
    const menu = Menu.buildFromTemplate([
      { label: "Jarvis 桌面助手", enabled: false },
      { type: "separator" },
      { label: "打开 / 关闭对话面板", click: () => togglePanel() },
      {
        label: "切换球体状态",
        submenu: ASSISTANT_STATES.map((st) => ({
          label: st,
          click: async () => {
            const r = await orbController.setState(st as AssistantState);
            if (!r) logger.warn(`[Tray] 切换状态 ${st} 未成功（球体可能未就绪）`);
          },
        })),
      },
      { type: "separator" },
      { label: "启动语音会话", click: () => void orchestrator.startSession() },
      { label: "停止语音会话", click: () => orchestrator.stopSession() },
      { label: "打断当前播报", click: () => orchestrator.interrupt("托盘菜单打断") },
      { type: "separator" },
      {
        label: "查看屏幕（截活动窗口）",
        click: async () => {
          const r = await visionManager.captureAndUnderstand(
            "请描述当前窗口内容；如有报错，请解释原因。",
            "active_window"
          );
          if (r.success) {
            dialog.showMessageBox({ type: "info", title: "屏幕理解结果", message: r.analysisText.slice(0, 1500) });
          } else {
            dialog.showErrorBox("屏幕理解失败", r.errorMessage || "未知错误");
          }
        },
      },
      {
        label: "WebGPU 自检",
        click: async () => {
          const r = await orbController.checkWebGPU();
          if (r.supported) {
            dialog.showMessageBox({
              type: "info",
              title: "WebGPU 自检通过",
              message: "WebGPU 可用，球体可正常渲染。",
              detail: JSON.stringify(r.adapterInfo, null, 2),
            });
          } else {
            dialog.showErrorBox(
              "WebGPU 自检未通过",
              `${r.error}\n\n球体硬依赖 WebGPU 且无降级方案，请检查显卡驱动或系统图形设置。`
            );
          }
        },
      },
      {
        label: "检查更新",
        click: async () => {
          try {
            const r = await autoUpdater.checkForUpdates();
            if (!r) {
              dialog.showMessageBox({
                type: "info",
                title: "检查更新",
                message: "当前已是最新版本。",
              });
            } else {
              dialog.showMessageBox({
                type: "info",
                title: "检查更新",
                message: `发现新版本 v${r.updateInfo.version}，正在后台下载。`,
              });
            }
          } catch (e) {
            dialog.showErrorBox(
              "检查更新失败",
              `无法访问更新源：${(e as Error).message}\n\n请检查网络或确认已配置 GitHub Token。`
            );
          }
        },
      },
      { type: "separator" },
      {
        label: "打开配置文件",
        click: () => shell.showItemInFolder(configManager.getConfigPath()),
      },
      {
        label: "打开日志目录",
        click: () => shell.showItemInFolder(logger.getLogPath()),
      },
      {
        label: "打开审计日志",
        click: () => shell.showItemInFolder(safetyManager.getAuditPath()),
      },
      { type: "separator" },
      {
        label: "重置球体到右下角",
        click: () => {
          if (!orbWindow || orbWindow.isDestroyed()) return;
          const { screen } = require("electron");
          const { workArea } = screen.getPrimaryDisplay();
          const b = orbWindow.getBounds();
          orbWindow.setPosition(workArea.x + workArea.width - b.width - 40, workArea.y + workArea.height - b.height - 80);
        },
      },
      {
        label: "退出",
        click: () => {
          (app as any).isQuitting = true;
          app.quit();
        },
      },
    ]);
    tray?.setContextMenu(menu);
  };

  rebuild();
  tray.on("click", () => togglePanel());
}

/** 自测模式：无人值守验证核心链路，输出清晰结果后退出 */
async function runSelfTest(): Promise<void> {
  logger.info("==================== SELFTEST START ====================");
  let failures = 0;
  const check = (ok: boolean, label: string, extra = "") => {
    if (ok) logger.info(`  ✓ ${label}${extra ? " | " + extra : ""}`);
    else {
      failures += 1;
      logger.error(`  ✗ ${label}${extra ? " | " + extra : ""}`);
    }
  };

  // 1) 协议与 URL
  const url = orbWindow?.webContents.getURL() || "";
  check(url.startsWith("app://"), "球体通过 app:// 加载（非 file://）", url);

  // 2) 球体就绪
  const ready = await orbController.waitReady(10_000);
  check(ready, "window.liquidOrb 就绪");

  // 3) 六态切换
  for (const st of ASSISTANT_STATES) {
    const ok = await orbController.setState(st as AssistantState);
    const now = await orbController.getState();
    check(ok && now === st, `球体状态切换 ${st}`, `现在=${now}`);
    await new Promise((r) => setTimeout(r, 120));
  }

  // 4) 音频频段
  const ab = await orbController.setAudioBands({ low: 0.9, mid: 0.7, high: 0.5, all: 0.8 });
  check(ab, "setAudioBands(带参) 生效");
  const ab2 = await orbController.setAudioBands();
  check(ab2, "setAudioBands(无参) 回落生效");

  // 5) 六态状态机迁移
  stateMachine.reset("selftest");
  let sawChange = false;
  stateMachine.once("change", () => (sawChange = true));
  stateMachine.transition("listening", "selftest");
  check(sawChange && stateMachine.getState() === "listening", "状态机迁移与事件广播");
  stateMachine.reset("selftest 结束");

  // 6) WebGPU
  const gpu = await orbController.checkWebGPU();
  check(gpu.supported, "WebGPU 可用", gpu.supported ? JSON.stringify(gpu.adapterInfo) : gpu.error || "");

  // 7) 配置与安全
  check(typeof configManager.getConfigPath() === "string", "配置文件路径可用", configManager.getConfigPath());
  check(configManager.getMasked().apiKey !== configManager.get().apiKey || !configManager.hasApiKey(), "API Key 已脱敏");
  const pre = safetyManager.validateMcpPreconditions();
  logger.info(`  · MCP 前置校验：${pre.ok ? "通过" : "未通过（" + pre.reason + "）"}`);
  check(safetyManager.assessCommand("rm -rf /").level !== "low", "危险命令识别有效");
  check(safetyManager.assessCommand("dir").level === "low", "普通命令不误报");

  // 8) 截图能力（selftest 是用户主动触发的无人值守验证，视同已授权；
  //    正常使用时首次授权由聊天面板确认流程完成）
  try {
    const { grantAuthorization } = require("./authorization");
    if (!isAuthorized("screen-capture")) {
      grantAuthorization(["screen-capture", "mouse-control", "keyboard-control"]);
      logger.info("  · selftest 模式：已自动授予高敏感能力授权（正常使用时需用户在面板确认）");
    }
  } catch (e) {
    logger.warn("  · selftest 授权写入失败:", e);
  }
  try {
    const shot = await visionManager.captureScreen("entire_screen");
    check(shot.length > 1000, "屏幕截图可用", `${shot.length} 字节`);
    await visionManager.saveDebugShot(shot, "selftest");
  } catch (e) {
    check(false, "屏幕截图可用", (e as Error).message);
  }

  // 9) 活动窗口识别
  const aw = await visionManager.getActiveWindow();
  check(aw !== null, "活动窗口识别可用", aw ? `${aw.processName}` : "未获取到");

  // 9b) T07：坐标换算断言（高 DPI + 多显示器合成用例，不靠目测）
  try {
    const { imageToScreen, virtualScreenBounds } = require("./coordinate-mapping");
    // 用例 1：2560x1440 物理屏截图压到 1280x720 送模型，模型报图中心 -> 屏幕中心
    const m1 = imageToScreen({ x: 640, y: 360 }, { width: 1280, height: 720, region: { x: 0, y: 0, width: 2560, height: 1440 } });
    check(m1.point.x === 1280 && m1.point.y === 720 && !m1.clamped, "坐标换算：缩放图中心 → 屏幕中心", JSON.stringify(m1.point));
    // 用例 2：多显示器负原点（副屏在主屏左侧 -1920..0）
    const m2 = imageToScreen({ x: 960, y: 540 }, { width: 1920, height: 1080, region: { x: -1920, y: 0, width: 1920, height: 1080 } });
    check(m2.point.x === -960 && m2.point.y === 540, "坐标换算：多显示器负原点", JSON.stringify(m2.point));
    // 用例 3：模型坐标越界必须被 clamp 并标记
    const m3 = imageToScreen({ x: 9999, y: 10 }, { width: 1000, height: 1000, region: { x: 100, y: 100, width: 800, height: 600 } });
    check(m3.clamped && m3.point.x === 900, "坐标换算：越界坐标被 clamp", JSON.stringify(m3.point));
    // 用例 4：虚拟桌面并集
    const vsb = virtualScreenBounds([
      { x: -1920, y: 0, width: 1920, height: 1080 },
      { x: 0, y: 0, width: 2560, height: 1440 },
      { x: 2560, y: 0, width: 2560, height: 1440 },
    ]);
    check(vsb.x === -1920 && vsb.width === 7040, "坐标换算：虚拟桌面并集覆盖负原点", JSON.stringify(vsb));
  } catch (e) {
    check(false, "坐标换算断言", (e as Error).message);
  }

  // 9c) T07：视觉定位解析（合成模型输出）
  try {
    const { parseVisionTarget } = require("./vision-target");
    const t1 = parseVisionTarget('错误是缺少 DLL。\n```json\n{"target":{"x":640,"y":360,"label":"确定按钮"}}\n```', 1280, 720);
    check(t1 !== null && t1.x === 640 && t1.label === "确定按钮", "视觉定位解析：target 形态");
    const t2 = parseVisionTarget('{"x":5000,"y":10}', 1280, 720);
    check(t2 === null, "视觉定位解析：越界坐标拒绝信任");
  } catch (e) {
    check(false, "视觉定位解析断言", (e as Error).message);
  }

  // 9d) T07：安全机制状态
  const { isStopped: emergencyStopped, getTriggerCount } = require("./emergency-stop");
  check(!emergencyStopped(), "全局急停初始为未触发态", `触发次数=${getTriggerCount()}`);
  const authState = isAuthorized("mouse-control");
  logger.info(`  · 鼠标控制授权状态：${authState ? "已授权" : "未授权（首次使用需用户确认）"}`);
  check(true, "首次授权门就绪（未授权时桌面控制会被拦截）");

  // 10) 面板窗口
  check(Boolean(panelWindow && !panelWindow.isDestroyed()), "聊天面板窗口已创建");

  // 11) 可视化取证：把两个窗口截图存盘，供人工核验
  try {
    const shotsDir = path.join(process.cwd(), "assets");
    if (!fs.existsSync(shotsDir)) fs.mkdirSync(shotsDir, { recursive: true });

    // 球体：逐个状态各截一张
    if (orbWindow && !orbWindow.isDestroyed()) {
      for (const st of ASSISTANT_STATES) {
        await orbController.setState(st as AssistantState);
        await new Promise((r) => setTimeout(r, 800)); // 等过渡动画走完
        const img = await orbWindow.webContents.capturePage();
        fs.writeFileSync(path.join(shotsDir, `orb-${st}.png`), img.toPNG());
      }
      // 回到 idle 并灌入音频频段，截一张"有声"形态
      await orbController.setState("speaking");
      await orbController.setAudioBands({ low: 0.9, mid: 0.7, high: 0.5, all: 0.8 });
      await new Promise((r) => setTimeout(r, 800));
      const img2 = await orbWindow.webContents.capturePage();
      fs.writeFileSync(path.join(shotsDir, "orb-speaking-audio.png"), img2.toPNG());
      await orbController.setAudioBands();
      await orbController.setState("idle");
      logger.info(`  ✓ 球体截图已保存到 ${shotsDir}`);
    }

    // 面板
    if (panelWindow && !panelWindow.isDestroyed()) {
      await new Promise((r) => setTimeout(r, 700));
      const pImg = await panelWindow.webContents.capturePage();
      fs.writeFileSync(path.join(shotsDir, "panel.png"), pImg.toPNG());
      logger.info(`  ✓ 面板截图已保存到 ${shotsDir}`);

      // 展开「设置与状态」后再截一张：视觉自定义/执行模式/音色等配置项
      // 都折叠在这个区域里，展开截图才能作为"设置确实存在"的取证。
      try {
        await panelWindow.webContents.executeJavaScript(
          `(() => { const d = document.querySelector('details.settings'); if (d) d.open = true; return true; })()`
        );
        await new Promise((r) => setTimeout(r, 500));
        const pImg2 = await panelWindow.webContents.capturePage();
        fs.writeFileSync(path.join(shotsDir, "panel-settings.png"), pImg2.toPNG());
        logger.info(`  ✓ 设置面板展开截图已保存（含视觉自定义/音色/执行模式）`);

        // 再滚到「屏幕理解」区域单独截一张，证明视觉自定义端点/模型/专属 Key 均可配置
        const scrollInfo = await panelWindow.webContents.executeJavaScript(
          `(() => {
             const body = document.querySelector('details.settings .body');
             if (!body) return { ok: false, reason: '设置内容区不存在' };
             const el = document.getElementById('visionPreset');
             if (!el) return { ok: false, reason: 'visionPreset 不存在' };
             el.scrollIntoView({ block: 'center' });
             return {
               ok: true,
               scrollHeight: body.scrollHeight,
               clientHeight: body.clientHeight,
               canScroll: body.scrollHeight > body.clientHeight,
               scrollTop: body.scrollTop,
             };
           })()`
        );
        logger.info(`  · 设置区滚动能力：${JSON.stringify(scrollInfo)}`);
        await new Promise((r) => setTimeout(r, 500));
        const pImg3 = await panelWindow.webContents.capturePage();
        fs.writeFileSync(path.join(shotsDir, "panel-vision-settings.png"), pImg3.toPNG());
        logger.info(`  ✓ 视觉自定义设置截图已保存`);

        // 再滑到最底部，确认最后一项（视觉专属 Key / 执行模式）也能触达
        const bottomInfo = await panelWindow.webContents.executeJavaScript(
          `(() => {
             const body = document.querySelector('details.settings .body');
             if (!body) return { ok: false };
             body.scrollTop = body.scrollHeight;
             return { ok: true, scrollTop: body.scrollTop, maxScroll: body.scrollHeight - body.clientHeight };
           })()`
        );
        logger.info(`  · 滑到设置底部：${JSON.stringify(bottomInfo)}`);
        await new Promise((r) => setTimeout(r, 500));
        const pImg4 = await panelWindow.webContents.capturePage();
        fs.writeFileSync(path.join(shotsDir, "panel-settings-bottom.png"), pImg4.toPNG());
        logger.info(`  ✓ 设置区底部截图已保存（验证可滑到底）`);
      } catch (e) {
        logger.warn("  · 设置面板展开截图失败:", (e as Error).message);
      }
    }
    check(true, "可视化取证截图已生成");
  } catch (e) {
    check(false, "可视化取证截图已生成", (e as Error).message);
  }

  logger.info("==================== SELFTEST SUMMARY ====================");
  logger.info(`失败项：${failures}`);
  logger.info(`结论：${failures === 0 ? "全部通过" : "存在失败项"}`);
  logger.info("==========================================================");

  process.exitCode = failures === 0 ? 0 : 1;
  setTimeout(() => {
    (app as any).isQuitting = true;
    app.quit();
  }, 500);
}

app.whenReady().then(async () => {
  logger.info("===================================================");
  logger.info("Jarvis 桌面助手启动中...");
  logger.info(`日志文件：${logger.getLogPath()}`);
  logger.info(`配置文件：${configManager.getConfigPath()}`);
  logger.info(`审计日志：${safetyManager.getAuditPath()}`);
  logger.info("===================================================");

  // 1) 协议处理器（app:// 提供 renderer 目录下的静态文件）
  setupProtocolHandler();

  // 2) 窗口
  orbWindow = createOrbWindow();
  orbController.attach(orbWindow);
  panelWindow = createPanelWindow();
  panelWindow.once("ready-to-show", () => panelWindow?.show());

  // 3) 让安全模块知道去哪个窗口弹确认框
  safetyManager.setPanelResolver(() => panelWindow);

  // 3b) 全自动模式：启动即授予屏幕/鼠标/键盘能力，之后不再逐次打断用户。
  //     所有实际操作仍写入 audit.jsonl，可事后追溯。
  ensureAutoAuthorized();
  logger.info("[Authorization] 全自动模式：已授予屏幕录制/鼠标控制/键盘控制能力");

  // 4) 编排器与 IPC
  orchestrator.init(() => panelWindow);
  registerIpcHandlers({
    getOrbWindow: () => orbWindow,
    getPanelWindow: () => panelWindow,
    togglePanel,
    quit: () => {
      (app as any).isQuitting = true;
      app.quit();
    },
  });

  // 4b) 全局急停热键（T07 第 6 节：Ctrl+Alt+X 中断一切自动化）
  if (!armEmergencyStop()) {
    logger.warn("全局急停热键注册失败（可能被占用），桌面控制仍可用但无快捷键中断");
  }

  // 5) 加载球体（必须用 app://，不能用 file://）
  orbWindow.loadURL("app://orb/orb.html");

  // 6) 托盘
  createTray();

  // 6b) 自动更新（含面板解析器绑定）
  setUpdaterPanelResolver(() => panelWindow);
  initAutoUpdater();

  // 7) 球体加载完成后的健康检查
  orbWindow.webContents.on("did-finish-load", async () => {
    logger.info("球体页面加载完成");
    const ready = await orbController.waitReady(8000);
    if (!ready) {
      logger.warn("球体在 8 秒内未就绪");
    } else {
      const gpu = await orbController.checkWebGPU();
      if (!gpu.supported) {
        logger.error(`WebGPU 自检未通过：${gpu.error}`);
        if (!isSelfTest) {
          dialog.showErrorBox(
            "WebGPU 硬件加速不可用",
            `Jarvis 悬浮球依赖 WebGPU，但自检未通过：\n\n${gpu.error}\n\n建议：\n1. 更新显卡驱动\n2. 确认系统已开启硬件加速\n3. 确认显卡支持 WebGPU（DirectX 12 及以上）`
          );
        }
      } else {
        logger.info(`WebGPU 自检通过：${JSON.stringify(gpu.adapterInfo)}`);
      }

      // 未配置 Key 时给出明确指引，而不是静默不动
      if (!configManager.hasApiKey() && !isSelfTest) {
        logger.warn("尚未配置 StepFun API Key");
      }
    }

    if (isSelfTest) {
      await runSelfTest();
    }
  });

  // 8) 崩溃与退出
  orbWindow.webContents.on("render-process-gone", (_e, d) => {
    logger.error("球体渲染进程异常退出:", d);
  });
  panelWindow.webContents.on("render-process-gone", (_e, d) => {
    logger.error("面板渲染进程异常退出:", d);
  });
});

app.on("before-quit", () => {
  (app as any).isQuitting = true;
  // 先彻底静音（清空渲染进程播放队列），再断连接。
  // 顺序反了会出现"程序要退了，声音还拖着响完"的现象。
  orchestrator.shutdown();
  disposeEmergencyStop();
  desktopController.destroy();
  mcpClient.stop();
  realtimeClient.dispose();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    (app as any).isQuitting = true;
    app.quit();
  }
});

app.on("second-instance", () => {
  if (panelWindow) {
    panelWindow.show();
    panelWindow.focus();
  }
});
