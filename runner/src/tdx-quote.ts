import { createHash, createPublicKey, type KeyObject, verify, X509Certificate } from "node:crypto";

/**
 * An Intel TDX quote (version 4, the form NEAR AI's model reports carry) and the checks of its signature chain that
 * Node's own crypto can do, with no new dependency.
 *
 * Layout: Intel's DCAP quote format (TDX quote v4: a 48-byte header, the 584-byte TD report, then the signature
 * data), as read by `dcap-qvl` (github.com/Phala-Network/dcap-qvl, the verifier NEAR AI's docs name), whose
 * `quote.js` and `verify.js` this follows field by field. Offsets were cross-checked on a real report fetched on
 * 2026-11-13: MRTD and RTMR0 to RTMR3 read from the quote equal the report's `info.tcb_info` values.
 *
 * What is checked here: the PCK certificate chain up to Intel's SGX root certificate (pinned below), the quoting
 * enclave's report signed by the PCK key, that report binding the attestation key, and the quote signed by that
 * key. What is NOT checked (it needs Intel's collateral, which `dcap-qvl` fetches): the platform's TCB status and
 * advisories, the quoting enclave's identity, and certificate revocation.
 */

/**
 * Intel SGX Root CA, DER, as served by Intel at
 * https://certificates.trustedservices.intel.com/Intel_SGX_Provisioning_Certification_RootCA.cer (fetched
 * 2026-11-13; SHA-256 of the DER 44a0196b2b99f889b8e149e95b807a350e7424964399e885a7cbb8ccfab674d3, the same bytes
 * `dcap-qvl` 0.7.1 embeds). Valid 2018-05-21 to 2049-12-31.
 */
export const INTEL_SGX_ROOT_CA_DER = Buffer.from(
  "MIICjzCCAjSgAwIBAgIUImUM1lqdNInzg7SVUr9QGzknBqwwCgYIKoZIzj0EAwIwaDEaMBgGA1UEAwwRSW50ZWwgU0dYIFJvb3QgQ0ExGjAYBgNVBAoMEUludGVsIENvcnBvcmF0aW9uMRQwEgYDVQQHDAtTYW50YSBDbGFyYTELMAkGA1UECAwCQ0ExCzAJBgNVBAYTAlVTMB4XDTE4MDUyMTEwNDUxMFoXDTQ5MTIzMTIzNTk1OVowaDEaMBgGA1UEAwwRSW50ZWwgU0dYIFJvb3QgQ0ExGjAYBgNVBAoMEUludGVsIENvcnBvcmF0aW9uMRQwEgYDVQQHDAtTYW50YSBDbGFyYTELMAkGA1UECAwCQ0ExCzAJBgNVBAYTAlVTMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEC6nEwMDIYZOj/iPWsCzaEKi71OiOSLRFhWGjbnBVJfVnkY4u3IjkDYYL0MxO4mqsyYjlBalTVYxFP2sJBK5zlKOBuzCBuDAfBgNVHSMEGDAWgBQiZQzWWp00ifODtJVSv1AbOScGrDBSBgNVHR8ESzBJMEegRaBDhkFodHRwczovL2NlcnRpZmljYXRlcy50cnVzdGVkc2VydmljZXMuaW50ZWwuY29tL0ludGVsU0dYUm9vdENBLmRlcjAdBgNVHQ4EFgQUImUM1lqdNInzg7SVUr9QGzknBqwwDgYDVR0PAQH/BAQDAgEGMBIGA1UdEwEB/wQIMAYBAf8CAQEwCgYIKoZIzj0EAwIDSQAwRgIhAOW/5QkR+S9CiSDcNoowLuPRLsWGf/Yi7GSX94BgwTwgAiEA4J0lrHoMs+Xo5o/sX6O9QWxHRAvZUGOdRQ7cvqRXaqI=",
  "base64",
);

const HEADER_LEN = 48;
const TD_REPORT10_LEN = 584;
const TEE_TYPE_TDX = 0x81;
const ATTESTATION_KEY_ECDSA_P256 = 2;
const CERT_QE_REPORT = 6; // QE report certification data (quote v4)
const CERT_PCK_CHAIN = 5; // PCK certificate chain, PEM
const QE_REPORT_LEN = 384; // an SGX report body
const QE_REPORT_DATA_AT = 320; // report data, the last 64 bytes of the report body

/** The TD report of a TDX 1.0 quote body. */
export interface TdReport {
  teeTcbSvn: Buffer;
  mrSeam: Buffer;
  mrSignerSeam: Buffer;
  seamAttributes: Buffer;
  tdAttributes: Buffer;
  xfam: Buffer;
  mrTd: Buffer;
  mrConfigId: Buffer;
  mrOwner: Buffer;
  mrOwnerConfig: Buffer;
  rtmr0: Buffer;
  rtmr1: Buffer;
  rtmr2: Buffer;
  rtmr3: Buffer;
  reportData: Buffer;
}

