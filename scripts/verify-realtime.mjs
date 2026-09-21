/**
 * 真实语音链路验收：逐项验证 realtime.ts 的假设是否与真实 API 一致。
 *   1. 事件名是否与我实现的一致（尤其 VAD、工具调用）
 *   2. server_vad 模式下 speech_started / speech_stopped 是否真的推送
 *   3. response.cancel（打断）是否有效
 *   4. 工具定义能否下发、模型是否真的发起 function call
 *   5. 30 分钟会话重建所需的会话内上下文回注是否可行
 */
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";

const cfgPath = path.join(process.env.APPDATA || "", "jarvis-desktop-assistant", "config.json");
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
const KEY = cfg.apiKey;
const MODEL = cfg.realtimeModel || "stepaudio-3-realtime-preview";
const VOICE = cfg.voice || "cixingnansheng";
const URL = `wss://api.stepfun.com/v1/realtime?model=${encodeURIComponent(MODEL)}`;

let pass = 0, fail = 0;
const ok = (c, label, extra = "") => {
  if (c) { pass++; console.log(`  ✓ ${label}${extra ? " | " + extra : ""}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? " | " + extra : ""}`); }
};

function pcm16(ms, freq = 440, amp = 8000) {
  const rate = 24000, n = Math.floor(rate * ms / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(2 * Math.PI * freq * i / rate) * amp), i * 2);
  return b.toString("base64");
}
/** 类语音：频率随时间滑动的复合音，更容易被 VAD 判为人声 */
function speechLike(ms) {
  const rate = 24000, n = Math.floor(rate * ms / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const f = 120 + 60 * Math.sin(2 * Math.PI * 1.3 * t) + 20 * Math.sin(2 * Math.PI * 3.7 * t);
    const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 2.2 * t);
    const v = Math.sin(2 * Math.PI * f * t) * 9000 * env
            + Math.sin(2 * Math.PI * f * 2 * t) * 4000 * env;
    b.writeInt16LE(Math.max(-32000, Math.min(32000, Math.round(v))), i * 2);
  }
  return b.toString("base64");
}

function connect(sessionPatch) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL, { headers: { Authorization: `Bearer ${KEY}` } });
    const events = [];
    const seen = new Set();
    const handlers = [];
    const api = {
      ws, events, seen,
      send: (o) => ws.send(JSON.stringify(o)),
      on: (t, fn) => handlers.push([t, fn]),
      waitFor: (type, ms) => new Promise((res) => {
        const t0 = Date.now();
        const iv = setInterval(() => {
          if (seen.has(type)) { clearInterval(iv); res(true); }
          else if (Date.now() - t0 > ms) { clearInterval(iv); res(false); }
        }, 100);
      }),
      close: () => { try { ws.close(); } catch {} },
    };
    ws.on("open", () => {
      const session = { input_audio_format: "pcm16", output_audio_format: "pcm16", voice: sessionPatch?.voice ?? VOICE };
      if (sessionPatch?.turnDetection !== undefined) session.turn_detection = sessionPatch.turnDetection;
      if (sessionPatch?.instructions) session.instructions = sessionPatch.instructions;
      if (sessionPatch?.tools) session.tools = sessionPatch.tools;
      api.send({ type: "session.update", session });
    });
    ws.on("message", (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (!seen.has(m.type)) { seen.add(m.type); }
      events.push(m);
      for (const [t, fn] of handlers) if (t === m.type) fn(m);
    });
    ws.on("error", reject);
    const iv = setInterval(() => {
      if (seen.has("session.created")) { clearInterval(iv); resolve(api); }
    }, 80);
    setTimeout(() => { clearInterval(iv); resolve(api); }, 12000);
  });
}

/* ================= 1. 事件名一致性 ================= */
console.log("=========== 1. 事件名一致性（对照 realtime.ts 的监听列表）===========");
// 注意：server_vad 模式下**不能**发 input_audio_buffer.commit ——
// 实测服务端会返回 error: "commit when server vad" (invalid_request_error)。
// 本应用的 realtime.ts 在 server_vad 下不发 commit（只由服务端自动断句），此处保持一致。
const c1 = await connect({ turnDetection: { type: "server_vad", silence_duration_ms: 100 }, instructions: "简短回答。" });
await c1.waitFor("session.updated", 8000);
// 连续推音频，再推静音，触发服务端 VAD 断句（不手动 commit）
for (let i = 0; i < 4; i++) {
  c1.send({ type: "input_audio_buffer.append", audio: speechLike(500) });
  await new Promise((r) => setTimeout(r, 450));
}
const silence = Buffer.alloc(24000, 0).toString("base64");
for (let i = 0; i < 3; i++) {
  c1.send({ type: "input_audio_buffer.append", audio: silence });
  await new Promise((r) => setTimeout(r, 450));
}
await c1.waitFor("response.done", 60000);
await new Promise((r) => setTimeout(r, 800));

const EXPECTED = [
  "session.created", "session.updated", "response.created", "response.done",
  "response.audio.delta", "response.audio_transcript.delta",
];
console.log("  实际收到事件:", [...c1.seen].join(", "));
for (const e of EXPECTED) ok(c1.seen.has(e), `事件 ${e} 存在`);
const VAD_EVENTS = ["input_audio_buffer.speech_started", "input_audio_buffer.speech_stopped"];
const vadSeen = VAD_EVENTS.filter((e) => c1.seen.has(e));
ok(vadSeen.length === 2, "服务端 VAD 断句事件完整（started + stopped）", vadSeen.join(", ") || "未触发");
c1.close();

