import type { Decision } from "../../../runner/src/decision.ts";
import { MARKETS, type Market } from "../../../runner/src/markets.ts";
import { dollarLimit, MIN_NOTIONAL_E6, RANKS, type Side } from "../../../runner/src/ranks.ts";
import { maxMarginE6 } from "../../../runner/src/rulebook.ts";
import {
  checkDecision,
  HL_MAX_LEVERAGE,
  limitBase,
  nope,
  type RoundState,
  type Verdict,
  windowAndStatus,
} from "../../../runner/src/rules.ts";
import { suspend } from "./ballots.ts";
import { type Recorded, replay, type ShapeCode, type Told } from "./behaviour.ts";
import { type CashOutPlan, cashOutsDue } from "./community.ts";
import type { SimConfig } from "./engine.ts";
import { positionResult } from "./position.ts";
import { anyOn } from "./proposals.ts";
import { ruling, type Verdict3 } from "./rewards.ts";
import type { Rng } from "./rng.ts";
import { BPS, HL_MIN_ORDER_E6, type RoundClock } from "./rules01.ts";
import type { Position, SimRound, World } from "./world.ts";

/**
 * The proposal window: the runner asks the Intern, the program judges the answer. Today's rules: every proposal judged
 * by runner/src/rules.ts. With PROPOSALS on (src/sim/proposals.ts) the program judges as each would, and every answer
 * is also judged as today's rules would judge it, to count the bets a proposal stops, shrinks or lets through. Pure.
 */

/** The runner asks one second into the proposal window (runner/src/round.ts sleeps until `propose_from + 1_000`). */
export const ASK_DELAY_MS = 1_000;
/** PROPOSAL e2: the most times the runner asks again in one round because the rulebook changed. */
export const MAX_REASKS = 3;

const NONCE = "0000000000000000"; // the rulebook's nonce changes no number in it
const ALL_MARKETS: readonly Market[] = MARKETS.map((m) => m.market);
const BOTH_SIDES: readonly Side[] = ["LONG", "SHORT"];
/** With the limits off no rank says how many bets: the runner asks as often as the most any rank allows (TRADER's). */
const CONTROL_ASKS = RANKS.TRADER.max_bets;

/** One answer of the Intern, before the program judges it. */
export type Answer =
  | { kind: "skip" }
  | { kind: "unreadable"; code: ShapeCode }
  | { kind: "bet"; decision: Decision };

/** A judged proposal: YES, SKIP or the refusal code (NOT_PLACEABLE with the limits off), and the bet if placed. */
export interface Judged {
  key: string;
  position: Position | null;
}

interface Offer extends Told {
  markets: readonly Market[];
  sides: readonly Side[];
}

/** What a recorded answer is, before it is sized against a rulebook; `ms` is how long it took to get. */
type Pick =
  | { kind: "recorded"; rec: Recorded; ms: number }
  | { kind: "max"; market: Market; side: Side; ms: 0 };

/**
 * The pool the rulebook's numbers are worked out on. Today: the pool when the round opened (01 §6.1). PROPOSAL e: the
 * smaller of that and the pool now. PROPOSAL c, while the gate is shut: that, times the shrink.
 */
function ruleBase(w: World, round: SimRound): bigint {
  const p = w.proposals;
  let base = round.brave_at_open;
  if (p.max_on_now !== null && w.pot.brave_total < base) base = w.pot.brave_total;
  if (p.record_gate !== null && w.ps.gated) base = (base * BigInt(p.record_gate.shrink_bps)) / BPS;
  return base;
}

/**
 * What the Intern is told it may do. With the limits: 01 §6.1's `max_margin_e6`, worked out by the runner's own
 * `maxMarginE6` (runner/src/rulebook.ts); the example amount is 01 1.2's $11, the minimum; the rank's markets and
 * sides. `today` ignores the proposals. Without the limits: the whole idle BRAVE pool, all six markets, both sides.
 */
