import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { runAttestationCheck, trimJwks, trimReport, UNVERIFIED_PARTS } from "../src/attestation-check.ts";
import { checkNrasReply, parseGpuPayload, parseJwks, verifyEs384 } from "../src/nvidia-gpu.ts";
import { PINNED_01 } from "../src/pinned.ts";
import {
  checkQuoteSignatures,
  expectedMrConfigId,
  expectedReportData,
  parseTdxQuote,
  replayRtmr3,
  tdDebug,
} from "../src/tdx-quote.ts";

// A real run of `npm run attestation-check -- --save`, 2026-11-13 14:00:58 UTC (source.json): NEAR AI's report for
// z-ai/glm-5.3-flash, ed25519, with our nonce (trimmed to the fields the check reads), NVIDIA NRAS's reply to its GPU
// evidence, and the NVIDIA keys that reply's tokens name. Offline: the services are replayed by a fake fetch.
const DIR = new URL("../../fixtures/ai/attestation/20261113T140058Z/", import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, DIR), "utf8");
const SOURCE = JSON.parse(read("source.json")) as { nonce: string; fetched_at: string };
const REPORT = read("report-trimmed.json");
const NRAS = read("nras-reply-1.json");
const JWKS = read("nvidia-jwks-used-1.json");
const NOW = new Date("2026-11-13T14:01:00Z"); // inside the certificates' and the NVIDIA tokens' validity
const candidate = JSON.parse(REPORT).model_attestations[0];
const quoteBytes = Buffer.from(candidate.intel_quote, "hex");

