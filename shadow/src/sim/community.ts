import { cast, openVote } from "./ballots.ts";
import {
  type Account,
  cashOutBrave,
  coinPriceE6,
  freeCoins,
  lock,
  lockedOf,
  payIn,
  takeBackPending,
  unlock,
  usdOf,
} from "./ledger.ts";
import {
  addToJackpot,
  enterDraw,
  guess,
  playerOf,
  resolveGuess,
  tip,
  VERDICTS,
  type Verdict3,
} from "./rewards.ts";
import type { Rng } from "./rng.ts";
import type { RoundClock } from "./rules01.ts";
import { REWARDS } from "./rules01.ts";
import type { VoteKind } from "./votes.ts";
import { addAccount, inOpenVote, traitsOf, type World } from "./world.ts";

/**
 * What the people around the coin do. EVERY number in this file is a scenario input, an assumption, not a contract
 * rule: nobody has measured how bosses behave. The report prints them with each scenario. Pure: no node: imports.
 */

/** Dollars to whole units with 6 decimals. */
export function usd(x: number): bigint {
  return BigInt(Math.round(x * 1e6));
}

export interface CommunityInputs {
  /** Bosses who pay in before the first round. */
  start_bosses: number;
  /** Each one's deposit, in dollars, spread evenly on a log scale between the two. */
  start_deposit_usd: [number, number];
  /** Share of each deposit put in BRAVE (the dial); the rest goes to SAFE. */
  brave_share: number;
  /** New bosses a day (on average). */
  new_bosses_per_day: number;
  deposit_usd: [number, number];
  /** Chance a boss cashes out some coins on a given day. */
  cash_out_per_day: number;
  /** Share of their unlocked coins they cash out when they do. */
  cash_out_share: [number, number];
  /**
   * Whether cash-outs come at any moment of the round (true) or only after the round's bets have closed (false).
   * Money that leaves between the opening and the proposal shrinks the limit base under the rulebook's
   * `max_margin_e6` (01 §3, §6.1), so a bet of exactly that size is refused; money that leaves while bets are open
   * leaves its share of their margin to those who stay (01 §9.1, 1.1). Both spare the pool. The stress scenarios set
   * false, so that every bet the limits allow goes through and nobody's leaving lifts the coin price.
   */
  cash_out_any_time: boolean;
  /** Share of bosses who lock coins to vote, and the share of their coins they lock. */
  lock_share: number;
  lock_fraction: number;
  /** Whether ordinary bosses open and cast votes at all. */
  votes: boolean;
  /** Chance a boss with locked coins casts a vote that is open. */
  turnout: number;
  /** Chance a voter says yes, by kind of vote. */
  yes_promote: number;
  yes_tighten: number;
  yes_rehire: number;
  yes_playbook: number;
  /** A promotion is opened after this many days at a rank, if the coin is worth more than when the rank began. */
  promote_after_days: number;
  /** A demotion (or a firing, at INTERN) is opened when the coin falls this far below its high at this rank. */
  fire_drawdown_bps: number;
  /** A rehire is opened this many days after a firing. */
  rehire_after_days: number;
  /** After a vote of a kind fails, the bosses wait this long before opening another. */
  retry_after_days: number;
  /** The day a playbook vote is opened (null: never). */
  playbook_day: number | null;
  /** Chance a boss makes the free guess in a round. */
  guess_share: number;
  /** Share of bosses who join the payday draw. */
  draw_join_share: number;
  /** Tips a day, in dollars, made as tips of `tip_usd` each. */
  tips_per_day_usd: number;
  tip_usd: number;
  /** The team's seed for the streak jackpot. */
  jackpot_seed_usd: number;
}

