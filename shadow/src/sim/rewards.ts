import type { Rng } from "./rng.ts";
import { BPS, REWARDS } from "./rules01.ts";

/**
 * The parts of the reward ladder (01 §9.7, 1.4) the scenarios need: the free guess (R1), golden stickers (R2, counted
 * only), the streak jackpot (R3) and the payday draw (R4); and where their money comes from: half of each tip
 * (01 §9.5), direct additions, the lender's interest (01 §9.6). Every prize comes from those; no coin is minted and
 * nothing is taken from the pools (01 §9.7). Where 01 does not spell out the mechanics the owner's contract
 * (crates/coin/src/rewards.rs) is followed, and the comment says so. Pure: no node: imports.
 */

export type Verdict3 = "YES" | "NOPE" | "SKIP";
export const VERDICTS: readonly Verdict3[] = ["YES", "NOPE", "SKIP"];

export interface Player {
  points: number;
  right: number;
  wrong: number;
  streak: number;
  best: number;
  /** This round's guess, or one still waiting for its round's ruling. */
  last: { round: number; guess: Verdict3 } | null;
  goldens: number;
}

export interface DrawEntry {
  since_round: number;
  /** The dollars the tickets count for this period: held when it began, or when joining (01 §9.7). */
  base_usd: bigint;
}

export interface DrawResult {
  period: number;
  held_in_round: number;
  prize: bigint;
  winner: string | null;
  winner_prize: bigint;
  runners_up: string[];
  each: bigint;
  tickets_total: bigint;
}

export interface Rewards {
  jackpot: bigint;
  jackpot_from_tips: bigint;
  jackpot_added: bigint;
  draw_pot: bigint;
  draw_period: number;
  interest_total: bigint;
  /** In the order they joined; at most `max_entrants`. */
  entrants: string[];
  entries: Map<string, DrawEntry>;
  /** Each round's first ruling: the guesses are judged on it (01 §9.7). */
  verdicts: Map<number, Verdict3>;
  /** Eligible accounts on six right in a row that guessed in a round: if right, they win that round's jackpot. */
  candidates: Map<number, { id: string; guess: Verdict3 }[]>;
  jackpot_done_round: number;
  golden_minted: number[];
  players: Map<string, Player>;
  /** Prizes credited to each account, by source. Claiming is not modeled: a credited prize counts as won. */
  prizes: { draw: Map<string, bigint>; jackpot: Map<string, bigint> };
  guesses: Map<string, number>;
  draws: DrawResult[];
  jackpot_wins: { round: number; winners: string[]; each: bigint }[];
  /** Accounts refused a place in the draw because it was full. */
  refused_full: string[];
  /** PROPOSAL f3: entrants who lost their place to a newcomer holding more. */
  bumped: string[];
}

export function newRewards(): Rewards {
  return {
    jackpot: 0n,
    jackpot_from_tips: 0n,
    jackpot_added: 0n,
    draw_pot: 0n,
    draw_period: 0,
    interest_total: 0n,
    entrants: [],
    entries: new Map(),
    verdicts: new Map(),
    candidates: new Map(),
    jackpot_done_round: 0,
    golden_minted: new Array(REWARDS.golden_codes).fill(0),
    players: new Map(),
    prizes: { draw: new Map(), jackpot: new Map() },
    guesses: new Map(),
    draws: [],
    jackpot_wins: [],
    refused_full: [],
    bumped: [],
  };
}

export function playerOf(rw: Rewards, id: string): Player {
  let p = rw.players.get(id);
  if (!p) {
    p = { points: 0, right: 0, wrong: 0, streak: 0, best: 0, last: null, goldens: 0 };
    rw.players.set(id, p);
  }
  return p;
}

/**
 * Settles a player's last guess once its round has a ruling (01 §9.7): right adds a point and grows the streak, wrong
 * resets it; a round that ended with no ruling counts for nothing; a round not guessed leaves the streak as it was.
 * A streak that reaches seven starts again (the contract's reading: crates/coin/src/rewards.rs; 01 does not say).
 */
export function resolveGuess(rw: Rewards, p: Player, currentRound: number): void {
  if (!p.last) return;
  const v = rw.verdicts.get(p.last.round);
  if (v !== undefined) {
    if (v === p.last.guess) {
      p.points += 1;
      p.right += 1;
      p.streak += 1;
      p.best = Math.max(p.best, p.streak);
      if (p.streak >= REWARDS.jackpot_streak) p.streak = 0;
    } else {
      p.wrong += 1;
      p.streak = 0;
    }
    p.last = null;
  } else if (p.last.round < currentRound) {
    p.last = null;
  }
}

