/**
 * 定点排查两个失败项：
 *   A. response.audio.delta / response.audio_transcript.delta 在本轮未被记录（但第 2 组收到了音频）
 *   B. server_vad 模式下 speech_stopped 是否真的推送
 *   C. 同时确认「client_websocket_error」这条 error 是什么
 */
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";

const cfg = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, "jarvis-desktop-assistant", "config.json"), "utf-8"));
const KEY = cfg.apiKey;
const MODEL = cfg.realtimeModel || "stepaudio-3-realtime-preview";
const VOICE = cfg.voice;
const URL = `wss://api.stepfun.com/v1/realtime?model=${encodeURIComponent(MODEL)}`;

function speechLike(ms) {
  const rate = 24000, n = Math.floor(rate * ms / 1000), b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const f = 120 + 60 * Math.sin(2 * Math.PI * 1.3 * t) + 20 * Math.sin(2 * Math.PI * 3.7 * t);
    const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 2.2 * t);
    const v = Math.sin(2 * Math.PI * f * t) * 9000 * env + Math.sin(2 * Math.PI * f * 2 * t) * 4000 * env;
    b.writeInt16LE(Math.max(-32000, Math.min(32000, Math.round(v))), i * 2);
  }
  return b.toString("base64");
}

function connect(patch = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL, { headers: { Authorization: `Bearer ${KEY}` } });
    const counts = {};          // 事件类型 -> 次数
    const order = [];           // 事件顺序（去重前）
    const firstPayload = {};    // 每个类型第一条载荷片段
    const handlers = [];
    let sessionId = null;
    ws.on("open", () => {
      const session = { input_audio_format: "pcm16", output_audio_format: "pcm16", voice: VOICE };
      Object.assign(session, patch.session || {});
      ws.send(JSON.stringify({ type: "session.update", session }));
    });
    ws.on("message", (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      counts[m.type] = (counts[m.type] || 0) + 1;
      if (order.length < 200) order.push(m.type);
      if (!firstPayload[m.type]) firstPayload[m.type] = JSON.stringify(m).slice(0, 400);
      if (m.type === "session.created") sessionId = m.session?.id;
      for (const [t, fn] of handlers) if (t === m.type) fn(m);
    });
    ws.on("error", () => {});
    const iv = setInterval(() => { if (sessionId) { clearInterval(iv); resolve(api); } }, 80);
    const api = {
      ws, counts, order, firstPayload,
      send: (o) => ws.send(JSON.stringify(o)),
      on: (t, fn) => handlers.push([t, fn]),
      close: () => { try { ws.close(); } catch {} },
    };
    setTimeout(() => { clearInterval(iv); resolve(api); }, 12000);
  });
}

/* ============ A. server_vad 模式：只推音频，不 commit，看 VAD 事件 ============ */
console.log("========== A. server_vad：speech_started / speech_stopped ==========");
const a = await connect({
  session: { turn_detection: { type: "server_vad", prefix_padding_ms: 500, silence_duration_ms: 100, energy_awakeness_threshold: 2500 }, instructions: "简短回答。" },
});
await new Promise((r) => setTimeout(r, 1200));
// 连续推 3 秒"语音"
for (let i = 0; i < 6; i++) { a.send({ type: "input_audio_buffer.append", audio: speechLike(500) }); await new Promise((r) => setTimeout(r, 500)); }
// 之后推静音，触发 silence_duration 判定
const silence = Buffer.alloc(24000, 0).toString("base64");
for (let i = 0; i < 4; i++) { a.send({ type: "input_audio_buffer.append", audio: silence }); await new Promise((r) => setTimeout(r, 500)); }
await new Promise((r) => setTimeout(r, 6000));
console.log("  事件计数:", JSON.stringify(a.counts, null, 1));
console.log("  speech_started 载荷:", a.firstPayload["input_audio_buffer.speech_started"] || "(未收到)");
console.log("  speech_stopped 载荷:", a.firstPayload["input_audio_buffer.speech_stopped"] || "(未收到)");
a.close();

/* ============ B. 音频/转录增量事件是否真的推送 ============ */
console.log("\n========== B. 音频与转录增量事件 ==========");
const b = await connect({ session: { turn_detection: null, instructions: "请用一句话简短回答，并说出这是语音回复。" } });
await new Promise((r) => setTimeout(r, 1500));
b.send({ type: "input_audio_buffer.append", audio: speechLike(1200) });
b.send({ type: "input_audio_buffer.commit" });
b.send({ type: "response.create", response: { modalities: ["text", "audio"] } });
await new Promise((r) => setTimeout(r, 12000));
const audioDeltaN = b.counts["response.audio.delta"] || 0;
const transcriptN = (b.counts["response.audio_transcript.delta"] || 0) + (b.counts["response.text.delta"] || 0);
console.log("  response.audio.delta 次数:", audioDeltaN);
console.log("  response.audio_transcript.delta 次数:", b.counts["response.audio_transcript.delta"] || 0);
console.log("  response.text.delta 次数:", b.counts["response.text.delta"] || 0);
console.log("  全部事件:", JSON.stringify(b.counts));
console.log("  audio.delta 首条载荷:", (b.firstPayload["response.audio.delta"] || "(未收到)").slice(0, 200));
console.log("  transcript.delta 首条载荷:", (b.firstPayload["response.audio_transcript.delta"] || "(未收到)").slice(0, 200));
b.close();

/* ============ C. error 事件到底是什么 ============ */
console.log("\n========== C. 第 1 组里出现的 error 是什么 ==========");
const c = await connect({ session: { turn_detection: { type: "server_vad", silence_duration_ms: 100 }, instructions: "简短回答。" } });
await new Promise((r) => setTimeout(r, 1200));
c.send({ type: "input_audio_buffer.append", audio: speechLike(1500) });
await new Promise((r) => setTimeout(r, 3000));
c.send({ type: "input_audio_buffer.commit" });
c.send({ type: "response.create", response: { modalities: ["text", "audio"] } });
await new Promise((r) => setTimeout(r, 10000));
console.log("  error 载荷:", c.firstPayload["error"] || "(未收到)");
console.log("  事件:", JSON.stringify(c.counts));
c.close();

console.log("\n========== D. 打断：cancel 后是否立刻停 ==========");
const d = await connect({ session: { turn_detection: null, instructions: "请非常详细地解释量子纠缠，越长越好。" } });
await new Promise((r) => setTimeout(r, 1500));
d.send({ type: "input_audio_buffer.append", audio: speechLike(1000) });
d.send({ type: "input_audio_buffer.commit" });
d.send({ type: "response.create", response: { modalities: ["text", "audio"] } });
let n1 = 0, n2 = 0, cancelledSeen = null;
d.on("response.audio.delta", () => { n1++; if (cancelledSeen !== null) n2++; });
d.on("response.done", (m) => { if (m.response?.status === "cancelled") cancelledSeen = true; });
await new Promise((r) => setTimeout(r, 4000));
console.log(`  取消前 audio.delta = ${n1}`);
d.send({ type: "response.cancel" });
cancelledSeen = cancelledSeen || false;
await new Promise((r) => setTimeout(r, 5000));
console.log(`  取消后新增 audio.delta = ${n2}`);
console.log(`  response.done 状态为 cancelled: ${cancelledSeen}`);
console.log(`  结论: ${n1 > 0 && n2 <= 2 ? "✓ 打断有效（取消后几乎不再推音频）" : "✗ 打断后仍在推音频，需处理"}`);
d.close();

process.exit(0);
