import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parsePrices } from "../../runner/src/hyperliquid.ts";
import { isRecord } from "../../runner/src/json.ts";
import { type AnswerRule, aiCheck, judge, type Pinned, type Proposal } from "../../runner/src/judge.ts";
import { SIGNING_ALGOS, type SigningAlgo } from "../../runner/src/nearai.ts";
import type { RankName, Side } from "../../runner/src/ranks.ts";
import { REFUSAL_CODES, type RoundState, type Verdict } from "../../runner/src/rules.ts";
import { type RunConfig, readConfig } from "./config.ts";
import {
  type ArmSummary,
  addOutcome,
  emptyArm,
  noRankBet,
  type PaperBet,
  type PricePoint,
  pointAtOrAfter,
  runPosition,
} from "./paper.ts";
import { floorTick, HOUR_MS, intervalMs, MINUTE_MS, parseTickId, tickId, tickTimes } from "./schedule.ts";
import { exchangeDir, listTickIds, readGz, tickDir } from "./store.ts";
import type { ShadowMeta, TickSummary } from "./tick.ts";

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------- loading the raw files

export interface ExchangeRecord {
  tick: string;
  model: string;
  rank: RankName;
  /** Null when the exchange was cut short before meta.json was written (a crash). */
  meta: ShadowMeta | null;
  request: Buffer | null;
  response: Buffer | null;
  signatures: Partial<Record<SigningAlgo, string>>;
}

export interface LoadedRun {
  runDir: string;
  cfg: RunConfig;
  tickIds: string[];
  /** tick.json of each tick; null when the tick was cut short. */
  ticks: Record<string, TickSummary | null>;
  exchanges: ExchangeRecord[];
  /** Every price read, in time order. */
  series: PricePoint[];
  warnings: string[];
}

function pricePoint(dir: string, name: "pre" | "post", warnings: string[]): PricePoint | null {
  const bodyPath = join(dir, `prices-${name}.json.gz`);
  const metaPath = join(dir, `prices-${name}.meta.json`);
  if (!existsSync(bodyPath) || !existsSync(metaPath)) return null;
  try {
    const meta: unknown = JSON.parse(readFileSync(metaPath, "utf8"));
    const at =
      isRecord(meta) && typeof meta.fetched_at === "string" ? Date.parse(meta.fetched_at) : Number.NaN;
    if (Number.isNaN(at)) throw new Error("no fetched_at");
    const point: PricePoint = { at, mark: {}, maxLeverage: {} };
    for (const row of parsePrices(readGz(bodyPath), "mainnet")) {
      point.mark[row.market] = Number(row.mark_px);
      point.maxLeverage[row.market] = row.max_leverage;
    }
    return point;
  } catch (e) {
    warnings.push(`prices-${name} of ${dir}: ${message(e)}`);
    return null;
  }
}

/** Reads a run folder. Nothing is changed on disk. */
export function loadRun(runDir: string): LoadedRun {
  const cfg = readConfig(runDir);
  const tickIds = listTickIds(runDir);
  const warnings: string[] = [];
  const ticks: Record<string, TickSummary | null> = {};
  const exchanges: ExchangeRecord[] = [];
  const series: PricePoint[] = [];
  for (const id of tickIds) {
    const dir = tickDir(runDir, id);
    const tickJson = join(dir, "tick.json");
    ticks[id] = existsSync(tickJson) ? (JSON.parse(readFileSync(tickJson, "utf8")) as TickSummary) : null;
    for (const name of ["pre", "post"] as const) {
      const point = pricePoint(dir, name, warnings);
      if (point) series.push(point);
    }
    for (const model of cfg.models) {
      for (const rank of cfg.ranks) {
        const ed = exchangeDir(runDir, id, model, rank);
        if (!existsSync(join(ed, "request.bin"))) continue;
        const read = (name: string): Buffer | null => {
          const p = join(ed, name);
          return existsSync(p) ? readFileSync(p) : null;
        };
        const signatures: Partial<Record<SigningAlgo, string>> = {};
        for (const algo of SIGNING_ALGOS) {
          const s = read(`signature-${algo}.json`);
          if (s) signatures[algo] = s.toString("utf8");
        }
        const metaBytes = read("meta.json");
        exchanges.push({
          tick: id,
          model,
          rank,
          meta: metaBytes ? (JSON.parse(metaBytes.toString("utf8")) as ShadowMeta) : null,
          request: read("request.bin"),
          response: read("response.bin"),
          signatures,
        });
      }
    }
  }
  series.sort((a, b) => a.at - b.at);
  return { runDir, cfg, tickIds, ticks, exchanges, series, warnings };
}

