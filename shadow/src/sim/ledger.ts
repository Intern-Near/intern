import { LOCKED_FOREVER, MIN_FIRST_DEPOSIT_E6 } from "./rules01.ts";

/**
 * The coin's money, in whole dollars and coins with 6 decimals (01 §2: no floating point). The rules are 01 §5 and
 * §9.1; where 01 states a rule but not the arithmetic, the arithmetic is the owner's (crates/rules/src/shares.rs):
 * `coins = dollars × supply / pool` at a round's opening, `paid = held × coins / supply` at a cash-out, every division
 * rounded down so that rounding favours the pool (01 §2).
 *
 * Pure: no node: imports.
 */

export type Pool = "BRAVE" | "SAFE";
/** Who an account is in a scenario: an ordinary boss, the whale, a fake account, or an abuse test's attacker. */
export type Kind = "boss" | "whale" | "fake" | "griefer" | "sniper";

/** Coins locked for voting in one round (01 §9.2). */
export interface Lot {
  amount: bigint;
  round: number;
}

export interface Account {
  id: string;
  kind: Kind;
  /** Coins held, locked ones included (01 §8.1 `Account.coin`). */
  coins: bigint;
  /** Locked lots, oldest first; their sum is never above `coins`. */
  lots: Lot[];
  /** BRAVE dollars waiting for the next round (01 §5). */
  pending: bigint;
  /** SAFE dollars (01 §9.1). */
  safe: bigint;
  /** The first round this account held the coin (01 §8.1 `joined_round`). */
  joined_round: number | null;
  /** Dollars paid in and out, for the report. */
  paid_in: bigint;
  paid_out: bigint;
}

export interface Pot {
  /** 01 §8.1 `brave.total`: everything in BRAVE, margin out on open bets included. */
  brave_total: bigint;
  /** `brave.in_play`: margin out on open bets. */
  in_play: bigint;
  /** `brave.pending`: pay-ins waiting for the next round. */
  pending: bigint;
  /** `brave.income_waiting`: outside income (half of each tip) credited at the next opening (01 §9.6). */
  income_waiting: bigint;
  /** `coin_supply`. */
  supply: bigint;
  /** Coins that belong to nobody: the 1,000 units locked at the first conversion (01 §9.1) and rounding dust. */
  nobodys: bigint;
  /** `safe.total`. */
  safe_total: bigint;
}

export function newPot(): Pot {
  return {
    brave_total: 0n,
    in_play: 0n,
    pending: 0n,
    income_waiting: 0n,
    supply: 0n,
    nobodys: 0n,
    safe_total: 0n,
  };
}

export function newAccount(id: string, kind: Kind): Account {
  return {
    id,
    kind,
    coins: 0n,
    lots: [],
    pending: 0n,
    safe: 0n,
    joined_round: null,
    paid_in: 0n,
    paid_out: 0n,
  };
}

export function lockedOf(a: Account): bigint {
  return a.lots.reduce((s, l) => s + l.amount, 0n);
}

/** Coins that may be cashed out or locked: locked coins must be unlocked first. */
export function freeCoins(a: Account): bigint {
  return a.coins - lockedOf(a);
}

/** What the pool holds for its coins: everything except margin out on open bets (01 §9.1, 1.1). */
export function held(pot: Pot): bigint {
  return pot.brave_total > pot.in_play ? pot.brave_total - pot.in_play : 0n;
}

/** 01 §8.1 `coin_price_e6`: dollars per whole coin, leaving out margin in play; $1.00 before any coin exists. */
export function coinPriceE6(pot: Pot): bigint {
  return pot.supply === 0n ? 1_000_000n : (held(pot) * 1_000_000n) / pot.supply;
}

/** What `coins` would be paid now (01 §8.1 `brave_value`). */
export function braveValue(pot: Pot, coins: bigint): bigint {
  return coins === 0n || pot.supply === 0n ? 0n : (held(pot) * coins) / pot.supply;
}

/** The dollars an account holds, as the reward ladder counts them: BRAVE at today's value, pending, SAFE (01 §9.7). */
export function usdOf(pot: Pot, a: Account): bigint {
  return braveValue(pot, a.coins) + a.pending + a.safe;
}

/** 01 §9.1 pay in: SAFE is credited at once; BRAVE waits as pending until the next round opens. */
export function payIn(pot: Pot, a: Account, pool: Pool, amount: bigint): void {
  if (amount <= 0n) return;
  a.paid_in += amount;
  if (pool === "SAFE") {
    a.safe += amount;
    pot.safe_total += amount;
  } else {
    a.pending += amount;
    pot.pending += amount;
  }
}

export interface Opening {
  /** Outside income credited to BRAVE at this opening. */
  income: bigint;
  /** Coins minted for the pending money (0 when nothing converted). */
  minted: bigint;
}

