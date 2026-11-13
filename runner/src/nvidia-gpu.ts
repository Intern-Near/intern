import { createHash, createPublicKey, verify } from "node:crypto";
import { isRecord } from "./json.ts";
import type { Check } from "./tdx-quote.ts";

/**
 * NVIDIA GPU evidence in a NEAR AI model report, checked the way NEAR AI's docs describe it
 * (docs.near.ai/cloud/verification/reference/quote-nonce-signer.md, "Verify GPU evidence when present"): decode
 * `nvidia_payload`, require its nonce to be ours, send the object unchanged to NVIDIA's Remote Attestation Service
 * (NRAS), and require the first token of the reply to say `x-nvidia-overall-att-result: true`.
 *
 * The docs call that minimal flow "TLS-authenticated" and leave local token checks to the reader's policy. This file
 * also checks every token's ES384 signature against NVIDIA's published keys (the JWKS URL below is NVIDIA's,
 * docs.api.nvidia.com/attestation/reference/nras-jwks-api) and that each GPU's token is the one the overall token's
 * `submods` digest names. The claim names used are those of real replies seen on 2026-11-13.
 */
export const NRAS_GPU_URL = "https://nras.attestation.nvidia.com/v3/attest/gpu";
export const NVIDIA_JWKS_URL = "https://nras.attestation.nvidia.com/.well-known/jwks.json";
export const NRAS_ISSUER = "https://nras.attestation.nvidia.com";

export interface GpuPayload {
  nonce: string;
  arch: string | null;
  gpus: number;
}

/** Reads `nvidia_payload` (a JSON string). Throws when it is not the documented shape. */
export function parseGpuPayload(text: string): GpuPayload {
  const data: unknown = JSON.parse(text);
  if (!isRecord(data) || typeof data.nonce !== "string" || !Array.isArray(data.evidence_list)) {
    throw new Error("nvidia_payload: no nonce or evidence_list");
  }
  return {
    nonce: data.nonce,
    arch: typeof data.arch === "string" ? data.arch : null,
    gpus: data.evidence_list.length,
  };
}

/** POST the payload, byte for byte as NEAR AI gave it, to NRAS. Returns the raw reply. */
export async function attestGpu(
  payloadText: string,
  fetchFn: typeof fetch,
): Promise<{ status: number; body: string }> {
  const res = await fetchFn(NRAS_GPU_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: payloadText,
    signal: AbortSignal.timeout(120_000),
  });
  return { status: res.status, body: await res.text() };
}

/** GET NVIDIA's public keys for NRAS tokens. */
export async function fetchNvidiaJwks(fetchFn: typeof fetch): Promise<{ status: number; body: string }> {
  const res = await fetchFn(NVIDIA_JWKS_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(60_000),
  });
  return { status: res.status, body: await res.text() };
}

interface Jwk {
  kid: string;
  kty: string;
  crv: string;
  x: string;
  y: string;
}

export function parseJwks(body: string): Jwk[] {
  const data: unknown = JSON.parse(body);
  if (!isRecord(data) || !Array.isArray(data.keys)) throw new Error("JWKS: no keys");
  return data.keys.flatMap((k: unknown): Jwk[] =>
    isRecord(k) &&
    typeof k.kid === "string" &&
    k.kty === "EC" &&
    typeof k.crv === "string" &&
    typeof k.x === "string" &&
    typeof k.y === "string"
      ? [{ kid: k.kid, kty: k.kty, crv: k.crv, x: k.x, y: k.y }]
      : [],
  );
}

function part(token: string, i: number): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(Buffer.from(token.split(".")[i] ?? "", "base64url").toString("utf8"));
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}

/** An ES384 JWT's signature, checked with the key its header names. Returns the claims, or the reason it fails. */
export function verifyEs384(
  token: string,
  keys: readonly Jwk[],
): { ok: true; claims: Record<string, unknown> } | { ok: false; reason: string } {
  const pieces = token.split(".");
  const header = part(token, 0);
  const claims = part(token, 1);
  if (pieces.length !== 3 || header === null || claims === null) return { ok: false, reason: "not a JWT" };
  if (header.alg !== "ES384") return { ok: false, reason: `alg ${String(header.alg)}, not ES384` };
  const key = keys.find((k) => k.kid === header.kid);
  if (key?.crv !== "P-384")
    return { ok: false, reason: `NVIDIA publishes no P-384 key ${String(header.kid)}` };
  try {
    const ok = verify(
      "sha384",
      Buffer.from(`${pieces[0]}.${pieces[1]}`, "ascii"),
      { key: createPublicKey({ key: { ...key }, format: "jwk" }), dsaEncoding: "ieee-p1363" },
      Buffer.from(pieces[2] ?? "", "base64url"),
    );
    return ok ? { ok: true, claims } : { ok: false, reason: "the signature does not verify" };
  } catch (e) {
    return { ok: false, reason: `the signature could not be checked: ${String(e)}` };
  }
}

