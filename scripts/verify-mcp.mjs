/**
 * MCP 连通性独立验证：
 *  在配置了白名单目录的前提下，真实拉起 desktop-commander 子进程，
 *  完成 initialize 握手、tools/list 发现、并实际调用一次 list_directory。
 * 这是对 mcp.ts 协议实现的端到端验证（不依赖 Electron）。
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

const require = createRequire(import.meta.url);
const entry = require.resolve("@wonderwhy-er/desktop-commander/dist/index.js");

const workDir = path.join(os.tmpdir(), "jarvis-mcp-probe");
if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });
fs.writeFileSync(path.join(workDir, "hello.txt"), "jarvis mcp probe\n", "utf-8");

console.log("MCP entry:", entry);
console.log("白名单目录:", workDir);

const proc = spawn(process.execPath, [entry], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env },
});

let buf = "";
const pending = new Map();
let id = 1;

proc.stdout.on("data", (c) => {
  buf += c.toString();
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (typeof m.id === "number" && pending.has(m.id)) {
      const { resolve, timer } = pending.get(m.id);
      clearTimeout(timer);
      pending.delete(m.id);
      resolve(m);
    }
  }
});
proc.stderr.on("data", (c) => {
  const s = c.toString().trim();
  if (s) console.log("[stderr]", s.slice(0, 200));
});

function rpc(method, params, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const myId = id++;
    const timer = setTimeout(() => {
      pending.delete(myId);
      resolve({ error: { message: `${method} 超时` } });
    }, timeoutMs);
    pending.set(myId, { resolve, timer });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
  });
}
function notify(method, params) {
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

let pass = 0, fail = 0;
const check = (ok, label, extra = "") => {
  if (ok) { pass++; console.log(`  ✓ ${label}${extra ? " | " + extra : ""}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? " | " + extra : ""}`); }
};

console.log("\n=== 1. initialize 握手 ===");
const init = await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "jarvis-probe", version: "1.0.0" },
});
check(!init.error, "initialize 成功", init.error ? init.error.message : `server=${init.result?.serverInfo?.name} v${init.result?.serverInfo?.version}`);
notify("notifications/initialized", {});

console.log("\n=== 2. tools/list 工具发现 ===");
const list = await rpc("tools/list", {});
const tools = list.result?.tools || [];
check(tools.length > 0, "发现工具", `${tools.length} 个`);

// 与 mcp.ts 的 EXPOSED_TOOLS 白名单对齐，验证裁剪后仍有可用工具
const EXPOSED = new Set([
  "start_process", "interact_with_process", "read_process_output", "list_processes",
  "read_file", "write_file", "list_directory", "create_directory", "move_file",
  "get_file_info", "edit_block", "start_search",
]);
const exposed = tools.filter((t) => EXPOSED.has(t.name));
check(exposed.length > 0, "暴露给模型的工具（白名单裁剪后）", `${exposed.length} 个: ${exposed.map((t) => t.name).join(", ")}`);

console.log("\n=== 3. tools/call 实际调用 list_directory ===");
const call = await rpc("tools/call", { name: "list_directory", arguments: { path: workDir } }, 45000);
if (call.error) {
  check(false, "list_directory 调用", call.error.message);
} else {
  const text = Array.isArray(call.result?.content)
    ? call.result.content.map((c) => c.text || "").join("\n")
    : JSON.stringify(call.result);
  check(!call.result?.isError && text.includes("hello.txt"), "list_directory 返回内容正确", text.replace(/\s+/g, " ").slice(0, 120));
}

console.log("\n=== 4. tools/call 读取文件内容 ===");
const rd = await rpc("tools/call", { name: "read_file", arguments: { path: path.join(workDir, "hello.txt") } }, 45000);
if (rd.error) {
  check(false, "read_file 调用", rd.error.message);
} else {
  const text = Array.isArray(rd.result?.content) ? rd.result.content.map((c) => c.text || "").join("\n") : "";
  check(text.includes("jarvis mcp probe"), "read_file 内容正确", text.trim().slice(0, 80));
}

console.log(`\n=== MCP 验证结果：通过 ${pass}，失败 ${fail} ===`);
proc.kill();
setTimeout(() => process.exit(fail === 0 ? 0 : 1), 300);
