import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { formatScaled, parseScaled } from "../../src/pricing.ts";
import { signedText } from "../../src/signature.ts";

/**
 * TEST DOUBLES, NOT THE SERVICES. A `fetch` that answers like NEAR AI and Hyperliquid testnet, for the runner's
 * round tests. Hyperliquid's market data and mid prices are real replies saved from testnet on 2026-11-11
 * (`intern/fixtures/hl/info/2026-11-11T173427Z/`); order replies and fills are made up in the documented shapes.
 * The model's answers are signed with a key made in the test, so the runner's own signature check can pass.
 */

const INFO = fileURLToPath(new URL("../../../fixtures/hl/info/2026-11-11T173427Z/", import.meta.url));
export const META_AND_CTXS = readFileSync(`${INFO}metaAndAssetCtxs-testnet.json`, "utf8");
export const ALL_MIDS = readFileSync(`${INFO}allMids-testnet.json`, "utf8");
const UNIVERSE: { name: string }[] = JSON.parse(META_AND_CTXS)[0].universe;

export interface Fill {
  coin: string;
  px: string;
  sz: string;
  side: "B" | "A";
  time: number;
  startPosition: string;
  dir: string;
  closedPnl: string;
  hash: string;
  oid: number;
  crossed: boolean;
  fee: string;
  tid: number;
  feeToken: string;
}

export interface Services {
  fetch: typeof fetch;
  /** The model's signer for `get_constants().model.signer`: the test key, 32 bytes as hex. */
  signer: string;
  /** Every user message the model was sent. */
  userMessages: string[];
  /** Every body POSTed to /exchange, parsed. */
  exchangeBodies: Record<string, unknown>[];
  fills: Fill[];
}

export interface ServiceOptions {
  /** The model's answer for a round and nonce (the decision line, maybe with blank lines around it). */
  answer: (round: number, nonce: string, user: string) => string;
  /** Reply to an /exchange body; by default leverage is accepted and orders fill at their own limit price. */
  exchange?: (body: Record<string, unknown>, s: Services) => string;
  now: () => number;
}

