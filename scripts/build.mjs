import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

/**
 * 用 process.execPath 而不是裸 "node"：
 * Windows 上 Node 常常不在 PATH 里（本机就是这种情况），
 * 用裸命令会导致 `npm run build` 直接失败。这里用当前解释器的绝对路径，规避环境差异。
 */
function run(label, script, args = []) {
  console.log(`\n[Build] ${label}`);
  execFileSync(process.execPath, [script, ...args], { cwd: root, stdio: "inherit" });
}

// 1) 生成 Orb 自包含导出页（含 6 态扩展 + 宿主桥接脚本）
run("1/4 生成 Orb 球体页面...", "scripts/generate-orb.mjs");

// 2) TypeScript 编译（主进程 + preload + 公共类型）
console.log("\n[Build] 2/4 编译 TypeScript...");
const tscJs = resolve(root, "node_modules/typescript/bin/tsc");
if (!existsSync(tscJs)) {
  console.error("  ✗ 未找到 typescript，请先执行 npm install");
  process.exit(1);
}
execFileSync(process.execPath, [tscJs, "-p", "tsconfig.json"], { cwd: root, stdio: "inherit" });

// 3) 拷贝渲染资源到 dist
console.log("\n[Build] 3/4 拷贝渲染资源...");
const srcRenderer = resolve(root, "src/renderer");
const distRenderer = resolve(root, "dist/renderer");
if (existsSync(distRenderer)) rmSync(distRenderer, { recursive: true, force: true });
mkdirSync(distRenderer, { recursive: true });
cpSync(srcRenderer, distRenderer, { recursive: true });
console.log(`      已拷贝到 ${distRenderer}`);

// 4) 校验产物完整性（避免"构建成功但运行白屏"）
console.log("\n[Build] 4/4 校验产物...");
const must = [
  "dist/main/index.js",
  "dist/main/protocol.js",
  "dist/preload/index.js",
  "dist/renderer/orb.html",
  "dist/renderer/panel.html",
];
const missing = must.filter((m) => !existsSync(resolve(root, m)));
if (missing.length) {
  console.error("  ✗ 缺少产物：\n   - " + missing.join("\n   - "));
  process.exit(1);
}
console.log("  ✓ 全部产物就位");

console.log("\n[Build] 构建完成。运行：npm start");