export interface TdxQuote {
  version: number;
  qeVendorId: string;
  report: TdReport;
  /** Header and TD report: what the attestation key signs. */
  signed: Buffer;
  signature: Buffer;
  attestationKey: Buffer;
  qeReport: Buffer;
  qeReportSignature: Buffer;
  qeAuthData: Buffer;
  pckChainPem: string;
}

class Reader {
  #at = 0;
  readonly bytes: Buffer;
  constructor(bytes: Buffer) {
    this.bytes = bytes;
  }
  get at(): number {
    return this.#at;
  }
  take(n: number): Buffer {
    if (n < 0 || this.#at + n > this.bytes.length) throw new Error("TDX quote: shorter than its fields");
    const out = this.bytes.subarray(this.#at, this.#at + n);
    this.#at += n;
    return out;
  }
  u16(): number {
    return this.take(2).readUInt16LE(0);
  }
  u32(): number {
    return this.take(4).readUInt32LE(0);
  }
}

/** Parses a version 4 TDX quote with an ECDSA P-256 attestation key and a PCK chain. Throws on anything else. */
export function parseTdxQuote(bytes: Buffer): TdxQuote {
  const r = new Reader(bytes);
  const version = r.u16();
  const keyType = r.u16();
  const teeType = r.u32();
  r.take(4); // QE SVN, PCE SVN
  const qeVendorId = r.take(16).toString("hex");
  r.take(20); // user data
  if (version !== 4) throw new Error(`TDX quote: version ${version}; only version 4 is read here`);
  if (teeType !== TEE_TYPE_TDX) throw new Error(`TDX quote: TEE type 0x${teeType.toString(16)}, not TDX`);
  if (keyType !== ATTESTATION_KEY_ECDSA_P256) throw new Error(`TDX quote: attestation key type ${keyType}`);
  const report: TdReport = {
    teeTcbSvn: r.take(16),
    mrSeam: r.take(48),
    mrSignerSeam: r.take(48),
    seamAttributes: r.take(8),
    tdAttributes: r.take(8),
    xfam: r.take(8),
    mrTd: r.take(48),
    mrConfigId: r.take(48),
    mrOwner: r.take(48),
    mrOwnerConfig: r.take(48),
    rtmr0: r.take(48),
    rtmr1: r.take(48),
    rtmr2: r.take(48),
    rtmr3: r.take(48),
    reportData: r.take(64),
  };
  if (r.at !== HEADER_LEN + TD_REPORT10_LEN) throw new Error("TDX quote: body length");
  const signed = bytes.subarray(0, r.at);
  const auth = new Reader(r.take(r.u32()));
  const signature = auth.take(64);
  const attestationKey = auth.take(64);
  const outerType = auth.u16();
  const outer = new Reader(auth.take(auth.u32()));
  if (outerType !== CERT_QE_REPORT) throw new Error(`TDX quote: certification data type ${outerType}, not 6`);
  const qeReport = outer.take(QE_REPORT_LEN);
  const qeReportSignature = outer.take(64);
  const qeAuthData = outer.take(outer.u16());
  const innerType = outer.u16();
  const chain = outer.take(outer.u32());
  if (innerType !== CERT_PCK_CHAIN)
    throw new Error(`TDX quote: inner certification data type ${innerType}, not 5`);
  return {
    version,
    qeVendorId,
    report,
    signed,
    signature,
    attestationKey,
    qeReport,
    qeReportSignature,
    qeAuthData,
    pckChainPem: chain.toString("utf8"),
  };
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/** ECDSA P-256 with SHA-256; the signature is r || s (64 bytes), as Intel's quote format writes it. */
function ecdsaP256(data: Buffer, signature: Buffer, key: KeyObject): boolean {
  try {
    return verify("sha256", data, { key, dsaEncoding: "ieee-p1363" }, signature);
  } catch {
    return false;
  }
}

/** The quote's signature chain, as far as Node's crypto reaches (see the file's comment). */
export function checkQuoteSignatures(
  q: TdxQuote,
  now: Date,
  rootDer: Buffer = INTEL_SGX_ROOT_CA_DER,
): Check[] {
  const checks: Check[] = [];
  const pems = q.pckChainPem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  let certs: X509Certificate[] = [];
  try {
    certs = pems.map((p) => new X509Certificate(p));
  } catch (e) {
    checks.push({
      name: "PCK certificate chain",
      ok: false,
      detail: `a certificate does not parse: ${String(e)}`,
    });
    return checks;
  }
  const root = new X509Certificate(rootDer);
  const problems: string[] = [];
  if (certs.length < 2) problems.push(`${certs.length} certificate(s) in the chain`);
  const last = certs[certs.length - 1];
  if (last === undefined || !last.raw.equals(root.raw))
    problems.push("it does not end in Intel's SGX root certificate");
  certs.forEach((c, i) => {
    const issuer = certs[i + 1] ?? root;
    if (!c.checkIssued(issuer) || !c.verify(issuer.publicKey))
      problems.push(`certificate ${i + 1} is not signed by the next one`);
    if (i > 0 && !c.ca) problems.push(`certificate ${i + 1} signs others but is not a CA certificate`);
    if (now < new Date(c.validFrom) || now > new Date(c.validTo))
      problems.push(`certificate ${i + 1} is not valid now`);
  });
  const leaf = certs[0];
  const names = certs.map((c) => /CN=([^\n,]+)/.exec(c.subject)?.[1] ?? "?").join(" -> ");
  checks.push({
    name: "PCK certificate chain",
    ok: problems.length === 0,
    detail:
      problems.length === 0
        ? `${names}; each signed by the next, the last is Intel's pinned root, all valid now`
        : problems.join("; "),
  });

  const qeSigned = leaf !== undefined && ecdsaP256(q.qeReport, q.qeReportSignature, leaf.publicKey);
  checks.push({
    name: "quoting enclave report",
    ok: qeSigned,
    detail: qeSigned
      ? "signed by the PCK certificate's key"
      : "its signature does not verify with the PCK certificate's key",
  });

  const bound = createHash("sha256")
    .update(Buffer.concat([q.attestationKey, q.qeAuthData]))
    .digest()
    .equals(q.qeReport.subarray(QE_REPORT_DATA_AT, QE_REPORT_DATA_AT + 32));
  checks.push({
    name: "attestation key",
    ok: bound,
    detail: bound
      ? "the quoting enclave's report data is sha256(attestation key || QE auth data)"
      : "the quoting enclave's report does not bind the attestation key",
  });

  let quoteSigned = false;
  try {
    const key = createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: q.attestationKey.subarray(0, 32).toString("base64url"),
        y: q.attestationKey.subarray(32, 64).toString("base64url"),
      },
      format: "jwk",
    });
    quoteSigned = ecdsaP256(q.signed, q.signature, key);
  } catch {
    quoteSigned = false;
  }
  checks.push({
    name: "quote signature",
    ok: quoteSigned,
    detail: quoteSigned
      ? "the header and TD report are signed by the attestation key"
      : "the quote's signature does not verify",
  });
  return checks;
}