/** The plain-words meaning of each input, for the report. */
export const COMMUNITY_TEXT: Record<keyof CommunityInputs, string> = {
  start_bosses: "bosses who pay in before the first round",
  start_deposit_usd: "their deposits, dollars (spread evenly on a log scale)",
  brave_share: "share of each deposit put in BRAVE (the rest in SAFE)",
  new_bosses_per_day: "new bosses a day, on average",
  deposit_usd: "new bosses' deposits, dollars",
  cash_out_per_day: "chance a boss cashes out on a given day",
  cash_out_share: "share of their unlocked coins they cash out then",
  cash_out_any_time:
    "cash-outs come at any moment of the round (false: only after the round's bets have closed)",
  lock_share: "share of bosses who lock coins to vote",
  lock_fraction: "share of their coins they lock",
  votes: "ordinary bosses open and cast votes",
  turnout: "chance a boss with locked coins votes in an open vote",
  yes_promote: "chance a voter says yes to a promotion",
  yes_tighten: "chance a voter says yes to a demotion or firing",
  yes_rehire: "chance a voter says yes to a rehire",
  yes_playbook: "chance a voter says yes to a playbook",
  promote_after_days:
    "a promotion is opened after this many days at a rank, if the coin is worth more than when the rank began",
  fire_drawdown_bps:
    "a demotion (a firing at INTERN) is opened when the coin falls this far below its high at this rank, bps",
  rehire_after_days: "a rehire is opened this many days after a firing",
  retry_after_days: "days the bosses wait after a failed vote before opening another of that kind",
  playbook_day: "the day a playbook vote is opened",
  guess_share: "chance a boss makes the free guess in a round",
  draw_join_share: "share of bosses who join the payday draw",
  tips_per_day_usd: "tips a day, dollars",
  tip_usd: "size of each tip, dollars",
  jackpot_seed_usd: "the team's seed for the streak jackpot, dollars",
};

/** The baseline community. Every number is an assumption; the jackpot seed is the live testnet coin's (2026-11-13). */
export const BASELINE_COMMUNITY: CommunityInputs = {
  start_bosses: 20,
  start_deposit_usd: [50, 2_000],
  brave_share: 0.7,
  new_bosses_per_day: 3,
  deposit_usd: [20, 1_000],
  cash_out_per_day: 0.02,
  cash_out_share: [0.5, 1],
  cash_out_any_time: true,
  lock_share: 0.5,
  lock_fraction: 0.5,
  votes: true,
  turnout: 0.5,
  yes_promote: 0.6,
  yes_tighten: 0.8,
  yes_rehire: 0.6,
  yes_playbook: 0.7,
  promote_after_days: 7,
  fire_drawdown_bps: 1_000,
  rehire_after_days: 3,
  retry_after_days: 2,
  playbook_day: 3,
  guess_share: 0.5,
  draw_join_share: 0.5,
  tips_per_day_usd: 10,
  tip_usd: 2,
  jackpot_seed_usd: 100,
};

/** One whale who votes alone: holds `share_of_locked` of the coins locked when he arrives, and locks them all. */
export interface WhaleInputs {
  share_of_locked: number;
  /** He opens a vote to fire the Intern every this many days, besides a promotion whenever one can be opened. */
  fire_every_days: number;
  /** ABUSE TEST: he also votes in a playbook of his own, so the 10% coach cut of winning rounds goes to him (01 §9.5). */
  own_playbook?: boolean;
}

/**
 * ABUSE TEST: a griefer, a holder who cashes out coins worth `usd` every round, either a minute before the proposal
 * window (`before`) or a few seconds after the runner has fetched the rulebook (`in-flight`).
 */
export interface GrieferInputs {
  usd: number;
  at: "before" | "in-flight";
}

/**
 * ABUSE TEST: a vote sniper: arrives on `day`, buys `share_of_locked` of the coins then locked, locks them as soon as it
 * holds them, and opens a vote to fire the Intern every round, voting yes alone.
 */
export interface SniperInputs {
  day: number;
  share_of_locked: number;
}

/** Fake accounts: each registered, holding a little BRAVE (to be a boss) and enough SAFE to be jackpot-eligible. */
export interface FakeInputs {
  count: number;
  brave_usd: number;
  safe_usd: number;
}

/** A run on BRAVE: from `day`, for `days` days, each boss holding coins leaves with chance `share`. */
export interface RunInputs {
  day: number;
  days: number;
  share: number;
}

// ---------------------------------------------------------------- money

function arrive(w: World, inputs: CommunityInputs, rng: Rng, range: readonly [number, number]): Account {
  const a = addAccount(w, "boss", {
    locks: rng.chance(inputs.lock_share),
    joins_draw: rng.chance(inputs.draw_join_share),
  });
  const total = usd(rng.logUniform(range[0], range[1]));
  const brave = (total * BigInt(Math.round(inputs.brave_share * 10_000))) / 10_000n;
  payIn(w.pot, a, "BRAVE", brave);
  payIn(w.pot, a, "SAFE", total - brave);
  return a;
}

