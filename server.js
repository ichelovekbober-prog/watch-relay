// Локальный relay для часов в Termux (Android). Слушает 0.0.0.0:3000.
// Часы подключаются к Wi-Fi-точке телефона (адрес 192.168.43.1) по обычному http.
const http = require("http");
const fs = require("fs");
const path = require("path");
const SECRET = process.env.RELAY_SECRET || "eKvz5tlYf2nupKjvfTAEgZhX3lN1";
const PORT = Number(process.env.PORT) || 3000;
const CHAT_URL = process.env.CHAT_URL || "https://anymodel.org/v1/chat/completions";
const NTFY = process.env.NTFY_BASE || "https://ntfy.sh";
const TOPICS = { notes: "wnote-xdmiwebvnas638", photos: "wphoto-8kxn9xx02hrk7b" };
const ANY_KEY_DEFAULT = process.env.ANYMODEL_KEY || "";
const DEADLINE_MS = Number(process.env.DEADLINE_MS) || 7000;

function send(res, code, body, type) {
  res.writeHead(code, { "Content-Type": type || "application/json; charset=utf-8" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((ok, bad) => {
    let d = ""; req.on("data", c => { d += c; if (d.length > 2e6) req.destroy(); });
    req.on("end", () => ok(d)); req.on("error", bad);
  });
}
function authOK(req) { return req.headers["x-relay-secret"] === SECRET; }

// ---- чат: потоковое чтение, отдаём то, что успели за DEADLINE_MS ----
async function chat(req, res) {
  if (req.method !== "POST") return send(res, 405, "POST only", "text/plain");
  if (!authOK(req)) return send(res, 401, "unauthorized", "text/plain");
  const auth = req.headers["authorization"] || "";
  const key = (auth.indexOf("Bearer ") === 0 ? auth.slice(7) : "") || req.headers["x-anymodel-key"] || ANY_KEY_DEFAULT;
  if (!key) return send(res, 500, { error: { message: "Ключ AnyModel не задан" } });
  let body; try { body = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, "bad json", "text/plain"); }
  if (!body || !Array.isArray(body.messages)) return send(res, 400, "messages required", "text/plain");
  const model = String(body.model || "ds/deepseek-v4-flash");
  if (model.indexOf("ds/") !== 0) return send(res, 400, { error: { message: "Разрешены только модели ds/..." } });
  const maxTokens = Math.min(Number(body.max_tokens) || 700, 4096);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DEADLINE_MS);
  const go = extra => fetch(CHAT_URL, { method: "POST", signal: ctrl.signal,
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify(Object.assign({ model, messages: body.messages, max_tokens: maxTokens, stream: true }, extra || {})) });
  let text = "", finished = false, reason = "", buf = "";
  try {
    let r = await go({ thinking: { type: "disabled" } });
    if (r.status === 400 || r.status === 422) r = await go();
    if (r.status !== 200) { clearTimeout(timer); return send(res, r.status, await r.text()); }
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    if (ct.indexOf("text/event-stream") < 0) { clearTimeout(timer); return send(res, 200, await r.text()); }
    const dec = new TextDecoder();
    try {
      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (line.indexOf("data:") !== 0) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") { finished = true; continue; }
          try {
            const j = JSON.parse(data), c = j.choices && j.choices[0];
            if (c && c.delta && typeof c.delta.content === "string") text += c.delta.content;
            if (c && c.finish_reason) { finished = true; reason = c.finish_reason; }
          } catch (e) {}
        }
      }
    } catch (e) {}
    clearTimeout(timer);
    const truncated = !finished || reason === "length";
    return send(res, 200, { relay_truncated: truncated, choices: [{ message: { role: "assistant", content: text }, finish_reason: truncated ? "length" : "stop" }] });
  } catch (e) {
    clearTimeout(timer);
    return send(res, 502, { error: { message: "AnyModel недоступен: " + (e && e.name === "AbortError" ? "таймаут" : e.message) } });
  }
}

// ---- ntfy: заметки и фото; ответ режем по размеру ----
async function ntfy(req, res, q) {
  if (!authOK(req)) return send(res, 401, "unauthorized", "text/plain");
  const topic = TOPICS[q.get("t") === "photos" ? "photos" : "notes"];
  const since = (q.get("since") || "all").replace(/[^A-Za-z0-9_-]/g, "") || "all";
  const limit = Math.min(Number(q.get("limit")) || 30000, 30000);
  try {
    const r = await fetch(NTFY + "/" + topic + "/json?poll=1&since=" + since);
    let text = await r.text();
    if (text.length > limit) {
      let out = "", n = 0;
      for (const line of text.split("\n")) {
        if (!line) continue;
        if (n > 0 && out.length + line.length + 1 > limit) break;
        out += line + "\n"; n++;
      }
      text = out;
    }
    return send(res, r.status, text, "text/plain; charset=utf-8");
  } catch (e) { return send(res, 502, "ntfy unavailable", "text/plain"); }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/" ) {
      return send(res, 200, fs.readFileSync(path.join(__dirname, "send.html"), "utf8"), "text/html; charset=utf-8");
    }
    if (url.pathname === "/api/ping") return send(res, 200, "ok", "text/plain");
    if (url.pathname === "/api/chat") return chat(req, res);
    if (url.pathname === "/api/ntfy") return ntfy(req, res, url.searchParams);
    send(res, 404, "not found", "text/plain");
  } catch (e) { send(res, 500, "server error", "text/plain"); }
});
server.listen(PORT, "0.0.0.0", () => console.log("relay on http://0.0.0.0:" + PORT));
