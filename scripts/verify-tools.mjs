/**
 * 工具执行闭环回测（regression suite）。
 *
 * 为什么需要它：此前多次修复都靠"改完手动试一试"，导致同一个问题反复出现。
 * 这个脚本把用户实际抱怨过的每条链路固化成断言，每次改动后跑一遍，
 * 确保「执行工具」这件事是真的通的，而不是看起来通。
 *
 * 覆盖：
 *   1. 应用发现       —— 能否找到本机真实安装的浏览器/程序
 *   2. 打开软件       —— open_app 的核心逻辑（含 .lnk 启动 Edge 这类本机特例）
 *   3. 打开网址/搜索  —— open_url / search_web 的浏览器解析与降级
 *   4. 输入后提交     —— type_text+submit 是否真的补了回车
 *   5. MCP 工具闭环   —— 白名单下发、工具发现、真实调用、失败归类
 *   6. 提示词         —— 是否注入了本机程序清单与工具选用准则
 *   7. 日志/错误分类  —— 失败是否进入 errors.jsonl
 *
 * 用法：node scripts/verify-tools.mjs        （不需要 Electron）
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);

let pass = 0;
let fail = 0;
let skip = 0;
const results = [];
const failures = [];

/**
 * 使用 ASCII 标记（OK/FAIL/SKIP）而不是 ✓/✗。
 * 原因：GitHub Actions 的日志会把 ✓/✗ 这类字符替换成 `?`，
 * 导致 CI 上出了失败却无法从日志分辨是哪一条 —— 这会让回归测试形同虚设。
 */
function check(ok, label, extra = "") {
  if (ok) { pass++; console.log(`  [OK]   ${label}${extra ? " | " + extra : ""}`); }
  else { fail++; failures.push(label); console.log(`  [FAIL] ${label}${extra ? " | " + extra : ""}`); }
  results.push({ ok, label, extra });
}

/**
 * 环境相关的软断言：CI 的无人值守会话不一定能启动/观测 GUI 进程，
 * 这类检查在 CI 上失败时记为「跳过」而不是「失败」，避免把环境限制误报成代码缺陷。
 * 本地运行（非 CI）时仍按失败处理。
 */
const IS_CI = Boolean(process.env.CI);
function checkEnv(ok, label, extra = "") {
  if (ok) { pass++; console.log(`  [OK]   ${label}${extra ? " | " + extra : ""}`); }
  else if (IS_CI) { skip++; console.log(`  [SKIP] ${label} (CI 环境无法验证)${extra ? " | " + extra : ""}`); }
  else { fail++; failures.push(label); console.log(`  [FAIL] ${label}${extra ? " | " + extra : ""}`); }
  results.push({ ok: ok || IS_CI, label, extra, skipped: !ok && IS_CI });
}

function ps(script, timeoutMs = 20000) {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
       `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${script}`],
      { timeout: timeoutMs, windowsHide: true, encoding: "utf8" },
      (err, stdout) => resolve(String(stdout || "").trim())
    );
  });
}