/** Before the first round: the first bosses pay in (their BRAVE becomes coins at round 1's opening) and the seed. */
export function startCommunity(w: World, inputs: CommunityInputs, rng: Rng): void {
  for (let i = 0; i < inputs.start_bosses; i++) arrive(w, inputs, rng, inputs.start_deposit_usd);
  if (inputs.jackpot_seed_usd > 0) addToJackpot(w.rewards, usd(inputs.jackpot_seed_usd));
}

export function arrivals(w: World, inputs: CommunityInputs, rng: Rng, roundsPerDay: number): void {
  const n = rng.poisson(inputs.new_bosses_per_day / roundsPerDay);
  for (let i = 0; i < n; i++) arrive(w, inputs, rng, inputs.deposit_usd);
}

/** Bosses who lock do it once, in the first round they hold coins (01 §9.2). */
export function locks(w: World, inputs: CommunityInputs): void {
  for (const a of w.accounts) {
    const t = traitsOf(w, a.id);
    if (a.kind !== "boss" || !t.locks || t.locked_done || a.coins === 0n) continue;
    lock(a, (freeCoins(a) * BigInt(Math.round(inputs.lock_fraction * 10_000))) / 10_000n, w.round);
    t.locked_done = true;
  }
}

/** A BRAVE cash-out (01 §9.1), counted: what it paid, the price before and after, the margin in play left behind. */
export function cashOutCounted(w: World, a: Account, coins: bigint): void {
  if (coins <= 0n) return;
  const c = w.counters;
  const before = coinPriceE6(w.pot);
  const forfeit = w.pot.supply === 0n ? 0n : (w.pot.in_play * coins) / w.pot.supply;
  c.cashout_paid += cashOutBrave(w.pot, a, coins);
  c.cashouts += 1;
  c.forfeited += forfeit;
  const drop = before - coinPriceE6(w.pot);
  if (c.cashouts === 1 || drop > c.max_cashout_price_drop) c.max_cashout_price_drop = drop;
}

/** One cash-out planned for a round: who, when (ms after the round's start), and how much. */
export interface CashOutPlan {
  id: string;
  at_ms: number;
  /** A share of the account's unlocked coins, in bps; or, when `usd_e6` is set, coins worth that many dollars. */
  share_bps: number;
  usd_e6?: bigint;
  done: boolean;
}

/**
 * Who cashes out this round, and when: each boss at a random moment of the round (before the proposal window, while
 * the model is answering, during the hold or after the close), or only after the close when `cash_out_any_time` is
 * false. Every boss draws the same numbers whatever its state, so a run and its control stay in step.
 */
export function planCashOuts(
  w: World,
  inputs: CommunityInputs,
  rng: Rng,
  roundsPerDay: number,
  clock: RoundClock,
): CashOutPlan[] {
  const chance = inputs.cash_out_per_day / roundsPerDay;
  const plan: CashOutPlan[] = [];
  for (const a of w.accounts) {
    if (a.kind !== "boss") continue;
    const roll = rng.next();
    const when = rng.next();
    const share = rng.between(inputs.cash_out_share[0], inputs.cash_out_share[1]);
    const at = inputs.cash_out_any_time ? Math.floor(when * clock.round_ms) : clock.round_ms - 1;
    if (roll < chance) plan.push({ id: a.id, at_ms: at, share_bps: Math.round(share * 10_000), done: false });
  }
  return plan;
}

/** Coins worth `usdE6` at the coin price (at least one unit), never more than `max`. */
function coinsWorth(w: World, usdE6: bigint, max: bigint): bigint {
  const h = w.pot.brave_total - w.pot.in_play;
  const coins = h > 0n ? (usdE6 * w.pot.supply) / h : 0n;
  const atLeastOne = coins > 0n ? coins : 1n;
  return atLeastOne < max ? atLeastOne : max;
}

/**
 * Every planned cash-out, and every run-on-BRAVE leaver, due before `untilMs` in this round, each once. Returns how
 * many took money out of BRAVE.
 */
