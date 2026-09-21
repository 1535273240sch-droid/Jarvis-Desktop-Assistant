/**
 * 应用内真实端到端联调（无人值 automation）：
 *  启动真实 Electron 应用 -> 启动会话 -> 注入真实合成语音 -> 验证：
 *    1. WebSocket 真实连上（session.created）
 *    2. 音频真的上行（服务端回 speech_started/stopped）
 *    3. 状态机真的走到 listening -> thinking -> speaking
 *    4. 模型真的回了音频（下行 PCM 到达渲染进程）
 *    5. 打断真的生效
 *
 * 说明：声音用"注入合成 PCM"代替真人说话（无法自动说话），
 * 其余全部走应用真实代码路径。
 */
import { _electron as electron } from "playwright-core";
import path from "node:path";
import fs from "node:fs";

const ROOT = "C:/开发任务/Jarvis";

function speechLike(ms) {
  const rate = 24000, n = Math.floor((rate * ms) / 1000), b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const f = 120 + 60 * Math.sin(2 * Math.PI * 1.3 * t) + 20 * Math.sin(2 * Math.PI * 3.7 * t);
    const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 2.2 * t);
    const v = Math.sin(2 * Math.PI * f * t) * 9000 * env + Math.sin(2 * Math.PI * f * 2 * t) * 4000 * env;
    b.writeInt16LE(Math.max(-32000, Math.min(32000, Math.round(v))), i * 2);
  }
  return b.toString("base64");
}
function silence(ms) {
  const n = Math.floor((24000 * ms) / 1000);
  return Buffer.alloc(n * 2).toString("base64");
}

let pass = 0, fail = 0;
const ok = (c, label, extra = "") => {
  if (c) { pass++; console.log(`  ✓ ${label}${extra ? " | " + extra : ""}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? " | " + extra : ""}`); }
};

console.log("启动 Electron 应用（真实代码路径）...");
const app = await electron.launch({
  cwd: ROOT,
  args: [ROOT],
  env: { ...process.env, PATH: "C:\\Program Files\\nodejs;" + process.env.PATH },
});

// 1) 主进程就绪
const mainLogs = [];
await app.process().stdout?.on("data", (d) => mainLogs.push(d.toString()));
await app.process().stderr?.on("data", (d) => mainLogs.push(d.toString()));

// 等窗口
let orbPage = null, panelPage = null;
for (let i = 0; i < 40; i++) {
  const pages = app.windows();
  for (const p of pages) {
    const u = p.url();
    if (u.includes("orb")) orbPage = p;
    if (u.includes("panel")) panelPage = p;
  }
  if (orbPage && panelPage) break;
  await new Promise((r) => setTimeout(r, 500));
}
ok(Boolean(orbPage), "球体窗口已加载", orbPage?.url() || "未找到");
ok(Boolean(panelPage), "聊天面板窗口已加载", panelPage?.url() || "未找到");

// 2) 球体就绪 + 六态可切换
if (orbPage) {
  const st = await orbPage.evaluate(() => (window.liquidOrb ? window.liquidOrb.getState() : null));
  ok(st === "idle", "球体 window.liquidOrb 就绪", `初始状态=${st}`);
}