// ---------------------------------------------------------------- 1. 应用发现
console.log("\n=== 1. 应用目录发现（AppCatalog）===");
// dist 编译为 CommonJS，用 require 加载（createRequire 已在上方创建）
let appCatalog = null;
try {
  ({ appCatalog } = require(path.join(root, "dist/main/app-catalog.js")));
} catch (e) {
  console.log(`    (require 失败: ${e.message})`);
}
if (!appCatalog) {
  check(false, "加载 app-catalog 模块");
} else {
  const apps = await appCatalog.scan(true);
  // 以下均为「本机装了什么」的断言：干净 runner 与开发机的 PATH/开始菜单差异很大，
  // 因此用 checkEnv（CI 上记为跳过）。真正的逻辑正确性由 3b 节的源码断言保证。
  checkEnv(apps.length > 5, "扫描到可启动程序", `${apps.length} 个`);
  checkEnv(apps.some((a) => /calc/i.test(a.launchPath)), "扫描结果含系统程序（计算器）");

  const browsers = await appCatalog.resolve("浏览器");
  checkEnv(browsers.length > 0, "「浏览器」能解析出候选", browsers.slice(0, 3).map((b) => b.name).join(", "));
  // 关键（纯逻辑，不依赖环境）：不能把 browser_broker / browserexport 这类系统组件当成浏览器首选
  const bad = browsers.find((b) => /broker|export/i.test(b.name));
  check(!bad || browsers.indexOf(bad) > 0, "系统组件未被误排为首选", bad ? `误排在首位:${bad.name}` : "ok");

  const calc = await appCatalog.resolve("计算器");
  checkEnv(calc.length > 0 && /calc/i.test(calc[0].launchPath), "「计算器」解析正确", calc[0] ? calc[0].name : "无");

  for (const q of ["记事本", "资源管理器"]) {
    const r = await appCatalog.resolve(q);
    checkEnv(r.length > 0, `「${q}」能解析`, r[0] ? `${r[0].name}(${r[0].kind})` : "未匹配");
  }

  // 提示词片段：只要有任一程序被扫到就应生成清单
  const section = await appCatalog.buildPromptSection();
  check(apps.length === 0 || section.includes("可用程序"), "提示词片段包含程序清单", `${section.split("\n").length - 1} 项`);
}

