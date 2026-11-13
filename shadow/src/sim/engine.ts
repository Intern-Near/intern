import { dollarLimit, RANKS } from "../../../runner/src/ranks.ts";
import { applyWaiting, finishDue } from "./ballots.ts";
import type { Recorded } from "./behaviour.ts";
import {
  addFakes,
  addGriefer,
  arrivals,
  type CommunityInputs,
  cashOutsDue,
  communityGuesses,
  communityVotes,
  drawEntries,
  type FakeInputs,
  fakeGuesses,
  type GrieferInputs,
  grieferPlan,
  locks,
  planCashOuts,
  planRun,
  type RunInputs,
  type SniperInputs,
  sniperActs,
  startCommunity,
  tips,
  type WhaleInputs,
  whaleActs,
} from "./community.ts";
import { propose } from "./intern.ts";
import { cashOutBrave, coinPriceE6, freeCoins, lockedOf, openRound, usdOf } from "./ledger.ts";
import { positionResult } from "./position.ts";
import type { MoveTable } from "./prices.ts";
import type { Proposals } from "./proposals.ts";
import { collectInterest, type DrawRule, holdDraw, settleJackpots } from "./rewards.ts";
import { type Rng, streamFor } from "./rng.ts";
import {
  BPS,
  COACH_CUT_BPS,
  LENDER,
  MIN_LEND_E6,
  REWARDS,
  type RoundClock,
  roundsPerDay,
} from "./rules01.ts";
import { bosses, newWorld, type SimRound, trackAdd, type World } from "./world.ts";

export { type Answer, type Judged, judgeWithLimits, judgeWithout, roundStateOf } from "./intern.ts";
export { positionResult } from "./position.ts";

/**
 * The round loop of the simulated coin, one round at a time as 01 §5 runs it: the opening (income, then pending money
 * becomes coins, waiting rank changes take effect, the rewards tick), the opening phase (people pay in, cash out,
 * lock, vote, guess), the proposal window (src/sim/intern.ts: the Intern's answers, judged by runner/src/rules.ts),
 * the hold (people may still cash out), the close (each bet settles on real Hyperliquid prices). Every cash-out has a
 * moment in the round, so it lands before, during or after the proposal as it would. Pure: no node: imports, no
 * clock; every random number comes from the seed.
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
  /** PROPOSALS switched on (src/sim/proposals.ts); none means today's rules. They apply with the limits on only. */
  proposals?: Proposals;
  /** ABUSE TESTS: a griefer cashing out a few cents every round; a vote sniper. */
  griefer?: GrieferInputs | null;
  sniper?: SniperInputs | null;
  /** Keep every judged proposal (tests re-judge them with runner/src/rules.ts). */
  audit?: boolean;
}

/** Before the first round: fake accounts (if any) first in line, then any griefer, the first bosses, the jackpot seed. */
export function setUp(w: World, cfg: SimConfig): void {
  if (cfg.fakes) addFakes(w, cfg.fakes);
  if (cfg.griefer) addGriefer(w);
  startCommunity(w, cfg.community, streamFor(cfg.seed, "start"));
}

/** Runs `cfg.rounds` rounds from a fresh coin, or from `start` (the projection's synthesized state). */
export function runSim(cfg: SimConfig, start?: World): World {
  const w = start ?? newWorld(cfg.audit ?? false, cfg.arm === "limits" ? cfg.proposals : undefined);
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
  openProposals(w);
  settleJackpots(w.rewards, r);
  const rule: DrawRule = {};
  if (w.proposals.lowest_balance) rule.lowest = (id) => w.ps.period_low.get(id);
  if (w.proposals.dollar_draw) rule.withReplacement = true;
  if (holdDraw(w.rewards, r, (id) => usdOfId(w, id), rng("draw"), rule)) {
    countFakeShare(w);
    if (w.proposals.lowest_balance)
      for (const id of w.rewards.entrants) w.ps.period_low.set(id, usdOfId(w, id));
  }

  // The opening phase: votes whose time is up, then what people do before guesses close and proposals open.
  finishDue(w);
  arrivals(w, cfg.community, rng("arrivals"), rpd);
  locks(w, cfg.community);
  if (cfg.whale) whaleActs(w, cfg.whale, rpd);
  if (cfg.sniper) sniperActs(w, cfg.sniper, rpd);
  if (cfg.run) planRun(w, cfg.run, rng("run"), rpd, cfg.clock);
  const plan = planCashOuts(w, cfg.community, rng("cashouts"), rpd, cfg.clock);
  const grief = cfg.griefer ? grieferPlan(w, cfg.griefer, cfg.clock) : null;
  if (grief) plan.push(grief);
  cashOutsDue(w, plan, cfg.clock.propose_from_ms);
  tips(w, cfg.community, rng("tips"), rpd);
  communityVotes(w, cfg.community, rng("votes"), rpd);
  drawEntries(w);
  if (cfg.fakes) fakeGuesses(w, rng("fakes"));
  communityGuesses(w, cfg.community, rng("guesses"));

  // The proposal window: cash-outs while the model answers land before the proposal (src/sim/intern.ts).
  propose(w, cfg, round, rng("intern"), plan, k);

  // The hold: anyone leaving now gives up their share of the margin out on the open bets (01 §9.1, 1.1).
  cashOutsDue(w, plan, cfg.clock.close_from_ms);

  // The close: every bet settles; then the rest of the round, and the lender's interest for it goes to the draw.
  settle(w, cfg, round, k);
  cashOutsDue(w, plan, cfg.clock.round_ms);
  lend(w, cfg.clock);
  record(w, rpd);
}

