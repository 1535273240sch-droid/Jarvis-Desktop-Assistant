/**
 * 找出可用的实时语音 voice ID。
 * 策略：先用不带 voice 的 session.update 确认音频流程通；再逐个试候选音色名。
 */
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";

const cfgPath = path.join(process.env.APPDATA || "", "jarvis-desktop-assistant", "config.json");
const key = JSON.parse(fs.readFileSync(cfgPath, "utf-8")).apiKey;

const BASE = "/v1";
const MODEL = "stepaudio-3-realtime-preview";

function makePcm16Base64(ms, freq) {
  const rate = 24000, n = Math.floor((rate * ms) / 1000);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 8000), i * 2);
  return buf.toString("base64");
}

/** voice 传 null 表示不带 voice 字段 */
function run(voice, timeoutMs = 40000) {
  return new Promise((resolve) => {
    const out = { voice, events: [], audioBytes: 0, transcript: "", text: "", error: null, ok: false };
    let settled = false;
    const ws = new WebSocket(`wss://api.stepfun.com${BASE}/realtime?model=${encodeURIComponent(MODEL)}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    const finish = (note) => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve({ ...out, note });
    };
    const timer = setTimeout(() => finish("超时"), timeoutMs);

    ws.on("error", (e) => { out.error = e.message; finish("WS 错误"); });
    ws.on("close", (c) => { if (!settled) finish("关闭 " + c); });
    ws.on("message", (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      out.events.push(m.type);

      if (m.type === "session.created") {
        const session = { input_audio_format: "pcm16", output_audio_format: "pcm16", turn_detection: null };
        if (voice) session.voice = voice;
        ws.send(JSON.stringify({ type: "session.update", session }));
      }
      if (m.type === "session.updated") {
        ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: makePcm16Base64(800, 440) }));
        ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        ws.send(JSON.stringify({ type: "response.create", response: { modalities: ["text", "audio"] } }));
      }
      if (m.type === "response.audio.delta" && m.delta) out.audioBytes += Buffer.from(m.delta, "base64").length;
      if (m.type === "response.audio_transcript.delta" && m.delta) out.transcript += m.delta;
      if (m.type === "response.text.delta" && m.delta) out.text += m.delta;
      if (m.type === "error") {
        out.error = JSON.stringify(m.error || m).slice(0, 220);
        finish("服务端错误");
      }
      if (m.type === "response.done") setTimeout(() => finish("完成"), 1500);
    });
  });
}

console.log("=========== A. 不带 voice，验证音频流程是否通 ===========");
const noVoice = await run(null);
console.log(`结果: ${noVoice.note}`);
console.log(`音频: ${noVoice.audioBytes} 字节 | 转录: "${(noVoice.transcript || noVoice.text).slice(0, 100)}"`);
if (noVoice.error) console.log(`错误: ${noVoice.error}`);
console.log(`事件: ${noVoice.events.slice(0, 14).join(" -> ")}`);
const audioPipelineWorks = noVoice.audioBytes > 0;

console.log("\n=========== B. 逐个试候选音色 ===========");
const CANDIDATES = [
  "cangshubao",      // 之前失败
  "qiuqiu",
  "cixingnansheng",
  "zhengpaiqingnian",
  "shenyunxiaoyan",
  "sweetlady",
  "qingxin",
  "qingnian",
  "nansheng",
  "nvsheng",
  "yujie",
  "shaonv",
  "tongzhen",
  "jingdian",
  "boy",
  "girl",
  "alloy",
  "echo",
  "shimmer",
];
const valid = [];
for (const v of CANDIDATES) {
  const r = await run(v, 25000);
  const ok = r.audioBytes > 0;
  const voiceErr = r.error && /voice/i.test(r.error);
  console.log(`${ok ? "✓" : voiceErr ? "✗" : "?"} ${v.padEnd(18)} 音频=${String(r.audioBytes).padStart(7)}B  ${r.error ? r.error.slice(0, 90) : ""}`);
  if (ok) valid.push(v);
  if (valid.length >= 3) break;
}

console.log("\n=========== 结论 ===========");
console.log("音频流程可用:", audioPipelineWorks ? "是" : "否");
console.log("可用音色:", valid.length ? valid.join(", ") : "（未找到，可省略 voice 字段）");