/** TD attributes bit 0: the TD runs in debug mode (NEAR AI's verification policy: reject). */
export function tdDebug(report: TdReport): boolean {
  return ((report.tdAttributes[0] ?? 0) & 1) === 1;
}

/**
 * Replays the RTMR3 event log as NEAR AI's docs describe (quote-nonce-signer.md): for each event with `imr` 3, in
 * order, digest = SHA-384(event_type as 4 little-endian bytes || ":" || event || ":" || payload bytes); a non-empty
 * `digest` field must equal it; RTMR3 = SHA-384(RTMR3 || digest), from 48 zero bytes.
 */
export function replayRtmr3(eventLog: unknown): { rtmr3: Buffer; events: number; problems: string[] } {
  const list: unknown = typeof eventLog === "string" ? JSON.parse(eventLog) : eventLog;
  if (!Array.isArray(list)) throw new Error("event_log is not a list");
  let rtmr3 = Buffer.alloc(48);
  let events = 0;
  const problems: string[] = [];
  for (const e of list) {
    if (typeof e !== "object" || e === null || (e as { imr?: unknown }).imr !== 3) continue;
    const { event_type, event, event_payload, digest } = e as Record<string, unknown>;
    if (typeof event_type !== "number" || typeof event !== "string")
      throw new Error("event_log: malformed event");
    const type = Buffer.alloc(4);
    type.writeUInt32LE(event_type);
    const computed = createHash("sha384")
      .update(
        Buffer.concat([
          type,
          Buffer.from(":"),
          Buffer.from(event, "utf8"),
          Buffer.from(":"),
          Buffer.from(typeof event_payload === "string" ? event_payload : "", "hex"),
        ]),
      )
      .digest();
    if (typeof digest === "string" && digest !== "" && digest.toLowerCase() !== computed.toString("hex")) {
      problems.push(`event ${event}: its digest is not the hash of its payload`);
    }
    rtmr3 = createHash("sha384")
      .update(Buffer.concat([rtmr3, computed]))
      .digest();
    events += 1;
  }
  return { rtmr3, events, problems };
}

/** NEAR AI's docs: MRCONFIGID is 01, then SHA-256 of the exact `app_compose` text, then 15 zero bytes. */
export function expectedMrConfigId(appCompose: string): Buffer {
  return Buffer.concat([
    Buffer.from([1]),
    createHash("sha256").update(Buffer.from(appCompose, "utf8")).digest(),
    Buffer.alloc(15),
  ]);
}

/**
 * NEAR AI's docs, for a report fetched without TLS binding: report data is the signing identity zero-padded on the
 * right to 32 bytes (an ed25519 key fills all 32; an ECDSA address 20), then the client's 32-byte nonce.
 */
export function expectedReportData(signingAddress: string, nonceHex: string): Buffer {
  const id = Buffer.from(signingAddress.replace(/^0x/i, ""), "hex");
  return Buffer.concat([id, Buffer.alloc(32 - id.length), Buffer.from(nonceHex, "hex")]);
}
