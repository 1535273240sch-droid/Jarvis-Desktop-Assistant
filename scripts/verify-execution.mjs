/**
 * 「一句话执行不完整」专项回归测试。
 *
 * 背景：用户实测反馈「给他一个命令他能执行，但执行到一半会自己断掉，
 * 每次要我说几遍才行」。本脚本针对定位到的 4 个根因各写一组断言：
 *
 *   1. 执行态看门狗固定 60s -> 长任务被强制回退 idle（state.ts）
 *   2. executing 态被 barge-in 打断 -> 风扇/机械噪音触发 VAD 误判（orchestrator.ts）
 *   3. 工具输出单向 slice(0, 8000) -> 模型看到半截就以为做完（orchestrator.ts）
 *   4. response.done 兜底定时器与工具执行竞争 -> 状态被误打回 idle（orchestrator.ts）
 *
 * 用法：
 *   node scripts/verify-execution.mjs        离线断言（不联网、不需要 Electron）
 *   node scripts/run.mjs verify-execution   同上（推荐，与其它脚本一致）
 *
 * 前置：先 `node scripts/run.mjs build`。
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);

let pass = 0;
let fail = 0;
let uncovered = 0;
const failures = [];
const uncoveredItems = [];
function check(ok, label, extra = "") {
  if (ok) { pass++; console.log(`  [OK]   ${label}${extra ? " | " + extra : ""}`); }
  else { fail++; failures.push(label); console.log(`  [FAIL] ${label}${extra ? " | " + extra : ""}`); }
}
/**
 * 显式声明「本项未被覆盖」：既不计入通过，也不计入失败。
 * 用于「想在 CI 验证但当前无法真正调用生产代码」的条目 —— 与其用重写/正则冒充
 * 行为验证让通过数虚高，不如把它明确标出来，避免回归失去拦截能力还看不出来。
 */
function markUncovered(label, reason = "") {
  uncovered++;
  uncoveredItems.push(label);
  console.log(`  [UNCOVERED] ${label}${reason ? " | " + reason : ""}`);
}

// state.ts 顶层 import 了 logger（会写文件），这里打桩避免污染用户目录
const Module = require("node:module");
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "./logger" || request.endsWith("main/logger") || request.endsWith("logger")) {
    return { logger: { info() {}, warn() {}, error() {}, errorCategorized() {}, debug() {} } };
  }
  return origLoad.apply(this, arguments);
};

const { stateMachine, StateMachine } = require(path.join(root, "dist", "main", "state.js"));

/* ============ 1. 执行态看门狗时长 ============ */
console.log("== 1. 执行态看门狗（长任务不再被 60s 掐断）==");
{
  const defaultMs = new StateMachine().timeoutMsFor("executing");
  check(defaultMs >= 600_000, "默认执行态看门狗 ≥ 10 分钟", `${defaultMs} ms`);
  check(defaultMs !== 60_000, "不再是旧的固定 60 秒", `${defaultMs} ms`);

  const m2 = new StateMachine();
  m2.setExecutingTimeout(30 * 60_000);
  check(m2.timeoutMsFor("executing") === 30 * 60_000, "支持用户自定义执行超时（30 分钟）", `${m2.timeoutMsFor("executing")} ms`);

  const m3 = new StateMachine();
  m3.setExecutingTimeout(0);
  check(m3.timeoutMsFor("executing") === defaultMs, "传入 0 视为恢复默认，不会变成立即超时");

  const m4 = new StateMachine();
  m4.setExecutingTimeout(1000);
  check(m4.timeoutMsFor("executing") === 30_000, "过小的值被抬到 30s 下限，避免执行态秒超时");

  // 非 executing 态不受影响
  const m5 = new StateMachine();
  m5.setExecutingTimeout(30 * 60_000);
  check(m5.timeoutMsFor("thinking") === 20_000, "thinking 仍是 20s（简报取数不切 thinking，规避此项）", `${m5.timeoutMsFor("thinking")} ms`);
  check(m5.timeoutMsFor("idle") === null, "idle 仍不设超时");
  m5.dispose(); m2.dispose(); m3.dispose(); m4.dispose();
}

