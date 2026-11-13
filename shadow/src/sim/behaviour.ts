import type { Decision } from "../../../runner/src/decision.ts";
import type { Market } from "../../../runner/src/markets.ts";
import type { Side } from "../../../runner/src/ranks.ts";

/**
 * How the simulated Intern answers: by replaying a model's own recorded answers from the shadow run
 * (shadow/data/<run>), read from the raw files by src/sim/load.ts. Nothing about the answers is invented: the share of
 * skips, the markets, sides and leverage are the recorded ones, drawn at random from the record each round.
 *
 * One thing has to be translated: a recorded bet's size was an answer to the rulebook the model was told then
 * (rank INTERN, a $1,000 pool, a $10 example bet). Each recorded margin is kept as what it was relative to that
 * rulebook: exactly the example amount, exactly the largest margin allowed (`max_margin_e6`), or a share of the
 * largest margin. Replayed, it becomes the same thing in today's rulebook: the example amount of 01 §6.1 (1.2), which
 * is the $11 minimum; today's `max_margin_e6`; or the same share of it. Market, side and leverage are replayed as
 * recorded, whatever the rank: a model told TRADER might answer differently, which no run has measured.
 *
 * Pure: no node: imports.
 */

/** A recorded margin, relative to the rulebook the model was given. */
export type Size = { kind: "example" } | { kind: "max" } | { kind: "share"; bps: number };

export type ShapeCode = "BAD_MODEL_SIGNATURE" | "WRONG_RULEBOOK" | "MALFORMED_DECISION";

export type Recorded =
  | { kind: "skip" }
  /** An answer the program could not take: refused at checks 3 to 5 whatever the rank. */
  | { kind: "unreadable"; code: ShapeCode }
  | { kind: "bet"; market: Market; side: Side; leverage: number; size: Size };

export interface Profile {
  model: string;
  /** The shadow run folder's name. */
  run_folder: string;
  answer_rule: string;
  first_tick: string | null;
  last_tick: string | null;
  /** What the model was told when these answers were recorded (the first exchange's rulebook). */
  told: { rank: string; max_margin_e6: string; example_e6: string };
  /** Every answered exchange of the model, in time order. */
  decisions: Recorded[];
  /** Exchanges with no answer to judge (HTTP error, timeout, cut short): not decisions, never replayed. */
  failed: number;
  /** The verdicts when recorded, as the shadow report judges them (shadow/src/report.ts `classify`). */
  verdicts_when_recorded: Record<string, number>;
}

/** The two amounts a replayed bet is sized from: today's rulebook. */
export interface Told {
  max_margin_e6: bigint;
  example_e6: bigint;
}

/** How a recorded margin relates to the rulebook it answered. */
export function sizeOf(margin: bigint, toldMax: bigint, toldExample: bigint): Size {
  if (margin === toldMax) return { kind: "max" };
  if (margin === toldExample) return { kind: "example" };
  if (toldMax === 0n) return { kind: "share", bps: 0 };
  return { kind: "share", bps: Number((margin * 10_000n) / toldMax) };
}

/** A recorded bet, sized against today's rulebook. */
export function replay(rec: Extract<Recorded, { kind: "bet" }>, told: Told): Decision {
  const margin =
    rec.size.kind === "max"
      ? told.max_margin_e6
      : rec.size.kind === "example"
        ? told.example_e6
        : (told.max_margin_e6 * BigInt(rec.size.bps)) / 10_000n;
  return { action: "BET", market: rec.market, side: rec.side, margin_e6: margin, leverage: rec.leverage };
}

export interface ProfileSummary {
  decisions: number;
  skips: number;
  bets: number;
  unreadable: number;
  sizes: { example: number; max: number; share: number };
  markets: Record<string, number>;
  sides: Record<string, number>;
  leverages: Record<string, number>;
}

export function summarize(decisions: readonly Recorded[]): ProfileSummary {
  const s: ProfileSummary = {
    decisions: decisions.length,
    skips: 0,
    bets: 0,
    unreadable: 0,
    sizes: { example: 0, max: 0, share: 0 },
    markets: {},
    sides: {},
    leverages: {},
  };
  for (const d of decisions) {
    if (d.kind === "skip") s.skips += 1;
    else if (d.kind === "unreadable") s.unreadable += 1;
    else {
      s.bets += 1;
      s.sizes[d.size.kind] += 1;
      s.markets[d.market] = (s.markets[d.market] ?? 0) + 1;
      s.sides[d.side] = (s.sides[d.side] ?? 0) + 1;
      s.leverages[String(d.leverage)] = (s.leverages[String(d.leverage)] ?? 0) + 1;
    }
  }
  return s;
}
