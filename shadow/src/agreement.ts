import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AnswerRule } from "../../runner/src/judge.ts";
import { SIGNING_ALGOS, type SigningAlgo } from "../../runner/src/nearai.ts";
import type { RankName } from "../../runner/src/ranks.ts";
import { SECOND } from "./ask-twice.ts";
import { type Classified, classify, type ExchangeRecord, type LoadedRun } from "./report.ts";
import { exchangeDir } from "./store.ts";
import type { ShadowMeta } from "./tick.ts";

/**
 * For a run with `ask_twice`: how often the two answers to the same request disagree. The first answer is the one
 * the report counts; the second (in `second/`) is judged here the same way, then the two are compared:
 *   decision  skip; a bet (market, side, margin, leverage); or unreadable (refused by checks 3 to 5)
 *   verdict   YES, SKIP or the refusal code
 * A pair counts only when both answers could be judged.
 */

export interface AgreementRow {
  model: string;
  rank: RankName;
  /** Ticks where both answers could be judged. */
  pairs: number;
  decisionDiffers: number;
  verdictDiffers: number;
  /** Among the pairs whose verdicts differ: "first → second" and how often. */
  verdictChanges: Record<string, number>;
  /** First answers judged without a second one to compare (not asked, no time left, or failed). */
  unpaired: number;
  /**
   * Second responses that are the first one byte for byte (the same chat id): the same completion served again, not a
   * new answer. Not counted as pairs. Whether NEAR AI ever does this is not known (UNVERIFIED); this shows it if so.
   */
  sameResponse: number;
}

export interface Agreement {
  runFolder: string;
  runId: string;
  answerRule: AnswerRule;
  scheme: SigningAlgo;
  rows: AgreementRow[];
  warnings: string[];
}

/** The second answer of an exchange, read like the first (src/report.ts loadRun), or null when there is none. */
export function loadSecond(runDir: string, first: ExchangeRecord): ExchangeRecord | null {
  const dir = join(exchangeDir(runDir, first.tick, first.model, first.rank), SECOND);
  if (!existsSync(join(dir, "request.bin"))) return null;
  const read = (name: string): Buffer | null => {
    const p = join(dir, name);
    return existsSync(p) ? readFileSync(p) : null;
  };
  const signatures: ExchangeRecord["signatures"] = {};
  for (const algo of SIGNING_ALGOS) {
    const s = read(`signature-${algo}.json`);
    if (s) signatures[algo] = s.toString("utf8");
  }
  const meta = read("meta.json");
  return {
    ...first,
    meta: meta ? (JSON.parse(meta.toString("utf8")) as ShadowMeta) : null,
    request: read("request.bin"),
    response: read("response.bin"),
    signatures,
  };
}

export function decisionOf(c: Classified): string {
  if (c.verdict?.verdict === "SKIP") return "skip";
  const b = c.readableBet;
  return b ? `bet ${b.market} ${b.side} ${b.marginUsd} x${b.leverage}` : "unreadable";
}

export function verdictOf(c: Classified): string {
  const v = c.verdict;
  return v === null ? "none" : v.verdict === "NOPE" ? v.code : v.verdict;
}

export function buildAgreement(
  run: LoadedRun,
  opts: { answerRule: AnswerRule; scheme: SigningAlgo },
): Agreement {
  const { cfg } = run;
  const folder = basename(run.runDir);
  if (cfg.ask_twice !== true)
    throw new Error(`${folder} does not ask twice (its run.json has no ask_twice: true)`);
  const warnings = [...run.warnings];
  const rows = new Map<string, AgreementRow>();
  for (const model of cfg.models) {
    for (const rank of cfg.ranks) {
      const row = {
        model,
        rank,
        pairs: 0,
        decisionDiffers: 0,
        verdictDiffers: 0,
        verdictChanges: {},
        unpaired: 0,
        sameResponse: 0,
      };
      rows.set(`${model}|${rank}`, row);
    }
  }
  for (const rec of run.exchanges) {
    const row = rows.get(`${rec.model}|${rec.rank}`);
    if (!row) continue;
    const first = classify(rec, cfg, opts);
    if (!first.answered) continue; // the report counts it as failed; there is nothing to compare
    const again = loadSecond(run.runDir, rec);
    const second = again === null ? null : classify(again, cfg, opts);
    if (again === null || second === null || !second.answered) {
      row.unpaired += 1;
      continue;
    }
    // By construction the second request is the first one's bytes; anything else is not a fair pair.
    if (again.request === null || rec.request === null || !again.request.equals(rec.request)) {
      warnings.push(
        `${rec.tick} ${rec.model} ${rec.rank}: the second request is not the first one byte for byte`,
      );
    }
    // A new completion has its own chat id, so a response equal byte for byte is the first one again.
    if (again.response !== null && rec.response !== null && again.response.equals(rec.response)) {
      row.sameResponse += 1;
      continue;
    }
    row.pairs += 1;
    if (decisionOf(first) !== decisionOf(second)) row.decisionDiffers += 1;
    const a = verdictOf(first);
    const b = verdictOf(second);
    if (a !== b) {
      row.verdictDiffers += 1;
      row.verdictChanges[`${a} → ${b}`] = (row.verdictChanges[`${a} → ${b}`] ?? 0) + 1;
    }
  }
  return {
    runFolder: folder,
    runId: cfg.run_id,
    answerRule: opts.answerRule,
    scheme: opts.scheme,
    rows: [...rows.values()],
    warnings,
  };
}

const pct = (part: number, whole: number): string =>
  whole === 0 ? "-" : `${((100 * part) / whole).toFixed(1)}%`;

export function formatAgreement(a: Agreement): string {
  const L: string[] = [];
  L.push(`# Asked twice: shadow run ${a.runId}`);
  L.push("");
  L.push(
    `From the raw files in the run folder \`${a.runFolder}\`. Each model was asked twice per tick with the same request; the report counts only the first answer. Both are judged here as the program would, answer rule ${a.answerRule === "strict" ? "strict (01 §6.2 as written)" : "trim (blank lines around the line ignored)"}, signatures checked against each model's pinned ${a.scheme} signer.`,
  );
  L.push("");
  L.push(
    "| Model | Rank | Pairs | Different decision | Different verdict | How the verdict changed (first → second) | First answers without a second | Second response the same bytes |",
  );
  L.push("|---|---|---|---|---|---|---|---|");
  for (const r of a.rows) {
    const changes = Object.entries(r.verdictChanges)
      .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
      .map(([k, n]) => `${k} ${n}`)
      .join(", ");
    L.push(
      `| \`${r.model}\` | ${r.rank} | ${r.pairs} | ${r.decisionDiffers} (${pct(r.decisionDiffers, r.pairs)}) | ${r.verdictDiffers} (${pct(r.verdictDiffers, r.pairs)}) | ${changes || "-"} | ${r.unpaired} | ${r.sameResponse} |`,
    );
  }
  L.push("");
  L.push(
    "A pair is a tick where both answers could be judged. A decision is skip, a bet (market, side, margin, leverage) or unreadable (refused at checks 3 to 5); a verdict is YES, SKIP or the refusal code. Two different bets can both be YES: a different decision is not always a different verdict.",
  );
  L.push(
    "A second response equal to the first byte for byte (same chat id) is the same completion served again, not a second answer: it is left out of the pairs and counted in the last column. A second answer that differs only in its thinking still counts as the same decision.",
  );
  if (a.warnings.length > 0) {
    L.push("");
    L.push("## Warnings");
    L.push("");
    for (const w of a.warnings) L.push(`- ${w}`);
  }
  return `${L.join("\n")}\n`;
}