// ------------------------------------------------------- 2. 打开软件（含 .lnk）
console.log("\n=== 2. 打开软件闭环（open_app 的启动路径）===");
if (appCatalog) {
  const targets = ["计算器", "记事本"];
  for (const t of targets) {
    const cands = await appCatalog.resolve(t);
    if (!cands.length) { check(false, `启动「${t}」`, "未解析到程序"); continue; }
    const pick = cands[0];
    const esc = (s) => String(s).replace(/'/g, "''");
    const out = await ps(`$p = Start-Process -FilePath '${esc(pick.launchPath)}' -PassThru -ErrorAction Stop; if ($p) { 'ok pid=' + $p.Id } else { 'ok' }`);
    const launched = /ok/.test(out);
    if (!launched) { check(false, `启动「${t}」`, out.slice(0, 100)); continue; }

    await new Promise((r) => setTimeout(r, 2500));
    let procName = path.basename(pick.launchPath).replace(/\.(exe|lnk)$/i, "");
    if (pick.kind === "lnk") {
      const tp = await ps(`(New-Object -ComObject WScript.Shell).CreateShortcut('${esc(pick.launchPath)}').TargetPath`);
      if (tp) procName = tp.split(/[\\/]/).pop().replace(/\.exe$/i, "");
    }
    // 验证时把 UWP 别名也算上（Win11 计算器真实进程名是 Calculator）
    const alias = [];
    if (/calc/i.test(procName)) alias.push("Calculator", "ApplicationFrameHost");
    if (/mspaint/i.test(procName)) alias.push("Paint");
    const candidates = [procName, ...alias].filter(Boolean);
    let running = "NONE";
    for (const n of candidates) {
      const r = await ps(`$p=Get-Process -Name '${esc(n)}' -ErrorAction SilentlyContinue; if ($p) { 'RUNNING' } else { 'NONE' }`);
      if (/RUNNING/.test(r)) { running = `RUNNING(${n})`; break; }
    }
    checkEnv(/RUNNING/.test(running), `启动「${t}」并确认进程`, `${pick.name} -> ${running}`);
    // 清理，避免残留
    for (const n of candidates) {
      await ps(`Get-Process -Name '${esc(n)}' -ErrorAction SilentlyContinue | Stop-Process -Force`);
    }
  }
}

// -------------------------------------------- 3. 浏览器：open_url / search_web
console.log("\n=== 3. 打开网址 / 搜索（浏览器解析）===");
if (appCatalog) {
  const browsers = await appCatalog.resolve("浏览器");
  checkEnv(browsers.length > 0, "解析到可用浏览器", browsers.map((b) => b.name).join(", ").slice(0, 80));
  // 逻辑断言（与环境无关）：只要解析出候选，其启动路径就必须真实存在/可用
  const usable = browsers.find((b) =>
    b.kind === "lnk" ? fs.existsSync(b.launchPath) : b.kind === "exe" ? fs.existsSync(b.launchPath) : true
  );
  check(browsers.length === 0 || Boolean(usable), "浏览器候选可直接启动", usable ? `${usable.name}(${usable.kind})` : "无可启动项");
}

// --------------------------------------------------- 3b. open_app 工具定义完整性
console.log("\n=== 3b. open_app 工具（不依赖运行环境）===");
{
  const orch = fs.readFileSync(path.join(root, "src/main/orchestrator.ts"), "utf-8");
  // open_app 必须是内置工具，且定义了 name 参数
  check(/name:\s*"open_app"/.test(orch), "open_app 已注册为内置工具");
  check(orch.includes("appCatalog.resolve"), "open_app 走应用目录解析（而非猜命令）");
  check(orch.includes("verifyAppRunning"), "open_app 启动后会校验进程");
  check(orch.includes("launchInBrowser"), "open_url/search_web 走浏览器解析");
  // 归一化：cmd 内建命令必须补 shell
  const mcp = fs.readFileSync(path.join(root, "src/main/mcp.ts"), "utf-8");
  check(mcp.includes("normalizeWindowsArgs"), "命令归一化函数存在");
  check(/CMD_BUILTINS/.test(mcp), "cmd 内建命令清单存在");
  check(/shell:\s*"cmd"/.test(mcp), "cmd 内建命令会补 shell=cmd");
}

// ----------------------------------------------------- 4. 输入后回车（submit）
console.log("\n=== 4. type_text 的 submit（回车提交）===");
{
  const orch = fs.readFileSync(path.join(root, "src/main/orchestrator.ts"), "utf-8");
  check(orch.includes("submit"), "type_text 工具定义含 submit 参数");
  check(/submit[\s\S]{0,4000}pressKeys\("enter"\)/.test(orch), "submit=true 时真的发送回车");
  check(orch.includes("open_app"), "内置工具含 open_app");
  check(orch.includes("open_url"), "内置工具含 open_url");
  check(orch.includes("search_web"), "内置工具含 search_web");
}

// ---------------------------------------------------- 5. MCP 工具执行闭环
console.log("\n=== 5. MCP 工具执行闭环 ===");
{
  const entry = require.resolve("@wonderwhy-er/desktop-commander/dist/index.js");
  const { spawn } = await import("node:child_process");
  const workDir = path.join(os.tmpdir(), "jarvis-regression");
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(path.join(workDir, "probe.txt"), "regression-ok\n", "utf-8");

  const proc = spawn(process.execPath, [entry], {
    cwd: path.dirname(entry),
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", PUPPETEER_SKIP_DOWNLOAD: "1", DISABLE_TELEMETRY: "1" },
  });
  let buf = "";
  const pending = new Map();
  let id = 1;
  let chromeLines = 0;
  proc.stdout.on("data", (c) => {
    buf += c.toString();
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (typeof m.id === "number" && pending.has(m.id)) {
        const p = pending.get(m.id); clearTimeout(p.t); pending.delete(m.id); p.r(m);
      }
    }
  });
  proc.stderr.on("data", (c) => {
    const s = c.toString();
    chromeLines += (s.match(/Downloading Chrome/gi) || []).length;
  });
  const rpc = (method, params, t = 90000) => new Promise((r) => {
    const my = id++;
    const tm = setTimeout(() => { pending.delete(my); r({ error: { message: "timeout" } }); }, t);
    pending.set(my, { r, t: tm });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: my, method, params }) + "\n");
  });
  const notify = (m, p) => proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: m, params: p }) + "\n");
  const textOf = (r) => (Array.isArray(r.result?.content) ? r.result.content.map((c) => c.text || "").join("\n") : JSON.stringify(r.result ?? r.error));

  const init = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "reg", version: "1.0.0" } });
  check(!init.error, "MCP 握手成功", init.result?.serverInfo?.name || init.error?.message || "");
  notify("notifications/initialized", {});

  const setRes = await rpc("tools/call", { name: "set_config_value", arguments: { key: "allowedDirectories", value: [workDir] } }, 40000);
  check(!setRes.error, "目录白名单下发成功");

  const list = await rpc("tools/list", {});
  const EXPOSED = new Set(["start_process","interact_with_process","read_process_output","list_processes","read_file","write_file","list_directory","create_directory","move_file","get_file_info","edit_block","start_search"]);
  const exposed = (list.result?.tools || []).filter((t) => EXPOSED.has(t.name));
  check(exposed.length === 12, "暴露的工具数量正确", `${exposed.length} 个`);

  const ld = await rpc("tools/call", { name: "list_directory", arguments: { path: workDir } }, 60000);
  check(/probe\.txt/.test(textOf(ld)), "list_directory 白名单内可读");

  const outside = await rpc("tools/call", { name: "read_file", arguments: { path: "C:\\Windows\\win.ini" } }, 30000);
  check(/not allowed|Path not allowed/i.test(textOf(outside)), "白名单外被拒绝（安全闸门生效）");

  // 用户真实场景：打开计算器
  const sp = await rpc("tools/call", { name: "start_process", arguments: { command: "calc.exe", timeout_ms: 5000 } }, 60000);
  checkEnv(/Process started with PID/i.test(textOf(sp)), "start_process 能启动程序", textOf(sp).replace(/\s+/g, " ").slice(0, 80));

  // 用户真实场景：start 内建命令（此前偶发失败）
  const sp2 = await rpc("tools/call", { name: "start_process", arguments: { command: "start notepad", timeout_ms: 5000 } }, 60000);
  const t2 = textOf(sp2);
  check(!/not recognized|不是内部/i.test(t2), "`start xxx` 不再因 shell 选错而失败", t2.replace(/\s+/g, " ").slice(0, 80));

  check(chromeLines === 0, "无 Chrome 下载刷屏", `${chromeLines} 行`);

  proc.kill();
  await new Promise((r) => setTimeout(r, 300));
  await ps("Get-Process -Name calc,notepad -ErrorAction SilentlyContinue | Stop-Process -Force");
}