/**
 * What a round's opening does with money (01 §5, §9.6): outside income is credited to BRAVE first, then pending
 * money becomes coins at the price of that moment. The first conversion ever must reach `min_first_deposit` and
 * locks 1,000 units for ever (01 §9.1). If the money would buy less than one coin unit, or the pool is empty while
 * coins exist, it keeps waiting (the owner's shares.rs: otherwise it would be handed to the old coins).
 */
export function openRound(pot: Pot, accounts: Iterable<Account>, round: number): Opening {
  const income = pot.income_waiting;
  pot.brave_total += income;
  pot.income_waiting = 0n;
  if (pot.pending === 0n) return { income, minted: 0n };

  let ratePool: bigint;
  let rateSupply: bigint;
  let minted: bigint;
  if (pot.supply === 0n) {
    if (pot.brave_total !== 0n || pot.pending < MIN_FIRST_DEPOSIT_E6 || pot.pending <= LOCKED_FOREVER) {
      return { income, minted: 0n };
    }
    // The first conversion: everyone converting shares the 1,000 locked units, which belong to nobody.
    ratePool = pot.pending;
    rateSupply = pot.pending - LOCKED_FOREVER;
    minted = pot.pending;
  } else {
    if (pot.brave_total === 0n) return { income, minted: 0n };
    ratePool = pot.brave_total;
    rateSupply = pot.supply;
    minted = (pot.pending * rateSupply) / ratePool;
    if (minted === 0n) return { income, minted: 0n };
  }
  let given = 0n;
  for (const a of accounts) {
    if (a.pending === 0n) continue;
    const coins = (a.pending * rateSupply) / ratePool;
    a.coins += coins;
    a.pending = 0n;
    given += coins;
    if (coins > 0n && a.joined_round === null) a.joined_round = round;
  }
  pot.brave_total += pot.pending;
  pot.pending = 0n;
  pot.supply += minted;
  // The locked units and each account's rounding dust: in the supply, held by nobody.
  pot.nobodys += minted - given;
  return { income, minted };
}

/**
 * 01 §9.1 cash out of BRAVE: burns the coins and pays their share of what the pool holds, leaving out margin on open
 * bets (1.1: someone who leaves during an open bet gives up their share of it). Never blocked (01 §5). Returns the
 * dollars paid.
 */
export function cashOutBrave(pot: Pot, a: Account, coins: bigint): bigint {
  if (coins <= 0n) return 0n;
  if (coins > freeCoins(a)) throw new Error(`${a.id}: cash-out of ${coins} coins, ${freeCoins(a)} free`);
  const paid = (held(pot) * coins) / pot.supply;
  pot.brave_total -= paid;
  pot.supply -= coins;
  a.coins -= coins;
  a.paid_out += paid;
  return paid;
}

/** 01 §9.1 cash out with `pending: true`: dollars taken back from money still waiting. */
export function takeBackPending(pot: Pot, a: Account, amount: bigint): bigint {
  const x = amount < a.pending ? amount : a.pending;
  a.pending -= x;
  pot.pending -= x;
  a.paid_out += x;
  return x;
}

/** 01 §9.1 turn the dial to SAFE: the same as cashing coins out of BRAVE and paying the dollars into SAFE. */
export function dialToSafe(pot: Pot, a: Account, coins: bigint): bigint {
  const paid = cashOutBrave(pot, a, coins);
  a.paid_out -= paid; // the money does not leave
  a.safe += paid;
  pot.safe_total += paid;
  return paid;
}

/** 01 §9.1 turn the dial to BRAVE: SAFE dollars become pending BRAVE money, coins at the next opening. */
export function dialToBrave(pot: Pot, a: Account, dollars: bigint): void {
  const x = dollars < a.safe ? dollars : a.safe;
  a.safe -= x;
  pot.safe_total -= x;
  a.pending += x;
  pot.pending += x;
}

/** 01 §9.2 lock: coins locked in a round form one lot; a second lock in the same round joins it. */
export function lock(a: Account, amount: bigint, round: number): void {
  if (amount <= 0n) return;
  if (amount > freeCoins(a)) throw new Error(`${a.id}: lock of ${amount}, ${freeCoins(a)} free`);
  const last = a.lots[a.lots.length - 1];
  if (last && last.round === round) last.amount += amount;
  else a.lots.push({ amount, round });
}

/**
 * 01 §9.2 unlock, newest lots first so the oldest keep their weight (the owner's reading, crates/coin/src/vote.rs).
 * The caller refuses it while the boss has voted in a vote that is still open (01 §9.2).
 */
export function unlock(a: Account, amount: bigint): void {
  let left = amount;
  while (left > 0n) {
    const last = a.lots[a.lots.length - 1];
    if (!last) throw new Error(`${a.id}: unlock of more than is locked`);
    if (last.amount <= left) {
      left -= last.amount;
      a.lots.pop();
    } else {
      last.amount -= left;
      left = 0n;
    }
  }
}
