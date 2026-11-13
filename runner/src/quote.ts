import {
  type Constants,
  type Position,
  type Pot,
  type RankState,
  type Round,
  type Rulebook,
  readConstants,
  readPositions,
  readPot,
  readRankState,
  readRound,
  readRulebook,
} from "./contract.ts";
import { type Decision, decisionLine, readDecisionLine } from "./decision.ts";
import { type Explanation, explain, explanationLines, usd } from "./explain.ts";
import type { Market } from "./markets.ts";
import { parseScaled } from "./pricing.ts";
import { MIN_NOTIONAL_E6, RANKS, type RankName } from "./ranks.ts";
import { longShotMarginE6, longShotOf } from "./rulebook.ts";
import { limitBase, type RoundState, windowAndStatus } from "./rules.ts";

/**
 * `quote`: a free dry run. It reads the contract's views (01 §8: get_constants, get_rank, get_round, get_pot,
 * get_rulebook, get_positions), builds the round's state the way the contract's `propose` does (crates/coin
 * round.rs: the rank and status now, the pool at round open and now, the round's counters, the rulebook's long-shot
 * ticket), and explains the verdict of checks 6 to 12 for a bet (src/explain.ts). Nothing is signed or sent.
 *
 * Browser-safe like explain.ts: the views come through a `View` function the caller gives (a NEAR RPC client in
 * Node, src/chain-snapshot.ts; the website's own in a browser).
 */

/** One read-only view of the coin contract; all views of one quote should come from the same block. */
export type View = (method: string, args: Record<string, unknown>) => Promise<unknown>;

export interface QuoteViews {
  constants: Constants;
  rank: RankState;
  round: Round;
  pot: Pot;
  rulebook: Rulebook;
  /** This round's bets so far (get_positions for get_round's id). */
  positions: Position[];
}

/** A dry run cannot be given: the contract's numbers do not fit the explainer, or the views disagree. */
export class QuoteError extends Error {}

export async function readQuoteViews(view: View): Promise<QuoteViews> {
  const [constants, rank, round, pot, rulebook] = await Promise.all([
    view("get_constants", {}).then(readConstants),
    view("get_rank", {}).then(readRankState),
    view("get_round", {}).then(readRound),
    view("get_pot", {}).then(readPot),
    view("get_rulebook", {}).then(readRulebook),
  ]);
  const positions = readPositions(await view("get_positions", { round_id: round.id }));
  return { constants, rank, round, pot, rulebook, positions };
}

// ---------------------------------------------------------------- the bet

type BetDecision = Extract<Decision, { action: "BET" }>;

/** A bet as a person or an agent gives it: the margin in dollars (up to 6 decimals), the side in either case. */
export interface BetInput {
  market: string;
  side: string;
  margin_usd: string;
  leverage: number;
}

/**
 * The bet as a decision, or why it cannot be one. A bet that cannot be written as a decision line (01 §6.2) would
 * be refused MALFORMED_DECISION at check 5, before any rank check; decision.ts's own reader says why.
 */
export function readBet(
  input: BetInput,
): { ok: true; decision: BetDecision } | { ok: false; reason: string } {
  let margin: bigint;
  try {
    margin = parseScaled(input.margin_usd.trim(), 6);
  } catch {
    return {
      ok: false,
      reason: `margin ${JSON.stringify(input.margin_usd)} is not dollars with up to 6 decimals`,
    };
  }
  if (margin < 0n) return { ok: false, reason: "the margin cannot be negative" };
  const side = input.side.toLowerCase();
  if (side !== "long" && side !== "short") return { ok: false, reason: "the side must be long or short" };
  if (!Number.isFinite(input.leverage)) return { ok: false, reason: "the leverage must be a whole number" };
  const candidate = {
    action: "BET",
    market: input.market.toUpperCase() as Market,
    side: side === "long" ? "LONG" : "SHORT",
    margin_e6: margin,
    leverage: input.leverage,
  } as const;
  // The line the AI would have to write, read back with check 5's own strict reader.
  const expect = { round_id: 0, nonce: "0".repeat(16) };
  const read = readDecisionLine(decisionLine(expect.round_id, expect.nonce, candidate), expect);
  if (!read.ok)
    return {
      ok: false,
      reason: `as a decision line (01 §6.2) it would be MALFORMED_DECISION: ${read.reason}`,
    };
  if (read.decision.action !== "BET") return { ok: false, reason: "not a bet" };
  return { ok: true, decision: read.decision };
}

// ---------------------------------------------------------------- the round's state

/** Differences between the contract's ranks (get_constants().ranks) and ranks.ts, the explainer's table (01 §3). */
export function rankDifferences(c: Constants): string[] {
  const out: string[] = [];
  for (const name of Object.keys(RANKS) as RankName[]) {
    const mine = RANKS[name];
    const theirs = c.ranks.find((r) => r.rank === name);
    if (!theirs) {
      out.push(`${name} is missing from get_constants().ranks`);
      continue;
    }
    const same =
      theirs.per_bet_bps === mine.per_bet_bps &&
      theirs.max_bets === mine.max_bets &&
      theirs.per_round_bps === mine.per_round_bps &&
      theirs.max_leverage === mine.max_leverage &&
      theirs.sides.join() === mine.sides.join() &&
      theirs.markets.join() === mine.markets.join();
    if (!same) out.push(`${name}: the contract has ${JSON.stringify(theirs)}`);
  }
  return out;
}