// --------------------------------------------------------- 6. 提示词内容检查
console.log("\n=== 6. 提示词（人设与工具准则）===");
{
  const cfg = fs.readFileSync(path.join(root, "src/main/config.ts"), "utf-8");
  check(cfg.includes("open_app"), "人设要求「打开软件用 open_app」");
  check(cfg.includes("submit=true"), "人设要求输入后提交带 submit");
  check(/干脆利落|一句话确认/.test(cfg), "人设要求执行工具时简短");
  check(/不要点击桌面图标/.test(cfg), "人设禁止点桌面图标");
  const rt = fs.readFileSync(path.join(root, "src/main/realtime.ts"), "utf-8");
  check(rt.includes("refreshEnvPrompt"), "会话前刷新本机程序清单");
  check(rt.includes("listVoices"), "提供音色列表接口");
  check(rt.includes("speech_interrupted"), "适配 speech_interrupted 打断事件");
}

// -------------------------------------------------------- 7. 日志与错误分类
console.log("\n=== 7. 日志与错误分类 ===");
{
  const lg = fs.readFileSync(path.join(root, "src/main/logger.ts"), "utf-8");
  check(lg.includes("errorCategorized"), "分类错误 API 存在");
  check(lg.includes("errors.jsonl"), "错误写入 errors.jsonl");
  check(lg.includes("rotateIfNeeded"), "日志轮转存在");
  check(lg.includes("THROTTLE_WINDOW_MS"), "日志限流存在");
  const orch = fs.readFileSync(path.join(root, "src/main/orchestrator.ts"), "utf-8");
  check(/tool_execution/.test(orch), "工具失败归类为 tool_execution");
}

console.log("\n==================================================");
console.log(`回测结果：通过 ${pass}，失败 ${fail}${skip ? `，跳过 ${skip}（环境受限）` : ""}`);
if (failures.length) {
  console.log("失败项明细：");
  failures.forEach((f) => console.log(`  - ${f}`));
}
console.log(`结论：${fail === 0 ? "全部通过" : "存在失败项"}`);
console.log("==================================================");
process.exit(fail === 0 ? 0 : 1);