export function cashOutsDue(w: World, plan: readonly CashOutPlan[], untilMs: number): number {
  let n = 0;
  for (const p of plan) {
    if (p.done || p.at_ms >= untilMs) continue;
    p.done = true;
    const a = w.byId.get(p.id);
    if (!a) continue;
    const coins =
      p.usd_e6 !== undefined
        ? coinsWorth(w, p.usd_e6, freeCoins(a))
        : (freeCoins(a) * BigInt(p.share_bps)) / 10_000n;
    if (coins > 0n) {
      cashOutCounted(w, a, coins);
      n += 1;
    }
  }
  for (const a of w.accounts) {
    const t = traitsOf(w, a.id);
    if (!t.leaves || t.leaves.round !== w.round || t.leaves.at_ms >= untilMs) continue;
    // A leaver takes everything out of BRAVE: unlock (refused while they voted in an open vote, 01 §9.2), pending, coins.
    if (!inOpenVote(w, a.id)) unlock(a, lockedOf(a));
    takeBackPending(w.pot, a, a.pending);
    if (freeCoins(a) > 0n) {
      cashOutCounted(w, a, freeCoins(a));
      n += 1;
    }
    t.leaves = null;
  }
  return n;
}

/** Tips: half to the jackpot, half to BRAVE at the next opening (01 §9.5 1.4, §9.6). The contract takes tips while FIRED too. */
export function tips(w: World, inputs: CommunityInputs, rng: Rng, roundsPerDay: number): void {
  if (inputs.tip_usd <= 0) return;
  const n = rng.poisson(inputs.tips_per_day_usd / inputs.tip_usd / roundsPerDay);
  for (let i = 0; i < n; i++) w.pot.income_waiting += tip(w.rewards, usd(inputs.tip_usd));
}

// ---------------------------------------------------------------- votes

/**
 * The ordinary bosses' votes (the triggers are assumptions): fire or demote after the coin fell `fire_drawdown_bps`
 * below its high at this rank; promote after `promote_after_days` at a rank if the coin is worth more than when the
 * rank began; rehire `rehire_after_days` after a firing; the playbook on `playbook_day`. A random boss with locked
 * coins opens the vote and votes yes; the others vote with chance `turnout`.
 */
export function communityVotes(w: World, inputs: CommunityInputs, rng: Rng, roundsPerDay: number): void {
  if (!inputs.votes) return;
  const lockers = w.accounts.filter((a) => a.kind === "boss" && lockedOf(a) > 0n);
  if (lockers.length === 0) return;
  const price = coinPriceE6(w.pot);
  const intents: VoteKind[] = [];
  if (w.status === "FIRED") {
    if (w.fired_round !== null && w.round - w.fired_round >= inputs.rehire_after_days * roundsPerDay)
      intents.push("REHIRE");
  } else if (
    w.price_high > 0n &&
    price * 10_000n <= w.price_high * BigInt(10_000 - inputs.fire_drawdown_bps)
  ) {
    intents.push(w.rank === "INTERN" ? "FIRE" : "DEMOTE");
  } else if (
    w.rank !== "TRADER" &&
    w.round - w.change_round >= inputs.promote_after_days * roundsPerDay &&
    price > w.price_at_change
  ) {
    intents.push("PROMOTE");
  }
  if (inputs.playbook_day !== null && w.round === (inputs.playbook_day - 1) * roundsPerDay + 1) {
    intents.push("SET_PLAYBOOK");
  }
  // PROPOSAL b: the bosses open a RESUME vote as they would a rehire, `rehire_after_days` after a halt.
  const halt = w.ps;
  if (
    halt.halted &&
    halt.halted_round !== null &&
    halt.resume_round === null &&
    w.round - halt.halted_round >= inputs.rehire_after_days * roundsPerDay
  ) {
    intents.push("RESUME");
  }
  for (const kind of intents) {
    const failed = w.failed_round[kind];
    if (failed !== undefined && w.round - failed < inputs.retry_after_days * roundsPerDay) continue;
    const opener = rng.pick(lockers);
    const vote = openVote(w, kind, opener.id);
    if (!vote) continue;
    cast(w, vote, opener.id, true);
    const yesShare =
      kind === "PROMOTE"
        ? inputs.yes_promote
        : kind === "REHIRE" || kind === "RESUME"
          ? inputs.yes_rehire
          : kind === "SET_PLAYBOOK"
            ? inputs.yes_playbook
            : inputs.yes_tighten;
    for (const a of lockers) {
      const turns = rng.next();
      const yes = rng.next();
      if (a.id !== opener.id && turns < inputs.turnout) cast(w, vote, a.id, yes < yesShare);
    }
  }
}

/**
 * The whale votes alone. In round 1, after the first locks, he pays in enough that his coins will be
 * `share_of_locked` of the coins then locked; he locks all his coins once he has them; he opens a promotion whenever
 * one can be opened and a firing every `fire_every_days`, voting yes on both.
 */
