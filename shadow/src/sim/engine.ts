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
import { applyWaiting, finishDue } from "./ballots.ts";
import { type Recorded, replay, type ShapeCode, type Told } from "./behaviour.ts";
import {
  addFakes,
  arrivals,
  type CommunityInputs,
  communityGuesses,
  communityVotes,
  doCashOuts,
  drawEntries,
  type FakeInputs,
  fakeGuesses,
  locks,
  planCashOuts,
  planRun,
  type RunInputs,
  runLeavers,
  startCommunity,
  tips,
  type WhaleInputs,
  whaleActs,
} from "./community.ts";
import { coinPriceE6, lockedOf, openRound, usdOf } from "./ledger.ts";
import type { Move, MoveTable } from "./prices.ts";
import { collectInterest, holdDraw, ruling, settleJackpots, type Verdict3 } from "./rewards.ts";
import { type Rng, streamFor } from "./rng.ts";
import {
  BPS,
  COACH_CUT_BPS,
  HL_MIN_ORDER_E6,
  LENDER,
  MIN_LEND_E6,
  PPM,
  type RoundClock,
  roundsPerDay,
} from "./rules01.ts";
import { bosses, newWorld, type Position, type SimRound, trackAdd, type World } from "./world.ts";

/**
 * The round loop of the simulated coin, one round at a time as 01 §5 runs it: the opening (income, then pending money
 * becomes coins, waiting rank changes take effect, the rewards tick), the opening phase (people pay in, cash out,
 * lock, vote, guess), the proposal window (the Intern's answers, judged by runner/src/rules.ts), the hold (people may
 * still cash out), the close (each bet settles on real Hyperliquid prices). Pure: no node: imports, no clock; every
 * random number comes from the seed.
 */

/** "limits": every proposal judged by runner/src/rules.ts. "control": the same run with the rank limits switched off. */
export type Arm = "limits" | "control";

/** How the Intern answers: replaying a model's recorded answers, or always asking for the most it is told it may. */
export type InternPolicy = { kind: "recorded"; decisions: readonly Recorded[] } | { kind: "max" };

export interface SimConfig {
  clock: RoundClock;
  rounds: number;
  arm: Arm;
  intern: InternPolicy;
  /**
   * Proposals the runner makes in a round. The runner asks once (runner/src/round.ts `DEFAULT_SETTINGS.maxAsks`);
   * "until-full" asks until the rank's bets are used up, a stress setting.
   */
  asks: number | "until-full";
  /** The price move each round's bets see, one entry per simulated round. */
  moves: MoveTable;
  /** Round-trip trading cost on each bet's notional, in bps. */
  cost_bps: number;
  /** Simulated rounds (1 = this run's first) in which every bet is set against the real move. */
  losing: { from_round: number; to_round: number } | null;
  community: CommunityInputs;
  whale: WhaleInputs | null;
  fakes: FakeInputs | null;
  run: RunInputs | null;
  seed: number;
  /** Keep every judged proposal (tests re-judge them with runner/src/rules.ts). */
  audit?: boolean;
}

/** With the limits off no rank says how many bets: the runner asks as often as the most any rank allows (TRADER's). */
const CONTROL_ASKS = RANKS.TRADER.max_bets;
/** The rulebook's nonce changes no number in it; any 16 hex characters do for `maxMarginE6`. */
const NONCE = "0000000000000000";
const ALL_MARKETS: readonly Market[] = MARKETS.map((m) => m.market);
const BOTH_SIDES: readonly Side[] = ["LONG", "SHORT"];

/** Before the first round: fake accounts (if any) first in line, then the first bosses and the jackpot seed. */
export function setUp(w: World, cfg: SimConfig): void {
  if (cfg.fakes) addFakes(w, cfg.fakes);
  startCommunity(w, cfg.community, streamFor(cfg.seed, "start"));
}

/** Runs `cfg.rounds` rounds from a fresh coin, or from `start` (the projection's synthesized state). */
export function runSim(cfg: SimConfig, start?: World): World {
  const w = start ?? newWorld(cfg.audit ?? false);
  if (!start) setUp(w, cfg);
  for (let k = 0; k < cfg.rounds; k++) playRound(w, cfg, k);
  return w;
}

function usdOfId(w: World, id: string): bigint {
  const a = w.byId.get(id);
  return a ? usdOf(w.pot, a) : 0n;
}