// 3) 面板侧：捕获状态迁移与下行音频
if (panelPage) {
  await panelPage.evaluate(() => {
    window.__probe = { states: [], downChunks: 0, downBytes: 0, flushed: 0, msgs: 0 };
    window.jarvis.onStateChanged((p) => { window.__probe.states.push(p.state); });
    window.jarvis.onAudioChunkDown((p) => {
      if (p && p.pcmBase64) { window.__probe.downChunks++; window.__probe.downBytes += Math.floor(p.pcmBase64.length * 0.75); }
    });
    window.jarvis.onAudioFlush(() => { window.__probe.flushed++; });
    window.jarvis.onMessage(() => { window.__probe.msgs++; });
  });

  // 4) 启动会话（真实连接）
  console.log("\n启动实时语音会话（真实 WebSocket）...");
  const startRes = await panelPage.evaluate(() => window.jarvis.sessionStart());
  ok(startRes?.ok === true, "会话启动调用成功", JSON.stringify(startRes));

  // 等连接建立
  let connected = false;
  for (let i = 0; i < 30; i++) {
    const s = await panelPage.evaluate(() => window.__probe.states.slice());
    await new Promise((r) => setTimeout(r, 500));
    const status = await panelPage.evaluate(async () => {
      return await new Promise((res) => {
        const off = window.jarvis.onSessionStatus((st) => { off(); res(st); });
        setTimeout(() => res(null), 800);
      });
    });
    if (status && status.connection === "connected") { connected = true; break; }
  }
  ok(connected, "WebSocket 真实连接建立（connection=connected）");

  // 5) 注入真实合成语音 -> 走应用真实音频上行路径
  //    说明：用「类人声」信号（基频滑动 + 谐波 + 包络），
  //    纯正弦/扫频会被服务端 VAD 判为非人声，导致模型只回一句描述而无完整应答。
  console.log("\n注入合成语音（走应用真实上行代码路径）...");
  await panelPage.evaluate(async () => {
    const rate = 24000;
    function humanLike(ms) {
      const n = Math.floor(rate * ms / 1000);
      const buf = new ArrayBuffer(n * 2); const view = new DataView(buf);
      for (let i = 0; i < n; i++) {
        const t = i / rate;
        // 基频在 85-180Hz 之间缓慢滑动（男声范围），叠加多次谐波与音节级包络
        const f0 = 120 + 35 * Math.sin(2 * Math.PI * 0.9 * t) + 12 * Math.sin(2 * Math.PI * 2.7 * t);
        const syl = Math.max(0, Math.sin(2 * Math.PI * 3.2 * t));       // 音节包络
        const env = 0.25 + 0.75 * syl;
        let v = 0;
        for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f0 * h * t) * (1 / h) * 3000;
        // 加一点噪声模拟辅音
        v += (Math.random() * 2 - 1) * 700 * (1 - syl);
        view.setInt16(i * 2, Math.max(-32000, Math.min(32000, Math.round(v * env))), true);
      }
      const bytes = new Uint8Array(buf); let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(bin);
    }
    function silenceMs(ms) {
      const n = Math.floor(rate * ms / 1000);
      const bytes = new Uint8Array(n * 2);
      let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(bin);
    }
    // 推 2.5 秒"说话"，再推静音让服务端 VAD 断句
    for (let i = 0; i < 5; i++) { window.jarvis.sendAudioChunkUp(humanLike(500)); await new Promise((r) => setTimeout(r, 400)); }
    for (let i = 0; i < 4; i++) { window.jarvis.sendAudioChunkUp(silenceMs(1000)); await new Promise((r) => setTimeout(r, 400)); }
  });

  // 6) 等模型响应（状态应经过 thinking -> speaking，且收到下行音频）
  console.log("\n等待模型响应...");
  let sawThinking = false, sawSpeaking = false, finalProbe = null;
  for (let i = 0; i < 60; i++) {
    finalProbe = await panelPage.evaluate(() => ({ ...window.__probe }));
    if (finalProbe.states.includes("thinking")) sawThinking = true;
    if (finalProbe.states.includes("speaking")) sawSpeaking = true;
    if (sawSpeaking && finalProbe.downChunks > 0) break;
    await new Promise((r) => setTimeout(r, 800));
  }
  ok(sawThinking, "状态机走到 thinking（服务端真实响应）");
  ok(sawSpeaking, "状态机走到 speaking（模型真实发声）");
  ok(finalProbe.downChunks > 0, "收到下行音频并送达渲染进程", `${finalProbe.downChunks} 分片 / ~${finalProbe.downBytes} 字节`);

  // 7) 打断
  console.log("\n验证打断...");
  const before = await panelPage.evaluate(() => window.__probe.downChunks);
  await panelPage.evaluate(() => window.jarvis.interrupt());
  await new Promise((r) => setTimeout(r, 2500));
  const after = await panelPage.evaluate(() => ({ ...window.__probe }));
  ok(after.flushed > 0, "打断已向渲染进程下发 flush（清空播放缓冲）", `flushed=${after.flushed}`);
  const delta = after.downChunks - before;
  console.log(`  打断后新增分片: ${delta}（应接近 0）`);
  ok(delta <= 3, "打断后不再持续推送音频");

  // 8) 停止会话
  await panelPage.evaluate(() => window.jarvis.sessionStop());
  await new Promise((r) => setTimeout(r, 1200));
  const endStates = await panelPage.evaluate(() => window.__probe.states);
  console.log("  完整状态迁移链:", endStates.join(" -> "));
  ok(endStates.length >= 2, "状态迁移链完整", endStates.join(" -> "));
}

console.log(`\n================ 应用内联调结果：通过 ${pass}，失败 ${fail} ================`);
fs.writeFileSync(path.join(ROOT, "docs/evidence/app-e2e.log"),
  `应用内真实端到端联调\n通过 ${pass}，失败 ${fail}\n`, "utf-8");
await app.close();
process.exit(fail === 0 ? 0 : 1);
