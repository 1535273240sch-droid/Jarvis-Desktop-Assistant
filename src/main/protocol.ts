import { protocol, net } from "electron";
import * as path from "node:path";
import * as fs from "node:fs";
import { pathToFileURL } from "node:url";
import { logger } from "./logger";

/**
 * app:// 自定义协议。
 *
 * 为什么必须用它（而不是 file://）：
 *   验收标准硬性要求球体不得通过 file:// 打开；且 Electron 内 file:// 与
 *   WebGPU、透明窗的组合另有约束。自定义协议同时带来一个额外好处：
 *   页面获得安全上下文（secure context），WebGPU 的可用性更稳定。
 *
 * 路由规则（standard scheme 下 host 即第一个路径段）：
 *   app://orb/orb.html      -> <renderer>/orb.html      （球体）
 *   app://panel/panel.html  -> <renderer>/panel.html    （聊天面板）
 */

export const APP_SCHEME = "app";

/** 只允许这两个 host，避免任意路径探测 */
const ALLOWED_HOSTS = new Set(["orb", "panel"]);

export function registerAppSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
  logger.info(`[Protocol] 已注册特权协议 ${APP_SCHEME}://`);
}

function resolveRendererDir(): string {
  // 打包后：dist/main -> ../renderer
  const packed = path.join(__dirname, "..", "renderer");
  if (fs.existsSync(packed)) return packed;
  // 开发期回退到源码目录
  return path.join(process.cwd(), "src", "renderer");
}

export function setupProtocolHandler(): void {
  const rendererDir = resolveRendererDir();
  logger.info(`[Protocol] 渲染资源目录：${rendererDir}`);

  protocol.handle(APP_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      const host = url.hostname;
      let rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");

      if (!ALLOWED_HOSTS.has(host)) {
        logger.warn(`[Protocol] 拒绝未知 host：${host}`);
        return new Response("Forbidden", { status: 403 });
      }
      if (!rel) rel = host === "orb" ? "orb.html" : "panel.html";

      const filePath = path.normalize(path.join(rendererDir, rel));

      // 目录穿越防护
      if (!filePath.startsWith(rendererDir)) {
        logger.warn(`[Protocol] 拒绝越权路径：${filePath}`);
        return new Response("Forbidden", { status: 403 });
      }
      if (!fs.existsSync(filePath)) {
        logger.error(`[Protocol] 文件不存在：${filePath}`);
        return new Response("Not Found", { status: 404 });
      }

      return net.fetch(pathToFileURL(filePath).toString());
    } catch (err) {
      logger.error("[Protocol] 处理请求异常:", err);
      return new Response("Internal Server Error", { status: 500 });
    }
  });

  logger.info("[Protocol] app:// 处理器已就绪");
}
