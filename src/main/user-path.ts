/**
 * 运行目录解析（惰性 electron 获取）。
 *
 * 为什么不用顶层 `import { app } from "electron"`：
 * 回归测试（scripts/verify-tasks.mjs）在纯 Node 下 require dist 产物，
 * 顶层 import 会在模块加载时直接执行 require("electron")，
 * 在无 Electron 运行时的环境里抛错并连带整条 require 链失败。
 * 这里改为惰性 + 容错：Electron 运行时返回真实 userData，纯 Node 回退 cwd。
 */
export function userDataDir(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require("electron");
    const app = electron?.app ?? (electron?.default && electron.default.app);
    if (app && typeof app.getPath === "function") {
      return app.getPath("userData") || process.cwd();
    }
  } catch {
    /* 纯 Node 环境（回归测试） */
  }
  return process.cwd();
}