function offer(w: World, cfg: SimConfig, round: SimRound, today = false): Offer {
  if (cfg.arm === "limits") {
    const max = maxMarginE6({
      round_id: round.id,
      nonce: NONCE,
      rank: w.rank,
      brave_at_open_e6: today ? round.brave_at_open : ruleBase(w, round),
      bets_used: round.bets_used,
      at_risk_e6: round.at_risk,
      playbook: null,
    });
    const limits = RANKS[w.rank];
    return { max_margin_e6: max, example_e6: MIN_NOTIONAL_E6, markets: limits.markets, sides: limits.sides };
  }
  const idle = w.pot.brave_total - w.pot.in_play;
  return { max_margin_e6: idle, example_e6: MIN_NOTIONAL_E6, markets: ALL_MARKETS, sides: BOTH_SIDES };
}

function pickAnswer(w: World, cfg: SimConfig, round: SimRound, rng: Rng): Pick {
  if (cfg.intern.kind === "max") {
    const told = offer(w, cfg, round);
    return { kind: "max", market: rng.pick(told.markets), side: rng.pick(told.sides), ms: 0 };
  }
  const rec = rng.pick(cfg.intern.decisions);
  return { kind: "recorded", rec, ms: rec.ms ?? 0 };
}

/** A picked answer sized against a rulebook. `count` adds a bet at exactly the told max to the counters. */
function sized(w: World, cfg: SimConfig, pick: Pick, told: Offer, count: boolean): Answer {
  let decision: Decision;
  if (pick.kind === "max") {
    const leverage = cfg.arm === "limits" ? RANKS[w.rank].max_leverage : (HL_MAX_LEVERAGE[pick.market] ?? 1);
    decision = {
      action: "BET",
      market: pick.market,
      side: pick.side,
      margin_e6: told.max_margin_e6,
      leverage,
    };
  } else {
    const rec = pick.rec;
    if (rec.kind === "skip") return { kind: "skip" };
    if (rec.kind === "unreadable") return { kind: "unreadable", code: rec.code };
    decision = replay(rec, told);
  }
  if (count && decision.action === "BET" && decision.margin_e6 === told.max_margin_e6)
    w.counters.asked_max += 1;
  return { kind: "bet", decision };
}

/** The round as the program sees it when a proposal arrives (01 §7 checks 1 and 2, and the limit base of 01 §3). */
export function roundStateOf(w: World, clock: RoundClock, round: SimRound): RoundState {
  return {
    phase: "PROPOSE",
    status: w.status,
    rank: w.rank,
    brave_at_open_e6: round.brave_at_open,
    brave_now_e6: w.pot.brave_total,
    bets_used: round.bets_used,
    at_risk_e6: round.at_risk,
    ms_into_round: clock.propose_from_ms,
    propose_from_ms: clock.propose_from_ms,
    propose_until_ms: clock.propose_until_ms,
  };
}

/** PROPOSAL c: the gate shrinks every limit by judging today's checks on a proportionally smaller pool. */
function gatedState(w: World, state: RoundState): RoundState {
  const gate = w.proposals.record_gate;
  if (gate === null || !w.ps.gated) return state;
  const k = BigInt(gate.shrink_bps);
  return {
    ...state,
    brave_at_open_e6: (state.brave_at_open_e6 * k) / BPS,
    brave_now_e6: (state.brave_now_e6 * k) / BPS,
  };
}

/**
 * With the limits: checks 1, 2 and 6 to 12 by runner/src/rules.ts `checkDecision`, on the round as the program sees
 * it; an unreadable answer fails at its own check (3 to 5) after checks 1 and 2. PROPOSAL e1: an answer to a rulebook
 * that changed before it arrived fails check 4 (WRONG_RULEBOOK). test/sim-refusals.test.ts checks that, under today's
 * rules, this refuses exactly what runner/src/rules.ts refuses.
 */
