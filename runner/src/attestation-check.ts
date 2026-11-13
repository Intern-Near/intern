import { isRecord } from "./json.ts";
import { fetchAttestation, NEARAI_BASE_URL, type SigningAlgo } from "./nearai.ts";
import { attestGpu, checkNrasReply, fetchNvidiaJwks, parseGpuPayload, parseJwks } from "./nvidia-gpu.ts";
import { PINNED_01 } from "./pinned.ts";
import {
  type Check,
  checkQuoteSignatures,
  expectedMrConfigId,
  expectedReportData,
  parseTdxQuote,
  replayRtmr3,
  tdDebug,
} from "./tdx-quote.ts";

/**
 * `attestation-check`: asks NEAR AI for a fresh attestation report of one model (provider=near, our own random
 * nonce) and checks what can be checked with documented methods and Node's own crypto, following NEAR AI's docs
 * (docs.near.ai/cloud/verification/cloud-api/model-attestations.md and reference/quote-nonce-signer.md):
 * the nonce is echoed; the signer is the one 01 pins; the Intel TDX quote's signature chain reaches Intel's root;
 * the quote's report data binds that signer and our nonce; the TD is not in debug mode; MRCONFIGID matches the
 * measured configuration; the RTMR3 event log replays to the quote's RTMR3; and the NVIDIA GPU evidence carries our
 * nonce and gets a passing, NVIDIA-signed verdict from NVIDIA's attestation service. Everything else is listed as
 * UNVERIFIED with the reason. Read-only: it sends no completion and needs no key.
 */

export interface AttestationDeps {
  fetchFn: typeof fetch;
  now: () => Date;
  /** 32 random bytes as 64 hex characters (docs: "Generate 32 random bytes in the client"). */
  nonce: () => string;
  /** Keeps the raw replies (for tests); null: not kept. */
  save: ((name: string, body: string) => Promise<void>) | null;
}

export interface AttestationResult {
  lines: string[];
  failures: number;
  /** Calls that could not be made or read. */
  callFailures: number;
}

/** Not checked here, and why. Printed on every run. */
export const UNVERIFIED_PARTS: readonly string[] = [
  "Intel TCB status and security advisories: the quote's signature chain reaches Intel's root, so it was made on genuine Intel TDX hardware, but whether that platform is up to date needs Intel's collateral (TCB info, QE identity, revocation lists), which a DCAP verifier such as dcap-qvl (the one NEAR AI's docs name; 27 npm packages) fetches. Not added: no heavy new dependency.",
  "The quoting enclave's identity (its MRSIGNER and version against Intel's QE identity) and certificate revocation (Intel's PCK and root CRLs): the same collateral.",
  "The software measured: MRTD, RTMR0 to RTMR2, the OS image and the compose file are printed but not compared with an allowlist, and the image digests in the compose file are not checked for build provenance (NEAR AI's image-provenance flow needs a signed provenance statement per digest; not added). NEAR AI's docs leave the accepted measurements and builders to the reader's policy.",
  "That a given completion came from this instance: NEAR AI's docs warn that instances of one model share one signing key, so a matching signer does not show which instance answered.",
  "The GPU verdict is NVIDIA's (its reference-measurement and certificate-status checks are not redone here); its tokens are checked against NVIDIA's keys as published at the JWKS URL. The GPU evidence and the TDX quote are linked only by carrying the same nonce; NEAR AI's docs give no other binding.",
  "The gateway's own attestation (gateway_attestation): not checked. The signature the contract checks is the model's (provider_tee), made inside the model's TEE, so the gateway is not trusted for it.",
];

function hex(b: Buffer): string {
  return b.toString("hex");
}

function short(h: string): string {
  return h.length > 20 ? `${h.slice(0, 16)}…` : h;
}

/** Reads `info.tcb_info`, which may be an object or JSON text (docs). */
function tcbInfo(candidate: Record<string, unknown>): Record<string, unknown> | null {
  const info = isRecord(candidate.info) ? candidate.info : null;
  const raw = info?.tcb_info;
  try {
    const v: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}

/** The report with what this check does not read replaced by "<removed: N bytes>", as test/data does. */
export function trimReport(body: string): string {
  const data: unknown = JSON.parse(body);
  if (!isRecord(data)) return body;
  const removed = (v: unknown): string =>
    `<removed: ${Buffer.byteLength(typeof v === "string" ? v : JSON.stringify(v))} bytes>`;
  const keep = new Set([
    "model_name",
    "signing_address",
    "signing_algo",
    "signing_public_key",
    "request_nonce",
    "intel_quote",
    "event_log",
    "nvidia_payload",
    "info",
  ]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) out[k] = k === "model_attestations" ? v : removed(v);
  if (Array.isArray(data.model_attestations)) {
    out.model_attestations = data.model_attestations.map((c: unknown) => {
      if (!isRecord(c)) return c;
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(c)) o[k] = keep.has(k) ? v : removed(v);
      if (isRecord(c.info)) {
        const info: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(c.info)) info[k] = k === "tcb_info" ? v : removed(v);
        o.info = info;
      }
      return o;
    });
  }
  return `${JSON.stringify(out, null, 1)}\n`;
}

