import { isRecord } from "./json.ts";
import { Secret } from "./secret.ts";

/** NEAR AI Cloud. Docs index: https://docs.near.ai/llms.txt */
export const NEARAI_BASE_URL = "https://cloud-api.near.ai/v1";

/**
 * The four chat models whose answers NEAR AI signs inside the model's own secure hardware
 * (03-ENGINE-2-THE-INTERN.md section 4). `npm run check` confirms they are still listed and still attested.
 */
export const SIGNED_CHAT_MODELS = [
  "Qwen/Qwen3.8-27B",
  "z-ai/glm-5.3-flash",
  "Qwen/Qwen3.6-35B-A3B-FP8",
  "deepseek-ai/DeepSeek-V4.1-Flash-1017",
] as const;

export const SIGNING_ALGOS = ["ecdsa", "ed25519"] as const;
export type SigningAlgo = (typeof SIGNING_ALGOS)[number];

/**
 * ECDSA signers recorded during research, used only to notice a key change. Values written with "…" were
 * recorded shortened, so only their start and end can be compared.
 */
export const RESEARCH_ECDSA_SIGNERS: Readonly<Record<string, { value: string; source: string }>> = {
  "Qwen/Qwen3.8-27B": {
    value: "0x835AB53d20294Ef795906DFf21aE4C045336aa26",
    source: "03-ENGINE-2-THE-INTERN.md §4, measured 2026-11-01 and 2026-11-11",
  },
  "z-ai/glm-5.3-flash": {
    value: "0x3b753b44…fa0c",
    source: "RESEARCH-mandate-coin-prior-art.md §3a, 2026-11-10",
  },
  "Qwen/Qwen3.6-35B-A3B-FP8": {
    value: "0xfdbd7952…8ddf",
    source: "RESEARCH-mandate-coin-prior-art.md §3a, 2026-11-10",
  },
  "deepseek-ai/DeepSeek-V4.1-Flash-1017": {
    value: "0xfe007189…337e",
    source: "RESEARCH-mandate-coin-prior-art.md §3a, 2026-11-10",
  },
};

/** True when `address` equals `recorded`, or, for a shortened "start…end" value, starts and ends the same. */
export function matchesRecorded(address: string, recorded: string): boolean {
  const a = address.toLowerCase();
  const parts = recorded.toLowerCase().split("…");
  if (parts.length === 1) return a === parts[0];
  const [start = "", end = ""] = parts;
  return parts.length === 2 && a.startsWith(start) && a.endsWith(end);
}

export interface ListedModel {
  id: string;
  owned_by: string;
}

/** Parses the body of GET /v1/models. */
export function parseModels(body: string): ListedModel[] {
  const data: unknown = JSON.parse(body);
  if (!isRecord(data) || !Array.isArray(data.data)) {
    throw new Error("NEAR AI /models: no `data` array");
  }
  return data.data.map((m: unknown, i: number): ListedModel => {
    if (!isRecord(m) || typeof m.id !== "string") {
      throw new Error(`NEAR AI /models: entry ${i} has no id`);
    }
    return { id: m.id, owned_by: typeof m.owned_by === "string" ? m.owned_by : "" };
  });
}

/** GET /v1/models. Public; no key is sent. */
export async function fetchModels(fetchFn: typeof fetch): Promise<{ body: string; models: ListedModel[] }> {
  const res = await fetchFn(`${NEARAI_BASE_URL}/models`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`NEAR AI /models: HTTP ${res.status}: ${body.slice(0, 200)}`);
  return { body, models: parseModels(body) };
}

export interface ModelSigner {
  model_name: string;
  signing_algo: SigningAlgo;
  /** ecdsa: 0x-prefixed 20-byte address. ed25519: 32-byte public key as 64 hex characters. Lower case. */
  signing_address: string;
}

const ADDRESS_FORMAT: Readonly<Record<SigningAlgo, RegExp>> = {
  ecdsa: /^0x[0-9a-f]{40}$/,
  ed25519: /^[0-9a-f]{64}$/,
};

/**
 * Reads the model signing identities from a GET /v1/attestation/report body. Every candidate must echo our
 * nonce and name our model and algorithm, or this throws.
 *
 * This reads what the report claims. It does NOT verify the hardware evidence (Intel TDX quote, event log,
 * NVIDIA payload); NEAR AI's docs describe that check, and nobody does it on-chain.
 */