export function whaleActs(w: World, whale: WhaleInputs, roundsPerDay: number): void {
  let a = w.accounts.find((x) => x.kind === "whale");
  if (!a) {
    if (w.round !== 1) return;
    const dollars = shareOfLocked(w, whale.share_of_locked);
    a = addAccount(w, "whale");
    payIn(w.pot, a, "BRAVE", dollars);
    return;
  }
  if (freeCoins(a) > 0n) lock(a, freeCoins(a), w.round);
  const promote = openVote(w, "PROMOTE", a.id);
  if (promote) cast(w, promote, a.id, true);
  if ((w.round - 1) % (whale.fire_every_days * roundsPerDay) === 0) {
    const fire = openVote(w, "FIRE", a.id);
    if (fire) cast(w, fire, a.id, true);
  }
  if (whale.own_playbook && !w.playbook.active) {
    const playbook = openVote(w, "SET_PLAYBOOK", a.id);
    if (playbook) cast(w, playbook, a.id, true);
  }
}

/** Sizes an attacker's deposit so that its coins will be `share` of all coins locked once it locks them. */
function shareOfLocked(w: World, share: number): bigint {
  const lockedNow = w.accounts.reduce((s, x) => s + lockedOf(x), 0n);
  const bps = BigInt(Math.round(share * 10_000));
  return (((lockedNow * bps) / (10_000n - bps)) * coinPriceE6(w.pot)) / 1_000_000n;
}

/** Before the first round: the griefer pays $100 into BRAVE, so it holds coins to cash out a sliver of each round. */
export function addGriefer(w: World): void {
  payIn(w.pot, addAccount(w, "griefer"), "BRAVE", usd(100));
}

/** The griefer's cash-out for this round. The runner fetches the rulebook one second into the window (runner/src/round.ts). */
export function grieferPlan(w: World, g: GrieferInputs, clock: RoundClock): CashOutPlan | null {
  const a = w.accounts.find((x) => x.kind === "griefer");
  if (!a || freeCoins(a) === 0n) return null;
  const at = g.at === "before" ? clock.propose_from_ms - 60_000 : clock.propose_from_ms + 5_000;
  return { id: a.id, at_ms: at, share_bps: 0, usd_e6: usd(g.usd), done: false };
}

/** The vote sniper (ABUSE TEST): arrives, locks everything as soon as it can, opens a firing every round. */
export function sniperActs(w: World, s: SniperInputs, roundsPerDay: number): void {
  let a = w.accounts.find((x) => x.kind === "sniper");
  if (!a) {
    if (w.round !== (s.day - 1) * roundsPerDay + 1) return;
    a = addAccount(w, "sniper");
    payIn(w.pot, a, "BRAVE", shareOfLocked(w, s.share_of_locked));
    return;
  }
  if (freeCoins(a) > 0n) lock(a, freeCoins(a), w.round);
  const fire = openVote(w, "FIRE", a.id);
  if (fire) cast(w, fire, a.id, true);
}

// ---------------------------------------------------------------- the run on BRAVE

/**
 * On the run's first round, each boss holding coins decides whether to leave (chance `share`), and when: a random
 * round of the run and a random moment of it (some leave while bets are open). `cashOutsDue` carries it out.
 */
export function planRun(w: World, run: RunInputs, rng: Rng, roundsPerDay: number, clock: RoundClock): void {
  if (w.round !== (run.day - 1) * roundsPerDay + 1) return;
  const span = run.days * roundsPerDay;
  for (const a of w.accounts) {
    const roll = rng.next();
    const whichRound = rng.next();
    const moment = rng.next();
    if (a.kind !== "boss" || a.coins === 0n || roll >= run.share) continue;
    traitsOf(w, a.id).leaves = {
      round: w.round + Math.floor(whichRound * span),
      at_ms: Math.floor(moment * clock.round_ms),
    };
  }
}

// ---------------------------------------------------------------- the reward ladder

/**
 * The dollars an account counts for the reward ladder now. Today (01 §9.7): BRAVE at today's value, pending, SAFE.
 * PROPOSAL f2: no more than it held when the current round opened.
 */
export function heldForRewards(w: World, a: Account): bigint {
  const now = usdOf(w.pot, a);
  if (!w.proposals.held_across) return now;
  const atOpen = w.ps.at_open.get(a.id) ?? 0n;
  // biome-ignore lint/complexity/useMathMinMax: these are bigints, and Math.min throws on bigint.
  return atOpen < now ? atOpen : now;
}

