/**
 * 悬浮球「渲染设备丢失 → 重建」恢复链路回归测试。
 *
 * 为什么需要它：此前 orb-renderer 遇到 device.lost 直接进入终态，
 * 球体一旦断连就永久黑屏（只能重启应用）。修复后改成了有限次退避重建 +
 * 宿主兜底重载两层恢复，但这条路径一直没有自动化覆盖，CI 无法验证。
 *
 * 本脚本全部为「源码 / 构建产物一致性 + 纯逻辑断言」，不需要 Electron、
 * 也不需要 WebGPU；在 CI 里跑在 `npm run build` 之后，用来固化下列不变量：
 *   1. 旧缺陷不回归   —— 渲染器存在重建路径，且不再把设备丢失当终态（fail()）
 *   2. 退避序列正确   —— 由源码参数复算 5 次重试延迟 = [500..8000]，总 15.5s
 *   3. 三层一致性     —— 恢复逻辑标记必须同在模块源 / 模板源 / 构建产物三处
 *                        （历史高频坑：只改产物会被下次构建覆盖）
 *   3b. 产物完整性    —— orb.html 必须是完整 HTML（防模板字符串提前结束导致静默截断）
 *   4. 宿主兜底参数   —— ORB_RECOVER_MAX=6、ORB_RECOVER_DELAY_MS=10000，
 *                        且 ORB_ON_ERROR 触发重建、ORB_ON_READY 清零计数
 *   5. 音频参数一致   —— 产物里的放大值 audioRules / audioFlowStrengths
 *                        与构建期期望值（JSON 解析后深比较）一致
 *
 * 用法：node scripts/verify-orb-recovery.mjs   （需先 npm run build）
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// 用 import.meta.url 定位仓库根，避免依赖 cwd（CI / 本地调用位置不同）。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

let pass = 0;
let fail = 0;
const failures = [];

function check(ok, label, extra = "") {
  if (ok) { pass++; console.log(`  [OK]   ${label}${extra ? " | " + extra : ""}`); }
  else { fail++; failures.push(label); console.log(`  [FAIL] ${label}${extra ? " | " + extra : ""}`); }
}

function readUtf8(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

// —— 关键文件（相对仓库根）——
const F_RENDERER = "vendor/orb/src/orb-renderer.ts"; // 模块源：真正的渲染器实现
const F_EXPORT = "vendor/orb/src/code-export.ts";    // 模板源：生成自包含 HTML 的地方
const F_ORB_HTML = "src/renderer/orb.html";          // 构建产物：由 code-export 生成
const F_IPC = "src/main/ipc.ts";                     // 宿主兜底重载逻辑
const F_TUNING = "vendor/orb/src/orb-audio-tuning.ts"; // 可选：并行改动抽出的调音常量

// 把值规范化为可比较的字符串（对象键排序、数组保序），用于深比较。
function canon(v) {
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}

// ---------------------------------------------------------------- 1. 旧缺陷不回归
console.log("\n=== 1. 旧缺陷不回归（设备丢失不再终态停摆）===");
try {
  const src = readUtf8(F_RENDERER);

  // 模块源必须保留重建路径的全部关键标记。
  const rebuildMarkers = [
    "maxRestartAttempts",
    "restartBaseDelayMs",
    "restartMaxDelayMs",
    "scheduleRestart",
    "navigator.gpu.requestAdapter",
  ];
  for (const m of rebuildMarkers) {
    check(src.includes(m), `渲染器保留重建标记：${m}`);
  }

  // onReady 在渲染恢复正常时会被再次调用（设备重建成功的信号）。
  check(/onReady\s*\(\s*\)/.test(src), "渲染器存在 onReady() 就绪回调");
  // 设备丢失走 .lost.then 绑定（而非终态 fail）。
  check(/\.lost\s*\.then\s*\(/.test(src), "渲染器绑定设备丢失事件（.lost.then）");

  // 旧缺陷：把设备丢失当终态，直接 fail(...) 停摆。修复后源码里不应再出现。
  check(!src.includes("fail("), "渲染器不再有终态 fail( 调用（旧缺陷防回归）");
} catch (e) {
  check(false, "读取 orb-renderer.ts", e.message);
}

// ---------------------------------------------------------------- 2. 退避序列
console.log("\n=== 2. 退避序列复算（由源码参数推导，防止改参数改语义）===");
try {
  const src = readUtf8(F_RENDERER);

  // 复算所依据的公式必须与源码一致，否则复算结论无意义。
  // 允许尾随逗号与跨行书写（源码里 Math.min 实为多行、末参带逗号）。
  const formulaRe = /Math\.min\(\s*restartMaxDelayMs\s*,\s*restartBaseDelayMs\s*\*\s*2\s*\*\*\s*restartAttempts\s*,?\s*\)/;
  check(formulaRe.test(src), "退避公式为 Math.min(max, base * 2 ** attempts)");

  const num = (name) => {
    const m = src.match(new RegExp(`const\\s+${name}\\s*=\\s*(\\d+)`));
    return m ? Number(m[1]) : NaN;
  };
  const max = num("maxRestartAttempts");
  const base = num("restartBaseDelayMs");
  const cap = num("restartMaxDelayMs");
  check([max, base, cap].every((n) => Number.isFinite(n) && n > 0),
    "解析出三个退避参数", `max=${max} base=${base} cap=${cap}`);

  // 严格按源码公式复算：attempts 从 0 起，取 delay 后才自增。
  const seq = [];
  for (let attempts = 0; attempts < max; attempts++) {
    seq.push(Math.min(cap, base * 2 ** attempts));
  }
  const expected = [500, 1000, 2000, 4000, 8000];
  check(JSON.stringify(seq) === JSON.stringify(expected),
    "5 次重试延迟序列 = [500,1000,2000,4000,8000]", JSON.stringify(seq));
  const total = seq.reduce((a, b) => a + b, 0);
  check(total === 15500, "渲染器重试总窗口 = 15500ms（≈15s）", `${total}ms`);
} catch (e) {
  check(false, "退避序列复算", e.message);
}

// ---------------------------------------------------------------- 3. 三层一致性
console.log("\n=== 3. 三层一致性（模块源 / 模板源 / 构建产物）===");
try {
  const renderer = readUtf8(F_RENDERER);
  const tpl = readUtf8(F_EXPORT);
  const html = readUtf8(F_ORB_HTML);

  const layers = [
    { name: "模块源 orb-renderer.ts", rel: F_RENDERER, text: renderer },
    { name: "模板源 code-export.ts", rel: F_EXPORT, text: tpl },
    { name: "构建产物 orb.html", rel: F_ORB_HTML, text: html },
  ];
  // 恢复逻辑最关键的四个标记：任何一层缺失都意味着漂移。
  const keyMarkers = ["scheduleRestart", "device.lost", "uncapturederror", "requestAdapter"];

  for (const marker of keyMarkers) {
    const missing = layers.filter((l) => !l.text.includes(marker));
    check(missing.length === 0,
      `恢复标记三处齐备：${marker}`,
      missing.length ? `漂移文件：${missing.map((m) => m.rel).join(", ")}` : "3/3");
  }

  // 三层都不应再有终态 fail(（与第 1 节呼应，防止产物/模板单独走样）。
  for (const l of layers) {
    check(!l.text.includes("fail("), `无终态 fail(：${l.name}`);
  }
} catch (e) {
  check(false, "三层一致性检查", e.message);
}

// -------------------------------------------------- 3b. 构建产物完整性（防截断）
console.log("\n=== 3b. 构建产物完整性（防模板字符串被提前截断）===");
try {
  const html = readUtf8(F_ORB_HTML);
  // 踩过的坑：code-export.ts 把整页放在**一个反引号模板字符串**里。只要有人在
  // 那段模板的注释里写下未转义的反引号，模板就会在那里提前结束，导出的 orb.html
  // 被**静默截断**（页面缺 </script>/</body>/</html>，球体直接白屏），
  // 而生成器与 tsc 都不会报任何错。所以这里把「产物必须是一份完整 HTML」固定下来。
  check(html.trimEnd().endsWith("</html>"), "产物以 </html> 结尾（未被截断）");
  const closeScript = html.split("</script>").length - 1;
  check(closeScript >= 2, "产物含完整的 script 块", `</script> x${closeScript}`);
  check(html.includes("electronBridge"), "产物含宿主桥接脚本（桥接段未被截断）");
  check(html.includes("window.liquidOrb"), "产物暴露 window.liquidOrb 接口");
} catch (e) {
  check(false, "产物完整性检查", e.message);
}

// ---------------------------------------------------------------- 4. 宿主兜底参数
console.log("\n=== 4. 宿主兜底重载参数与接线（ipc.ts）===");
try {
  const ipc = readUtf8(F_IPC);

  check(/ORB_RECOVER_MAX\s*=\s*6\b/.test(ipc), "ORB_RECOVER_MAX = 6");
  check(/ORB_RECOVER_DELAY_MS\s*=\s*10000\b/.test(ipc), "ORB_RECOVER_DELAY_MS = 10000");

  // ORB_ON_ERROR 处理里必须调用 scheduleOrbRecovery（宽松窗口匹配，不绑行号/空白）。
  check(/ORB_ON_ERROR[\s\S]{0,800}?scheduleOrbRecovery\s*\(/.test(ipc),
    "ORB_ON_ERROR 处理调用 scheduleOrbRecovery");
  // ORB_ON_READY 处理里必须把恢复计数清零（渲染恢复即复位）。
  check(/ORB_ON_READY[\s\S]{0,800}?orbRecoverAttempts\s*=\s*0/.test(ipc),
    "ORB_ON_READY 处理清零 orbRecoverAttempts");

  const max = Number((ipc.match(/ORB_RECOVER_MAX\s*=\s*(\d+)/) || [])[1]);
  const delay = Number((ipc.match(/ORB_RECOVER_DELAY_MS\s*=\s*(\d+)/) || [])[1]);
  check(Number.isFinite(max) && Number.isFinite(delay) && max * delay === 60000,
    "宿主总覆盖窗口 = 6 * 10000 = 60000ms（≈60s，覆盖 GPU 进程重启）",
    `${max} * ${delay} = ${max * delay}ms`);
} catch (e) {
  check(false, "宿主兜底参数检查", e.message);
}

// ---------------------------------------------------------------- 5. 音频参数一致
console.log("\n=== 5. 生成器/产物音频参数一致（放大值）===");
try {
  // 构建期期望的放大值（与 scripts/generate-orb.mjs 的 AMPLIFIED_* 一致）。
  const EXPECTED_RULES_JSON = '[[3,"all",0.35,2.6,14],[6,"mid",4.2,1.1,22],[7,"low",1.1,1.9,13],[21,"low",1.05,1.6,5.5],[10,"high",0.95,0.6,7],[14,"all",0.25,0.75,9]]';
  const EXPECTED_FLOW_JSON = '{"9":2.6,"10":2.1,"11":2.1,"14":2.4,"19":2.9,"21":2.2}';

  let expectedRules = JSON.parse(EXPECTED_RULES_JSON);
  let expectedFlow = JSON.parse(EXPECTED_FLOW_JSON);
  let source = "内联期望值";

  // 并行改动正把放大值抽到 orb-audio-tuning.ts。若该文件存在，尽量采用它的
  // 常量作为期望（宽松提取 + 形状校验）；不存在或提取失败则回退内联期望值。
  try {
    if (fs.existsSync(path.join(root, F_TUNING))) {
      const t = readUtf8(F_TUNING);
      // 兼容 amplifiedAudioRules / audioRules 两种命名；字面量可能是多行且带尾随逗号。
      const mr = t.match(/export\s+const\s+\w*[Aa]udioRules\b[\s\S]*?=\s*(\[[\s\S]*?\]);/);
      const mf = t.match(/export\s+const\s+\w*[Aa]udioFlowStrengths\b[\s\S]*?=\s*(\{[\s\S]*?\});/);
      const stripTrailingCommas = (s) => s.replace(/,\s*([\]}])/g, "$1");
      const pr = mr ? JSON.parse(stripTrailingCommas(mr[1])) : null;
      const pf = mf ? JSON.parse(stripTrailingCommas(mf[1])) : null;
      const rulesOk = Array.isArray(pr) && pr.length > 0 && pr.every((r) => Array.isArray(r) && r.length === 5);
      const flowOk = pf && typeof pf === "object" && !Array.isArray(pf) && Object.values(pf).every((v) => typeof v === "number");
      if (rulesOk && flowOk) {
        expectedRules = pr; expectedFlow = pf; source = "orb-audio-tuning.ts";
      } else {
        console.log(`    (提示) ${F_TUNING} 存在但未能提取有效常量，回退内联期望值`);
      }
    } else {
      console.log(`    (提示) ${F_TUNING} 暂不存在，使用内联期望值（并行改动落地后可自动切换）`);
    }
  } catch (e) {
    console.log(`    (提示) 读取 ${F_TUNING} 失败（${e.message}），回退内联期望值`);
  }
  console.log(`    期望值来源：${source}`);

  // 从产物 HTML 中提取两个字面量并解析为 JS 值。
  const html = readUtf8(F_ORB_HTML);
  const rulesMatch = html.match(/const\s+audioRules\s*=\s*(\[[\s\S]*?\])\s*;/);
  const flowMatch = html.match(/const\s+audioFlowStrengths\s*=\s*(\{[\s\S]*?\})\s*;/);

  check(Boolean(rulesMatch), "产物中存在 audioRules 字面量");
  check(Boolean(flowMatch), "产物中存在 audioFlowStrengths 字面量");

  if (rulesMatch && flowMatch) {
    let gotRules = null, gotFlow = null, parseErr = "";
    try { gotRules = JSON.parse(rulesMatch[1]); } catch (e) { parseErr = "audioRules: " + e.message; }
    try { gotFlow = JSON.parse(flowMatch[1]); } catch (e) { parseErr += (parseErr ? "；" : "") + "audioFlowStrengths: " + e.message; }
    check(!parseErr, "两个字面量可解析为 JS 值", parseErr);

    if (!parseErr) {
      check(canon(gotRules) === canon(expectedRules),
        "产物 audioRules 等于期望放大值", canon(gotRules));
      check(canon(gotFlow) === canon(expectedFlow),
        "产物 audioFlowStrengths 等于期望放大值", canon(gotFlow));
    }
  }
} catch (e) {
  check(false, "音频参数一致性检查", e.message);
}

// ---------------------------------------------------------------- 汇总
console.log(`\n=== 汇总：${pass} 通过，${fail} 失败 ===`);
if (failures.length) {
  console.log("失败项：");
  for (const f of failures) console.log("  - " + f);
}
console.log(`结论：${fail === 0 ? "全部通过" : "存在失败项"}`);
process.exit(fail === 0 ? 0 : 1);
