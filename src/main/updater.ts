import { autoUpdater } from "electron-updater";
import { app, dialog, BrowserWindow } from "electron";
import { logger } from "./logger";
import { configManager } from "./config";

/**
 * Jarvis 自动更新。
 *
 * 依赖 electron-builder 的 `publish: github` 配置 + GitHub Releases。
 * 每次启动后静默检查新版本；发现新版自动后台下载，下载完成后弹窗询问是否重启安装。
 *
 * 注意：本应用仓库为私有（private），electron-updater 访问 GitHub Release 需要 token，
 * 优先级：环境变量 GH_TOKEN / GITHUB_TOKEN > config.json 的 `githubToken` 字段。
 * 未提供 token 时，更新检查会失败，我们仅记录日志、不打断用户。
 */

let panelResolver: () => BrowserWindow | null = () => null;

function resolveToken(): string {
  const envToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  if (envToken) return envToken;
  const cfg = configManager.get() as Record<string, unknown>;
  const cfgToken = (cfg.githubToken as string) || "";
  return cfgToken;
}

/** 通知用户「有新版本，且已下载完成」 */
function notifyDownloaded(info: { version: string }): void {
  const win = panelResolver();
  const opts = {
    type: "info" as const,
    title: "发现新版本",
    message: `Jarvis v${info.version} 已下载完成`,
    detail: "重启应用即可完成更新。是否现在重启？",
    buttons: ["立即重启", "稍后再说"],
    defaultId: 0,
    cancelId: 1,
  };
  if (win && !win.isDestroyed()) {
    void dialog.showMessageBox(win, opts).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall();
    });
  } else {
    void dialog.showMessageBox(opts).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall();
    });
  }
}

/** 设置获取聊天面板窗口的闭包（用于把更新弹窗绑定到主窗口） */
export function setUpdaterPanelResolver(fn: () => BrowserWindow | null): void {
  panelResolver = fn;
}

/** 初始化自动更新：只应在主进程 ready 后调用一次 */
export function initAutoUpdater(): void {
  // 开发模式下不做更新检查
  if (!app.isPackaged) {
    logger.info("[Updater] 开发模式，跳过自动更新检查");
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = logger as unknown as typeof autoUpdater["logger"];

  const token = resolveToken();
  if (token) {
    autoUpdater.setFeedURL({
      provider: "github",
      owner: "1535273240sch-droid",
      repo: "Jarvis-Desktop-Assistant",
      private: true,
      token,
    } as never);
  }

  autoUpdater.on("checking-for-update", () => logger.info("[Updater] 正在检查更新..."));
  autoUpdater.on("update-available", (info) => {
    logger.info(`[Updater] 发现新版本 v${info.version}`);
  });
  autoUpdater.on("update-not-available", (info) => {
    logger.info(`[Updater] 当前已是最新版本 v${info.version}`);
  });
  autoUpdater.on("error", (err) => {
    // 私有仓库无 token 时这里会报 404/401，仅记录，不打扰用户
    logger.warn(`[Updater] 更新检查失败: ${(err as Error).message}`);
  });
  autoUpdater.on("download-progress", (p) => {
    logger.info(
      `[Updater] 下载进度 ${Math.round(p.percent)}% (${(p.transferred / 1048576).toFixed(1)}/${(p.total / 1048576).toFixed(1)} MB)`
    );
  });
  autoUpdater.on("update-downloaded", (info) => {
    logger.info(`[Updater] 新版本 v${info.version} 已下载，等待重启安装`);
    notifyDownloaded(info);
  });

  // 启动后稍作延迟再检查，避免占用启动资源
  setTimeout(() => {
    void autoUpdater.checkForUpdates().catch((e) => {
      logger.warn(`[Updater] checkForUpdates 异常: ${(e as Error).message}`);
    });
  }, 8_000);
}