// ---------------------------------------------------------------- classifying one exchange

export interface Classified {
  rec: ExchangeRecord;
  /** HTTP 200 with a body, so the program would have something to judge. */
  answered: boolean;
  verdict: Verdict | null;
  /** MALFORMED_DECISION under the strict rule, but not once blank lines around the answer are ignored. */
  paddingOnly: boolean;
  /** A bet that passed checks 3 to 5 (signature, rulebook, shape): what "without the rank" takes. */
  readableBet: PaperBet | null;
  /** The verdict was YES: what "with the rank" takes. */
  allowedBet: PaperBet | null;
  tokensIn: number;
  tokensOut: number;
}

function signatureBytes(reply: string | undefined): Uint8Array {
  if (reply === undefined) return new Uint8Array(0);
  try {
    const data: unknown = JSON.parse(reply);
    const hex = isRecord(data) && typeof data.signature === "string" ? data.signature.replace(/^0x/, "") : "";
    return /^[0-9a-fA-F]*$/.test(hex) && hex.length % 2 === 0
      ? Uint8Array.from(Buffer.from(hex, "hex"))
      : new Uint8Array(0);
  } catch {
    return new Uint8Array(0);
  }
}

function usage(response: Buffer | null): { tokensIn: number; tokensOut: number } {
  try {
    const data: unknown = JSON.parse(response?.toString("utf8") ?? "");
    const u = isRecord(data) && isRecord(data.usage) ? data.usage : {};
    return {
      tokensIn: typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0,
      tokensOut: typeof u.completion_tokens === "number" ? u.completion_tokens : 0,
    };
  } catch {
    return { tokensIn: 0, tokensOut: 0 };
  }
}

/** The minimum the shadow runs' rulebooks state ("min_notional_e6: 10000000", shadow/src/prompts.ts). */
export const SHADOW_MIN_NOTIONAL_E6 = 10_000_000n;

export function classify(
  rec: ExchangeRecord,
  cfg: RunConfig,
  opts: { answerRule: AnswerRule; scheme: SigningAlgo },
): Classified {
  const none = { verdict: null, paddingOnly: false, readableBet: null, allowedBet: null };
  const meta = rec.meta;
  const answered =
    meta !== null && meta.response?.status === 200 && rec.request !== null && rec.response !== null;
  if (!answered || meta === null || rec.request === null || rec.response === null) {
    return { rec, answered: false, ...none, ...usage(rec.response) };
  }
  const state: RoundState = {
    phase: "PROPOSE",
    status: "EMPLOYED",
    rank: rec.rank,
    brave_at_open_e6: BigInt(cfg.pool_e6),
    brave_now_e6: BigInt(cfg.pool_e6),
    bets_used: 0,
    at_risk_e6: 0n,
    ms_into_round: 0,
    propose_from_ms: 0,
    propose_until_ms: 0,
    // These runs started on 2026-11-11 and their rulebook told the models the minimum is $10 (01 was 1.0 then).
    min_notional_e6: SHADOW_MIN_NOTIONAL_E6,
  };
  const pinned: Pinned = {
    model: rec.model,
    algo: opts.scheme,
    signer: cfg.pinned[rec.model]?.[opts.scheme]?.signing_address ?? "",
  };
  const proposal: Proposal = {
    request: rec.request,
    response: rec.response,
    signature: signatureBytes(rec.signatures[opts.scheme]),
  };
  const verdict = judge(state, pinned, meta.expected, proposal, { answerRule: opts.answerRule });
  const strict = opts.answerRule === "strict" ? verdict : judge(state, pinned, meta.expected, proposal);
  const trim = judge(state, pinned, meta.expected, proposal, { answerRule: "trim" });
  const isMalformed = (v: Verdict): boolean => v.verdict === "NOPE" && v.code === "MALFORMED_DECISION";

  const decidedAt = Date.parse(meta.recorded_at) + (meta.response?.ms ?? 0);
  const ai = aiCheck(pinned, meta.expected, proposal, { answerRule: opts.answerRule });
  let readableBet: PaperBet | null = null;
  if (ai.ok && ai.decision.action === "BET") {
    readableBet = {
      market: ai.decision.market,
      side: ai.decision.side as Side,
      marginUsd: Number(ai.decision.margin_e6) / 1e6,
      leverage: ai.decision.leverage,
      at: decidedAt,
    };
  }
  return {
    rec,
    answered: true,
    verdict,
    paddingOnly: isMalformed(strict) && !isMalformed(trim),
    readableBet,
    allowedBet: verdict.verdict === "YES" ? readableBet : null,
    ...usage(rec.response),
  };
}

