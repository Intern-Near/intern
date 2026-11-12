import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isRecord } from "./json.ts";
import {
  completionHeadersForRecord,
  fetchSignature,
  NEARAI_BASE_URL,
  postCompletion,
  SIGNING_ALGOS,
  type SigningAlgo,
} from "./nearai.ts";
import type { Secret } from "./secret.ts";

/** Writes a new file, creating its folder. Never overwrites: fails if the file exists. */
export async function writeNew(path: string, data: Uint8Array | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data, { flag: "wx" });
}

/**
 * The request body for one decision: the rulebook as the system message, the market data as the user message,
 * no streaming, then any extra top-level fields (for example a switch for thinking). Built once; these exact bytes
 * are sent, saved and hashed.
 */
export function requestBody(
  model: string,
  rulebook: string,
  userMessage: string,
  opts: { extra?: Record<string, unknown>; pretty?: boolean } = {},
): Buffer {
  const body = {
    model,
    messages: [
      { role: "system", content: rulebook },
      { role: "user", content: userMessage },
    ],
    stream: false,
    ...opts.extra,
  };
  return Buffer.from(JSON.stringify(body, null, opts.pretty ? 2 : undefined), "utf8");
}

export interface ExchangeResult {
  request: { url: string; headers: Record<string, string> };
  response: { status: number; ms: number; headers: Record<string, string>; chat_id: string | null } | null;
  signatures: Record<SigningAlgo, { status: number; attempts: number; fetched_at: string } | null>;
  /** Set when the exchange could not be completed; whatever arrived is still on disk. */
  error?: string;
}

/**
 * One signed exchange with NEAR AI, saved into `dir` as it happens: `request.bin` before sending, `response.bin`
 * as soon as the reply arrives, then `signature-ecdsa.json` and `signature-ed25519.json`. Never overwrites a file.
 * A failed call does not throw; it is reported in `error`, and the caller writes `meta.json`.
 */
export async function runExchange(args: {
  dir: string;
  requestBytes: Uint8Array;
  apiKey: Secret;
  fetchFn: typeof fetch;
  log: (line: string) => void;
  timeoutMs?: number;
  now?: () => Date;
  /** Which signatures to fetch; both by default. */
  algos?: readonly SigningAlgo[];
}): Promise<ExchangeResult> {
  const now = args.now ?? (() => new Date());
  const result: ExchangeResult = {
    request: { url: `${NEARAI_BASE_URL}/chat/completions`, headers: completionHeadersForRecord() },
    response: null,
    signatures: { ecdsa: null, ed25519: null },
  };
  await writeNew(join(args.dir, "request.bin"), args.requestBytes);
  try {
    const t0 = Date.now();
    const reply = await postCompletion(args.requestBytes, args.apiKey, args.fetchFn, args.timeoutMs);
    const ms = Date.now() - t0;
    await writeNew(join(args.dir, "response.bin"), reply.body);
    const { "set-cookie": _dropped, ...headers } = reply.headers;
    let chatId: string | null = null;
    try {
      const body: unknown = JSON.parse(reply.body.toString("utf8"));
      if (isRecord(body) && typeof body.id === "string") chatId = body.id;
    } catch {
      // Not JSON: kept as it is; the classification reports it.
    }
    result.response = { status: reply.status, ms, headers, chat_id: chatId };
    args.log(`completion HTTP ${reply.status} in ${ms} ms, ${reply.body.length} bytes, chat id ${chatId}`);
    if (reply.status !== 200 || chatId === null) {
      result.error = `completion HTTP ${reply.status}; nothing to sign`;
      return result;
    }
    for (const algo of args.algos ?? SIGNING_ALGOS) {
      const s = await fetchSignature(chatId, algo, args.apiKey, args.fetchFn, args.log);
      await writeNew(join(args.dir, `signature-${algo}.json`), s.body);
      result.signatures[algo] = { status: s.status, attempts: s.attempts, fetched_at: now().toISOString() };
      args.log(`signature ${algo} HTTP ${s.status} after ${s.attempts} attempt(s)`);
    }
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    args.log(`FAILED: ${result.error}`);
  }
  return result;
}
