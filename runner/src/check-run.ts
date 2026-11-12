import { createHash } from "node:crypto";
import { checkMarkets, checkModels, checkSigner } from "./check.ts";
import { fetchMeta, HL_INFO_URL } from "./hyperliquid.ts";
import type { Network } from "./markets.ts";
import {
  fetchAttestation,
  fetchModels,
  NEARAI_BASE_URL,
  parseModelSigners,
  SIGNED_CHAT_MODELS,
  SIGNING_ALGOS,
} from "./nearai.ts";
import { readSecret } from "./secret.ts";

export interface CheckDeps {
  fetchFn: typeof fetch;
  env: Record<string, string | undefined>;
  now: () => Date;
  /** A fresh client nonce for each attestation request (64 hex characters). */
  nonce: () => string;
  /** Saves a raw response at intern/fixtures/<relPath>. Null means do not save. */
  save: ((relPath: string, body: string) => Promise<void>) | null;
}

export interface CheckResult {
  lines: string[];
  /** Differences from what the brief and 01 expect, including a missing key. */
  problems: number;
  /** Calls that could not be made or read. */
  failures: number;
}

const NETWORKS: readonly Network[] = ["testnet", "mainnet"];

function status(problems: readonly string[]): string {
  return problems.length === 0 ? "OK  " : "DIFF";
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** "2026-11-11T15:30:12.345Z" -> "2026-11-11T1530Z", used as a folder name for saved snapshots. */
export function snapshotStamp(d: Date): string {
  const iso = d.toISOString();
  return `${iso.slice(0, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}Z`;
}

/**
 * Step 0 of the brief: checks the NEAR AI key, the four signed models and their signers, and the six
 * Hyperliquid markets on both networks against 01 §4. Read-only. All I/O goes through `deps`.
 */
export async function runCheck(deps: CheckDeps): Promise<CheckResult> {
  const lines: string[] = [];
  let problems = 0;
  let failures = 0;
  const started = deps.now();
  const stamp = snapshotStamp(started);

  lines.push(`$INTERN runner check, ${started.toISOString()}`);
  lines.push("Read-only: no order is sent, no money moves, no key is printed.");

  // 1. The API key. Sent once to the attestation endpoint, which rejects an invalid key and does not bill.
  lines.push("", "NEAR AI API key (NEARAI_API_KEY)");
  const apiKey = readSecret("NEARAI_API_KEY", deps.env);
  if (!apiKey) {
    problems += 1;
    lines.push("  MISSING  not set, so not checked. Recording signed answers (step 1) needs it.");
  } else {
    try {
      const r = await fetchAttestation(SIGNED_CHAT_MODELS[0], "ecdsa", deps.nonce(), deps.fetchFn, apiKey);
      if (r.status === 200) {
        lines.push(
          "  OK    accepted by GET /v1/attestation/report (an invalid key gets 401). Credit not checked.",
        );
      } else if (r.status === 401) {
        problems += 1;
        lines.push("  DIFF  rejected: HTTP 401");
      } else {
        failures += 1;
        lines.push(`  FAIL  unexpected HTTP ${r.status}`);
      }
    } catch (e) {
      failures += 1;
      lines.push(`  FAIL  ${message(e)}`);
    }
  }

  // 2. The four models are still offered.
  lines.push("", `NEAR AI models (GET ${NEARAI_BASE_URL}/models)`);
  try {
    const { body, models } = await fetchModels(deps.fetchFn);
    for (const c of checkModels(models)) {
      problems += c.problems.length;
      const owner = c.owned_by === null ? "" : `owned_by ${c.owned_by}`;
      lines.push(`  ${status(c.problems)}  ${c.model.padEnd(38)} ${[owner, ...c.problems].join("; ")}`);
    }
    await deps.save?.(`ai/catalog/${stamp}/models.json`, body);
  } catch (e) {
    failures += 1;
    lines.push(`  FAIL  ${message(e)}`);
  }

  // 3. Each model still has a signing identity in its own hardware, for both schemes.
  lines.push("", `NEAR AI model signers (GET ${NEARAI_BASE_URL}/attestation/report, provider=near)`);
  lines.push("  Shows what each report claims. The hardware evidence inside it is not verified here.");
  const records: object[] = [];
  for (const model of SIGNED_CHAT_MODELS) {
    for (const algo of SIGNING_ALGOS) {
      const nonce = deps.nonce();
      const fetched_at = deps.now().toISOString();
      try {
        const r = await fetchAttestation(model, algo, nonce, deps.fetchFn);
        if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${r.body.slice(0, 200)}`);
        const signers = parseModelSigners(r.body, { model, algo, nonce });
        const c = checkSigner(model, algo, signers);
        problems += c.problems.length;
        const detail = [c.signing_address ?? "", c.note, ...c.problems].filter((s) => s !== "").join("  ");
        lines.push(`  ${status(c.problems)}  ${model.padEnd(38)} ${algo.padEnd(8)} ${detail}`);
        records.push({
          model,
          signing_algo: algo,
          signing_addresses: signers.map((s) => s.signing_address),
          request_nonce: nonce,
          fetched_at,
          http_status: r.status,
          body_bytes: Buffer.byteLength(r.body),
          body_sha256: createHash("sha256").update(r.body).digest("hex"),
        });
      } catch (e) {
        failures += 1;
        lines.push(`  FAIL  ${model.padEnd(38)} ${algo.padEnd(8)} ${message(e)}`);
      }
    }
  }
  try {
    const summary = {
      what: "Signing identities read from GET /v1/attestation/report (provider=near). A summary: the full reports (about 300 KB each) were not kept, and their hardware evidence was not verified.",
      records,
    };
    await deps.save?.(`ai/catalog/${stamp}/signers.json`, `${JSON.stringify(summary, null, 2)}\n`);
  } catch (e) {
    failures += 1;
    lines.push(`  FAIL  saving signers: ${message(e)}`);
  }

  // 4. The six markets on both networks, against 01 §4.
  lines.push("", 'Hyperliquid markets vs 01-SHARED-INTERFACE.md §4 (POST /info {"type":"meta"})');
  for (const network of NETWORKS) {
    try {
      const { body, assets } = await fetchMeta(network, deps.fetchFn);
      lines.push(`  ${network}: ${HL_INFO_URL[network]}, ${assets.length} markets listed`);
      for (const c of checkMarkets(network, assets)) {
        problems += c.problems.length;
        const found = c.found_index === null ? "not found" : `index ${c.found_index}`;
        const facts = [
          `${c.market.padEnd(5)} = ${c.hl_name.padEnd(5)}`,
          `${found} (01: ${c.expected_index})`,
          `size decimals ${c.found_sz_decimals ?? "-"} (01: ${c.expected_sz_decimals})`,
          `max leverage ${c.max_leverage ?? "-"}`,
        ];
        lines.push(`  ${status(c.problems)}  ${network.padEnd(7)} ${[...facts, ...c.problems].join("  ")}`);
      }
      await deps.save?.(`hl/info/${stamp}/meta-${network}.json`, body);
    } catch (e) {
      failures += 1;
      lines.push(`  FAIL  ${network}: ${message(e)}`);
    }
  }

  lines.push(
    "",
    problems === 0 && failures === 0
      ? "RESULT  everything matches"
      : `RESULT  ${problems} difference(s), ${failures} failed call(s); see the lines marked DIFF, MISSING or FAIL`,
  );
  return { lines, problems, failures };
}