function json(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The default exchange: leverage accepted; an IOC order fills in full at its limit price, with a 0.045% fee. */
export function fillAtLimit(body: Record<string, unknown>, s: Services, now: number): string {
  const action = body.action as Record<string, unknown>;
  if (action.type === "updateLeverage")
    return JSON.stringify({ status: "ok", response: { type: "default" } });
  const order = (action.orders as Record<string, unknown>[])[0] as Record<string, unknown>;
  const coin = UNIVERSE[order.a as number]?.name ?? "?";
  const reduce = order.r === true;
  const buy = order.b === true;
  const oid = 1000 + s.fills.length;
  const px = order.p as string;
  const sz = order.s as string;
  // fee = 0.045% of px × sz, rounded down to 6 decimals (made up, in the documented shape)
  const valueE12 = BigInt(Math.round(Number(px) * 1e6)) * BigInt(Math.round(Number(sz) * 1e6));
  const feeE6 = (valueE12 * 45n) / 100_000n / 1_000_000n;
  s.fills.push({
    coin,
    px,
    sz,
    side: buy ? "B" : "A",
    time: now,
    startPosition: "0.0",
    dir: reduce ? (buy ? "Close Short" : "Close Long") : buy ? "Open Long" : "Open Short",
    closedPnl: "0.0",
    hash: `0x${"0".repeat(64)}`,
    oid,
    crossed: true,
    fee: (Number(feeE6) / 1e6).toFixed(6),
    tid: 5000 + s.fills.length,
    feeToken: "USDC",
  });
  return JSON.stringify({
    status: "ok",
    response: { type: "order", data: { statuses: [{ filled: { totalSz: sz, avgPx: px, oid } }] } },
  });
}

export function fakeServices(opts: ServiceOptions): Services {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const x = publicKey.export({ format: "jwk" }).x;
  if (x === undefined) throw new Error("no public key");
  const signer = Buffer.from(x, "base64url").toString("hex");
  const exchanges = new Map<string, { request: Buffer; response: Buffer; model: string }>();
  let chatCounter = 0;

  const s: Services = {
    signer,
    userMessages: [],
    exchangeBodies: [],
    fills: [],
    fetch: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const bodyText = (): string => {
        const b = init?.body;
        if (typeof b === "string") return b;
        if (b instanceof Uint8Array) return Buffer.from(b).toString("utf8");
        throw new Error("unexpected body type");
      };

      if (url.href === "https://cloud-api.near.ai/v1/chat/completions") {
        const request = Buffer.from(init?.body as Uint8Array);
        const req = JSON.parse(request.toString("utf8"));
        const system: string = req.messages[0].content;
        const user: string = req.messages[1].content;
        s.userMessages.push(user);
        const round = Number(/^round: (\d+)$/m.exec(system)?.[1]);
        const nonce = /^nonce: ([0-9a-f]{16})$/m.exec(system)?.[1] ?? "";
        chatCounter++;
        const id = `chatcmpl-test-${chatCounter}`;
        const response = Buffer.from(
          JSON.stringify({
            id,
            object: "chat.completion",
            model: req.model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: opts.answer(round, nonce, user) },
                finish_reason: "stop",
              },
            ],
          }),
        );
        exchanges.set(id, { request, response, model: req.model });
        return new Response(response, { status: 200, headers: { "content-type": "application/json" } });
      }

      if (url.pathname.startsWith("/v1/signature/")) {
        const id = decodeURIComponent(url.pathname.slice("/v1/signature/".length));
        const ex = exchanges.get(id);
        if (!ex) return json({ detail: "not found" }, 404);
        const text = signedText(ex.model, ex.request, ex.response);
        const signature = sign(null, Buffer.from(text), privateKey).toString("hex");
        return json({
          text,
          signature,
          signing_address: signer,
          signing_algo: "ed25519",
          signature_kind: "provider_tee",
        });
      }

      if (url.href === "https://api.hyperliquid-testnet.xyz/info") {
        const req = JSON.parse(bodyText());
        if (req.type === "metaAndAssetCtxs") return json(META_AND_CTXS);
        if (req.type === "allMids") return json(ALL_MIDS);
        if (req.type === "userFillsByTime") {
          return json(
            s.fills.filter(
              (f) => f.time >= req.startTime && f.time <= (req.endTime ?? Number.MAX_SAFE_INTEGER),
            ),
          );
        }
        if (req.type === "userFunding") return json([]);
        if (req.type === "clearinghouseState") {
          // The open positions, from the fills so far: a buy adds its size, a sell takes it away.
          const szi = new Map<string, bigint>();
          for (const f of s.fills) {
            const sz = parseScaled(f.sz, 8);
            szi.set(f.coin, (szi.get(f.coin) ?? 0n) + (f.side === "B" ? sz : -sz));
          }
          const assetPositions = [...szi]
            .filter(([, v]) => v !== 0n)
            .map(([coin, v]) => ({ type: "oneWay", position: { coin, szi: formatScaled(v, 8) } }));
          return json({ assetPositions, withdrawable: "100.0" });
        }
        return json({ error: `fake: unknown info type ${req.type}` }, 400);
      }

      if (url.href === "https://api.hyperliquid-testnet.xyz/exchange") {
        const body = JSON.parse(bodyText());
        s.exchangeBodies.push(body);
        const reply = opts.exchange ? opts.exchange(body, s) : fillAtLimit(body, s, opts.now());
        return json(reply);
      }

      throw new Error(`fake services: no route for ${url.href}`);
    },
  };
  return s;
}

/** The decision line for a bet, as 01 §6.2 writes it. */
export function betLine(
  round: number,
  nonce: string,
  market: string,
  margin: string,
  leverage = 1,
  side = "long",
): string {
  return `{"v":1,"round":${round},"nonce":"${nonce}","action":"bet","market":"${market}","side":"${side}","margin_e6":"${margin}","leverage":${leverage}}`;
}

export function skipLine(round: number, nonce: string): string {
  return `{"v":1,"round":${round},"nonce":"${nonce}","action":"skip"}`;
}