/* ============ 2. extend() 续期 ============ */
console.log("\n== 2. 工具执行心跳续期（慢但正常推进不被误杀）==");
{
  // R-47：原断言只验证「extend 不改变状态」——extend 退化成空函数也能通过。
  // 现注入可控时钟（fake timer）验证「续期确实推迟了回收时刻」：
  // armWatchdog 在调用时才解析全局 setTimeout/clearTimeout，所以在测试内替换全局
  // 实现即可观测到 extend 是否真的「清旧定时器 + 建新定时器 + 截止时间后移」。
  // 覆盖边界：证明的是看门狗被重建且新定时器可触发；不验证真实 30s 的等待时长。
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let fakeNow = 0;
  let timerSeq = 0;
  const armed = [];
  const cleared = [];
  globalThis.setTimeout = (fn, delay, ...args) => {
    const handle = {
      __fakeTimer: true, id: ++timerSeq, fn, args,
      delay: Number(delay) || 0, dueAt: fakeNow + (Number(delay) || 0),
    };
    armed.push(handle);
    return handle;
  };
  globalThis.clearTimeout = (h) => { if (h && h.__fakeTimer) cleared.push(h.id); };

  try {
    const m = new StateMachine();
    m.setExecutingTimeout(30_000);
    m.transition("executing", "模拟长任务");
    const first = armed[armed.length - 1];
    check(Boolean(first) && first.delay === 30_000,
      "进入 executing 时按配置武装看门狗", first ? `${first.delay}ms` : "未武装");

    fakeNow = 5_000; // 时钟前进 5s，但不触发定时器
    m.extend("工具仍在执行");
    const second = armed[armed.length - 1];
    check(m.getState() === "executing", "执行中调用 extend 不会改变状态");
    check(Boolean(first) && cleared.includes(first.id),
      "extend 清除了旧的看门狗定时器", first ? `cleared=[${cleared.join(",")}]` : "");
    check(Boolean(first) && Boolean(second) && second.id !== first.id,
      "extend 重建看门狗定时器（句柄发生变化）",
      first && second ? `#${first.id} -> #${second.id}` : "");
    check(Boolean(first) && Boolean(second) && second.dueAt > first.dueAt,
      "extend 推迟了回收时刻（截止时间后移）",
      first && second ? `${first.dueAt}ms -> ${second.dueAt}ms` : "");

    // 新定时器必须是「活」的：手动触发它应真的把 executing 回退到 idle，
    // 证明 extend 武装的不是空壳（否则上面「重建句柄」也可能只是记账）。
    if (second && typeof second.fn === "function") second.fn();
    check(m.getState() === "idle", "新看门狗可被触发并回退状态（续期武装的是真实定时器）");
    m.dispose();
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }

  // 超时回收语义：直接驱动私有 watchdog 计时器不可行，改为断言 armWatchdog 存在且
  // 状态变更会重新计时（源码级，见第 1 节 timeoutMsFor 断言）。
  const srcState = require("node:fs").readFileSync(path.join(root, "src", "main", "state.ts"), "utf8");
  check(/this\.watchdog = setTimeout/.test(srcState), "看门狗仍是真实 setTimeout（卡死仍会被兜底回收）");
  check(/if \(this\.state !== state\) return;/.test(srcState), "超时前校验状态未变，避免误伤已迁移的状态");
}

/* ============ 3. 工具输出裁剪保留两端 ============ */
console.log("\n== 3. 工具输出裁剪（模型不再只看到半截）==");
{
  const fs = require("node:fs");
  const src = fs.readFileSync(path.join(root, "src", "main", "orchestrator.ts"), "utf8");

  check(!/sendToolResult\(callId, output\.slice\(0, 8000\)\)/.test(src),
    "已移除单向 slice(0, 8000) 截断");
  check(/fitToolOutputForModel/.test(src), "输出改走 fitToolOutputForModel");

  // 源码级断言：保留头尾 + 显式告知裁剪量。
  // 注意：以下三条只证明**源码里存在该实现结构**，不证明其运行时行为正确。
  const fnStart = src.indexOf("private fitToolOutputForModel");
  const fnBody = fnStart >= 0 ? src.slice(fnStart, fnStart + 900) : "";
  check(/slice\(0, head\)/.test(fnBody) && /slice\(text\.length - tail\)/.test(fnBody),
    "掐头去尾同时保留开头与结尾");
  check(/已省略/.test(fnBody), "显式告知模型被裁剪了多少字（不再静默丢尾巴）");
  check(/0\.6/.test(fnBody), "按 6:4 分配头尾，错误信息在结尾得以保留");

  // R-46：原实现把 fit() 裁剪算法在脚本里重写了一遍 —— 验证的是脚本自己，
  // 生产函数 fitToolOutputForModel 一旦漂移根本测不出来（同义反复）。
  // 改为直接调用真实生产函数是最理想的，但该函数在 orchestrator.ts 中是 `private`，
  // 既未导出为独立函数，require 整个 orchestrator 单例又会拉入 electron / realtime /
  // mcp 等重型依赖（本脚本设计为离线、不启动 Electron），无法在 CI 稳定调用。
  // 因此按约定降级为「显式声明未覆盖」：生产函数未导出，本项退化为上面的正则存在性
  // 检查，不再用重写算法冒充行为验证。
  markUncovered("fitToolOutputForModel 的运行时行为（头尾保留、裁剪量告知、短输出原样返回）",
    "生产函数未导出（private），离线无法调用；本项退化为正则存在性检查，行为未覆盖");
}