/* ================= 2. 打断 ================= */
console.log("\n=========== 2. 打断：response.cancel 是否有效 ==========");
const c2 = await connect({ turnDetection: null, instructions: "请详细解释量子计算，说得越长越好。" });
await c2.waitFor("session.updated", 8000);
c2.send({ type: "input_audio_buffer.append", audio: speechLike(1200) });
c2.send({ type: "input_audio_buffer.commit" });
c2.send({ type: "response.create", response: { modalities: ["text", "audio"] } });

let bytesBefore = 0;
c2.on("response.audio.delta", (m) => { bytesBefore += Buffer.from(m.delta, "base64").length; });
await new Promise((r) => setTimeout(r, 4000));
const gotAudio = bytesBefore > 0;
ok(gotAudio, "打断前已收到音频流", `${bytesBefore} 字节`);

let cancelled = false;
c2.on("response.done", (m) => {
  if (m.response?.status === "cancelled") cancelled = true;
});
const bytesAtCancel = bytesBefore;
c2.send({ type: "response.cancel" });
await new Promise((r) => setTimeout(r, 3000));
const bytesAfterCancel = bytesBefore;
ok(true, "已发送 response.cancel（无异常抛出）");
const delta = bytesAfterCancel - bytesAtCancel;
console.log(`  取消前 ${bytesAtCancel} 字节 -> 取消后 ${bytesAfterCancel} 字节（增量 ${delta}）`);
// 实测：取消后音频立即停止流入（增量≈0）。服务端不一定回传 status:"cancelled"，
// 故以"音频是否真的停了"作为判定依据，而不是以状态字段为准。
ok(gotAudio && delta < bytesAtCancel * 0.2,
   "取消后音频流立即停止（打断有效）",
   `增量 ${delta} 字节，约为取消前的 ${(bytesAtCancel ? (100 * delta / bytesAtCancel).toFixed(1) : "0")}%` + (cancelled ? "；状态字段=cancelled" : "；状态字段未标记 cancelled（不影响打断效果）"));
c2.close();

/* ================= 3. 工具定义与 function call ================= */
console.log("\n=========== 3. 工具定义下发与 function call ==========");
const tools = [{
  type: "function",
  function: {
    name: "look_at_screen",
    description: "查看屏幕内容。当用户询问屏幕上有什么、或有报错时调用。",
    parameters: {
      type: "object",
      properties: { question: { type: "string", description: "想了解什么" } },
      required: ["question"],
    },
  },
}];
const c3 = await connect({
  turnDetection: null,
  instructions: "你是桌面助手。用户要求看屏幕时必须调用 look_at_screen 工具。",
  tools,
});
const updated = await c3.waitFor("session.updated", 10000);
ok(updated, "带 tools 的 session.update 被接受");
c3.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: "帮我看一下屏幕上有什么报错" }] } });
c3.send({ type: "response.create", response: { modalities: ["text", "audio"] } });

let gotFunctionCall = false, fcName = "", fcArgs = "";
c3.on("response.function_call_arguments.done", (m) => { gotFunctionCall = true; fcName = m.name || ""; fcArgs = m.arguments || ""; });
c3.on("response.output_item.done", (m) => {
  if (m.item?.type === "function_call") { gotFunctionCall = true; fcName = fcName || m.item.name; fcArgs = fcArgs || m.item.arguments; }
});
await c3.waitFor("response.done", 40000);
await new Promise((r) => setTimeout(r, 800));
ok(gotFunctionCall, "模型发起了 function call", gotFunctionCall ? `name=${fcName} args=${String(fcArgs).slice(0, 80)}` : "未发起");
if (gotFunctionCall) {
  const re = c3.events.filter((e) => /function_call/.test(e.type)).map((e) => e.type);
  console.log("  函数调用相关事件:", [...new Set(re)].join(", "));
}
c3.close();

/* ================= 4. 上下文回注（会话重建前提）================= */
console.log("\n=========== 4. 上下文回注（30 分钟会话重建的前提）===========");
const c4 = await connect({ turnDetection: null, instructions: "记住用户告诉你的信息。" });
await c4.waitFor("session.updated", 8000);
c4.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: "我叫小明，我最喜欢的颜色是蓝色。" }] } });
c4.send({ type: "conversation.item.create", item: { type: "message", role: "assistant", content: [{ type: "text", text: "好的，小明，我记住了你喜欢蓝色。" }] } });
c4.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: "我最喜欢什么颜色？只答颜色。" }] } });
c4.send({ type: "response.create", response: { modalities: ["text"] } });

let answer = "";
c4.on("response.audio_transcript.delta", (m) => { answer += m.delta || ""; });
c4.on("response.text.delta", (m) => { answer += m.delta || ""; });
await c4.waitFor("response.done", 30000);
await new Promise((r) => setTimeout(r, 600));
ok(/蓝/.test(answer), "回注的历史被模型读到并正确回答", `回答="${answer.replace(/\s+/g, " ").slice(0, 60)}"`);
c4.close();

console.log(`\n================ 结果：通过 ${pass}，失败 ${fail} ================`);
process.exit(fail === 0 ? 0 : 1);
