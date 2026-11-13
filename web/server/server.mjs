// The website's small server: it serves the built site (web/dist) and gives the stream page a voice.
//
//   GET  /say/status   { enabled, chars_left }
//   POST /say          { "text": "..." }  ->  audio/mpeg, the Intern saying that line
//
// The voice comes from ElevenLabs. Its key stays here, in the host's private variables
// (ELEVENLABS_API_KEY or ELEVENLABS_SECRET_KEY, and ELEVENLABS_VOICE_ID); it is never sent to a browser.
// To keep strangers from spending it, /say only speaks lines the Intern can actually say (the templates
// of interface/lines.json), keeps every line it has made, and stops at a daily character cap.
// Plain Node, no packages.
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const DIST = resolve(process.env.SITE_DIR ?? join(here, "..", "dist"));
const LINES = process.env.LINES_FILE ?? [join(here, "..", "lines.json"), join(here, "..", "..", "interface", "lines.json")].find(existsSync);
const CACHE = resolve(process.env.VOICE_CACHE_DIR ?? "/tmp/intern-voice");
const PORT = Number(process.env.PORT ?? 8787);
const KEY = process.env.ELEVENLABS_API_KEY ?? process.env.ELEVENLABS_SECRET_KEY ?? "";
const VOICE = process.env.ELEVENLABS_VOICE_ID ?? "";
const MODEL = process.env.ELEVENLABS_MODEL_ID ?? "eleven_multilingual_v2";
const DAILY_CHARS = Number(process.env.VOICE_DAILY_CHARS ?? 20000);
const MAX_TEXT = 260;
const PER_ADDRESS_PER_MINUTE = 12;

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".csv": "text/csv; charset=utf-8",
  ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".mp4": "video/mp4", ".webm": "video/webm", ".moc3": "application/octet-stream",
};

// ---------------------------------------------------------------- which lines may be spoken

/** Every line the Intern can say, as a pattern: the words of lines.json with any short value in each {placeholder}. */
function allowedLines() {
  if (!LINES) return [];
  const found = [];
  const json = JSON.parse(readFileSync(LINES, "utf8"));
  // by_kind and by_cleared hold their lines directly under each key
  const lift = (v, inside) => {
    if (typeof v === "string") return void (inside && found.push(v));
    if (Array.isArray(v)) return void v.forEach((x) => lift(x, inside));
    if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) lift(x, inside || k === "intern" || k === "first_note" || k === "by_kind" || k === "by_cleared");
  };
  lift({ events: json.events, refusals: json.refusals }, false);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...new Set(found)].map((t) => {
    const body = t.split(/\{[a-z_]+\}/).map(esc).join("[^\\n]{1,48}");
    // the first letter may be capitalised by the cue builder, and a "first of its kind" note may follow
    return new RegExp(`^${body.replace(/^([a-z])/, (m) => `[${m}${m.toUpperCase()}]`)}(?: [^\\n]{1,120})?$`, "u");
  });
}
const PATTERNS = allowedLines();
const mayBeSaid = (text) => PATTERNS.some((p) => p.test(text));

// ---------------------------------------------------------------- limits

let day = "";
let spent = 0;
function charsLeft() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) {
    day = today;
    spent = 0;
  }
  return Math.max(0, DAILY_CHARS - spent);
}
const hits = new Map();
function tooFast(address) {
  const now = Date.now();
  const list = (hits.get(address) ?? []).filter((t) => now - t < 60_000);
  list.push(now);
  hits.set(address, list);
  if (hits.size > 5000) hits.clear();
  return list.length > PER_ADDRESS_PER_MINUTE;
}

// ---------------------------------------------------------------- the voice

const making = new Map();
async function voiceFor(text) {
  const file = join(CACHE, `${createHash("sha256").update(`${VOICE}:${MODEL}:${text}`).digest("hex")}.mp3`);
  if (existsSync(file)) return file;
  if (making.has(file)) return making.get(file);
  const job = (async () => {
    if (charsLeft() < text.length) throw Object.assign(new Error("Today's voice allowance is used up."), { status: 429 });
    spent += text.length;
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(VOICE)}?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "xi-api-key": KEY, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: MODEL }),
    });
    if (!res.ok) {
      const why = (await res.text()).slice(0, 200);
      console.error(`voice: ElevenLabs answered ${res.status}: ${why}`);
      throw Object.assign(new Error("The voice service refused the line."), { status: 502 });
    }
    mkdirSync(CACHE, { recursive: true });
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    return file;
  })().finally(() => making.delete(file));
  making.set(file, job);
  return job;
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function say(req, res) {
  if (!KEY || !VOICE) return json(res, 503, { error: "No voice is set up on this server." });
  const address = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",")[0].trim();
  if (tooFast(address)) return json(res, 429, { error: "Too many lines at once. Try again in a minute." });
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 4000) return json(res, 413, { error: "Too long." });
  }
  let text;
  try {
    text = String(JSON.parse(raw).text ?? "").trim();
  } catch {
    return json(res, 400, { error: "Send JSON with a text field." });
  }
  if (!text || text.length > MAX_TEXT) return json(res, 400, { error: "A line is 1 to 260 characters." });
  if (!mayBeSaid(text)) return json(res, 400, { error: "That is not one of the Intern's lines." });
  try {
    const file = await voiceFor(text);
    res.writeHead(200, { "content-type": "audio/mpeg", "content-length": statSync(file).size, "cache-control": "public, max-age=604800" });
    createReadStream(file).pipe(res);
  } catch (e) {
    json(res, e.status ?? 500, { error: e.message });
  }
}

// ---------------------------------------------------------------- the site

function sendFile(res, file, status = 200) {
  const type = TYPES[extname(file)] ?? "application/octet-stream";
  const hashed = file.includes(`${join(DIST, "assets")}`);
  res.writeHead(status, {
    "content-type": type,
    "content-length": statSync(file).size,
    "cache-control": hashed ? "public, max-age=31536000, immutable" : type.startsWith("text/html") || file.includes("proof") || file.endsWith("shadow-run.json") ? "no-cache" : "public, max-age=3600",
    "x-content-type-options": "nosniff",
  });
  createReadStream(file).pipe(res);
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://site");
  if (url.pathname === "/say/status") return json(res, 200, { enabled: !!KEY && !!VOICE, chars_left: KEY && VOICE ? charsLeft() : 0 });
  if (url.pathname === "/say") return req.method === "POST" ? void say(req, res) : json(res, 405, { error: "POST a line." });
  if (url.pathname === "/healthz") return json(res, 200, { ok: true });
  if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "Read only." });
  let path;
  try {
    path = normalize(decodeURIComponent(url.pathname));
  } catch {
    return json(res, 400, { error: "Bad address." });
  }
  const file = join(DIST, path);
  if (!file.startsWith(DIST)) return json(res, 400, { error: "Bad address." });
  if (existsSync(file) && statSync(file).isFile()) return sendFile(res, file);
  // A missing file with an extension is a real 404; anything else is a page of the site
  if (extname(path)) return json(res, 404, { error: "Not found." });
  sendFile(res, join(DIST, "index.html"));
}).listen(PORT, () => {
  console.log(`intern-web: serving ${DIST} on port ${PORT}; voice ${KEY && VOICE ? `on (${PATTERNS.length} lines, ${DAILY_CHARS} characters a day)` : "off"}`);
});