/**
 * Checks an NRAS reply: `[["JWT", <overall token>], {"GPU-0": <token>, ...}]`. `now` is for the tokens' time window.
 */
export function checkNrasReply(body: string, keys: readonly Jwk[], nonce: string, now: Date): Check[] {
  const checks: Check[] = [];
  let reply: unknown;
  try {
    reply = JSON.parse(body);
  } catch {
    return [{ name: "NRAS reply", ok: false, detail: "not JSON" }];
  }
  const first = Array.isArray(reply) ? reply[0] : undefined;
  const overall =
    Array.isArray(first) && first[0] === "JWT" && typeof first[1] === "string" ? first[1] : null;
  if (overall === null)
    return [{ name: "NRAS reply", ok: false, detail: 'the first entry is not ["JWT", <token>]' }];
  const v = verifyEs384(overall, keys);
  checks.push({
    name: "NRAS token signature",
    ok: v.ok,
    detail: v.ok ? "ES384, verifies with NVIDIA's published key" : v.reason,
  });
  if (!v.ok) return checks;
  const c = v.claims;
  const verdict = c["x-nvidia-overall-att-result"];
  checks.push({
    name: "GPU verdict",
    ok: verdict === true,
    detail: `x-nvidia-overall-att-result is ${JSON.stringify(verdict)}${c.iss === NRAS_ISSUER ? "" : `; issuer ${String(c.iss)}`}`,
  });
  const eatNonce = typeof c.eat_nonce === "string" ? c.eat_nonce.toLowerCase() : null;
  checks.push({
    name: "GPU nonce",
    ok: eatNonce === nonce.toLowerCase(),
    detail:
      eatNonce === nonce.toLowerCase()
        ? "the token's eat_nonce is ours"
        : `the token's eat_nonce is ${String(c.eat_nonce)}`,
  });
  const secs = Math.floor(now.getTime() / 1000);
  const inWindow =
    typeof c.nbf === "number" && typeof c.exp === "number" && c.nbf <= secs + 60 && secs <= c.exp;
  checks.push({
    name: "token time",
    ok: inWindow,
    detail: inWindow
      ? "valid now (nbf to exp)"
      : `not valid now (nbf ${String(c.nbf)}, exp ${String(c.exp)})`,
  });
  // Each GPU's own token: signed by NVIDIA, and the one the overall token's `submods` digest (SHA-256) names.
  const gpus = Array.isArray(reply) && isRecord(reply[1]) ? Object.entries(reply[1]) : [];
  const submods = isRecord(c.submods) ? c.submods : {};
  const bad: string[] = [];
  for (const [name, token] of gpus) {
    if (typeof token !== "string") {
      bad.push(`${name}: no token`);
      continue;
    }
    const g = verifyEs384(token, keys);
    if (!g.ok) bad.push(`${name}: ${g.reason}`);
    const digest = submods[name];
    const named = Array.isArray(digest) && Array.isArray(digest[1]) ? digest[1][1] : undefined;
    if (named !== createHash("sha256").update(token).digest("hex"))
      bad.push(`${name}: not the token the overall token names`);
    if (g.ok && g.claims["x-nvidia-gpu-attestation-report-nonce-match"] !== true)
      bad.push(`${name}: nonce does not match`);
  }
  if (gpus.length !== Object.keys(submods).length)
    bad.push(`${gpus.length} GPU tokens for ${Object.keys(submods).length} named`);
  checks.push({
    name: "each GPU",
    ok: gpus.length > 0 && bad.length === 0,
    detail:
      bad.length === 0
        ? `${gpus.length} GPU token(s), each signed by NVIDIA, named by the overall token, nonce matched`
        : bad.join("; "),
  });
  return checks;
}
