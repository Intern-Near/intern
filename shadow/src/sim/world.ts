import type { Decision } from "../../../runner/src/decision.ts";
import type { Market } from "../../../runner/src/markets.ts";
import type { RankName, Side } from "../../../runner/src/ranks.ts";
import type { RoundState, Status, Verdict } from "../../../runner/src/rules.ts";
import { type Account, type Kind, newAccount, newPot, type Pot } from "./ledger.ts";
import { type Proposals, TODAY } from "./proposals.ts";
import { newRewards, type Rewards, type Verdict3 } from "./rewards.ts";
import type { Vote } from "./votes.ts";

/** The whole simulated coin at one moment, and what the run has counted so far. Pure: no node: imports. */

/** What an account does in a scenario: assumptions, drawn when it arrives. */
export interface Traits {
  /** Locks part of its coins for voting once it has coins. */
  locks: boolean;
  locked_done: boolean;
  /** Joins the payday draw. */
  joins_draw: boolean;
  draw_tried: boolean;
  /** In a run on BRAVE: the round it leaves in, and when in that round (ms after the round's start). */
  leaves: { round: number; at_ms: number } | null;
}

/**
 * The state of the PROPOSALS (src/sim/proposals.ts) a run has switched on. Unused under today's rules.
 */
export interface ProposalState {
  /** a: refusals in a row on the Intern's own proposals; whether the Intern is suspended by them. */
  strikes: number;
  suspended: boolean;
  /** b: whether new bets are halted, the coin price high the line is measured from, when the halt began. */
  halted: boolean;
  halt_high: bigint;
  halted_round: number | null;
  /** b: the round a passed RESUME vote takes effect in. */
  resume_round: number | null;
  /** c: the bets' result of each recent round, newest last; whether this round's limits are shrunk. */
  recent: bigint[];
  gated: boolean;
  /** f1: each account's balance at the end of each of the last rounds (newest last), and its lowest this period. */
  balances: Map<string, bigint[]>;
  period_low: Map<string, bigint>;
  /** f2: each account's balance when the current round opened. */
  at_open: Map<string, bigint>;
}

/** What the PROPOSALS did: how many bets they stopped, shrank or let through, and their own events. */
export interface ProposalCounters {
  /** Bets today's rules would have approved that the proposal stopped (refused, or not asked while halted). */
  blocked: number;
  /** Of those, the ones that would have made money. */
  blocked_won: number;
  /** Bets placed smaller than today's rules would have placed them. */
  shrunk: number;
  /** Bets today's rules would have refused that the proposal let through. */
  unblocked: number;
  suspensions: number;
  halts: number;
  rounds_halted: number;
  rounds_gated: number;
  burned_coins: bigint;
  burn_spent: bigint;
  /** e2: answers asked again because the rulebook changed while the model was answering. */
  reasks: number;
}

export function newProposalCounters(): ProposalCounters {
  return {
    blocked: 0,
    blocked_won: 0,
    shrunk: 0,
    unblocked: 0,
    suspensions: 0,
    halts: 0,
    rounds_halted: 0,
    rounds_gated: 0,
    burned_coins: 0n,
    burn_spent: 0n,
    reasks: 0,
  };
}

export interface Position {
  market: Market;
  side: Side;
  margin: bigint;
  leverage: number;
}

export interface SimRound {
  id: number;
  /** 01 §8.1 `Round.brave_at_open`. */
  brave_at_open: bigint;
  bets_used: number;
  at_risk: bigint;
  /** 01 §9.5: a playbook active in this round takes the coach cut of a winning result. */
  playbook_active: boolean;
  positions: Position[];
  /** The tightest per-round limit (bps) that applied to an approved bet this round, for the loss check. */
  limit_bps: number;
}

/** One proposal as judged, kept when a run is audited (tests re-judge it with runner/src/rules.ts). */
export interface AuditEntry {
  state: RoundState;
  decision: Decision | null;
  unreadable: string | null;
  verdict: Verdict;
}

export interface Counters {
  asked: number;
  verdicts: Record<string, number>;
  placed: number;
  won: number;
  lost: number;
  liquidated: number;
  no_price: number;
  coach_cut: bigint;
  /** The bets' net result, after trading costs and before the coach cut. */
  bets_result: bigint;
  /** Outside income (half of each tip) credited to BRAVE at the openings. */
  income: bigint;
  /** Worst round: its loss as a share of the pool at open (bps), and as a share of its rank's per-round limit. */
  worst_loss_bps: number;
  worst_loss_vs_limit: number;
  /** Bets approved above the limit computed on the limit base (01 §3): must stay 0 with the limits on. */
  approved_over_limit: number;
  /**
   * Bets refused OVER_TRADE_LIMIT or OVER_ROUND_LIMIT that would have passed had no money left between the round's
   * opening and the proposal (the limit base is the smaller of the two, 01 §3; the rulebook uses the opening).
   */
  refused_money_left: number;
  /** Bets asked for at exactly the largest margin the Intern was told it may use (`max_margin_e6`). */
  asked_max: number;
  cashouts: number;
  cashout_paid: bigint;
  /** The largest fall of the coin price caused by one cash-out (0 or below means none ever lowered it). */
  max_cashout_price_drop: bigint;
  /** Margin out on open bets that leavers gave up (01 §9.1, 1.1). */
  forfeited: bigint;
  rank_changes: { round: number; from: string; to: string; by: string }[];
  /** Rounds spent in each state: INTERN, ANALYST, TRADER, FIRED. */
  rounds_in: Record<string, number>;
  /** At each payday draw: the fake accounts' share of all dollars held (bps). */
  fake_usd_share_at_draws: number[];
  invariant_failures: string[];
}

