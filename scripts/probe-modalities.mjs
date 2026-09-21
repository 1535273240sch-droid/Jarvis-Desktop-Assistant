/**
 * 定点验证：server_vad 自动响应是否产出音频。
 * 对比「session.update 里带 modalities」与「不带」，确认修复是否有效。
 */
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";

const cfg = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, "jarvis-desktop-assistant", "config.json"), "utf-8"));
const URL = `wss://api.stepfun.com/v1/realtime?model=${encodeURIComponent(cfg.realtimeModel)}`;

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
const silence = (ms) => Buffer.alloc(Math.floor(24000 * ms / 1000) * 2).toString("base64");

async function run(label, withModalities) {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL, { headers: { Authorization: `Bearer ${cfg.apiKey}` } });
    const counts = {};
    let audioBytes = 0, textOut = "";
    ws.on("message", (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      counts[m.type] = (counts[m.type] || 0) + 1;
      if (m.type === "response.audio.delta" && m.delta) audioBytes += Buffer.from(m.delta, "base64").length;
      if (m.type === "response.audio_transcript.delta") textOut += m.delta || "";
      if (m.type === "error") counts.__err = JSON.stringify(m.error).slice(0, 120);
    });
    ws.on("open", () => {
      const session = {
        instructions: "简短回答用户。",
        voice: cfg.voice,
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        turn_detection: { type: "server_vad", silence_duration_ms: 100 },
      };
      if (withModalities) session.modalities = ["text", "audio"];
      ws.send(JSON.stringify({ type: "session.update", session }));
    });
    ws.on("error", () => {});
    setTimeout(async () => {
      // 推语音 + 静音，触发服务端 VAD
      for (let i = 0; i < 4; i++) { ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: speechLike(500) })); await new Promise((r) => setTimeout(r, 420)); }
      for (let i = 0; i < 3; i++) { ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: silence(1000) })); await new Promise((r) => setTimeout(r, 420)); }
    }, 1200);
    setTimeout(() => {
      try { ws.close(); } catch {}
      resolve({ label, counts, audioBytes, textOut: textOut.slice(0, 60) });
    }, 25000);
  });
}

const a = await run("不带 modalities", false);
console.log("=== A. session.update 不带 modalities ===");
console.log("  audio.delta 次数:", a.counts["response.audio.delta"] || 0, "| 音频字节:", a.audioBytes);
console.log("  转录:", JSON.stringify(a.textOut));
console.log("  事件:", JSON.stringify(a.counts));

const b = await run("带 modalities", true);
console.log("\n=== B. session.update 带 modalities: ['text','audio'] ===");
console.log("  audio.delta 次数:", b.counts["response.audio.delta"] || 0, "| 音频字节:", b.audioBytes);
console.log("  转录:", JSON.stringify(b.textOut));
console.log("  事件:", JSON.stringify(b.counts));

console.log("\n=== 结论 ===");
console.log("带 modalities 是否产生音频:", b.audioBytes > 0 ? "是 ✓" : "否 ✗");
console.log("不带 modalities 是否产生音频:", a.audioBytes > 0 ? "是" : "否");
process.exit(0);