export function judgeWithLimits(
  w: World,
  clock: RoundClock,
  round: SimRound,
  answer: Answer,
  stale = false,
): Judged {
  const state = gatedState(w, roundStateOf(w, clock, round));
  let decision: Decision | null = null;
  let verdict: Verdict;
  const early = windowAndStatus(state);
  if (answer.kind === "unreadable") {
    verdict = early ?? (stale ? nope("WRONG_RULEBOOK") : nope(answer.code));
  } else {
    decision = answer.kind === "skip" ? { action: "SKIP" } : answer.decision;
    verdict = early ?? (stale ? nope("WRONG_RULEBOOK") : checkDecision(state, decision));
  }
  w.audit?.push({ state, decision, unreadable: answer.kind === "unreadable" ? answer.code : null, verdict });
  if (
    decision?.action === "BET" &&
    verdict.verdict === "NOPE" &&
    (verdict.code === "OVER_TRADE_LIMIT" || verdict.code === "OVER_ROUND_LIMIT") &&
    checkDecision({ ...state, brave_now_e6: state.brave_at_open_e6 }, decision).verdict === "YES"
  ) {
    w.counters.refused_money_left += 1;
  }
  if (verdict.verdict === "YES" && decision?.action === "BET") {
    if (decision.margin_e6 > dollarLimit(limitBase(state), RANKS[state.rank].per_bet_bps)) {
      w.counters.approved_over_limit += 1;
    }
    const { market, side, margin_e6, leverage } = decision;
    return { key: "YES", position: { market, side, margin: margin_e6, leverage } };
  }
  return { key: verdict.verdict === "NOPE" ? verdict.code : verdict.verdict, position: null };
}

/**
 * Without the limits: checks 6 to 12 are switched off; checks 3 to 5 (signature, rulebook, shape) are not rank limits
 * and stay. A bet is taken as asked, except what no pool or exchange allows: the margin is capped at the idle pool
 * and the leverage at Hyperliquid's maximum for the market; under Hyperliquid's $10 minimum it cannot be placed.
 */
export function judgeWithout(w: World, answer: Answer): Judged {
  if (answer.kind === "unreadable") return { key: answer.code, position: null };
  if (answer.kind === "skip" || answer.decision.action !== "BET") return { key: "SKIP", position: null };
  const d = answer.decision;
  const idle = w.pot.brave_total - w.pot.in_play;
  // biome-ignore lint/complexity/useMathMinMax: these are bigints, and Math.min throws on bigint.
  const margin = d.margin_e6 < idle ? d.margin_e6 : idle;
  const leverage = Math.min(d.leverage, HL_MAX_LEVERAGE[d.market] ?? 1);
  if (margin <= 0n || margin * BigInt(leverage) < HL_MIN_ORDER_E6)
    return { key: "NOT_PLACEABLE", position: null };
  return { key: "YES", position: { market: d.market, side: d.side, margin, leverage } };
}

/**
 * What today's rules would do with this answer now, without touching any counter: the bet they would place, or null.
 * Today's rules have no strikes and no halt, so the Intern counts as employed (a firing by vote is never counted here).
 */
function todayPosition(w: World, cfg: SimConfig, round: SimRound, answer: Answer): Position | null {
  if (answer.kind !== "bet" || answer.decision.action !== "BET") return null;
  const v = checkDecision({ ...roundStateOf(w, cfg.clock, round), status: "EMPLOYED" }, answer.decision);
  if (v.verdict !== "YES") return null;
  const { market, side, margin_e6, leverage } = answer.decision;
  return { market, side, margin: margin_e6, leverage };
}

/** Whether a bet would have made money at this round's close. */
function wins(cfg: SimConfig, p: Position, k: number): boolean {
  const losing = cfg.losing !== null && k + 1 >= cfg.losing.from_round && k + 1 <= cfg.losing.to_round;
  return positionResult(p, cfg.moves.moves[p.market][k] ?? null, cfg.cost_bps, losing).returned > p.margin;
}

/** A PROPOSAL's verdict against today's: a good bet stopped, a bet placed smaller, or a bet let through. */
function compare(w: World, cfg: SimConfig, k: number, today: Position | null, placed: Position | null): void {
  if (today && !placed) {
    w.pc.blocked += 1;
    if (wins(cfg, today, k)) w.pc.blocked_won += 1;
  } else if (today && placed && placed.margin < today.margin) {
    w.pc.shrunk += 1;
  } else if (!today && placed) {
    w.pc.unblocked += 1;
  }
}