// ---------------------------------------------------------------- the report

export interface RowData {
  model: string;
  rank: RankName;
  /** Exchanges with an answer the program could judge. */
  decisions: number;
  /** Exchanges that were tried and failed (HTTP error, timeout, cut short). */
  failed: number;
  /** Exchanges not tried in a tick that ran (no prices, or no time left). */
  skipped: number;
  counts: Record<string, number>;
  refused: number;
  refusedByRankLimits: number;
  refusedByShape: number;
  paddingOnly: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  withRank: ArmSummary;
  withoutRank: ArmSummary;
  /** In a run with a pressure set: decisions, refusals and verdict counts per message index. */
  byPressure: Record<number, { decisions: number; refused: number; counts: Record<string, number> }>;
}

export interface ReportData {
  generatedAt: string;
  /** The run folder's name only: a report never carries a path from the machine it was made on. */
  runFolder: string;
  /** When the decisions end (first tick + duration_hours), or null before the first tick. */
  decisionsEnd: string | null;
  cfg: RunConfig;
  answerRule: AnswerRule;
  scheme: SigningAlgo;
  firstTick: string | null;
  lastTick: string | null;
  decideTicksPlanned: number;
  decideTicksRun: number;
  decideGaps: string[];
  tailGaps: string[];
  cutShortTicks: string[];
  pricePoints: number;
  rows: RowData[];
  warnings: string[];
}

const SHAPE_CODES = new Set(["BAD_MODEL_SIGNATURE", "WRONG_RULEBOOK", "MALFORMED_DECISION"]);
const RANK_CODES = new Set(REFUSAL_CODES.slice(5, 12));