/**
 * The round's state as the contract's `propose` would build it (crates/coin/src/round.rs) from views read at
 * `nowMs`: the rank and status now (get_rank: a demotion or a firing applies at once), the pool at round open
 * (get_round) and now (get_pot().brave.total), the round's counters, min_notional, and the long-shot ticket that
 * the rulebook states (rulebook.ts `longShotOf`; only a ticket round's rulebook has that line). Throws QuoteError
 * when the explainer cannot give the contract's verdict.
 */
export function stateFromViews(v: QuoteViews, nowMs: number): { state: RoundState; notes: string[] } {
  const c = v.constants;
  if (c.network !== "testnet")
    throw new QuoteError(`get_constants().network is ${c.network}; this dry run is for testnet only`);
  const differ = rankDifferences(c);
  if (differ.length > 0) {
    throw new QuoteError(
      `the contract's rank limits differ from ranks.ts (01 §3), which the explainer judges with, so its verdict ` +
        `would not be the contract's: ${differ.join("; ")}`,
    );
  }
  if (v.rulebook.round_id !== v.round.id) {
    throw new QuoteError(
      `get_rulebook is for round ${v.rulebook.round_id} but get_round is round ${v.round.id}: read them again`,
    );
  }
  const notes: string[] = [];
  const atOpen = BigInt(v.round.brave_at_open);
  const ticket = longShotOf(v.rulebook.text);
  if (ticket && ticket.margin_e6 !== longShotMarginE6(atOpen)) {
    notes.push(
      `the rulebook's long-shot margin ${ticket.margin_e6} is not 01 1.5's share of the pool at round open ` +
        `(${longShotMarginE6(atOpen)}, rulebook.ts); the dry run uses the rulebook's, as the contract states it`,
    );
  }
  if (v.round.rank !== v.rank.rank) {
    notes.push(
      `the round opened at ${v.round.rank} and the rank now is ${v.rank.rank}: a demotion applies at once ` +
        "(01 §9.2), so the checks use the rank now",
    );
  }
  const minNotional = BigInt(c.min_notional);
  if (minNotional !== MIN_NOTIONAL_E6) {
    notes.push(
      `get_constants().min_notional is ${c.min_notional}, not 01 1.2's ${MIN_NOTIONAL_E6}; the dry run uses the contract's`,
    );
  }
  const margins = v.positions.reduce((sum, p) => sum + BigInt(p.margin), 0n);
  if (margins !== BigInt(v.round.at_risk)) {
    notes.push(
      `this round's bets add up to ${usd(margins)} of margin but get_round().at_risk is ${usd(BigInt(v.round.at_risk))}`,
    );
  }
  return {
    state: {
      phase: v.round.phase,
      status: v.rank.status,
      rank: v.rank.rank,
      brave_at_open_e6: atOpen,
      brave_now_e6: BigInt(v.pot.brave_total),
      bets_used: v.round.bets_used,
      at_risk_e6: BigInt(v.round.at_risk),
      ms_into_round: nowMs - v.round.started_at,
      propose_from_ms: c.round.propose_from_ms,
      propose_until_ms: c.round.propose_until_ms,
      min_notional_e6: minNotional,
      ...(ticket ? { ticket } : {}),
    },
    notes,
  };
}

// ---------------------------------------------------------------- the quote

export interface Block {
  height: number;
  hash: string;
  time_ms: number;
}

export const NOT_IN_DRY_RUN =
  "Checks 1 to 5 are not part of a dry run: the proposal window (1) and the firing (2) come before the rank " +
  "checks, and the AI's signature (3), the request carrying the exact rulebook (4) and the decision line (5) need " +
  "a real signed answer from the AI. This verdict is checks 6 to 12 only, on the state read now.";

export const MAY_CHANGE =
  "The state can change before a real proposal (another bet, a cash-out, a vote, a new round); only the " +
  "contract's own verdict counts.";

export interface Quote {
  coin: string;
  block: { height: number; hash: string; time: string } | null;
  bet: { market: Market; side: "long" | "short"; margin_e6: string; leverage: number; notional_e6: string };
  round: {
    id: number;
    phase: Round["phase"];
    ms_into_round: number;
    rank: RankName;
    status: RankState["status"];
    brave_at_open_e6: string;
    brave_now_e6: string;
    limit_base_e6: string;
    bets_used: number;
    max_bets: number;
    at_risk_e6: string;
    long_shot: { margin_e6: string; max_leverage: number } | null;
    bets_so_far: {
      id: number;
      market: Market;
      side: string;
      margin_e6: string;
      leverage: number;
      status: string;
    }[];
  };
  explanation: Explanation;
  not_in_dry_run: string;
  /** Checks 1 and 2 at the moment the views were read, for information only (rules.ts windowAndStatus). */
  checks_1_and_2_now: string;
  may_change: string;
  notes: string[];
}

