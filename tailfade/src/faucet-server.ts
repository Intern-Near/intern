import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { Faucet } from "./faucet.ts";
import { fromHex } from "./hash.ts";
import { hlAddressOf } from "./mpc.ts";

// The Tail or Fade faucet's HTTP door (docs/TAILFADE.md). Environment:
//   FAUCET_HL_PRIVATE_KEY  the owner's Hyperliquid TESTNET key (0x + 64 hex). Without it the server runs and says so.
//   FAUCET_USD (30), FAUCET_MAX (30), DATA_DIR (./data), PORT (8080), NEAR_RPC_URL, FAUCET_SALT (random).

function keyFromEnv(): Uint8Array | null {
  const raw = process.env.FAUCET_HL_PRIVATE_KEY?.trim();
  if (!raw) return null;
  const k = fromHex(raw);
  if (k.length !== 32) throw new Error("FAUCET_HL_PRIVATE_KEY must be 32 bytes of hex");
  return k;
}

const whole = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) ? Number(v) : d);
const faucet = new Faucet({
  key: keyFromEnv(),
  file: join(process.env.DATA_DIR || "data", "grants.jsonl"),
  usd: whole(process.env.FAUCET_USD, 30),
  maxAccounts: whole(process.env.FAUCET_MAX, 30),
  salt: process.env.FAUCET_SALT || randomBytes(16).toString("hex"),
  ...(process.env.NEAR_RPC_URL ? { rpc: process.env.NEAR_RPC_URL } : {}),
});

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const parts: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 4096) throw new Error("body too large");
    parts.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(parts).toString("utf8"));
}

const log = (f: Record<string, unknown>) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), ...f }));

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://x");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method === "GET" && path === "/health") return send(res, 200, { ok: true });
  if (req.method === "GET" && path === "/faucet") return send(res, 200, await faucet.status());
  const addr = /^\/address\/([a-z0-9._-]{2,64})$/.exec(path);
  if (req.method === "GET" && addr) {
    const accountId = addr[1] ?? "";
    return send(res, 200, { account_id: accountId, hl_address: await hlAddressOf(accountId) });
  }
  if (req.method === "POST" && path === "/faucet") {
    let b: unknown;
    try {
      b = await body(req);
    } catch {
      return send(res, 400, { error: "body must be JSON, at most 4 KB" });
    }
    const accountId = (b as { account_id?: unknown }).account_id;
    if (typeof accountId !== "string") return send(res, 400, { error: "account_id must be a string" });
    const fwd = req.headers["x-forwarded-for"];
    const from =
      (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim() || req.socket.remoteAddress || "?";
    const r = await faucet.grant(accountId, from);
    log({
      step: "faucet",
      account_id: accountId,
      ok: r.ok,
      ...(r.ok ? { hl_address: r.hl_address } : { status: r.status, error: r.error }),
    });
    return r.ok ? send(res, 200, r) : send(res, r.status, r);
  }
  return send(res, 404, { error: "not found" });
}

const port = Number(process.env.PORT) || 8080;
createServer((req, res) => {
  handle(req, res).catch((e) => {
    log({ step: "error", reason: e instanceof Error ? e.message : String(e) });
    if (!res.headersSent) send(res, 500, { error: "internal error" });
  });
}).listen(port, () =>
  log({ step: "faucet server", port, configured: faucet.address !== null, address: faucet.address }),
);