/**
 * R1, a free guess, once per round before the guess closes (01 §9.7). `eligible`: the account holds at least $10
 * and became a boss at least 7 rounds ago (R3), checked when the guess is made, as the contract does. R2: a 1 in 50
 * chance of a golden sticker of one of the sixteen codes, at most 100 of each code ever.
 */
export function guess(
  rw: Rewards,
  id: string,
  round: number,
  verdict: Verdict3,
  eligible: boolean,
  rng: Rng,
): void {
  const p = playerOf(rw, id);
  resolveGuess(rw, p, round);
  if (p.last) return; // already guessed this round
  if (p.streak === REWARDS.jackpot_streak - 1 && eligible) {
    const list = rw.candidates.get(round) ?? [];
    list.push({ id, guess: verdict });
    rw.candidates.set(round, list);
  }
  p.last = { round, guess: verdict };
  rw.guesses.set(id, (rw.guesses.get(id) ?? 0) + 1);
  if (rng.int(REWARDS.golden_odds) === 0) {
    const code = rng.int(REWARDS.golden_codes);
    const minted = rw.golden_minted[code] ?? REWARDS.golden_cap;
    if (minted < REWARDS.golden_cap) {
      rw.golden_minted[code] = minted + 1;
      p.goldens += 1;
    }
  }
}

/** The round's first ruling decides its guesses; later rulings do not (01 §9.7). */
export function ruling(rw: Rewards, round: number, verdict: Verdict3): void {
  if (!rw.verdicts.has(round)) rw.verdicts.set(round, verdict);
}

function credit(rw: Rewards, source: "draw" | "jackpot", id: string, amount: bigint): void {
  const book = rw.prizes[source];
  if (amount > 0n) book.set(id, (book.get(id) ?? 0n) + amount);
}

/** Half of every tip goes to the jackpot (01 §9.5, 1.4); the other half is returned, for the BRAVE pool's income. */
export function tip(rw: Rewards, amount: bigint): bigint {
  const toJackpot = (amount * BigInt(REWARDS.tip_to_jackpot_bps)) / BPS;
  rw.jackpot += toJackpot;
  rw.jackpot_from_tips += toJackpot;
  return amount - toJackpot;
}

/** A direct addition to the jackpot: the team's seed or a gift (01 §9.7). */
export function addToJackpot(rw: Rewards, amount: bigint): void {
  rw.jackpot += amount;
  rw.jackpot_added += amount;
}

/** The lender's interest is held for the payday draw, not added to the pool (01 §9.6, 1.4). */
export function collectInterest(rw: Rewards, amount: bigint): void {
  rw.draw_pot += amount;
  rw.interest_total += amount;
}

/**
 * Jackpots of closed rounds (the runner's rewards_tick each round, 01 §9.7): everyone who completed seven in a row
 * in the same round splits it equally; the rounding dust rolls over.
 */
export function settleJackpots(rw: Rewards, currentRound: number): void {
  for (let r = rw.jackpot_done_round + 1; r < currentRound; r++) {
    const list = rw.candidates.get(r);
    const v = rw.verdicts.get(r);
    rw.candidates.delete(r);
    if (list && v !== undefined) {
      const winners = list.filter((c) => c.guess === v).map((c) => c.id);
      if (winners.length > 0 && rw.jackpot > 0n) {
        const each = rw.jackpot / BigInt(winners.length);
        for (const w of winners) credit(rw, "jackpot", w, each);
        rw.jackpot -= each * BigInt(winners.length);
        rw.jackpot_wins.push({ round: r, winners, each });
      }
    }
    rw.jackpot_done_round = r;
  }
}

export type EntryResult = "IN" | "ALREADY" | "FULL" | "NO_MONEY";

/**
 * R4, joining the draw: a boss with money, at most 200 entrants (01 §9.7). PROPOSAL f3 (`sizeOf` given): when the draw
 * is full, a newcomer holding more takes the place of the entrant holding least, who leaves the draw.
 */
export function enterDraw(
  rw: Rewards,
  id: string,
  usd: bigint,
  round: number,
  sizeOf?: (id: string) => bigint,
): EntryResult {
  if (rw.entries.has(id)) return "ALREADY";
  if (usd <= 0n) return "NO_MONEY";
  if (rw.entrants.length >= REWARDS.max_entrants) {
    let smallest: string | null = null;
    let least = 0n;
    if (sizeOf) {
      for (const e of rw.entrants) {
        const x = sizeOf(e);
        if (smallest === null || x < least) {
          smallest = e;
          least = x;
        }
      }
    }
    if (smallest === null || usd <= least) {
      rw.refused_full.push(id);
      return "FULL";
    }
    rw.entrants = rw.entrants.filter((e) => e !== smallest);
    rw.entries.delete(smallest);
    rw.bumped.push(smallest);
  }
  rw.entrants.push(id);
  rw.entries.set(id, { since_round: round, base_usd: usd });
  return "IN";
}

