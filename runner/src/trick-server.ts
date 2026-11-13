import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isAccountId } from "./round.ts";
import { senderKey, TRICK_LIMITS, type TrickDesk } from "./trick-desk.ts";

// The trick page's door (docs/TRICK-API.md): a small HTTP server inside the runner process, so every proposal still
// goes out through one process and one key. No cookies, no accounts: a visitor either stays anonymous, or proves
// their NEAR account with a NEP-413 signature over the exact text below, and then is named as credited_to.

/** The NEP-413 `recipient` the wallet signs for. */
export const TRICK_RECIPIENT = "intern-trick";

/** The exact text a visitor's wallet signs (NEP-413 `message`) to be credited for their trick. */
export function trickSignText(message: string): string {
  return `Trick the Intern:\n${message}`;
}

export interface WindowInfo {
  round_id: number;
  phase: string;
  /** This round's proposal window, ms since the epoch. */
  propose_from: number;
  propose_until: number;
  /** When the next window opens (now, if one is open with time left). */
  next_window_from: number;
}

export interface TrickServerDeps {
  desk: TrickDesk;
  /** NEP-413 check: null when the signature is valid and the key is a full-access key of the account, else why not. */
  verify: (
    accountId: string,
    publicKey: string,
    message: string,
    nonce: Uint8Array,
    signature: Uint8Array,
  ) => Promise<string | null>;
  window: () => Promise<WindowInfo>;
  /**
   * 01 1.7: the on-chain payment for a trick (`get_trick_payment`), or null if there is none. Optional: without it,
   * `payment_id` is refused.
   */
  payment?: (id: string) => Promise<{ account_id: string; amount: string } | null>;
  /** Salt for hashing addresses: they are never stored. */
  salt: string;
  log: (fields: { step: string } & Record<string, unknown>) => void;
}

const MAX_BODY = 8 * 1024;

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

async function readBody(req: IncomingMessage): Promise<string | null> {
  let size = 0;
  const parts: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) return null;
    parts.push(chunk as Buffer);
  }
  return Buffer.concat(parts).toString("utf8");
}

function fromBase64(s: unknown, len: number): Uint8Array | null {
  if (typeof s !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  const b = Buffer.from(s, "base64");
  return b.length === len ? new Uint8Array(b) : null;
}

function clientAddress(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "unknown";
}

export async function handle(d: TrickServerDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://x");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (req.method === "OPTIONS") return send(res, 204, {});

  if (req.method === "GET" && path === "/health") return send(res, 200, { ok: true });

  if (req.method === "GET" && path === "/tricks") {
    let window: WindowInfo | null = null;
    try {
      window = await d.window();
    } catch {
      window = null;
    }
    return send(res, 200, {
      limits: TRICK_LIMITS,
      sign: { recipient: TRICK_RECIPIENT, text_prefix: trickSignText("") },
      window,
      ...d.desk.summary(),
    });
  }

  const one = /^\/tricks\/([0-9a-f-]{36})$/.exec(path);
  if (req.method === "GET" && one) {
    const t = d.desk.get(one[1] ?? "");
    return t ? send(res, 200, t) : send(res, 404, { error: "no such trick" });
  }

  if (req.method === "POST" && path === "/tricks") {
    const raw = await readBody(req);
    if (raw === null) return send(res, 413, { error: "body too large" });
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return send(res, 400, { error: "body must be JSON" });
    }
    if (typeof body !== "object" || body === null) return send(res, 400, { error: "body must be an object" });
    const { message, proof, payment_id } = body as {
      message?: unknown;
      proof?: unknown;
      payment_id?: unknown;
    };
    if (typeof message !== "string") return send(res, 400, { error: "message must be a string" });
    // 01 1.7: a paid trick goes ahead of free ones. The visitor pays the coin first (`{"trick":{"id"}}`), then sends
    // the same id here; it is checked on chain and used once.
    let paid: string | null = null;
    if (payment_id !== undefined && payment_id !== null) {
      if (typeof payment_id !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(payment_id))
        return send(res, 400, { error: "payment_id must be 1-64 letters, digits or '-'" });
      if (!d.payment) return send(res, 400, { error: "paid tricks are not enabled here" });
      if (d.desk.paymentUsed(payment_id))
        return send(res, 409, { error: "this payment was already used for a trick" });
      let p: { account_id: string; amount: string } | null = null;
      try {
        p = await d.payment(payment_id);
      } catch {
        return send(res, 503, { error: "the payment could not be checked just now; try again" });
      }
      if (p === null)
        return send(res, 402, { error: "no payment with this id on chain yet (pay first, then send)" });
      paid = payment_id;
    }

    let accountId: string | null = null;
    let nonceB64: string | null = null;
    if (proof !== undefined && proof !== null) {
      const p = proof as Record<string, unknown>;
      const nonce = fromBase64(p.nonce, 32);
      const signature = fromBase64(p.signature, 64);
      if (typeof p.account_id !== "string" || !isAccountId(p.account_id))
        return send(res, 400, { error: "proof.account_id is not a NEAR account id" });
      if (typeof p.public_key !== "string" || !p.public_key.startsWith("ed25519:"))
        return send(res, 400, { error: "proof.public_key must be an ed25519 key (ed25519:...)" });
      if (nonce === null) return send(res, 400, { error: "proof.nonce must be 32 bytes, base64" });
      if (signature === null) return send(res, 400, { error: "proof.signature must be 64 bytes, base64" });
      nonceB64 = Buffer.from(nonce).toString("base64");
      if (d.desk.nonceUsed(nonceB64)) return send(res, 409, { error: "this signature was already used" });
      const why = await d.verify(p.account_id, p.public_key, trickSignText(message), nonce, signature);
      if (why !== null) return send(res, 401, { error: `the wallet signature does not check out: ${why}` });
      accountId = p.account_id;
    }
    const sender = accountId ?? senderKey(clientAddress(req), d.salt);
    const r = d.desk.submit(message, accountId, sender, nonceB64, paid);
    if (!r.ok) return send(res, r.status, { error: r.error });
    d.log({ step: "trick queued", trick: r.trick.id, credited_to: accountId, position: r.trick.position });
    let window: WindowInfo | null = null;
    try {
      window = await d.window();
    } catch {
      window = null;
    }
    return send(res, 202, { ...r.trick, window });
  }

  return send(res, 404, { error: "not found" });
}

export function startTrickServer(d: TrickServerDeps, port: number): Server {
  const server = createServer((req, res) => {
    handle(d, req, res).catch((e) => {
      d.log({ step: "trick server error", reason: e instanceof Error ? e.message : String(e) });
      if (!res.headersSent) send(res, 500, { error: "internal error" });
    });
  });
  server.listen(port, () => d.log({ step: "trick server", port }));
  return server;
}