describe("Intel TDX quote", () => {
  const q = parseTdxQuote(quoteBytes);

  it("reads a version 4 TDX quote whose measurements are the ones the report states", () => {
    assert.equal(q.version, 4);
    assert.equal(q.qeVendorId, "939a7233f79c4ca9940a0db3957f0607");
    assert.equal(q.report.mrTd.toString("hex"), candidate.info.tcb_info.mrtd);
    assert.equal(q.report.rtmr0.toString("hex"), candidate.info.tcb_info.rtmr0);
    assert.equal(q.report.rtmr3.toString("hex"), candidate.info.tcb_info.rtmr3);
    assert.equal(tdDebug(q.report), false);
  });

  it("checks the signature chain up to Intel's root with Node's crypto", () => {
    const checks = checkQuoteSignatures(q, NOW);
    assert.deepEqual(
      checks.map((c) => [c.name, c.ok]),
      [
        ["PCK certificate chain", true],
        ["quoting enclave report", true],
        ["attestation key", true],
        ["quote signature", true],
      ],
    );
  });

  it("refuses a quote with one changed byte in its TD report", () => {
    const bad = Buffer.from(quoteBytes);
    bad[48 + 520] = (bad[48 + 520] ?? 0) ^ 1; // inside RTMR3
    const checks = checkQuoteSignatures(parseTdxQuote(bad), NOW);
    assert.deepEqual(
      checks.filter((c) => !c.ok).map((c) => c.name),
      ["quote signature"],
    );
  });

  it("refuses a chain that does not end in the pinned root", () => {
    const leafOnlyRoot = Buffer.from(
      (q.pckChainPem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [])[1] ?? "",
    );
    const checks = checkQuoteSignatures(q, NOW, leafOnlyRoot);
    assert.match(checks[0]?.detail ?? "", /does not end in Intel's SGX root certificate/);
  });

  it("refuses an expired moment", () => {
    assert.match(checkQuoteSignatures(q, new Date("2050-01-01"))[0]?.detail ?? "", /not valid now/);
  });

  it("binds the signer and our nonce in the report data, as NEAR AI's docs lay it out", () => {
    assert.ok(q.report.reportData.equals(expectedReportData(PINNED_01.signer, SOURCE.nonce)));
    assert.ok(!q.report.reportData.equals(expectedReportData(PINNED_01.signer, "00".repeat(32))));
  });

  it("matches MRCONFIGID to the measured configuration, and RTMR3 to the event log", () => {
    assert.ok(q.report.mrConfigId.equals(expectedMrConfigId(candidate.info.tcb_info.app_compose)));
    assert.ok(!q.report.mrConfigId.equals(expectedMrConfigId(`${candidate.info.tcb_info.app_compose} `)));
    const replay = replayRtmr3(candidate.event_log);
    assert.equal(replay.events, 10);
    assert.deepEqual(replay.problems, []);
    assert.ok(replay.rtmr3.equals(q.report.rtmr3));
    // This report leaves each RTMR3 event's own `digest` empty (the docs allow it), so a changed payload shows as
    // another RTMR3; a stated digest that does not match its payload is named.
    type Event = { imr: number; event: string; event_payload: string; digest: string };
    const changed = candidate.event_log.map((e: Event) =>
      e.imr === 3 && e.event === "compose-hash" ? { ...e, event_payload: "00".repeat(32) } : e,
    );
    assert.ok(!replayRtmr3(changed).rtmr3.equals(q.report.rtmr3));
    const misstated = candidate.event_log.map((e: Event) =>
      e.imr === 3 && e.event === "compose-hash" ? { ...e, digest: "00".repeat(48) } : e,
    );
    assert.match(
      replayRtmr3(misstated).problems.join(),
      /compose-hash: its digest is not the hash of its payload/,
    );
  });
});

describe("NVIDIA GPU evidence", () => {
  const keys = parseJwks(JWKS);

  it("reads the payload: our nonce, eight Hopper GPUs", () => {
    assert.deepEqual(parseGpuPayload(candidate.nvidia_payload), {
      nonce: SOURCE.nonce,
      arch: "HOPPER",
      gpus: 8,
    });
  });

  it("accepts NRAS's real reply: signed by NVIDIA, a passing verdict, our nonce, every GPU named", () => {
    const checks = checkNrasReply(NRAS, keys, SOURCE.nonce, NOW);
    assert.deepEqual(
      checks.filter((c) => !c.ok),
      [],
    );
    assert.equal(checks.length, 5);
  });

  it("refuses another nonce, unknown keys, a token that expired, and a changed token", () => {
    assert.match(
      checkNrasReply(NRAS, keys, "ab".repeat(32), NOW).find((c) => !c.ok)?.detail ?? "",
      /eat_nonce is 8ea290d0/,
    );
    assert.match(
      checkNrasReply(NRAS, [], SOURCE.nonce, NOW)[0]?.detail ?? "",
      /NVIDIA publishes no P-384 key/,
    );
    assert.match(
      checkNrasReply(NRAS, keys, SOURCE.nonce, new Date("2026-11-14T14:00:00Z")).find((c) => !c.ok)?.name ??
        "",
      /token time/,
    );
    const overall = JSON.parse(NRAS)[0][1] as string;
    const [h, p, s] = overall.split(".");
    const claims = JSON.parse(Buffer.from(p ?? "", "base64url").toString("utf8"));
    claims["x-nvidia-overall-att-result"] = false;
    const forged = `${h}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${s}`;
    assert.deepEqual(verifyEs384(forged, keys), { ok: false, reason: "the signature does not verify" });
  });
});

describe("attestation-check, end to end on the saved replies", () => {
  /** NEAR AI, NVIDIA's keys and NVIDIA's attestation service, answering with the saved replies. */
  const calls: string[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith("https://cloud-api.near.ai/v1/attestation/report?")) {
      calls.push(`report ${new URL(u).searchParams.get("provider")} ${new URL(u).searchParams.get("nonce")}`);
      return new Response(REPORT); // the saved reply, which echoes the nonce of the real run
    }
    if (u === "https://nras.attestation.nvidia.com/.well-known/jwks.json") return new Response(JWKS);
    if (u === "https://nras.attestation.nvidia.com/v3/attest/gpu") {
      assert.equal(init?.body, candidate.nvidia_payload, "the payload goes to NVIDIA unchanged");
      return new Response(NRAS);
    }
    throw new Error(`unexpected call ${u}`);
  }) as typeof fetch;

  it("passes every check and lists what stays UNVERIFIED", async () => {
    const saved: string[] = [];
    const r = await runAttestationCheck(PINNED_01, {
      fetchFn,
      now: () => NOW,
      nonce: () => SOURCE.nonce,
      save: async (name) => {
        saved.push(name);
      },
    });
    const text = r.lines.join("\n");
    assert.equal(r.failures, 0, text);
    assert.equal(r.callFailures, 0, text);
    assert.match(text, /OK +signer is 01's pin: 5a0210f2442c7935/);
    assert.match(text, /OK +report data: the quote's report data is the signer's key then our nonce/);
    assert.match(text, /OK +GPU verdict: x-nvidia-overall-att-result is true/);
    assert.ok(UNVERIFIED_PARTS.every((u) => text.includes(u)));
    assert.deepEqual(saved, ["report-trimmed.json", "nras-reply-1.json", "nvidia-jwks-used-1.json"]);
    assert.equal(calls.at(-1), `report near ${SOURCE.nonce}`);
  });

  it("fails when the report does not echo our nonce", async () => {
    const r = await runAttestationCheck(PINNED_01, {
      fetchFn,
      now: () => NOW,
      nonce: () => SOURCE.nonce.replace(/^8/, "9"),
      save: null,
    });
    const text = r.lines.join("\n");
    assert.match(text, /FAIL +nonce echoed/);
    assert.match(text, /FAIL +report data/);
    assert.match(text, /FAIL +payload nonce: 8ea290d0.*not ours \(not sent to NVIDIA\)/);
  });

  it("keeps what the check reads when trimming, and only the NVIDIA keys used", () => {
    const again = JSON.parse(trimReport(REPORT)).model_attestations[0];
    assert.equal(again.intel_quote, candidate.intel_quote);
    assert.deepEqual(again.info.tcb_info, candidate.info.tcb_info);
    assert.deepEqual(JSON.parse(trimJwks(JWKS, NRAS)), JSON.parse(JWKS));
  });
});