/**
 * The proposal window. The runner asks nothing while the Intern is FIRED, and only while the rank has bets left. It
 * holds the rulebook from its fetch until the answer is signed (the recorded answer's `ms`); a cash-out in that time
 * still changes the pool the proposal is judged on.
 */
export function propose(
  w: World,
  cfg: SimConfig,
  round: SimRound,
  rng: Rng,
  plan: readonly CashOutPlan[],
  k: number,
): void {
  const opts = w.proposals;
  const counting = cfg.arm === "limits" && anyOn(opts);
  const asks =
    cfg.asks === "until-full" ? (cfg.arm === "limits" ? RANKS[w.rank].max_bets : CONTROL_ASKS) : cfg.asks;
  let t = cfg.clock.propose_from_ms + ASK_DELAY_MS;
  for (let i = 0; i < asks; i++) {
    const halted = opts.drawdown_halt !== null && w.ps.halted;
    if (w.status !== "EMPLOYED" || halted) {
      // PROPOSALS a and b: suspended by three strikes, or halted: count the bet today's rules would have taken. A
      // firing by vote is today's rule, not the proposal's doing.
      const byProposal = w.status === "EMPLOYED" ? halted : w.ps.suspended;
      if (counting && i === 0 && byProposal) {
        const pick = pickAnswer(w, cfg, round, rng);
        compare(
          w,
          cfg,
          k,
          todayPosition(w, cfg, round, sized(w, cfg, pick, offer(w, cfg, round, true), false)),
          null,
        );
      }
      return;
    }
    if (cfg.arm === "limits" && round.bets_used >= RANKS[w.rank].max_bets) return;
    const first = pickAnswer(w, cfg, round, rng);
    let pick = first;
    let told = offer(w, cfg, round);
    let stale = false;
    for (let reask = 0; ; reask++) {
      const moved = cashOutsDue(w, plan, t + pick.ms);
      t += pick.ms;
      // PROPOSAL e: the rulebook's max moves with the pool now, so a cash-out while the model answered changed it.
      stale =
        moved > 0 && opts.max_on_now !== null && offer(w, cfg, round).max_margin_e6 !== told.max_margin_e6;
      if (!stale || opts.max_on_now?.reask !== true || reask >= MAX_REASKS) break;
      w.pc.reasks += 1;
      pick = pickAnswer(w, cfg, round, rng);
      told = offer(w, cfg, round);
    }
    const answer = sized(w, cfg, pick, told, true);
    const judged =
      cfg.arm === "limits" ? judgeWithLimits(w, cfg.clock, round, answer, stale) : judgeWithout(w, answer);
    if (counting) {
      const todayAnswer = sized(w, cfg, first, offer(w, cfg, round, true), false);
      compare(w, cfg, k, todayPosition(w, cfg, round, todayAnswer), judged.position);
    }
    const c = w.counters;
    c.asked += 1;
    c.verdicts[judged.key] = (c.verdicts[judged.key] ?? 0) + 1;
    // The free guess is judged on the round's first ruling (01 §9.7); a bet Hyperliquid would refuse was still a YES.
    const v3: Verdict3 =
      judged.key === "SKIP" ? "SKIP" : judged.position || judged.key === "NOT_PLACEABLE" ? "YES" : "NOPE";
    if (!w.rewards.verdicts.has(round.id)) w.ruling_counts[v3] += 1;
    ruling(w.rewards, round.id, v3);
    if (judged.position) {
      const p = judged.position;
      round.positions.push(p);
      round.bets_used += 1;
      round.at_risk += p.margin;
      round.limit_bps = Math.max(round.limit_bps, RANKS[w.rank].per_round_bps);
      w.pot.in_play += p.margin;
      c.placed += 1;
    }
    // PROPOSAL a: refusals in a row on the Intern's own proposals; a YES or a skip starts the count again.
    if (opts.three_strikes !== null && cfg.arm === "limits") {
      w.ps.strikes = v3 === "NOPE" ? w.ps.strikes + 1 : 0;
      if (w.ps.strikes >= opts.three_strikes.strikes) {
        w.ps.strikes = 0;
        suspend(w, w.round);
        return;
      }
    }
  }
}