/* ============ 4. executing 不再被 response.done 兜底/打断影响 ============ */
console.log("\n== 4. 执行中不被误打断 / 不被兜底打回 idle ==");
{
  const fs = require("node:fs");
  const src = fs.readFileSync(path.join(root, "src", "main", "orchestrator.ts"), "utf8");

  // 4a. barge-in 不再把 executing 当作可打断态
  const bargeRaw = src.slice(src.indexOf('realtimeClient.on("bargeIn"'), src.indexOf('realtimeClient.on("userTranscriptDelta"'));
  // 去掉注释后再断言，避免把「记录旧写法」的注释误判为代码
  const barge = bargeRaw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check(bargeRaw.length > 0, "定位到 bargeIn 处理块");
  check(!/cur === "speaking" \|\| cur === "thinking" \|\| cur === "executing"/.test(barge),
    "barge-in 不再把 executing 列入可打断状态（旧写法已移除，仅存于注释）");
  check(/cur === "executing"/.test(barge), "执行中单独分支：只更新字幕不打断");
  check(/Ctrl\+Alt\+X/.test(bargeRaw), "提示用户用急停 Ctrl+Alt+X 停止长任务（语义明确、不会误触）");

  // 4b. response.done 兜底不得影响 executing
  const done = src.slice(src.indexOf('realtimeClient.on("responseDone"'), src.indexOf('realtimeClient.on("toolCall"'));
  check(/if \(cur === "executing"\) return;/.test(done), "response.done 兜底遇到 executing 直接返回");
  check(!/}, 400\);/.test(done), "兜底延时由 400ms 放宽（避免抢在工具结果回注前收敛）", (done.match(/\}, (\d+)\);/) || [])[1] + "ms");

  // 4c. 执行态确实接上了可配置看门狗
  check(/setExecutingTimeout\(configManager\.get\(\)\.toolWatchdogMs\)/.test(src),
    "handleToolCall 执行前注入用户配置的执行超时");
  check(/clearInterval\(heartbeat\)/.test(src), "心跳定时器在 finally 里清理（不泄漏）");
  check(/const heartbeat = setInterval/.test(src), "长任务执行期间存在心跳续期");
}

/* ============ 5. 执行中不再误触发打断（状态机优先级） ============ */
console.log("\n== 5. 状态机 basics 回归（确保改动没破坏既有语义）==");
{
  const m = new StateMachine();
  check(m.getState() === "idle", "初始为 idle");
  check(m.transition("speaking", "测试") === true, "可迁移到 speaking");
  // speaking(4) -> executing(3) 属低优先级抢占，状态机按设计拒绝（工具调用由
  // handleToolCall 在非播报态发起，或先经 interrupt 回到 listening）
  check(m.transition("executing", "低优先级抢占") === false, "speaking -> executing 被优先级规则拒绝");
  check(m.getState() === "speaking", "被拒绝的迁移不改变状态");
  check(m.transition("idle", "播放完成", { force: true }) === true, "force 可强制回退（打断/急停依赖它）");
  check(m.getState() === "idle", "强制回退后状态正确");
  // 从低优先级态可以进入高优先级态（这是工具执行的关键路径）
  check(m.transition("listening", "回到聆听") === true, "idle -> listening 可迁移");
  check(m.transition("executing", "工具开始") === true, "listening -> executing 允许（工具执行的关键路径）");
  m.dispose();
}

console.log(`\n结果：${pass} 通过，${fail} 失败${uncovered ? `，${uncovered} 项显式未覆盖` : ""}`);
if (uncoveredItems.length) {
  console.log("未覆盖项（不计入通过/失败，需人工或集成测试确认）：");
  for (const u of uncoveredItems) console.log("  - " + u);
}
if (fail) { console.log("失败项：\n  - " + failures.join("\n  - ")); process.exit(1); }
