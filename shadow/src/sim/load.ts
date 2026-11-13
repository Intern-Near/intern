import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { readDecisionLine } from "../../../runner/src/decision.ts";
import { isRecord } from "../../../runner/src/json.ts";
import { type AnswerRule, answerText, applyAnswerRule } from "../../../runner/src/judge.ts";
import { MARKETS, type Market } from "../../../runner/src/markets.ts";
import type { SigningAlgo } from "../../../runner/src/nearai.ts";
import { classify, type ExchangeRecord, loadRun } from "../report.ts";
import { type Profile, type Recorded, type ShapeCode, sizeOf } from "./behaviour.ts";
import { buildBook, type Candle, type PriceBook, parseCandles } from "./prices.ts";

/** The simulation's two inputs read from disk. Nothing here writes. */

export interface PriceFixture {
  /** The fixture folder's name, e.g. hl-candles-2026-11-13. */
  folder: string;
  fetched_at: string;
  url: string;
  book: PriceBook;
}

interface FetchMeta {
  url: string;
  fetched_at: string;
  requests: { market: Market; coin: string; file: string }[];
}

function readFetchMeta(dir: string): FetchMeta {
  const data: unknown = JSON.parse(readFileSync(join(dir, "fetch.json"), "utf8"));
  if (
    !isRecord(data) ||
    typeof data.url !== "string" ||
    typeof data.fetched_at !== "string" ||
    !Array.isArray(data.requests)
  ) {
    throw new Error(`${dir}/fetch.json: not a candle fixture`);
  }
  return data as unknown as FetchMeta;
}

/** Reads a candle fixture written by src/sim/fetch.ts: every page of every market, closed candles only. */
export function loadPriceFixture(dir: string): PriceFixture {
  const meta = readFetchMeta(dir);
  const byTime = {} as Record<Market, Map<number, Candle>>;
  for (const { market } of MARKETS) byTime[market] = new Map();
  for (const req of meta.requests) {
    const row = MARKETS.find((m) => m.market === req.market);
    if (!row || row.hl_name !== req.coin)
      throw new Error(`${dir}: ${req.file} is not one of the six markets`);
    const body = gunzipSync(readFileSync(join(dir, req.file))).toString("utf8");
    for (const c of parseCandles(body, req.coin)) byTime[req.market].set(c.t, c);
  }
  const byMarket = {} as Record<Market, Candle[]>;
  for (const { market } of MARKETS) byMarket[market] = [...byTime[market].values()].sort((a, b) => a.t - b.t);
  return {
    folder: basename(dir),
    fetched_at: meta.fetched_at,
    url: meta.url,
    book: buildBook(byMarket, Date.parse(meta.fetched_at)),
  };
}

const SHAPE_CODES: ReadonlySet<string> = new Set([
  "BAD_MODEL_SIGNATURE",
  "WRONG_RULEBOOK",
  "MALFORMED_DECISION",
]);

/** A `name: <digits>` line of a rulebook. */
function rulebookNumber(rulebook: string, name: string): bigint {
  const m = new RegExp(`^${name}: (\\d+)$`, "m").exec(rulebook);
  if (!m?.[1]) throw new Error(`the recorded rulebook has no ${name} line`);
  return BigInt(m[1]);
}

/** The margin of the example bet on the rulebook's last line (01 §6.1). */
function exampleMargin(rulebook: string): bigint {
  const last = rulebook.slice(rulebook.lastIndexOf("\n") + 1);
  const m = /"margin_e6":"(\d+)"/.exec(last);
  if (!m?.[1]) throw new Error("the recorded rulebook has no example bet");
  return BigInt(m[1]);
}

/**
 * How long an exchange took from sending the question to holding the signed answer: the recording's signature fetch
 * time minus its start (meta.json), or the answer time alone when the signature time is missing. The proposal's own
 * transaction comes on top (not recorded here).
 */
function answerMs(meta: NonNullable<ExchangeRecord["meta"]>, scheme: SigningAlgo): number {
  const signedAt = meta.signatures?.[scheme]?.fetched_at;
  const start = Date.parse(meta.recorded_at);
  const ms = signedAt ? Date.parse(signedAt) - start : (meta.response?.ms ?? 0);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/**
 * One model's recorded answers from a shadow run folder, judged exactly as the shadow report judges them
 * (shadow/src/report.ts `loadRun` and `classify`: each real signature checked against the signer pinned at set-up).
 */
export function buildProfile(
  runDir: string,
  model: string,
  opts: { answerRule: AnswerRule; scheme: SigningAlgo },
): Profile {
  const run = loadRun(runDir);
  if (!run.cfg.models.includes(model)) {
    throw new Error(`${model} is not in ${basename(runDir)}; it has ${run.cfg.models.join(", ")}`);
  }
  const decisions: Recorded[] = [];
  const verdicts: Record<string, number> = {};
  let failed = 0;
  let told: Profile["told"] | null = null;
  const ticks: string[] = [];
  for (const rec of run.exchanges) {
    if (rec.model !== model) continue;
    const c = classify(rec, run.cfg, opts);
    if (!c.answered || c.verdict === null || rec.meta === null || rec.response === null) {
      failed += 1;
      continue;
    }
    ticks.push(rec.tick);
    const v = c.verdict;
    const key = v.verdict === "NOPE" ? v.code : v.verdict;
    verdicts[key] = (verdicts[key] ?? 0) + 1;
    const rulebook = rec.meta.expected.rulebook;
    const toldMax = rulebookNumber(rulebook, "max_margin_e6");
    const toldExample = exampleMargin(rulebook);
    told ??= { rank: rec.rank, max_margin_e6: String(toldMax), example_e6: String(toldExample) };
    const ms = answerMs(rec.meta, opts.scheme);
    if (c.readableBet) {
      // classify read a bet; read the same line again for its exact margin (classify keeps it in dollars).
      const read = readDecisionLine(
        applyAnswerRule(answerText(rec.response) ?? "", opts.answerRule),
        rec.meta.expected,
      );
      if (!read.ok || read.decision.action !== "BET")
        throw new Error(`${rec.tick}: the bet could not be re-read`);
      const d = read.decision;
      decisions.push({
        kind: "bet",
        market: d.market,
        side: d.side,
        leverage: d.leverage,
        size: sizeOf(d.margin_e6, toldMax, toldExample),
        ms,
      });
    } else if (v.verdict === "SKIP") {
      decisions.push({ kind: "skip", ms });
    } else if (v.verdict === "NOPE" && SHAPE_CODES.has(v.code)) {
      decisions.push({ kind: "unreadable", code: v.code as ShapeCode, ms });
    } else {
      throw new Error(`${rec.tick}: verdict ${key} without a readable bet`);
    }
  }
  if (told === null) throw new Error(`${model} has no answered exchange in ${basename(runDir)}`);
  return {
    model,
    run_folder: basename(runDir),
    answer_rule: opts.answerRule,
    first_tick: ticks[0] ?? null,
    last_tick: ticks[ticks.length - 1] ?? null,
    told,
    decisions,
    failed,
    verdicts_when_recorded: verdicts,
  };
}