/** One round; `k` is its index in this run (0 is the first), for the price table. */
export function playRound(w: World, cfg: SimConfig, k: number): void {
  w.round += 1;
  const r = w.round;
  const rpd = roundsPerDay(cfg.clock);
  const rng = (purpose: string): Rng => streamFor(cfg.seed, purpose, r);

  // The opening (01 §5, §9.6): outside income first, then pending money becomes coins. Waiting rank and playbook
  // changes take effect (01 §9.2, §9.5). The runner's rewards_tick: jackpots of closed rounds and a due draw (01 §9.7).
  w.counters.income += openRound(w.pot, w.accounts, r).income;
  applyWaiting(w);
  const round: SimRound = {
    id: r,
    brave_at_open: w.pot.brave_total,
    bets_used: 0,
    at_risk: 0n,
    playbook_active: w.playbook.active,
    positions: [],
    limit_bps: 0,
  };
  w.current = round;
  const priceNow = coinPriceE6(w.pot);
  if (!w.track.price.seen) {
    trackAdd(w.track.price, priceNow);
    trackAdd(w.track.brave, w.pot.brave_total);
    trackAdd(w.track.supply, w.pot.supply);
  }
  if (w.price_at_change === 0n) {
    w.price_at_change = priceNow;
    w.price_high = priceNow;
    w.change_round = r;
  }
  settleJackpots(w.rewards, r);
  if (holdDraw(w.rewards, r, (id) => usdOfId(w, id), rng("draw"))) countFakeShare(w);

  // The opening phase: votes whose time is up, then what people do before guesses close and proposals open.
  finishDue(w);
  arrivals(w, cfg.community, rng("arrivals"), rpd);
  locks(w, cfg.community);
  if (cfg.whale) whaleActs(w, cfg.whale, rpd);
  if (cfg.run) planRun(w, cfg.run, rng("run"), rpd, cfg.clock);
  const plan = planCashOuts(w, cfg.community, rng("cashouts"), rpd, cfg.clock);
  doCashOuts(w, plan, "before");
  if (cfg.run) runLeavers(w, "before");
  tips(w, cfg.community, rng("tips"), rpd);
  communityVotes(w, cfg.community, rng("votes"), rpd);
  drawEntries(w);
  if (cfg.fakes) fakeGuesses(w, rng("fakes"));
  communityGuesses(w, cfg.community, rng("guesses"));

  // The proposal window.
  propose(w, cfg, round, rng("intern"));

  // The hold: anyone leaving now gives up their share of the margin out on the open bets (01 §9.1, 1.1).
  doCashOuts(w, plan, "hold");
  if (cfg.run) runLeavers(w, "hold");

  // The close: every bet settles; then the rest of the round, and the lender's interest for it goes to the draw.
  settle(w, cfg, round, k);
  doCashOuts(w, plan, "after");
  if (cfg.run) runLeavers(w, "after");
  lend(w, cfg.clock);
  record(w, rpd);
}

// ---------------------------------------------------------------- the Intern

/** One answer of the Intern, before the program judges it. */
export type Answer =
  | { kind: "skip" }
  | { kind: "unreadable"; code: ShapeCode }
  | { kind: "bet"; decision: Decision };

interface Offer extends Told {
  markets: readonly Market[];
  sides: readonly Side[];
}

/**
 * What the Intern is told it may do. With the limits: 01 §6.1's `max_margin_e6`, worked out by the runner's own
 * `maxMarginE6` (runner/src/rulebook.ts) from `brave_at_open`; the example amount is 01 1.2's $11, the minimum; the
 * rank's markets and sides. Without the limits: the whole idle BRAVE pool, all six markets, both sides.
 */