/** One weighted pick; the picked account is taken out unless `keep` (PROPOSAL f3: drawing with replacement). */
function pick(weights: [string, bigint][], rng: Rng, keep = false): string | null {
  const total = weights.reduce((s, [, w]) => s + w, 0n);
  if (total === 0n) return null;
  let x = (BigInt(Math.floor(rng.next() * 2 ** 32)) * total) >> 32n;
  for (let i = 0; i < weights.length; i++) {
    const entry = weights[i];
    if (!entry) break;
    if (x < entry[1]) {
      if (!keep) weights.splice(i, 1);
      return entry[0];
    }
    x -= entry[1];
  }
  return null;
}

/**
 * R4, the payday draw (01 §9.7), held by the first rewards_tick after its period: period p is rounds 7p + 1 to 7p + 7.
 * A boss's tickets are the smaller of the dollars held when the period began (or when joining) and at the draw,
 * times the rounds of the period they were in. 70% to one winner and the rest shared equally by up to 10
 * runners-up; alone, the winner takes all; with no tickets or no interest the pot rolls over. Winners are picked in
 * proportion to tickets, each account at most once, and an entrant holding nothing leaves the draw: the contract's
 * reading (crates/coin/src/rewards.rs `rw_draw`), as 01 does not say how the tickets are drawn.
 */
export interface DrawRule {
  /** PROPOSAL f1: an entrant's lowest balance this period; its tickets count no more than that. */
  lowest?: (id: string) => bigint | undefined;
  /** PROPOSAL f3: every prize drawn by tickets with replacement, so an account may win several. */
  withReplacement?: boolean;
}

export function holdDraw(
  rw: Rewards,
  currentRound: number,
  usdOf: (id: string) => bigint,
  rng: Rng,
  rule: DrawRule = {},
): DrawResult | null {
  const p = rw.draw_period;
  const start = p * REWARDS.draw_rounds + 1;
  const end = (p + 1) * REWARDS.draw_rounds;
  if (currentRound <= end) return null;
  const weights: [string, bigint][] = [];
  const gone = new Set<string>();
  for (const id of rw.entrants) {
    const e = rw.entries.get(id);
    if (!e) continue;
    const now = usdOf(id);
    const rounds = BigInt(Math.max(0, end + 1 - Math.max(start, e.since_round)));
    // biome-ignore lint/complexity/useMathMinMax: these are bigints, and Math.min throws on bigint.
    let base = e.base_usd < now ? e.base_usd : now;
    const low = rule.lowest?.(id);
    if (low !== undefined && low < base) base = low;
    if (base * rounds > 0n) weights.push([id, base * rounds]);
    if (now === 0n) gone.add(id);
    else e.base_usd = now; // the next period counts from what is held now
  }
  if (gone.size > 0) {
    rw.entrants = rw.entrants.filter((id) => !gone.has(id));
    for (const id of gone) rw.entries.delete(id);
  }
  const prize = rw.draw_pot;
  const total = weights.reduce((s, [, w]) => s + w, 0n);
  const result: DrawResult = {
    period: p,
    held_in_round: currentRound,
    prize,
    winner: null,
    winner_prize: 0n,
    runners_up: [],
    each: 0n,
    tickets_total: total,
  };
  const keep = rule.withReplacement === true;
  const winner = total > 0n && prize > 0n ? pick(weights, rng, keep) : null;
  if (winner !== null) {
    const runners: string[] = [];
    while (runners.length < REWARDS.draw_runners) {
      const r = pick(weights, rng, keep);
      if (r === null) break;
      runners.push(r);
    }
    const top = (prize * BigInt(REWARDS.draw_top_bps)) / BPS;
    const winnerPrize = runners.length === 0 ? prize : top;
    const each = runners.length === 0 ? 0n : (prize - top) / BigInt(runners.length);
    credit(rw, "draw", winner, winnerPrize);
    for (const r of runners) credit(rw, "draw", r, each);
    rw.draw_pot -= winnerPrize + each * BigInt(runners.length);
    Object.assign(result, { winner, winner_prize: winnerPrize, runners_up: runners, each });
  }
  rw.draws.push(result);
  rw.draw_period = p + 1;
  return result;
}
