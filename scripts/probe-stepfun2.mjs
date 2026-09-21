/**
 * 深度验证：在真实可用模型上做「文本对话 + 音频往返」，
 * 确定应用应采用的通道与模型组合。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import WebSocket from "ws";

const cfgPath = path.join(process.env.APPDATA || "", "jarvis-desktop-assistant", "config.json");
const key = JSON.parse(fs.readFileSync(cfgPath, "utf-8")).apiKey;
const ORIGIN = "https://api.stepfun.com";

const mask = (s) => s.slice(0, 6) + "..." + s.slice(-4);
console.log("Key:", mask(key), "\n");

/* ---------- 1. 文本对话：找出真正可用的对话模型 ---------- */

async function chat(base, model, content) {
  const r = await fetch(`${ORIGIN}${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content }],
      max_tokens: 200,
    }),
  });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch {}
  const msg = j?.choices?.[0]?.message;
  const answer = msg?.content ?? msg?.reasoning_content ?? "";
  return { status: r.status, answer: String(answer).replace(/\s+/g, " ").trim(), raw: t.slice(0, 200) };
}

console.log("========== 1. 文本对话可用性（挑一个能用的）==========");
const textCandidates = [
  ["/step_plan/v1", "step-5-preview"],
  ["/step_plan/v1", "step-3.7-flash"],
  ["/step_plan/v1", "step-3.5-flash"],
  ["/v1", "step-3.7-flash"],
];
let workingChat = null;
for (const [base, model] of textCandidates) {
  const r = await chat(base, model, "只回复两个字：你好");
  const ok = r.status === 200 && r.answer.length > 0;
  console.log(`${ok ? "✓" : "✗"} ${base} | ${model} -> ${r.status} | "${r.answer.slice(0, 60)}"`);
  if (!ok && r.status !== 200) console.log("    " + r.raw.replace(/\s+/g, " ").slice(0, 150));
  if (ok && !workingChat) workingChat = { base, model };
}

/* ---------- 2. 视觉：确认能读到图像内容 ---------- */

console.log("\n========== 2. 视觉（图像输入）==========");
// 造一张纯红色 32x32 PNG，看模型能否说出颜色
import zlib from "node:zlib";
function makeRedPng(size = 32) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 3 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < size; x++) {
      const p = rowStart + 1 + x * 3;
      raw[p] = 220; raw[p + 1] = 20; raw[p + 2] = 20; // 红
    }
  }
  const chunks = [];
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const crcTable = (() => {
    const t = [];
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  chunks.push(sig, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(chunks);
}
const redPng = makeRedPng(32);
console.log("测试图: 32x32 纯红 PNG,", redPng.length, "字节");

async function vision(base, model) {
  const r = await fetch(`${ORIGIN}${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "这张图片主要是什么颜色？只回答颜色名称。" },
          { type: "image_url", image_url: { url: `data:image/png;base64,${redPng.toString("base64")}` } },
        ],
      }],
      max_tokens: 300,
    }),
  });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch {}
  const m = j?.choices?.[0]?.message;
  return { status: r.status, answer: String(m?.content ?? m?.reasoning_content ?? "").replace(/\s+/g, " ").trim(), raw: t.slice(0, 200) };
}

let workingVision = null;
for (const [base, model] of [["/step_plan/v1", "step-5-preview"], ["/step_plan/v1", "step-3.7-flash"], ["/v1", "step-5-preview"]]) {
  const r = await vision(base, model);
  const ok = r.status === 200 && r.answer.length > 0;
  console.log(`${ok ? "✓" : "✗"} ${base} | ${model} -> ${r.status} | "${r.answer.slice(0, 80)}"`);
  if (!ok) console.log("    " + r.raw.replace(/\s+/g, " ").slice(0, 150));
  if (ok && !workingVision) workingVision = { base, model };
}

/* ---------- 3. 实时语音：真实音频往返 ---------- */

console.log("\n========== 3. 实时语音：真实音频往返 ==========");
function makePcm16Base64(ms, freq) {
  const rate = 24000, n = Math.floor((rate * ms) / 1000);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 8000);
    buf.writeInt16LE(v, i * 2);
  }
  return buf.toString("base64");
}

function realtimeTest(base, model, timeoutMs = 45000) {
  return new Promise((resolve) => {
    const out = { events: [], audioBytes: 0, transcript: "", text: "", error: null };
    let settled = false;
    const finish = (note) => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve({ ...out, note });
    };
    const ws = new WebSocket(`wss://api.stepfun.com${base}/realtime?model=${encodeURIComponent(model)}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    const timer = setTimeout(() => finish("超时"), timeoutMs);

    ws.on("open", () => out.events.push("open"));
    ws.on("error", (e) => { out.error = e.message; finish("WS 错误: " + e.message); });
    ws.on("close", (c) => { if (!settled) finish("关闭 code=" + c); });

    ws.on("message", (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (out.events.length < 40) out.events.push(m.type);

      if (m.type === "session.created") {
        ws.send(JSON.stringify({
          type: "session.update",
          session: {
            instructions: "你是语音测试助手。用户会给你音频，请用中文简短回应你听到了什么。",
            voice: "cangshubao",
            input_audio_format: "pcm16",
            output_audio_format: "pcm16",
            turn_detection: null, // 手动模式，便于控制
          },
        }));
      }
      if (m.type === "session.updated") {
        // 送 1 秒 440Hz 正弦音频，然后提交并请求回复
        ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: makePcm16Base64(1000, 440) }));
        ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        ws.send(JSON.stringify({ type: "response.create", response: { modalities: ["text", "audio"] } }));
        out.events.push("sent:audio+commit+create");
      }
      if (m.type === "response.audio.delta" && m.delta) out.audioBytes += Buffer.from(m.delta, "base64").length;
      if (m.type === "response.audio_transcript.delta" && m.delta) out.transcript += m.delta;
      if (m.type === "response.text.delta" && m.delta) out.text += m.delta;
      if (m.type === "error") { out.error = JSON.stringify(m.error || m).slice(0, 200); out.events.push("ERROR"); }
      if (m.type === "response.done") setTimeout(() => finish("完成"), 1200);
    });
  });
}

for (const [base, model] of [["/step_plan/v1", "stepaudio-2.5-realtime"], ["/v1", "stepaudio-3-realtime-preview"]]) {
  console.log(`\n--- ${base} | ${model} ---`);
  const r = await realtimeTest(base, model);
  const audioOk = r.audioBytes > 0;
  console.log(`${audioOk ? "✓" : "✗"} 结果: ${r.note}`);
  console.log(`    收到音频: ${r.audioBytes} 字节 ${audioOk ? "（模型确实回了语音）" : ""}`);
  console.log(`    转录: "${(r.transcript || r.text || "").replace(/\s+/g, " ").slice(0, 120)}"`);
  if (r.error) console.log(`    错误: ${r.error}`);
  console.log(`    事件: ${r.events.slice(0, 16).join(" -> ")}`);
}

console.log("\n========== 结论 ==========");
console.log("建议配置:");
console.log("  文本/视觉 :", workingChat ? `${workingChat.base} | ${workingChat.model}` : "未找到");
console.log("  视觉理解  :", workingVision ? `${workingVision.base} | ${workingVision.model}` : "未找到");