function offer(w: World, cfg: SimConfig, round: SimRound): Offer {
  if (cfg.arm === "limits") {
    const max = maxMarginE6({
      round_id: round.id,
      nonce: NONCE,
      rank: w.rank,
      brave_at_open_e6: round.brave_at_open,
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

function answerOf(w: World, cfg: SimConfig, round: SimRound, rng: Rng): Answer {
  const told = offer(w, cfg, round);
  let decision: Decision;
  if (cfg.intern.kind === "max") {
    const market = rng.pick(told.markets);
    const side = rng.pick(told.sides);
    const leverage = cfg.arm === "limits" ? RANKS[w.rank].max_leverage : (HL_MAX_LEVERAGE[market] ?? 1);
    decision = { action: "BET", market, side, margin_e6: told.max_margin_e6, leverage };
  } else {
    const rec = rng.pick(cfg.intern.decisions);
    if (rec.kind === "skip") return { kind: "skip" };
    if (rec.kind === "unreadable") return { kind: "unreadable", code: rec.code };
    decision = replay(rec, told);
  }
  if (decision.action === "BET" && decision.margin_e6 === told.max_margin_e6) w.counters.asked_max += 1;
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

/** A judged proposal: YES, SKIP or the refusal code (NOT_PLACEABLE with the limits off), and the bet if placed. */
export interface Judged {
  key: string;
  position: Position | null;
}

/**
 * With the limits: checks 1, 2 and 6 to 12 by runner/src/rules.ts `checkDecision`, on the round as the program sees
 * it; an unreadable answer fails at its own check (3 to 5) after checks 1 and 2. test/sim-refusals.test.ts checks that
 * this refuses exactly what runner/src/rules.ts refuses.
 */
export function judgeWithLimits(w: World, clock: RoundClock, round: SimRound, answer: Answer): Judged {
  const state = roundStateOf(w, clock, round);
  let decision: Decision | null = null;
  let verdict: Verdict;
  if (answer.kind === "unreadable") {
    verdict = windowAndStatus(state) ?? nope(answer.code);
  } else {
    decision = answer.kind === "skip" ? { action: "SKIP" } : answer.decision;
    verdict = checkDecision(state, decision);
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

/** The proposal window. The runner asks nothing while the Intern is FIRED, and only while the rank has bets left. */
function propose(w: World, cfg: SimConfig, round: SimRound, rng: Rng): void {
  const asks =
    cfg.asks === "until-full" ? (cfg.arm === "limits" ? RANKS[w.rank].max_bets : CONTROL_ASKS) : cfg.asks;
  for (let i = 0; i < asks; i++) {
    if (w.status !== "EMPLOYED") return;
    if (cfg.arm === "limits" && round.bets_used >= RANKS[w.rank].max_bets) return;
    const answer = answerOf(w, cfg, round, rng);
    const judged =
      cfg.arm === "limits" ? judgeWithLimits(w, cfg.clock, round, answer) : judgeWithout(w, answer);
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
  }
}

// ---------------------------------------------------------------- settling

/**
 * What a bet returns at the close: its margin plus the price move on its notional, less the round-trip cost; nothing
 * if at the hold's worst price the loss reached the margin (the shadow run's rule, shadow/src/paper.ts, applied to
 * the candles' highs and lows). In a losing round the bet is set on the side that lost the real move. With no price,
 * it closes flat and pays the cost.
 */
export function positionResult(
  p: Position,
  move: Move | null,
  costBps: number,
  losing: boolean,
): { returned: bigint; liquidated: boolean; noPrice: boolean } {
  const notional = p.margin * BigInt(p.leverage);
  const cost = (notional * BigInt(costBps)) / BPS;
  if (move === null)
    return { returned: p.margin > cost ? p.margin - cost : 0n, liquidated: false, noPrice: true };
  const side = losing ? (move.exit_ppm >= PPM ? "SHORT" : "LONG") : p.side;
  const dir = side === "LONG" ? 1n : -1n;
  const worst = side === "LONG" ? move.low_ppm : move.high_ppm;
  if (dir * BigInt(worst - PPM) * BigInt(p.leverage) <= -BigInt(PPM)) {
    return { returned: 0n, liquidated: true, noPrice: false };
  }
  const back = p.margin + (notional * dir * BigInt(move.exit_ppm - PPM)) / BigInt(PPM) - cost;
  return { returned: back > 0n ? back : 0n, liquidated: false, noPrice: false };
}

function settle(w: World, cfg: SimConfig, round: SimRound, k: number): void {
  const c = w.counters;
  const losing = cfg.losing !== null && k + 1 >= cfg.losing.from_round && k + 1 <= cfg.losing.to_round;
  let result = 0n;
  for (const p of round.positions) {
    const out = positionResult(p, cfg.moves.moves[p.market][k] ?? null, cfg.cost_bps, losing);
    const r = out.returned - p.margin;
    w.pot.brave_total += r;
    w.pot.in_play -= p.margin;
    result += r;
    if (r > 0n) c.won += 1;
    else c.lost += 1;
    if (out.liquidated) c.liquidated += 1;
    if (out.noPrice) c.no_price += 1;
  }
  c.bets_result += result;
  // 01 §9.5: a winning round with an active playbook pays 10% of its result to the authors; the rest stays.
  if (result > 0n && round.playbook_active) {
    const cut = (result * BigInt(COACH_CUT_BPS)) / BPS;
    w.pot.brave_total -= cut;
    c.coach_cut += cut;
  }
  if (result < 0n && round.brave_at_open > 0n) {
    const loss = -result;
    c.worst_loss_bps = Math.max(c.worst_loss_bps, Number((loss * BPS) / round.brave_at_open));
    if (round.limit_bps > 0) {
      const ratio = Number((loss * BPS * 1_000_000n) / (round.brave_at_open * BigInt(round.limit_bps))) / 1e6;
      c.worst_loss_vs_limit = Math.max(c.worst_loss_vs_limit, ratio);
    }
  }
}

/**
 * 01 §9.6: `rebalance` keeps the Intern's slice idle (its rank's per-round limit on the pool) and lends the rest, if
 * at least $10; the STAND-IN lender pays its test rate on it; since 1.4 that interest goes to the payday draw.
 * Pending money and SAFE are never lent.
 */
function lend(w: World, clock: RoundClock): void {
  const total = w.pot.brave_total;
  const lent = total - dollarLimit(total, RANKS[w.rank].per_round_bps);
  if (lent < MIN_LEND_E6) return;
  const interest = (lent * BigInt(LENDER.rate_bps) * BigInt(clock.round_ms)) / (BPS * BigInt(LENDER.year_ms));
  collectInterest(w.rewards, interest);
}

/** The fake accounts' share of all dollars held, at each draw (for the farming pass mark). */
function countFakeShare(w: World): void {
  let fake = 0n;
  let all = 0n;
  for (const a of w.accounts) {
    const x = usdOf(w.pot, a);
    all += x;
    if (a.kind === "fake") fake += x;
  }
  w.counters.fake_usd_share_at_draws.push(all === 0n ? 0 : Number((fake * 10_000n) / all));
}

function record(w: World, rpd: number): void {
  const price = coinPriceE6(w.pot);
  trackAdd(w.track.price, price);
  trackAdd(w.track.brave, w.pot.brave_total);
  trackAdd(w.track.supply, w.pot.supply);
  if (price > w.price_high) w.price_high = price;
  const state = w.status === "FIRED" ? "FIRED" : w.rank;
  w.counters.rounds_in[state] = (w.counters.rounds_in[state] ?? 0) + 1;
  checkBooks(w);
  if (w.round % rpd === 0) {
    w.daily.push({
      day: w.round / rpd,
      brave_e6: String(w.pot.brave_total),
      supply_e6: String(w.pot.supply),
      price_e6: String(price),
      safe_e6: String(w.pot.safe_total),
      pending_e6: String(w.pot.pending),
      bosses: bosses(w),
      rank: w.rank,
      status: w.status,
    });
  }
}

/** The books must balance after every round; any failure is listed in the report. */
function checkBooks(w: World): void {
  const fails = w.counters.invariant_failures;
  if (fails.length >= 20) return;
  let coins = 0n;
  let pending = 0n;
  let safe = 0n;
  for (const a of w.accounts) {
    coins += a.coins;
    pending += a.pending;
    safe += a.safe;
    if (lockedOf(a) > a.coins || a.coins < 0n || a.safe < 0n || a.pending < 0n) {
      fails.push(`round ${w.round}: ${a.id} has a negative balance or more locked than held`);
    }
  }
  const p = w.pot;
  if (coins + p.nobodys !== p.supply) fails.push(`round ${w.round}: coins held + nobody's ≠ supply`);
  if (pending !== p.pending) fails.push(`round ${w.round}: pending money does not add up`);
  if (safe !== p.safe_total) fails.push(`round ${w.round}: SAFE does not add up`);
  if (p.in_play !== 0n) fails.push(`round ${w.round}: margin still in play after the close`);
  if (p.brave_total < 0n) fails.push(`round ${w.round}: BRAVE below zero`);
}