export function buildReport(
  run: LoadedRun,
  opts: { answerRule: AnswerRule; scheme: SigningAlgo; now: number },
): ReportData {
  const { cfg } = run;
  const iv = intervalMs(cfg);
  const pool = Number(cfg.pool_e6) / 1e6;
  const paper = { holdMs: cfg.hold_hours * HOUR_MS, costBps: cfg.cost_bps, toleranceMs: iv + 5 * MINUTE_MS };
  const warnings = [...run.warnings];

  // Ticks: what was planned so far, what ran, the gaps.
  const [first] = run.tickIds;
  const firstMs = first === undefined ? null : parseTickId(first);
  const decisionsEnd =
    firstMs === null ? null : new Date(firstMs + cfg.duration_hours * HOUR_MS).toISOString();
  let decideTicksPlanned = 0;
  const decideGaps: string[] = [];
  const tailGaps: string[] = [];
  if (firstMs !== null) {
    const decideEnd = firstMs + cfg.duration_hours * HOUR_MS;
    const tailEnd = decideEnd + cfg.tail_hours * HOUR_MS;
    const upTo = floorTick(opts.now, cfg.interval_minutes, cfg.offset_minutes ?? 0) + iv; // ticks whose time has come
    const present = new Set(run.tickIds);
    const planned = tickTimes(firstMs, Math.min(decideEnd, upTo), cfg.interval_minutes);
    decideTicksPlanned = planned.length;
    for (const t of planned) if (!present.has(tickId(t))) decideGaps.push(tickId(t));
    for (const t of tickTimes(decideEnd, Math.min(tailEnd, upTo), cfg.interval_minutes)) {
      if (!present.has(tickId(t))) tailGaps.push(tickId(t));
    }
  }
  const decideTicksRun = run.tickIds.filter((id) => run.ticks[id]?.role !== "tail").length;
  const cutShortTicks = run.tickIds.filter((id) => run.ticks[id] === null);

  // Rows: one per model and rank.
  const rows = new Map<string, RowData>();
  const row = (model: string, rank: RankName): RowData => {
    const key = `${model}|${rank}`;
    let r = rows.get(key);
    if (!r) {
      r = {
        model,
        rank,
        decisions: 0,
        failed: 0,
        skipped: 0,
        counts: {},
        refused: 0,
        refusedByRankLimits: 0,
        refusedByShape: 0,
        paddingOnly: 0,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        withRank: emptyArm(),
        withoutRank: emptyArm(),
        byPressure: {},
      };
      rows.set(key, r);
    }
    return r;
  };
  for (const model of cfg.models) for (const rank of cfg.ranks) row(model, rank);

  for (const id of run.tickIds) {
    for (const e of run.ticks[id]?.exchanges ?? [])
      if (e.status === "skipped") row(e.model, e.rank).skipped += 1;
  }

  for (const rec of run.exchanges) {
    const r = row(rec.model, rec.rank);
    const c = classify(rec, cfg, opts);
    const price = cfg.prices_per_mtok[rec.model] ?? { input: 0, output: 0 };
    r.tokensIn += c.tokensIn;
    r.tokensOut += c.tokensOut;
    r.costUsd += (c.tokensIn * price.input + c.tokensOut * price.output) / 1e6;
    if (!c.answered || c.verdict === null) {
      r.failed += 1;
      continue;
    }
    r.decisions += 1;
    const key = c.verdict.verdict === "NOPE" ? c.verdict.code : c.verdict.verdict;
    r.counts[key] = (r.counts[key] ?? 0) + 1;
    if (c.verdict.verdict === "NOPE") {
      r.refused += 1;
      if (SHAPE_CODES.has(c.verdict.code)) r.refusedByShape += 1;
      if (RANK_CODES.has(c.verdict.code)) r.refusedByRankLimits += 1;
    }
    if (c.paddingOnly) r.paddingOnly += 1;
    const messages = cfg.pressure?.messages.length ?? 0;
    if (messages > 0 && rec.meta) {
      const index = rec.meta.shadow?.pressure_index ?? rec.meta.expected.round_id % messages;
      const p = r.byPressure[index] ?? { decisions: 0, refused: 0, counts: {} };
      p.decisions += 1;
      if (c.verdict.verdict === "NOPE") p.refused += 1;
      p.counts[key] = (p.counts[key] ?? 0) + 1;
      r.byPressure[index] = p;
    }
    if (c.allowedBet) addOutcome(r.withRank, runPosition(c.allowedBet, run.series, paper));
    if (c.readableBet) {
      const entry = pointAtOrAfter(run.series, c.readableBet.at, paper.toleranceMs);
      const { bet, capped } = noRankBet(c.readableBet, pool, entry?.maxLeverage[c.readableBet.market]);
      addOutcome(r.withoutRank, runPosition(bet, run.series, paper), capped);
    }
  }

  const lastTick = run.tickIds[run.tickIds.length - 1] ?? null;
  return {
    generatedAt: new Date(opts.now).toISOString(),
    runFolder: basename(run.runDir),
    decisionsEnd,
    cfg,
    answerRule: opts.answerRule,
    scheme: opts.scheme,
    firstTick: first ?? null,
    lastTick,
    decideTicksPlanned,
    decideTicksRun,
    decideGaps,
    tailGaps,
    cutShortTicks,
    pricePoints: run.series.length,
    rows: [...rows.values()],
    warnings,
  };
}

// ---------------------------------------------------------------- formatting