/** An offset into the round as m:ss, or h:mm:ss from an hour (01 §5's offsets are milliseconds). */
export function clock(ms: number): string {
  const sign = ms < 0 ? "-" : "";
  const t = Math.floor(Math.abs(ms) / 1000);
  const [h, m, s] = [Math.floor(t / 3600), Math.floor((t % 3600) / 60), t % 60];
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${sign}${h}:${two(m)}:${two(s)}` : `${sign}${m}:${two(s)}`;
}

function gateNow(state: RoundState): string {
  const window = `proposals are taken from ${clock(state.propose_from_ms)} to ${clock(state.propose_until_ms)} into the round`;
  const now = `${clock(state.ms_into_round)} into the round, phase ${state.phase}`;
  const gate = windowAndStatus(state);
  const check1 =
    gate?.verdict === "NOPE" && gate.code === "OUTSIDE_WINDOW"
      ? `check 1 would refuse a proposal now with OUTSIDE_WINDOW (${now}; ${window})`
      : `check 1 would pass now (${now}; ${window})`;
  const check2 =
    state.status === "FIRED"
      ? "check 2 would refuse it with FIRED (the Intern is FIRED: no new bets)"
      : "check 2 would pass (the Intern is EMPLOYED)";
  return `For information, when the views were read: ${check1}; ${check2}.`;
}

/** The dry run for one bet, from views read at `at.now_ms` (the block's time). Throws QuoteError. */
export function quoteFromViews(
  v: QuoteViews,
  decision: BetDecision,
  at: { coin: string; now_ms: number; block: Block | null },
): Quote {
  const { state, notes } = stateFromViews(v, at.now_ms);
  return {
    coin: at.coin,
    block: at.block && {
      height: at.block.height,
      hash: at.block.hash,
      time: new Date(at.block.time_ms).toISOString(),
    },
    bet: {
      market: decision.market,
      side: decision.side === "LONG" ? "long" : "short",
      margin_e6: decision.margin_e6.toString(),
      leverage: decision.leverage,
      notional_e6: (decision.margin_e6 * BigInt(decision.leverage)).toString(),
    },
    round: {
      id: v.round.id,
      phase: v.round.phase,
      ms_into_round: state.ms_into_round,
      rank: state.rank,
      status: state.status,
      brave_at_open_e6: state.brave_at_open_e6.toString(),
      brave_now_e6: state.brave_now_e6.toString(),
      limit_base_e6: limitBase(state).toString(),
      bets_used: state.bets_used,
      max_bets: RANKS[state.rank].max_bets,
      at_risk_e6: state.at_risk_e6.toString(),
      long_shot: state.ticket
        ? { margin_e6: state.ticket.margin_e6.toString(), max_leverage: state.ticket.max_leverage }
        : null,
      bets_so_far: v.positions.map((p) => ({
        id: p.id,
        market: p.market,
        side: p.side.toLowerCase(),
        margin_e6: p.margin,
        leverage: p.leverage,
        status: p.status,
      })),
    },
    explanation: explain(state, decision),
    not_in_dry_run: NOT_IN_DRY_RUN,
    checks_1_and_2_now: gateNow(state),
    may_change: MAY_CHANGE,
    notes,
  };
}

/** The quote as text lines. */
export function quoteLines(q: Quote): string[] {
  const r = q.round;
  const at = q.block ? `views at block ${q.block.height} (${q.block.time})` : "views read now";
  const bets = r.bets_so_far.map(
    (b) => `#${b.id} ${b.market} ${b.side} ${usd(BigInt(b.margin_e6))} ×${b.leverage} (${b.status})`,
  );
  const ticket = r.long_shot
    ? `; this round has a long-shot ticket: margin exactly ${usd(BigInt(r.long_shot.margin_e6))}, up to ${r.long_shot.max_leverage}x`
    : "";
  return [
    `quote: a free dry run of checks 6 to 12 (01 §7) for ${q.coin}. Read-only: ${at}; nothing signed or sent.`,
    `the bet:    ${q.bet.market} ${q.bet.side}, margin ${usd(BigInt(q.bet.margin_e6))} × ${q.bet.leverage} = notional ${usd(BigInt(q.bet.notional_e6))}`,
    `the round:  ${r.id}, phase ${r.phase}, ${clock(r.ms_into_round)} in; rank ${r.rank} (${r.status}); bets so far ` +
      `${r.bets_used} of ${r.max_bets}, ${usd(BigInt(r.at_risk_e6))} at risk${ticket}`,
    ...(bets.length > 0 ? [`            ${bets.join("; ")}`] : []),
    `the pool:   ${usd(BigInt(r.brave_at_open_e6))} when the round opened, ${usd(BigInt(r.brave_now_e6))} now`,
    "",
    ...explanationLines(q.explanation),
    "",
    q.not_in_dry_run,
    q.checks_1_and_2_now,
    q.may_change,
    ...q.notes.map((n) => `note: ${n}`),
  ];
}