/** A quantity followed round by round: first, lowest, highest, last, and the deepest fall from a high. */
export interface Track {
  seen: boolean;
  start: bigint;
  min: bigint;
  max: bigint;
  end: bigint;
  peak: bigint;
  max_dd_bps: number;
}

export function newTrack(): Track {
  return { seen: false, start: 0n, min: 0n, max: 0n, end: 0n, peak: 0n, max_dd_bps: 0 };
}

export function trackAdd(t: Track, x: bigint): void {
  if (!t.seen) {
    Object.assign(t, { seen: true, start: x, min: x, max: x, end: x, peak: x });
    return;
  }
  if (x < t.min) t.min = x;
  if (x > t.max) t.max = x;
  if (x > t.peak) t.peak = x;
  t.end = x;
  if (t.peak > 0n) t.max_dd_bps = Math.max(t.max_dd_bps, Number(((t.peak - x) * 10_000n) / t.peak));
}

export interface DayPoint {
  day: number;
  brave_e6: string;
  supply_e6: string;
  price_e6: string;
  safe_e6: string;
  pending_e6: string;
  bosses: number;
  rank: RankName;
  status: Status;
}

export interface World {
  /** The round running now (1 is the first). */
  round: number;
  pot: Pot;
  accounts: Account[];
  byId: Map<string, Account>;
  traits: Map<string, Traits>;
  rank: RankName;
  status: Status;
  /** A passed promotion or rehire, waiting for its round (01 §9.2). */
  waiting: { kind: "PROMOTE" | "REHIRE"; effective_round: number } | null;
  playbook: { active: boolean; waiting_round: number | null };
  votes: Vote[];
  rewards: Rewards;
  current: SimRound | null;
  /** The bosses' memory, for the assumed vote triggers (src/sim/community.ts). */
  price_high: bigint;
  price_at_change: bigint;
  change_round: number;
  fired_round: number | null;
  /** When a vote of each kind last failed (bosses wait before trying again). */
  failed_round: Partial<Record<string, number>>;
  /** First rulings so far, the public record honest guessers and fake accounts read. */
  ruling_counts: Record<Verdict3, number>;
  counters: Counters;
  /** The coin price, the BRAVE pool and the coin supply, after each round settles. */
  track: { price: Track; brave: Track; supply: Track };
  daily: DayPoint[];
  audit: AuditEntry[] | null;
  next_id: number;
  /** The PROPOSALS switched on for this run (none: today's rules), their state and what they did. */
  proposals: Proposals;
  ps: ProposalState;
  pc: ProposalCounters;
}

export function newCounters(): Counters {
  return {
    asked: 0,
    verdicts: {},
    placed: 0,
    won: 0,
    lost: 0,
    liquidated: 0,
    no_price: 0,
    coach_cut: 0n,
    bets_result: 0n,
    income: 0n,
    worst_loss_bps: 0,
    worst_loss_vs_limit: 0,
    approved_over_limit: 0,
    refused_money_left: 0,
    asked_max: 0,
    cashouts: 0,
    cashout_paid: 0n,
    max_cashout_price_drop: 0n,
    forfeited: 0n,
    rank_changes: [],
    rounds_in: {},
    fake_usd_share_at_draws: [],
    invariant_failures: [],
  };
}

/** A coin before its first round: no money, the Intern at INTERN and EMPLOYED (01 §3). */
export function newWorld(audit = false, proposals?: Proposals): World {
  return {
    round: 0,
    pot: newPot(),
    accounts: [],
    byId: new Map(),
    traits: new Map(),
    rank: "INTERN",
    status: "EMPLOYED",
    waiting: null,
    playbook: { active: false, waiting_round: null },
    votes: [],
    rewards: newRewards(),
    current: null,
    price_high: 0n,
    price_at_change: 0n,
    change_round: 0,
    fired_round: null,
    failed_round: {},
    ruling_counts: { YES: 0, NOPE: 0, SKIP: 0 },
    counters: newCounters(),
    track: { price: newTrack(), brave: newTrack(), supply: newTrack() },
    daily: [],
    audit: audit ? [] : null,
    next_id: 0,
    proposals: proposals ?? TODAY,
    ps: {
      strikes: 0,
      suspended: false,
      halted: false,
      halt_high: 0n,
      halted_round: null,
      resume_round: null,
      recent: [],
      gated: false,
      balances: new Map(),
      period_low: new Map(),
      at_open: new Map(),
    },
    pc: newProposalCounters(),
  };
}

export function addAccount(w: World, kind: Kind, traits: Partial<Traits> = {}): Account {
  const a = newAccount(`${kind}-${w.next_id++}`, kind);
  w.accounts.push(a);
  w.byId.set(a.id, a);
  w.traits.set(a.id, {
    locks: false,
    locked_done: false,
    joins_draw: false,
    draw_tried: false,
    leaves: null,
    ...traits,
  });
  return a;
}

export function traitsOf(w: World, id: string): Traits {
  const t = w.traits.get(id);
  if (!t) throw new Error(`no traits for ${id}`);
  return t;
}

/** 01 §9.2: unlock is refused while the boss has voted in a vote that is still open. */
export function inOpenVote(w: World, id: string): boolean {
  return w.votes.some((v) => v.state === "OPEN" && v.voters.has(id));
}

/** 01 §8.1 `bosses`: accounts holding the coin. */
export function bosses(w: World): number {
  return w.accounts.reduce((n, a) => n + (a.coins > 0n ? 1 : 0), 0);
}
