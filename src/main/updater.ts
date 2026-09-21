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
 * 仓库为公开（public）时，访问 GitHub Releases 无需 token；
 * 若仓库改回私有，可设置环境变量 GH_TOKEN / GITHUB_TOKEN，或在本地 config.json 增加 `githubToken` 字段。
 * 未提供 token 时仅记录日志，不打断用户。
 */

let panelResolver: () => BrowserWindow | null = () => null;

function resolveToken(): string {
  const envToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  if (envToken) return envToken;
  const cfg = configManager.get() as unknown as { githubToken?: string };
  return cfg.githubToken || "";
}

/** 通知用户「有新版本，已下载完成」 */
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

/** 设置获取主窗口的闭包（用于把更新弹窗绑定到主窗口） */
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
  autoUpdater.logger = logger as unknown as (typeof autoUpdater)["logger"];

  const token = resolveToken();
  autoUpdater.setFeedURL({
    provider: "github",
    owner: "1535273240sch-droid",
    repo: "Jarvis-Desktop-Assistant",
    private: token.length > 0,
    token: token.length > 0 ? token : undefined,
  } as unknown as Parameters<typeof autoUpdater.setFeedURL>[0]);

  autoUpdater.on("checking-for-update", () => logger.info("[Updater] 正在检查更新..."));
  autoUpdater.on("update-available", (info) => {
    logger.info(`[Updater] 发现新版本 v${info.version}`);
  });
  autoUpdater.on("update-not-available", (info) => {
    logger.info(`[Updater] 当前已是最新版本 v${info.version}`);
  });
  autoUpdater.on("error", (err) => {
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