/** NVIDIA's JWKS cut to the keys the reply's tokens name (the full set is over 500 KB). */
export function trimJwks(jwks: string, nrasReply: string): string {
  const kids = new Set<string>();
  for (const m of nrasReply.matchAll(/"(eyJ[A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"/g)) {
    try {
      const h: unknown = JSON.parse(Buffer.from(m[1] ?? "", "base64url").toString("utf8"));
      if (isRecord(h) && typeof h.kid === "string") kids.add(h.kid);
    } catch {
      // not a JWT header
    }
  }
  const data: unknown = JSON.parse(jwks);
  const keys =
    isRecord(data) && Array.isArray(data.keys)
      ? data.keys.filter((k: unknown) => isRecord(k) && kids.has(String(k.kid)))
      : [];
  return `${JSON.stringify({ keys }, null, 1)}\n`;
}

export async function runAttestationCheck(
  opts: { model: string; algo: SigningAlgo },
  deps: AttestationDeps,
): Promise<AttestationResult> {
  const lines: string[] = [];
  let failures = 0;
  let callFailures = 0;
  const show = (c: Check): void => {
    if (!c.ok) failures += 1;
    lines.push(`  ${c.ok ? "OK  " : "FAIL"}  ${c.name}: ${c.detail}`);
  };
  const started = deps.now();
  const nonce = deps.nonce();
  lines.push(`NEAR AI attestation check, ${started.toISOString()}. Read-only: no completion, no key.`);
  lines.push(
    `model ${opts.model}, signing scheme ${opts.algo}; our nonce ${nonce} (32 random bytes, new for this run)`,
  );

  // 1. A fresh report for our nonce: NEAR's own hardware (provider=near), no TLS binding, no aliasing.
  let body: string;
  try {
    const r = await fetchAttestation(opts.model, opts.algo, nonce, deps.fetchFn);
    lines.push(
      `GET ${NEARAI_BASE_URL}/attestation/report (provider=near): HTTP ${r.status}, ${Buffer.byteLength(r.body)} bytes`,
    );
    if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${r.body.slice(0, 200)}`);
    body = r.body;
    await deps.save?.("report-trimmed.json", trimReport(body));
  } catch (e) {
    lines.push(`  FAIL  could not fetch the report: ${e instanceof Error ? e.message : String(e)}`);
    return { lines, failures, callFailures: callFailures + 1 };
  }
  const data: unknown = JSON.parse(body);
  const candidates = isRecord(data) && Array.isArray(data.model_attestations) ? data.model_attestations : [];
  if (candidates.length === 0) {
    show({
      name: "model evidence",
      ok: false,
      detail: "model_attestations is missing or empty (docs: reject)",
    });
  }
  // NVIDIA's keys, fetched once per run (the raw body is kept to save the keys used).
  let jwks: { body: string; keys: ReturnType<typeof parseJwks> } | null = null;

  for (const [i, c] of candidates.entries()) {
    lines.push("", `Candidate ${i + 1} of ${candidates.length}`);
    if (!isRecord(c)) {
      show({ name: "candidate", ok: false, detail: "not an object" });
      continue;
    }
    const address =
      typeof c.signing_address === "string" ? c.signing_address.toLowerCase().replace(/^0x/, "") : "";
    show({
      name: "nonce echoed",
      ok: c.request_nonce === nonce,
      detail:
        c.request_nonce === nonce ? "request_nonce is ours" : `request_nonce is ${String(c.request_nonce)}`,
    });
    show({
      name: "model and scheme",
      ok: c.model_name === opts.model && c.signing_algo === opts.algo,
      detail: `${String(c.model_name)}, ${String(c.signing_algo)}`,
    });
    if (opts.model === PINNED_01.model && opts.algo === PINNED_01.algo) {
      show({
        name: "signer is 01's pin",
        ok: address === PINNED_01.signer,
        detail:
          address === PINNED_01.signer
            ? `${address} (01 §6.3)`
            : `${address || "(none)"}, but 01 pins ${PINNED_01.signer}`,
      });
    } else {
      lines.push(`  INFO  signer: ${address} (01 pins no signer for this model and scheme)`);
    }

    // 2. The Intel TDX quote.
    let quote: ReturnType<typeof parseTdxQuote> | null = null;
    try {
      if (typeof c.intel_quote !== "string") throw new Error("no intel_quote");
      quote = parseTdxQuote(Buffer.from(c.intel_quote, "hex"));
      lines.push(` Intel TDX quote (${c.intel_quote.length / 2} bytes, version ${quote.version})`);
    } catch (e) {
      show({ name: "TDX quote", ok: false, detail: e instanceof Error ? e.message : String(e) });
    }
    const tcb = tcbInfo(c);
    if (quote) {
      for (const check of checkQuoteSignatures(quote, deps.now())) show(check);
      const want = expectedReportData(address, nonce);
      show({
        name: "report data",
        ok: quote.report.reportData.equals(want),
        detail: quote.report.reportData.equals(want)
          ? "the quote's report data is the signer's key then our nonce: it binds both"
          : `the quote's report data ${hex(quote.report.reportData)} is not signer || nonce`,
      });
      // The docs: model reports do not return `report_data` today; when one does, it must equal the quote's.
      if (typeof c.report_data === "string") {
        const same = c.report_data.toLowerCase() === hex(quote.report.reportData);
        show({
          name: "stated report data",
          ok: same,
          detail: same ? "equals the quote's" : "differs from the quote's",
        });
      }
      show({
        name: "debug mode",
        ok: !tdDebug(quote.report),
        detail: `TD attributes ${hex(quote.report.tdAttributes)}: debug ${tdDebug(quote.report) ? "ON (docs: reject)" : "off"}`,
      });
      const compose = typeof tcb?.app_compose === "string" ? tcb.app_compose : null;
      if (compose === null)
        show({ name: "configuration", ok: false, detail: "no info.tcb_info.app_compose" });
      else {
        const same = quote.report.mrConfigId.equals(expectedMrConfigId(compose));
        show({
          name: "configuration",
          ok: same,
          detail: same
            ? `MRCONFIGID is 01, sha256(app_compose) ${short(hex(quote.report.mrConfigId.subarray(1, 33)))}, then zeros`
            : "MRCONFIGID does not match app_compose",
        });
      }
      try {
        const replay = replayRtmr3(c.event_log);
        const same = replay.rtmr3.equals(quote.report.rtmr3) && replay.problems.length === 0;
        show({
          name: "event log",
          ok: same,
          detail: same
            ? `RTMR3 replayed from ${replay.events} events equals the quote's`
            : [...replay.problems, "RTMR3 does not replay"].join("; "),
        });
      } catch (e) {
        show({ name: "event log", ok: false, detail: e instanceof Error ? e.message : String(e) });
      }
      lines.push(
        `  INFO  measured (not compared with any allowlist): MRTD ${short(hex(quote.report.mrTd))}, RTMR0 ${short(hex(quote.report.rtmr0))}, RTMR1 ${short(hex(quote.report.rtmr1))}, RTMR2 ${short(hex(quote.report.rtmr2))}, os_image_hash ${short(String(tcb?.os_image_hash ?? "?"))}, compose_hash ${short(String(tcb?.compose_hash ?? "?"))}`,
      );
    }

    // 3. The NVIDIA GPU evidence.
    if (typeof c.nvidia_payload !== "string") {
      show({ name: "GPU evidence", ok: false, detail: "no nvidia_payload" });
      continue;
    }
    let payload: ReturnType<typeof parseGpuPayload>;
    try {
      payload = parseGpuPayload(c.nvidia_payload);
    } catch (e) {
      show({ name: "GPU evidence", ok: false, detail: e instanceof Error ? e.message : String(e) });
      continue;
    }
    lines.push(` NVIDIA GPU evidence (${payload.gpus} GPU(s), ${payload.arch ?? "arch not given"})`);
    const nonceOk = payload.nonce.toLowerCase() === nonce;
    show({
      name: "payload nonce",
      ok: nonceOk,
      detail: nonceOk ? "ours" : `${payload.nonce}, not ours (not sent to NVIDIA)`,
    });
    if (!nonceOk) continue;
    try {
      if (jwks === null) {
        const k = await fetchNvidiaJwks(deps.fetchFn);
        if (k.status !== 200) throw new Error(`NVIDIA JWKS: HTTP ${k.status}`);
        jwks = { body: k.body, keys: parseJwks(k.body) };
      }
      const n = await attestGpu(c.nvidia_payload, deps.fetchFn);
      lines.push(`  POST NVIDIA NRAS /v3/attest/gpu: HTTP ${n.status}`);
      if (n.status !== 200) throw new Error(`NRAS: HTTP ${n.status}: ${n.body.slice(0, 200)}`);
      await deps.save?.(`nras-reply-${i + 1}.json`, n.body);
      await deps.save?.(`nvidia-jwks-used-${i + 1}.json`, trimJwks(jwks.body, n.body));
      for (const check of checkNrasReply(n.body, jwks.keys, nonce, deps.now())) show(check);
    } catch (e) {
      callFailures += 1;
      lines.push(`  FAIL  GPU evidence could not be checked: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  lines.push("", "UNVERIFIED, and why:");
  for (const u of UNVERIFIED_PARTS) lines.push(`  - ${u}`);
  lines.push(
    "",
    failures === 0 && callFailures === 0
      ? `RESULT  every check above passed: NEAR AI's ${opts.model} ${opts.algo} key ${candidates.length === 1 ? "" : "(each candidate) "}is bound to a fresh Intel TDX quote with our nonce, and the GPU evidence with the same nonce passed NVIDIA's attestation. The parts listed as UNVERIFIED were not checked.`
      : `RESULT  ${failures} check(s) failed, ${callFailures} call(s) failed; see the lines marked FAIL`,
  );
  return { lines, failures, callFailures };
}
