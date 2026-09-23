import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 免 PATH 的任务运行器。
 *
 * 为什么需要它：`npm run <script>` 由 npm 的脚本外壳执行，要求 PATH 里有 `node`。
 * 但 Windows 上 Node 常常不在 PATH（本机就是如此），于是 `npm start` 会直接失败。
 * 本脚本用 process.execPath（当前解释器绝对路径）调用各工具，绕开 PATH 依赖。
 *
 * 用法：
 *   node scripts/run.mjs build      # 构建
 *   node scripts/run.mjs start      # 构建并启动应用
 *   node scripts/run.mjs selftest   # 构建并自测
 *   node scripts/run.mjs dist       # 构建并打包安装包
 *   node scripts/run.mjs verify-mcp # MCP 协议验证
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const task = (process.argv[2] || "build").toLowerCase();

function node(scriptPath, args = [], extraEnv = {}) {
  execFileSync(process.execPath, [scriptPath, ...args], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
}

function bin(name) {
  const p = resolve(root, "node_modules", ...name.split("/"));
  if (!existsSync(p)) {
    console.error(`  ✗ 未找到 ${name}，请先执行 npm install`);
    process.exit(1);
  }
  return p;
}

function build() {
  node(resolve(root, "scripts/build.mjs"));
}

switch (task) {
  case "build":
    build();
    break;

  case "start":
    build();
    node(bin("electron/cli.js"), ["."]);
    break;

  case "selftest":
    build();
    node(bin("electron/cli.js"), [".", "--selftest"]);
    break;

  case "dist":
    build();
    node(bin("electron-builder/cli.js"), ["--win", "nsis", "--x64"]);
    break;

  case "pack":
    build();
    node(bin("electron-builder/cli.js"), ["--win", "nsis", "--dir"]);
    break;

  case "typecheck":
    node(bin("typescript/bin/tsc"), ["-p", "tsconfig.json", "--noEmit"]);
    console.log("类型检查通过（0 错误）");
    break;

  case "verify-mcp":
    node(resolve(root, "scripts/verify-mcp.mjs"));
    break;

  case "verify-tools":
    node(resolve(root, "scripts/verify-tools.mjs"));
    break;

  default:
    console.log(`未知任务：${task}`);
    console.log("可用：build | start | selftest | dist | pack | typecheck | verify-mcp | verify-tools");
    process.exit(1);
}