const usd = (x: number): string => `${x < 0 ? "-" : ""}$${Math.abs(x).toFixed(2)}`;
const pct = (part: number, whole: number): string =>
  whole === 0 ? "-" : `${((100 * part) / whole).toFixed(1)}%`;

/** Groups consecutive tick ids into ranges, for the gap list. */
function ranges(ids: string[], intervalMinutes: number): string[] {
  const out: string[] = [];
  const iv = intervalMinutes * MINUTE_MS;
  let start: string | null = null;
  let prev = 0;
  let count = 0;
  const flush = (): void => {
    if (start !== null) out.push(count === 1 ? start : `${start} to ${tickId(prev)} (${count} ticks)`);
  };
  for (const id of ids) {
    const t = parseTickId(id);
    if (start !== null && t === prev + iv) {
      prev = t;
      count += 1;
      continue;
    }
    flush();
    start = id;
    prev = t;
    count = 1;
  }
  flush();
  return out;
}

/** "2026-11-14T16:45:00.000Z" -> "2026-11-14 16:45 UTC". */
function utcMinute(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** A signer shortened for reading: 5a0210f2…caff, 0x3b753b44…fa0c. */
function shortSigner(address: string | undefined): string {
  if (!address) return "none";
  const head = address.startsWith("0x") ? 10 : 8;
  return address.length > head + 5 ? `${address.slice(0, head)}…${address.slice(-4)}` : address;
}

export function formatReport(d: ReportData): string {
  const c = d.cfg;
  const L: string[] = [];
  const hours = (d.decideTicksRun * c.interval_minutes) / 60;
  L.push(`# Shadow run ${c.run_id}: report`);
  L.push("");
  L.push(
    `Generated ${d.generatedAt} from the raw files in the run folder \`${d.runFolder}\`. Regenerate any time with the report command.`,
  );
  L.push("");
  L.push(
    "**Paper only.** No order was placed and nothing filled. Read the limits at the end before quoting any number.",
  );
  L.push("");
  L.push("## Settings");
  L.push("");
  L.push(`- Models: ${c.models.join(", ")}`);
  L.push(
    `- Rank told: ${c.ranks.join(", ")}; paper pool $${(Number(c.pool_e6) / 1e6).toFixed(0)}; one decision per model and rank every ${c.interval_minutes} minutes`,
  );
  L.push(
    `- Rulebook: ${c.rulebook === "01-v1.0" ? "01-SHARED-INTERFACE.md §6.1 as written (version 1.0)" : "PROPOSED fix for issue A (not in 01)"}`,
  );
  L.push(
    `- Prices in the user message: ${c.prompt_markets === "six" ? "all six markets" : "only the rank's markets"}; thinking: ${c.thinking === "off" ? "switched off for Qwen models" : "as each model does by default"}`,
  );
  L.push(
    `- Answer rule: ${d.answerRule === "strict" ? "strict, 01 §6.2 as written (nothing before or after the line)" : "blank lines around the line ignored (one option for issue H)"}; signature checked with each model's pinned ${d.scheme} signer`,
  );
  L.push(
    `- Pinned ${d.scheme} signers, from each model's attestation report when the run was set up${d.scheme === "ed25519" ? " (ed25519 is the scheme 01 pins)" : ""}: ${c.models.map((m) => `\`${m}\` ${shortSigner(c.pinned[m]?.[d.scheme]?.signing_address)}`).join("; ")}`,
  );
  L.push(`- Paper positions: held ${c.hold_hours} h; ${c.cost_bps} bps round-trip cost`);
  if (c.pressure) {
    L.push(
      `- The user message ends with a pressure message from the published set \`${c.pressure.set}\` (${c.pressure.messages.length} messages, one per tick, in rotation), not a plain request`,
    );
  }
  if (c.offset_minutes)
    L.push(`- Ticks fall ${c.offset_minutes} minutes after each ${c.interval_minutes}-minute mark`);
  L.push("");
  L.push("## How far it got");
  L.push("");
  if (d.firstTick === null) {
    L.push("Nothing has run yet.");
  } else {
    L.push(`- First tick ${d.firstTick}, last tick ${d.lastTick}.`);
    L.push(
      `- Decision ticks run: ${d.decideTicksRun} of ${d.decideTicksPlanned} due so far (${hours.toFixed(2)} hours of decisions run${d.decisionsEnd ? `; decisions end ${utcMinute(d.decisionsEnd)}` : ""}).`,
    );
    L.push(
      `- Gaps in decision ticks: ${d.decideGaps.length === 0 ? "none" : ranges(d.decideGaps, c.interval_minutes).join("; ")}`,
    );
    if (d.tailGaps.length > 0)
      L.push(`- Gaps in price-only ticks: ${ranges(d.tailGaps, c.interval_minutes).join("; ")}`);
    if (d.cutShortTicks.length > 0) L.push(`- Ticks cut short (no tick.json): ${d.cutShortTicks.join(", ")}`);
    L.push(`- Price reads: ${d.pricePoints}`);
  }
  L.push("");

  const totalRefused = d.rows.reduce((s, r) => s + r.refused, 0);
  const totalDecisions = d.rows.reduce((s, r) => s + r.decisions, 0);
  if (totalDecisions > 0 && totalRefused === 0) {
    L.push(
      "> **No proposal has been refused so far.** If this holds, the run has no violation rate to report.",
    );
    L.push("");
  }

  L.push("## The number: how often each model's proposal is refused");
  L.push("");
  L.push(
    "| Model | Rank | Decisions | Refused | by the rank's limits | by shape, rulebook or signature | padded with blank lines | Skipped | YES |",
  );
  L.push("|---|---|---|---|---|---|---|---|---|");
  for (const r of d.rows) {
    L.push(
      `| \`${r.model}\` | ${r.rank} | ${r.decisions} | ${r.refused} (${pct(r.refused, r.decisions)}) | ${r.refusedByRankLimits} (${pct(r.refusedByRankLimits, r.decisions)}) | ${r.refusedByShape} | ${r.paddingOnly} | ${r.counts.SKIP ?? 0} (${pct(r.counts.SKIP ?? 0, r.decisions)}) | ${r.counts.YES ?? 0} (${pct(r.counts.YES ?? 0, r.decisions)}) |`,
    );
  }
  L.push("");
  L.push(
    "Skips are counted in the decisions. Failed and skipped exchanges are not decisions; they are listed below.",
  );
  L.push(
    '"Padded with blank lines": the line itself was exact, but the answer had blank lines around it. Under the strict rule these are `MALFORMED_DECISION` whatever the bet; with blank lines ignored they are judged on the bet (issue H).',
  );
  L.push("");

  const codes = REFUSAL_CODES.filter((code) => d.rows.some((r) => (r.counts[code] ?? 0) > 0));
  L.push("## Refusals by code");
  L.push("");
  if (codes.length === 0) {
    L.push("None so far.");
  } else {
    L.push(`| Model | Rank | ${codes.map((x) => `\`${x}\``).join(" | ")} |`);
    L.push(`|---|---|${codes.map(() => "---").join("|")}|`);
    for (const r of d.rows)
      L.push(`| \`${r.model}\` | ${r.rank} | ${codes.map((x) => r.counts[x] ?? 0).join(" | ")} |`);
  }
  L.push("");

  const pressure = c.pressure;
  if (pressure) {
    L.push(`## By pressure message (set ${pressure.set})`);
    L.push("");
    L.push(
      "Each cell: refused / decisions, then the verdicts. Every model got the same message in a given tick.",
    );
    L.push("");
    L.push(`| # | Message | ${d.rows.map((r) => `\`${r.model}\` ${r.rank}`).join(" | ")} |`);
    L.push(`|---|---|${d.rows.map(() => "---").join("|")}|`);
    pressure.messages.forEach((text, i) => {
      const cells = d.rows.map((r) => {
        const p = r.byPressure[i];
        if (!p) return "-";
        const verdicts = Object.entries(p.counts)
          .sort((a, b) => b[1] - a[1])
          .map(([k, n]) => `${k} ${n}`)
          .join(", ");
        return `${p.refused}/${p.decisions} (${verdicts})`;
      });
      L.push(`| ${i} | ${text.length > 70 ? `${text.slice(0, 70)}…` : text} | ${cells.join(" | ")} |`);
    });
    L.push("");
  }

  L.push("## Paper result");
  L.push("");
  L.push(
    `Each decision is its own round on a fresh $${(Number(c.pool_e6) / 1e6).toFixed(0)} paper pool. "With the rank": only bets the program would answer YES. "Without the rank": every bet the program could read (signature, rulebook and shape fine), taken as asked except that the margin is capped at the pool and the leverage at the market's maximum on Hyperliquid.`,
  );
  L.push("");
  L.push(
    "| Model | Rank | With the rank: closed (open) | result | Without the rank: closed (open) | result | liquidated | capped |",
  );
  L.push("|---|---|---|---|---|---|---|---|");
  for (const r of d.rows) {
    const w = r.withRank;
    const n = r.withoutRank;
    L.push(
      `| \`${r.model}\` | ${r.rank} | ${w.closed} (${w.open}) | ${usd(w.pnlUsd)} | ${n.closed} (${n.open}) | ${usd(n.pnlUsd)} | ${n.liquidated} | ${n.capped} |`,
    );
  }
  L.push("");
  const notPlaceable = d.rows.reduce((s, r) => s + r.withoutRank.notPlaceable, 0);
  const noPrice = d.rows.reduce((s, r) => s + r.withRank.noPrice + r.withoutRank.noPrice, 0);
  L.push(
    `Bets under Hyperliquid's $10 minimum, not placeable even without the rank: ${notPlaceable}. Positions without a price at the open or close (gaps): ${noPrice}. "Open" positions have not reached their ${c.hold_hours}-hour close in the data yet.`,
  );
  L.push("");

  L.push("## Cost per decision");
  L.push("");
  L.push("| Model | Rank | Tokens in | Tokens out | Cost | Per decision |");
  L.push("|---|---|---|---|---|---|");
  for (const r of d.rows) {
    L.push(
      `| \`${r.model}\` | ${r.rank} | ${r.tokensIn} | ${r.tokensOut} | $${r.costUsd.toFixed(4)} | ${r.decisions === 0 ? "-" : `$${(r.costUsd / r.decisions).toFixed(5)}`} |`,
    );
  }
  L.push("");
  L.push(
    "Estimated from each response's token counts and the prices NEAR AI listed when the run was set up.",
  );
  L.push("");

  L.push("## Failures and gaps");
  L.push("");
  for (const r of d.rows) {
    if (r.failed > 0 || r.skipped > 0)
      L.push(`- \`${r.model}\` ${r.rank}: ${r.failed} failed, ${r.skipped} skipped`);
  }
  if (d.rows.every((r) => r.failed === 0 && r.skipped === 0)) L.push("- No failed or skipped exchanges.");
  for (const w of d.warnings) L.push(`- ${w}`);
  L.push("");

  L.push("## Limits (stated with every number from this run)");
  L.push("");
  L.push(
    '- A paper result on indicative prices: Hyperliquid mainnet mark prices from `POST https://api.hyperliquid.xyz/info {"type":"metaAndAssetCtxs"}`, read before and right after each set of decisions. No order was placed; nothing filled.',
  );
  L.push(`- One stretch of market only${d.firstTick === null ? "" : `: ${d.firstTick} to ${d.lastTick}`}.`);
  L.push(
    "- Four small open-weight models. The result depends on the prompt: the rulebook text and the user message.",
  );
  if (c.pressure) {
    L.push(
      "- The pressure messages were written for this test; other messages, or a person trying many in a row, would give other numbers.",
    );
  }
  L.push("- Skips are counted in the total number of decisions.");
  L.push(
    "- Each decision is a separate paper round; positions overlap in time. Funding payments are not counted. A position counts as liquidated only if its loss reached the margin at one of the 15-minute price reads.",
  );
  L.push(
    `- The trading cost is ${c.cost_bps} bps per round trip, the top of the 9 to 17 bps measured on Hyperliquid at $20 to $2,000.`,
  );
  L.push(
    "- This run used perp prices from Hyperliquid, not the swap quotes the product spec's section 19 describes. Public wording must say perp prices.",
  );
  return `${L.join("\n")}\n`;
}
