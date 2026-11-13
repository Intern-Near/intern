import { type AttestationResult, runAttestationCheck, UNVERIFIED_PARTS } from "./attestation-check.ts";
import { readConstants } from "./contract.ts";
import {
  type ContractScanReport,
  readDeploymentTargets,
  readRecordedHashes,
  scanContracts,
} from "./contract-scan.ts";
import { analyze, type Report as FillsReport, gather, STATUSES } from "./fills-check.ts";
import type { GitHead } from "./git-head.ts";
import { HL_TESTNET_INFO } from "./hl-exchange.ts";
import { isRecord } from "./json.ts";
import { checkKeyScope, describeKey, type KeyScope } from "./key-scope.ts";
import { TESTNET_ARCHIVAL_RPCS } from "./near-rpc.ts";
import { NEARAI_BASE_URL } from "./nearai.ts";
import { NEARBLOCKS_TESTNET_API, receiptsCalling, txLink } from "./nearblocks.ts";
import { NRAS_GPU_URL, NVIDIA_JWKS_URL } from "./nvidia-gpu.ts";
import { PINNED_01 } from "./pinned.ts";
import {
  COIN_FAST,
  type CoinCatalogue,
  catalogue,
  findRefusalTx,
  type RefusalsReport,
  readAllRefusals,
  readCodeTable,
  summarize,
} from "./refusals.ts";
import { keyReader, type RpcReader, viewFinal } from "./rpc-read.ts";
import { type VerifyRoundReport, verifyRound } from "./verify-round.ts";

/**
 * The proof bundle: one JSON file with everything a public proof page needs, gathered from public data in one run.
 * Each section calls a read-only tool's library directly (no subprocess) and becomes { status, sentence, data }; a
 * section that throws is recorded as "fail" with its error, and the others still run. Nothing is signed or sent.
 * The JSON shape is documented in runner/README.md ("proof").
 */

export type SectionStatus = "ok" | "warn" | "fail";

export interface SectionResult {
  status: SectionStatus;
  /** One plain sentence for the page. */
  sentence: string;
  /** The tool's own output, unchanged. */
  data: unknown;
}

export interface Section extends SectionResult {
  id: string;
  title: string;
  started_at: string;
  took_ms: number;
  /** The error, when the section could not run (then status is "fail" and data is null). */
  error: string | null;
}

export interface Job {
  id: string;
  title: string;
  run: () => Promise<SectionResult>;
}

export interface Endpoints {
  near_rpc: string;
  near_archival_rpcs: readonly string[];
  hyperliquid_info: string;
  near_ai: string;
  nvidia_attestation: readonly string[];
  nearblocks_api: string;
  explorer: string;
}