export function parseModelSigners(
  body: string,
  expect: { model: string; algo: SigningAlgo; nonce: string },
): ModelSigner[] {
  const data: unknown = JSON.parse(body);
  if (!isRecord(data)) throw new Error("attestation report: not a JSON object");
  const list = data.model_attestations;
  if (list === undefined) return []; // the docs: "The field is omitted when no candidate is available"
  if (!Array.isArray(list)) throw new Error("attestation report: model_attestations is not an array");
  return list.map((c: unknown, i: number): ModelSigner => {
    if (!isRecord(c)) throw new Error(`attestation report: candidate ${i} is not an object`);
    if (c.request_nonce !== expect.nonce) {
      throw new Error(`attestation report: candidate ${i} did not echo our nonce`);
    }
    if (c.model_name !== expect.model) {
      throw new Error(`attestation report: candidate ${i} is for model ${String(c.model_name)}`);
    }
    if (c.signing_algo !== expect.algo) {
      throw new Error(`attestation report: candidate ${i} uses ${String(c.signing_algo)}`);
    }
    const address = typeof c.signing_address === "string" ? c.signing_address.toLowerCase() : "";
    if (!ADDRESS_FORMAT[expect.algo].test(address)) {
      throw new Error(`attestation report: candidate ${i} has a malformed signing_address`);
    }
    return { model_name: expect.model, signing_algo: expect.algo, signing_address: address };
  });
}

/**
 * GET /v1/attestation/report for one model and algorithm, NEAR's own hardware only (`provider=near`).
 * Needs no key. When `apiKey` is given it is sent, and NEAR AI answers 401 if it is invalid; the call is
 * not billed (docs: "Report retrieval is non-billable"). Returns the raw status and body.
 */
export async function fetchAttestation(
  model: string,
  algo: SigningAlgo,
  nonce: string,
  fetchFn: typeof fetch,
  apiKey: Secret | null = null,
): Promise<{ status: number; body: string }> {
  const url = new URL(`${NEARAI_BASE_URL}/attestation/report`);
  url.searchParams.set("model", model);
  url.searchParams.set("provider", "near");
  url.searchParams.set("include_tls_fingerprint", "false");
  url.searchParams.set("signing_algo", algo);
  url.searchParams.set("nonce", nonce);
  const headers: Record<string, string> = { accept: "application/json", "x-no-aliasing": "true" };
  if (apiKey) headers.authorization = `Bearer ${apiKey.reveal()}`;
  const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(60_000) });
  return { status: res.status, body: await res.text() };
}

/**
 * Headers for a chat completion that the model's own hardware signs (NEAR AI docs, response-signatures.md):
 * the canonical model id in the body, `x-no-aliasing: true`, no streaming (set in the body), and
 * `Accept-Encoding: identity` so the bytes we keep are the bytes that were signed.
 */
export function completionHeaders(apiKey: Secret): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey.reveal()}`,
    "content-type": "application/json",
    accept: "application/json",
    "accept-encoding": "identity",
    "x-no-aliasing": "true",
  };
}

/** The same headers as recorded in a fixture: the key replaced. */
export function completionHeadersForRecord(): Record<string, string> {
  return { ...completionHeaders(new Secret("")), authorization: "Bearer [redacted]" };
}

export interface RawReply {
  status: number;
  headers: Record<string, string>;
  /** The exact body bytes, never decoded and re-encoded. */
  body: Buffer;
}

/** POST /v1/chat/completions with the exact request bytes given. No retries. */
export async function postCompletion(
  requestBytes: Uint8Array,
  apiKey: Secret,
  fetchFn: typeof fetch,
  timeoutMs = 600_000,
): Promise<RawReply> {
  const res = await fetchFn(`${NEARAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: completionHeaders(apiKey),
    body: requestBytes,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: Object.fromEntries(res.headers), body };
}

/**
 * GET /v1/signature/<chat id>?signing_algo=… . A 404 means "not recorded yet" and is retried a bounded number
 * of times (NEAR AI docs); each retry is reported through `log`. Any other reply is returned as it is.
 */
export async function fetchSignature(
  chatId: string,
  algo: SigningAlgo,
  apiKey: Secret,
  fetchFn: typeof fetch,
  log: (line: string) => void,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<RawReply & { attempts: number }> {
  const attempts = opts.attempts ?? 8;
  const delayMs = opts.delayMs ?? 2_000;
  const url = new URL(`${NEARAI_BASE_URL}/signature/${encodeURIComponent(chatId)}`);
  url.searchParams.set("signing_algo", algo);
  for (let attempt = 1; ; attempt++) {
    const res = await fetchFn(url, {
      headers: { authorization: `Bearer ${apiKey.reveal()}`, accept: "application/json" },
      signal: AbortSignal.timeout(60_000),
    });
    const reply = {
      status: res.status,
      headers: Object.fromEntries(res.headers),
      body: Buffer.from(await res.arrayBuffer()),
      attempts: attempt,
    };
    if (res.status !== 404 || attempt >= attempts) return reply;
    log(
      `signature ${algo}: HTTP 404 (not recorded yet), retry ${attempt} of ${attempts - 1} in ${delayMs} ms`,
    );
    await new Promise((r) => setTimeout(r, delayMs));
  }
}