/**
 * R3 eligibility (01 §9.7, §14.15): became a boss at least 7 rounds ago and holds at least $10 now. PROPOSAL f1: the
 * $10 must also have been held at the end of each of the last 7 rounds.
 */
export function jackpotEligible(w: World, a: Account): boolean {
  if (a.joined_round === null || a.joined_round + REWARDS.min_boss_rounds > w.round) return false;
  let held = heldForRewards(w, a);
  if (w.proposals.lowest_balance) {
    for (const x of w.ps.balances.get(a.id) ?? []) if (x < held) held = x;
  }
  return held >= REWARDS.min_boss_usd_e6;
}

/**
 * Bosses who join the draw try once, as soon as they hold money; a full draw turns them away (01 §9.7). PROPOSAL f3:
 * a full draw takes a newcomer holding more in place of the entrant holding least.
 */
export function drawEntries(w: World): void {
  for (const a of w.accounts) {
    const t = traitsOf(w, a.id);
    if (!t.joins_draw || t.draw_tried) continue;
    const held = heldForRewards(w, a);
    if (held === 0n) continue;
    t.draw_tried = true;
    if (w.proposals.lowest_balance) w.ps.period_low.set(a.id, held);
    enterDraw(w.rewards, a.id, held, w.round, w.proposals.dollar_draw ? (id) => heldOf(w, id) : undefined);
  }
}

function heldOf(w: World, id: string): bigint {
  const a = w.byId.get(id);
  return a ? heldForRewards(w, a) : 0n;
}

/** The Intern's most common first ruling so far (a guesser's sensible pick); a random one before any ruling. */
export function mostCommonRuling(w: World, rng: Rng): Verdict3 {
  let best: Verdict3 | null = null;
  for (const v of VERDICTS) {
    if (w.ruling_counts[v] > 0 && (best === null || w.ruling_counts[v] > w.ruling_counts[best])) best = v;
  }
  return best ?? rng.pick(VERDICTS);
}

/** Ordinary bosses (and the whale) guess with chance `guess_share`, picking the Intern's most common first ruling. */
export function communityGuesses(w: World, inputs: CommunityInputs, rng: Rng): void {
  const pick = mostCommonRuling(w, rng);
  for (const a of w.accounts) {
    if (a.kind === "fake") continue;
    if (rng.next() < inputs.guess_share) guess(w.rewards, a.id, w.round, pick, jackpotEligible(w, a), rng);
  }
}

/** Before the first round: the fake accounts register and pay in. They are first in line for everything. */
export function addFakes(w: World, f: FakeInputs): void {
  for (let i = 0; i < f.count; i++) {
    const a = addAccount(w, "fake", { joins_draw: true });
    payIn(w.pot, a, "BRAVE", usd(f.brave_usd));
    payIn(w.pot, a, "SAFE", usd(f.safe_usd));
  }
}

/**
 * The fake accounts guess every round and cover the guess tree: the fakes on the same streak split their guesses
 * across the three verdicts in proportion to how often the Intern has ruled each (plus one), so that some of them
 * are always right. A script reading the public feed can do this.
 */
export function fakeGuesses(w: World, rng: Rng): void {
  const groups = new Map<number, Account[]>();
  for (const a of w.accounts) {
    if (a.kind !== "fake") continue;
    const p = playerOf(w.rewards, a.id);
    resolveGuess(w.rewards, p, w.round);
    if (p.last) continue;
    const list = groups.get(p.streak) ?? [];
    list.push(a);
    groups.set(p.streak, list);
  }
  const weights = VERDICTS.map((v) => w.ruling_counts[v] + 1);
  const total = weights.reduce((s, x) => s + x, 0);
  for (const members of groups.values()) {
    // Largest remainder: each verdict gets its share of this streak's fakes.
    const exact = weights.map((x) => (x * members.length) / total);
    const counts = exact.map(Math.floor);
    let left = members.length - counts.reduce((s, x) => s + x, 0);
    const order = exact.map((x, i) => [x - Math.floor(x), i] as const).sort((p, q) => q[0] - p[0]);
    for (const [, i] of order) {
      if (left === 0) break;
      counts[i] = (counts[i] ?? 0) + 1;
      left -= 1;
    }
    let k = 0;
    VERDICTS.forEach((v, i) => {
      for (let j = 0; j < (counts[i] ?? 0); j++) {
        const a = members[k++];
        if (a) guess(w.rewards, a.id, w.round, v, jackpotEligible(w, a), rng);
      }
    });
  }
}