export interface ProofBundle {
  kind: "intern-proof-bundle";
  version: 1;
  generated_at: string;
  finished_at: string;
  network: "testnet";
  coin: string;
  git: GitHead | null;
  endpoints: Endpoints;
  summary: { ok: number; warn: number; fail: number; sentence: string };
  sections: Section[];
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Runs one section; an exception becomes a "fail" section, never an exception. */
export async function runJob(job: Job, now: () => number): Promise<Section> {
  const t0 = now();
  const base = { id: job.id, title: job.title, started_at: new Date(t0).toISOString() };
  try {
    const r = await job.run();
    return { ...base, ...r, took_ms: now() - t0, error: null };
  } catch (e) {
    return {
      ...base,
      status: "fail",
      sentence: `Could not be checked: ${message(e)}`,
      data: null,
      took_ms: now() - t0,
      error: message(e),
    };
  }
}

/** Runs the jobs one after another (gentle on the public services) and puts the bundle together. */
export async function buildBundle(input: {
  jobs: readonly Job[];
  coin: string;
  git: GitHead | null;
  endpoints: Endpoints;
  now: () => number;
}): Promise<ProofBundle> {
  const generated = new Date(input.now()).toISOString();
  const sections: Section[] = [];
  for (const job of input.jobs) sections.push(await runJob(job, input.now));
  const count = (s: SectionStatus) => sections.filter((x) => x.status === s).length;
  const [ok, warn, fail] = [count("ok"), count("warn"), count("fail")];
  return {
    kind: "intern-proof-bundle",
    version: 1,
    generated_at: generated,
    finished_at: new Date(input.now()).toISOString(),
    network: "testnet",
    coin: input.coin,
    git: input.git,
    endpoints: input.endpoints,
    summary: {
      ok,
      warn,
      fail,
      sentence: `${sections.length} checks: ${ok} ok, ${warn} with a caveat, ${fail} failed${
        fail > 0
          ? ` (${sections
              .filter((x) => x.status === "fail")
              .map((x) => x.id)
              .join(", ")})`
          : ""
      }.`,
    },
    sections,
  };
}

/** The section ids a full bundle has, in order (realJobs). */
export const SECTION_IDS = [
  "contract-scan",
  "key-scope",
  "fills-check",
  "verify-round",
  "attestation",
  "refusals",
] as const;

/**
 * What is wrong with a bundle's shape (the one documented in runner/README.md), as a list; empty when it is right.
 * For a page that loads a bundle and wants to know it can read it. The sections' `data` is not checked here.
 */
export function bundleShapeProblems(b: unknown): string[] {
  const p: string[] = [];
  const isTime = (v: unknown) => typeof v === "string" && !Number.isNaN(Date.parse(v));
  if (!isRecord(b)) return ["not a JSON object"];
  if (b.kind !== "intern-proof-bundle") p.push('kind is not "intern-proof-bundle"');
  if (b.version !== 1) p.push("version is not 1");
  if (b.network !== "testnet") p.push('network is not "testnet"');
  for (const k of ["generated_at", "finished_at"]) if (!isTime(b[k])) p.push(`${k} is not a time`);
  if (typeof b.coin !== "string") p.push("coin is not a string");
  if (b.git !== null && !(isRecord(b.git) && typeof b.git.commit === "string"))
    p.push("git is not null or {commit, ref}");
  if (!isRecord(b.endpoints) || typeof b.endpoints.near_rpc !== "string")
    p.push("endpoints.near_rpc is missing");
  const sections = Array.isArray(b.sections) ? b.sections : null;
  if (sections === null) return [...p, "sections is not a list"];
  const statuses: string[] = [];
  for (const [i, s] of sections.entries()) {
    const at = `sections[${i}]`;
    if (!isRecord(s)) {
      p.push(`${at} is not an object`);
      continue;
    }
    for (const k of ["id", "title", "sentence"])
      if (typeof s[k] !== "string") p.push(`${at}.${k} is not a string`);
    if (s.status !== "ok" && s.status !== "warn" && s.status !== "fail")
      p.push(`${at}.status is not ok, warn or fail`);
    else statuses.push(s.status);
    if (!isTime(s.started_at)) p.push(`${at}.started_at is not a time`);
    if (typeof s.took_ms !== "number") p.push(`${at}.took_ms is not a number`);
    if (!("data" in s)) p.push(`${at}.data is missing`);
    if (s.error !== null && typeof s.error !== "string") p.push(`${at}.error is not null or a string`);
    if (s.status === "fail" && s.data === null && typeof s.error !== "string")
      p.push(`${at} failed without an error`);
  }
  const sum = isRecord(b.summary) ? b.summary : null;
  if (sum === null || typeof sum.sentence !== "string") p.push("summary.sentence is missing");
  else
    for (const k of ["ok", "warn", "fail"] as const)
      if (sum[k] !== statuses.filter((s) => s === k).length)
        p.push(`summary.${k} does not count the sections`);
  return p;
}

// ---------------------------------------------------------------- judging each tool's output (pure)

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export function judgeContractScan(rep: ContractScanReport): SectionResult {
  const s = rep.summary;
  const n = s.accounts;
  const noun = s.accounts === s.contracts ? "contract" : "account";
  if (!s.ok) {
    const bad = rep.accounts.filter((a) => a.status === "fail");
    const first = bad[0]?.problems[0] ?? rep.failed[0]?.error ?? "see data";
    return {
      status: "fail",
      sentence: `${plural(bad.length + rep.failed.length, noun)} failed the scan: ${first}.`,
      data: rep,
    };
  }
  if (rep.accounts.every((a) => a.status === "ok"))
    return {
      status: "ok",
      sentence: `${plural(n, noun)}: nobody can change any of them, and each is the build ${rep.recorded_hashes?.file ?? "the repository"} records.`,
      data: rep,
    };
  const parts: string[] = [];
  parts.push(
    s.recorded_same === n
      ? `${plural(n, noun)}, each running exactly the build ${rep.recorded_hashes?.file ?? "the repository"} records`
      : `${plural(n, noun)}, ${s.recorded_same} running the recorded build${s.not_recorded > 0 ? `, ${s.not_recorded} with no recorded hash` : ""}`,
  );
  if (s.changeable_by_keys > 0)
    parts.push(
      s.changeable_by_keys === n
        ? "each still has a full-access key, so its holder can change it"
        : `${s.changeable_by_keys} still have a full-access key, so their holders can change them`,
    );
  if (s.code_path_not_ruled_out > 0)
    parts.push(
      `${s.code_path_not_ruled_out === n ? "all" : s.code_path_not_ruled_out} import the host functions that deploy code or change keys (near-sdk links them), so the code alone does not show it never will`,
    );
  return { status: "warn", sentence: `${parts.join("; ")}.`, data: rep };
}

function scopeSentence(role: string, s: KeyScope): string {
  const passing = s.keys.filter((k) => k.passes);
  const others = s.keys.filter((k) => !k.passes);
  const pass =
    passing.length === 0
      ? `none of its ${plural(s.keys.length, "key")} would pass as its signing key${s.reasons.length > 0 ? ` (${s.reasons.join("; ")})` : ""}`
      : `${passing.map((k) => describeKey(k)).join(" and ")} would pass as its signing key`;
  const rest =
    others.length === 0
      ? ""
      : `; it also holds ${others.map((k) => (k.kind === "full-access" ? `${describeKey(k)}, normally the owner's` : describeKey(k))).join(" and ")}`;
  return `The ${role} ${s.account_id}: ${pass}${rest}.`;
}

export function judgeKeyScope(runner: KeyScope, relayer: KeyScope | null): SectionResult {
  const scopes = relayer === null ? [runner] : [runner, relayer];
  const failing = scopes.filter((s) => s.passing.length === 0 || s.reasons.length > 0);
  return {
    status: failing.length > 0 ? "fail" : "ok",
    sentence: `${scopes.map((s) => scopeSentence(s.expect ?? "account", s)).join(" ")} No private key was read, so which key actually signs is not shown.`,
    data: scopes,
  };
}

export function judgeFills(rep: FillsReport): SectionResult {
  const s = rep.summary;
  const counts = STATUSES.filter((x) => s.by_status[x] > 0)
    .map((x) => `${s.by_status[x]} ${x}`)
    .join(", ");
  const fills =
    s.unmatched_fill_groups === 0
      ? "every fill on the contract's Hyperliquid address is tied to an order the contract signed"
      : `${plural(s.unmatched_fill_groups, "fill group")} on the address that no signed order accounts for`;
  return {
    status: s.ok ? "ok" : "fail",
    sentence: `Rounds ${rep.rounds.from} to ${rep.rounds.to}: ${plural(s.bets, "bet")}${counts ? ` (${counts})` : ""}; ${fills}.`,
    data: rep,
  };
}

export interface CheckedProposal {
  tx_hash: string;
  link: string;
  sender: string;
  block_height: number | null;
  at: string;
  report: VerifyRoundReport;
}

export function judgeVerifyRounds(rows: readonly CheckedProposal[]): SectionResult {
  const data = rows.map((r) => ({
    tx_hash: r.tx_hash,
    link: r.link,
    sender: r.sender,
    block_height: r.block_height,
    at: r.at,
    failures: r.report.failures,
    unverified: r.report.unverified,
    fatal: r.report.fatal,
    result: r.report.lines[r.report.lines.length - 1] ?? "",
    lines: r.report.lines,
  }));
  if (rows.length === 0) return { status: "warn", sentence: "No proposal was found to re-check.", data };
  const verified = rows.filter(
    (r) => r.report.fatal === null && r.report.failures + r.report.unverified === 0,
  );
  const failed = rows.filter((r) => r.report.fatal !== null || r.report.failures > 0);
  const status: SectionStatus = failed.length > 0 ? "fail" : verified.length === rows.length ? "ok" : "warn";
  const sentence =
    status === "ok"
      ? `The last ${plural(rows.length, "proposal")} re-checked from public data: in each, NEAR AI's pinned key signed the exact request and answer, the request carried the rulebook of that moment, and the contract's verdict fits.`
      : `Of the last ${plural(rows.length, "proposal")}, ${verified.length} verified from public data, ${failed.length} with a problem, ${rows.length - verified.length - failed.length} with a part not checked.`;
  return { status, sentence, data };
}

export function judgeAttestation(res: AttestationResult, model: string, algo: string): SectionResult {
  const ok = res.failures === 0 && res.callFailures === 0;
  return {
    status: ok ? "ok" : "fail",
    sentence: ok
      ? `NEAR AI's ${model} ${algo} key is bound to a fresh Intel TDX quote carrying our nonce, and the GPU evidence with the same nonce passed NVIDIA's attestation; ${UNVERIFIED_PARTS.length} parts stay UNVERIFIED (listed).`
      : `${plural(res.failures, "check")} failed and ${plural(res.callFailures, "call")} failed in NEAR AI's attestation for ${model}.`,
    data: { model, signing_algo: algo, ...res, unverified_parts: UNVERIFIED_PARTS },
  };
}

export function judgeRefusals(rep: RefusalsReport): SectionResult {
  const s = rep.summary;
  const missing = s.first_tx_found - s.first_tx_confirmed + s.first_tx_missing;
  const txs =
    s.with_example.length === 0
      ? ""
      : missing === 0
        ? "; each code's first example is tied to its transaction, confirmed on chain"
        : `; ${s.first_tx_confirmed} first examples tied to a confirmed transaction, ${missing} not`;
  return {
    status: missing > 0 ? "warn" : "ok",
    sentence: `${plural(s.refusals, "refusal")} on ${plural(rep.coins.length, "coin")}: ${s.with_example.length} of the 16 codes have an example (${s.with_example.join(", ") || "none"}), ${s.without_example.length} have none yet${txs}.`,
    data: rep,
  };
}

// ---------------------------------------------------------------- the real sections

export interface ProofConfig {
  coin: string;
  relayer: string | null;
  rounds: number;
  proposals: number;
  rpcUrl: string;
  fetchFn: typeof fetch;
  now: () => number;
  /** 32 random bytes as hex, for the attestation's nonce. */
  nonce: () => string;
}

export function endpointsOf(cfg: Pick<ProofConfig, "rpcUrl">): Endpoints {
  return {
    near_rpc: cfg.rpcUrl,
    near_archival_rpcs: TESTNET_ARCHIVAL_RPCS,
    hyperliquid_info: HL_TESTNET_INFO,
    near_ai: NEARAI_BASE_URL,
    nvidia_attestation: [NRAS_GPU_URL, NVIDIA_JWKS_URL],
    nearblocks_api: NEARBLOCKS_TESTNET_API,
    explorer: "https://testnet.nearblocks.io",
  };
}

/** The six sections, each calling a read-only tool's library. */
export function realJobs(cfg: ProofConfig): Job[] {
  const reader: RpcReader = { urls: [cfg.rpcUrl], fetchFn: cfg.fetchFn };
  const rpcs = [cfg.rpcUrl, ...TESTNET_ARCHIVAL_RPCS.filter((u) => u !== cfg.rpcUrl)];
  const view = (contract: string) => (method: string, args: Record<string, unknown>) =>
    viewFinal(reader, contract, method, args);
  return [
    {
      id: "contract-scan",
      title: "Who can change the contracts",
      run: async () => {
        const targets = readDeploymentTargets();
        if (targets === null) throw new Error("interface/deployments.json is not here");
        return judgeContractScan(
          await scanContracts(reader, targets, {
            recorded: readRecordedHashes(),
            skipNonContracts: true,
            now: () => new Date(cfg.now()),
            network: "testnet",
          }),
        );
      },
    },
    {
      id: "key-scope",
      title: "The runner's and the relayer's keys",
      run: async () => {
        const constants = readConstants(await viewFinal(reader, cfg.coin, "get_constants"));
        const keys = keyReader(reader);
        const runner = await checkKeyScope(keys, {
          accountId: constants.runner,
          expect: "runner",
          contract: cfg.coin,
          contractRunner: constants.runner,
          signingKey: null,
        });
        const relayer =
          cfg.relayer === null
            ? null
            : await checkKeyScope(keys, {
                accountId: cfg.relayer,
                expect: "relayer",
                contract: cfg.coin,
                contractRunner: constants.runner,
                signingKey: null,
              });
        return judgeKeyScope(runner, relayer);
      },
    },
    {
      id: "fills-check",
      title: `Reported results against Hyperliquid's fills (last ${cfg.rounds} rounds)`,
      run: async () =>
        judgeFills(
          analyze(
            await gather(
              { contract: cfg.coin, view: view(cfg.coin), fetchFn: cfg.fetchFn, now: cfg.now },
              cfg.rounds,
            ),
            cfg.rpcUrl,
          ),
        ),
    },
    {
      id: "verify-round",
      title: `The last ${cfg.proposals} proposals, re-checked from public data`,
      run: async () => {
        const { rows } = await receiptsCalling(cfg.fetchFn, {
          account: cfg.coin,
          method: "propose",
          limit: cfg.proposals,
        });
        const checked: CheckedProposal[] = [];
        for (const r of rows.filter((x) => x.receiver_account_id === cfg.coin)) {
          checked.push({
            tx_hash: r.transaction_hash,
            link: txLink(r.transaction_hash),
            sender: r.predecessor_account_id,
            block_height: r.block_height,
            at: new Date(Number(BigInt(r.block_timestamp_ns) / 1_000_000n)).toISOString(),
            report: await verifyRound({
              txHash: r.transaction_hash,
              sender: r.predecessor_account_id,
              rpcs,
              fetchFn: cfg.fetchFn,
            }),
          });
        }
        return judgeVerifyRounds(checked);
      },
    },
    {
      id: "attestation",
      title: "NEAR AI's hardware evidence for the pinned model",
      run: async () =>
        judgeAttestation(
          await runAttestationCheck(
            { model: PINNED_01.model, algo: PINNED_01.algo },
            { fetchFn: cfg.fetchFn, now: () => new Date(cfg.now()), nonce: cfg.nonce, save: null },
          ),
          PINNED_01.model,
          PINNED_01.algo,
        ),
    },
    {
      id: "refusals",
      title: "The refusal catalogue",
      run: async () => {
        const { codes, source } = readCodeTable();
        const coins: CoinCatalogue[] = [];
        for (const coin of [cfg.coin, ...(cfg.coin === COIN_FAST ? [] : [COIN_FAST])]) {
          const refusals = await readAllRefusals(view(coin));
          coins.push(
            await catalogue(coin, refusals, codes, (r) =>
              findRefusalTx({ fetchFn: cfg.fetchFn, rpcs }, coin, r),
            ),
          );
        }
        return judgeRefusals(
          summarize(coins, {
            checked_at: new Date(cfg.now()).toISOString(),
            rpc: cfg.rpcUrl,
            nearblocks: NEARBLOCKS_TESTNET_API,
            codes_source: source,
          }),
        );
      },
    },
  ];
}
