import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "../../runner/src/json.ts";
import { Secret } from "../../runner/src/secret.ts";
import { DEFAULTS, type RunConfig } from "../src/config.ts";

/** intern/fixtures/ */
export const FIXTURES = fileURLToPath(new URL("../../fixtures/", import.meta.url));

/** A real reply of POST https://api.hyperliquid.xyz/info {"type":"metaAndAssetCtxs"}, saved in step 1. */
export const PRICES_BODY = readFileSync(
  join(FIXTURES, "hl/info/2026-11-11T153837Z/metaAndAssetCtxs-mainnet.json"),
  "utf8",
);

/** Pinned signers as recorded in step 1 (the same for every recording of a model). */
export function pinsFromFixtures(model: string): RunConfig["pinned"][string] {
  const slug = model.toLowerCase().replaceAll("/", "--");
  const meta = JSON.parse(readFileSync(join(FIXTURES, "ai", slug, "normal", "meta.json"), "utf8")) as {
    preflight: RunConfig["pinned"][string];
  };
  return meta.preflight;
}

export function makeConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  const models = overrides.models ?? DEFAULTS.models;
  return {
    ...DEFAULTS,
    format: 1,
    run_id: "test",
    created_at: "2026-11-11T00:00:00.000Z",
    models,
    pinned: Object.fromEntries(models.map((m) => [m, pinsFromFixtures(m)])),
    prices_per_mtok: Object.fromEntries(models.map((m) => [m, { input: 0.1, output: 1 }])),
    ...overrides,
  };
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "intern-shadow-test-"));
}

export const TEST_KEY = new Secret("sk-test-never-printed");

/** Rewrites one market's mark price in the saved Hyperliquid reply. `index` is the market's mainnet index. */
export function pricesWith(marks: Record<number, string>): string {
  const data = JSON.parse(PRICES_BODY) as [unknown, Record<string, unknown>[]];
  for (const [index, px] of Object.entries(marks)) {
    const ctx = data[1][Number(index)];
    if (!isRecord(ctx)) throw new Error(`no context at ${index}`);
    ctx.markPx = px;
  }
  return JSON.stringify(data);
}

export interface FakeOptions {
  hlStatus?: number;
  completionStatus?: number;
  /** The signing_address the fake signature replies carry; default: the pinned one. */
  signer?: (model: string, algo: string) => string;
  /** Called when a completion arrives, with the request body; use it to check what was on disk then. */
  onCompletion?: (body: Record<string, unknown>) => void;
  answer?: (model: string, nonce: string, round: number) => string;
}

/**
 * A fake fetch that plays NEAR AI (completions and signatures) and Hyperliquid (prices). Its signatures are not
 * real; the tick tests check what is saved and when, not signature maths (the runner's tests do that).
 */
export function fakeFetch(
  cfg: RunConfig,
  opts: FakeOptions = {},
): { fetchFn: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const chatModel = new Map<string, string>();
  let n = 0;
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    calls.push(`${init?.method ?? "GET"} ${url.origin}${url.pathname}`);
    if (url.href === "https://api.hyperliquid.xyz/info") {
      return new Response(opts.hlStatus && opts.hlStatus !== 200 ? "down" : PRICES_BODY, {
        status: opts.hlStatus ?? 200,
      });
    }
    if (url.href === "https://cloud-api.near.ai/v1/chat/completions") {
      const body = JSON.parse(Buffer.from(init?.body as Uint8Array).toString("utf8")) as Record<
        string,
        unknown
      >;
      opts.onCompletion?.(body);
      const model = String(body.model);
      const system = (body.messages as { content: string }[])[0]?.content ?? "";
      const nonce = /\nnonce: ([0-9a-f]{16})\n/.exec(system)?.[1] ?? "";
      const round = Number(/\nround: (\d+)\n/.exec(system)?.[1] ?? "0");
      n += 1;
      const id = `chat${n}`;
      chatModel.set(id, model);
      const content =
        opts.answer?.(model, nonce, round) ?? `{"v":1,"round":${round},"nonce":"${nonce}","action":"skip"}`;
      const reply = {
        id,
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content } }],
      };
      return new Response(JSON.stringify(reply), { status: opts.completionStatus ?? 200 });
    }
    if (url.pathname.startsWith("/v1/signature/")) {
      const id = decodeURIComponent(url.pathname.slice("/v1/signature/".length));
      const model = chatModel.get(id) ?? "";
      const algo = url.searchParams.get("signing_algo") ?? "ecdsa";
      const pinned = cfg.pinned[model]?.[algo as "ecdsa" | "ed25519"]?.signing_address ?? "";
      const reply = {
        text: `${model}:aa:bb`,
        signature: algo === "ecdsa" ? `0x${"00".repeat(65)}` : "00".repeat(64),
        signing_address: opts.signer?.(model, algo) ?? pinned,
        signing_algo: algo,
        signature_kind: "provider_tee",
      };
      return new Response(JSON.stringify(reply));
    }
    throw new Error(`unexpected call ${url.href}`);
  }) as typeof fetch;
  return { fetchFn, calls };
}

export function exists(...parts: string[]): boolean {
  return existsSync(join(...parts));
}