// ---------------------------------------------------------------- PROPOSALS at the opening and the close

/** At the opening: PROPOSAL c decides whether this round's limits are shrunk; b counts halted rounds; f2 notes balances. */
function openProposals(w: World): void {
  const p = w.proposals;
  if (w.ps.halt_high === 0n) w.ps.halt_high = coinPriceE6(w.pot);
  if (p.drawdown_halt !== null && w.ps.halted) w.pc.rounds_halted += 1;
  if (p.record_gate !== null) {
    const lost = -w.ps.recent.reduce((s, x) => s + x, 0n);
    w.ps.gated = lost * BPS > w.pot.brave_total * BigInt(p.record_gate.poor_bps);
    if (w.ps.gated) w.pc.rounds_gated += 1;
  }
  if (p.held_across) for (const a of w.accounts) w.ps.at_open.set(a.id, usdOf(w.pot, a));
}

/**
 * PROPOSAL d: coins bought at the coin price and burned. In a pool where every coin can be cashed out at its share of
 * the pool, the sellers are holders: here each holder sells a sliver of its unlocked coins, in proportion, at that
 * price. The supply and the pool shrink together; the coin price does not move.
 */
function buyAndBurn(w: World, budget: bigint): void {
  const held = w.pot.brave_total - w.pot.in_play;
  if (budget <= 0n || held <= 0n || w.pot.supply === 0n) return;
  const want = (budget * w.pot.supply) / held;
  let free = 0n;
  for (const a of w.accounts) free += freeCoins(a);
  if (free === 0n) return;
  for (const a of w.accounts) {
    const f = freeCoins(a);
    const coins = (want * f) / free;
    if (coins === 0n) continue;
    w.pc.burn_spent += cashOutBrave(w.pot, a, coins);
    w.pc.burned_coins += coins;
  }
}

/** After the close: PROPOSAL b halts new bets once the coin price falls far enough below its high. */
function haltCheck(w: World): void {
  const h = w.proposals.drawdown_halt;
  if (h === null || w.ps.halted || w.status !== "EMPLOYED") return;
  const price = coinPriceE6(w.pot);
  if (price > w.ps.halt_high) w.ps.halt_high = price;
  if (price * BPS <= w.ps.halt_high * (BPS - BigInt(h.fall_bps))) {
    w.ps.halted = true;
    w.ps.halted_round = w.round;
    w.pc.halts += 1;
  }
}

// ---------------------------------------------------------------- settling

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
  let cut = 0n;
  if (result > 0n && round.playbook_active) {
    cut = (result * BigInt(COACH_CUT_BPS)) / BPS;
    w.pot.brave_total -= cut;
    c.coach_cut += cut;
  }
  const burn = w.proposals.buy_burn;
  if (burn !== null && result > 0n) {
    const share = ((result - cut) * BigInt(burn.share_bps)) / BPS;
    const cap = (w.pot.brave_total * BigInt(burn.cap_bps)) / BPS;
    // biome-ignore lint/complexity/useMathMinMax: these are bigints, and Math.min throws on bigint.
    buyAndBurn(w, share < cap ? share : cap);
  }
  if (w.proposals.record_gate !== null) {
    w.ps.recent.push(result);
    if (w.ps.recent.length > w.proposals.record_gate.rounds) w.ps.recent.shift();
  }
  if (result < 0n && round.brave_at_open > 0n) {
    const loss = -result;
    c.worst_loss_bps = Math.max(c.worst_loss_bps, Number((loss * BPS) / round.brave_at_open));
    if (round.limit_bps > 0) {
      const ratio = Number((loss * BPS * 1_000_000n) / (round.brave_at_open * BigInt(round.limit_bps))) / 1e6;
      c.worst_loss_vs_limit = Math.max(c.worst_loss_vs_limit, ratio);
    }
  }
  haltCheck(w);
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
  // PROPOSAL f1: each account's balance at every round end (the last 7 kept), and the lowest of the draw period.
  if (w.proposals.lowest_balance) {
    for (const a of w.accounts) {
      const x = usdOf(w.pot, a);
      const list = w.ps.balances.get(a.id) ?? [];
      list.push(x);
      if (list.length > REWARDS.min_boss_rounds) list.shift();
      w.ps.balances.set(a.id, list);
      const low = w.ps.period_low.get(a.id);
      if (low !== undefined && x < low) w.ps.period_low.set(a.id, x);
    }
  }
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
