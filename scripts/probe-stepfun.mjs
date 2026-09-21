/**
 * StepFun 连通性探测：验证 API Key、可用模型、实时语音 WS 握手、视觉接口。
 * Key 从 %APPDATA%\jarvis-desktop-assistant\config.json 读取（不进代码、不进日志）。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const cfgPath = path.join(
  process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
  "jarvis-desktop-assistant",
  "config.json"
);
if (!fs.existsSync(cfgPath)) {
  console.error("配置文件不存在:", cfgPath);
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
const key = cfg.apiKey;
if (!key) {
  console.error("配置里没有 apiKey");
  process.exit(1);
}
const mask = (s) => (s ? s.slice(0, 6) + "..." + s.slice(-4) : "(空)");
console.log("Key:", mask(key));
console.log("Base:", cfg.realtimeBaseUrl);

const ORIGIN = "https://api.stepfun.com";
const PATHS = ["/step_plan/v1", "/v1"];

async function tryJson(url) {
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    const txt = await r.text();
    let j = null;
    try { j = JSON.parse(txt); } catch { /* 非 JSON */ }
    return { status: r.status, ok: r.ok, json: j, text: txt.slice(0, 300) };
  } catch (e) {
    return { status: -1, ok: false, error: e.message };
  }
}

console.log("\n================ 1. 模型列表 ================");
for (const p of PATHS) {
  const r = await tryJson(`${ORIGIN}${p}/models`);
  console.log(`\nGET ${p}/models -> ${r.status}`);
  if (r.ok && r.json?.data) {
    const ids = r.json.data.map((m) => m.id).sort();
    console.log("  可用模型 " + ids.length + " 个:");
    for (const id of ids) console.log("   -", id);
  } else {
    console.log("  " + (r.text || r.error || "").replace(/\s+/g, " ").slice(0, 200));
  }
}

console.log("\n================ 2. 文本对话（验证鉴权）================");
for (const p of PATHS) {
  const body = {
    model: "step-1o-turbo",
    messages: [{ role: "user", content: "只回复两个字：你好" }],
    max_tokens: 20,
  };
  try {
    const r = await fetch(`${ORIGIN}${p}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
    const t = await r.text();
    console.log(`\nPOST ${p}/chat/completions -> ${r.status}`);
    console.log("  " + t.replace(/\s+/g, " ").slice(0, 260));
  } catch (e) {
    console.log(`\nPOST ${p}/chat/completions -> 异常: ${e.message}`);
  }
}

console.log("\n================ 3. 实时语音 WebSocket 握手 ================");
const WS_PATHS = ["/step_plan/v1/realtime", "/v1/realtime"];
const MODELS = ["stepaudio-3-realtime-preview", "stepaudio-2.5-realtime", "step-1o-audio"];

const { default: WebSocket } = await import("ws");

function wsProbe(url, model, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const full = `${url}?model=${encodeURIComponent(model)}`;
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    let ws;
    try {
      ws = new WebSocket(full, { headers: { Authorization: `Bearer ${key}` } });
    } catch (e) {
      return done({ ok: false, note: "构造失败: " + e.message });
    }
    const timer = setTimeout(() => { try { ws.close(); } catch {} done({ ok: false, note: "超时（未收到 session.created）" }); }, timeoutMs);

    const events = [];
    ws.on("open", () => { events.push("open"); });
    ws.on("message", (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      events.push(m.type || "?");
      if (m.type === "session.created") {
        clearTimeout(timer);
        const sid = m.session?.id;
        // 发一个 session.update 验证双向通信
        try {
          ws.send(JSON.stringify({
            type: "session.update",
            session: { instructions: "你是测试助手", input_audio_format: "pcm16", output_audio_format: "pcm16" },
          }));
          events.push("sent:session.update");
        } catch {}
        setTimeout(() => { try { ws.close(); } catch {} done({ ok: true, note: "握手成功 session=" + sid, events }); }, 1800);
      }
      if (m.type === "error") {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        done({ ok: false, note: "服务端错误: " + JSON.stringify(m.error || m).slice(0, 200), events });
      }
    });
    ws.on("error", (e) => { clearTimeout(timer); done({ ok: false, note: "WS 错误: " + e.message, events }); });
    ws.on("close", (code, reason) => {
      clearTimeout(timer);
      done({ ok: false, note: `关闭 code=${code} ${reason?.toString?.() || ""}`.trim(), events });
    });
  });
}

for (const wp of WS_PATHS) {
  for (const model of MODELS) {
    const url = `wss://api.stepfun.com${wp}`;
    const r = await wsProbe(url, model);
    const mark = r.ok ? "✓" : "✗";
    console.log(`${mark} ${wp} | ${model}`);
    console.log(`    ${r.note}`);
    if (r.events && r.events.length) console.log("    事件: " + r.events.join(" -> "));
    if (r.ok) break; // 该路径通了就不再试其它模型
  }
}

console.log("\n================ 4. 视觉接口（图像输入）================");
const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
for (const p of PATHS) {
  for (const model of ["step-5-preview", "step-3.7-flash"]) {
    const body = {
      model,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "这张图是什么颜色？只答颜色。" },
          { type: "image_url", image_url: { url: `data:image/png;base64,${tinyPng}` } },
        ],
      }],
      max_tokens: 30,
    };
    try {
      const r = await fetch(`${ORIGIN}${p}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      });
      const t = await r.text();
      const ok = r.status === 200;
      console.log(`${ok ? "✓" : "✗"} ${p} | ${model} -> ${r.status}`);
      if (ok) {
        let j; try { j = JSON.parse(t); } catch {}
        console.log("    回答: " + (j?.choices?.[0]?.message?.content ?? "").toString().replace(/\s+/g, " ").slice(0, 120));
      } else {
        console.log("    " + t.replace(/\s+/g, " ").slice(0, 200));
      }
    } catch (e) {
      console.log(`✗ ${p} | ${model} -> 异常 ${e.message}`);
    }
  }
}
