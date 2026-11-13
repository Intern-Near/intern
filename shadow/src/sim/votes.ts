import type { RankName } from "../../../runner/src/ranks.ts";
import type { Status } from "../../../runner/src/rules.ts";
import type { Lot } from "./ledger.ts";
import { VOTE } from "./rules01.ts";

/**
 * The vote rules of 01 §9.2 (1.1, 1.2) and §9.5 (SET_PLAYBOOK). Where 01 is silent the owner's reading in
 * crates/rules/src/vote.rs is followed, and the comment says so. Pure: no node: imports.
 */

/**
 * 01 §8.1 `VoteKind`, without LONG_SHOT (the long shot is not modeled), plus RESUME: a PROPOSAL, not in 01, used only
 * by the drawdown halt (src/sim/proposals.ts b). It passes like a rehire and lifts the halt, keeping the rank.
 */
export type VoteKind = "PROMOTE" | "DEMOTE" | "FIRE" | "REHIRE" | "SET_PLAYBOOK" | "RESUME";

/** Demote and fire tighten: a lower bar, no quorum, effective at once (01 §9.2). */
export function isTightening(kind: VoteKind): boolean {
  return kind === "DEMOTE" || kind === "FIRE";
}

/**
 * 01 §9.2: "full rounds since they were locked". Coins locked while round L was running count, for a vote opened
 * while round V is running, the rounds strictly between: V − L − 1, never below 0 (crates/rules/src/vote.rs reads it
 * the same way).
 */
export function fullRounds(lockedRound: number, voteRound: number): number {
  return Math.max(0, voteRound - lockedRound - 1);
}

/**
 * 01 §9.2: weight = locked coins × min(full rounds since they were locked, 7) / 7. Lots locked in the vote's round
 * or later count zero ("coins locked after the vote opened count as zero"). Rounded down once over all of a boss's
 * lots, as the contract does.
 */
export function weightOf(lots: readonly Lot[], voteRound: number): bigint {
  const full = BigInt(VOTE.weight_full_rounds);
  let whole = 0n;
  let parts = 0n;
  for (const lot of lots) {
    const k = BigInt(Math.min(fullRounds(lot.round, voteRound), VOTE.weight_full_rounds));
    if (k === full) whole += lot.amount;
    else parts += lot.amount * k;
  }
  return whole + parts / full;
}

export interface Tally {
  yes: bigint;
  no: bigint;
  locked_weight_at_open: bigint;
}

const atLeast = (a: bigint, bps: number, b: bigint): boolean => a * 10_000n >= b * BigInt(bps);
const above = (a: bigint, bps: number, b: bigint): boolean => a * 10_000n > b * BigInt(bps);

/**
 * Whether a vote passed, judged at its close (01 §9.2, 1.1):
 * - promote, rehire, set playbook: yes above 50% of the weight that voted, and votes at least 20% of the weight locked
 *   when the vote opened;
 * - demote, fire (1.2): yes at least 34% of the weight locked when the vote opened; "no" votes do not count.
 * A vote in which no weight voted fails. 01 does not say this; by its letter a fire vote opened when no weight is
 * locked would pass with no votes (0 is at least 34% of 0). The owner's contract fails it
 * (crates/rules/src/vote.rs `passed`), and so does the sim.
 */
export function passed(kind: VoteKind, t: Tally): boolean {
  const voted = t.yes + t.no;
  if (voted === 0n) return false;
  if (isTightening(kind)) return atLeast(t.yes, VOTE.tighten_pass_bps, t.locked_weight_at_open);
  return (
    above(t.yes, VOTE.promote_pass_bps, voted) &&
    atLeast(voted, VOTE.promote_quorum_bps, t.locked_weight_at_open)
  );
}

/** 01 §9.2 (1.1, 1.2): a demote or fire vote may be finished the moment it has passed. */
export function canFinishEarly(kind: VoteKind, t: Tally): boolean {
  return isTightening(kind) && t.yes > 0n && atLeast(t.yes, VOTE.tighten_pass_bps, t.locked_weight_at_open);
}

/**
 * Why a vote of this kind cannot be opened now, or null (01 §9.2 1.1, §9.5). `changeWaiting`: a passed promotion or
 * rehire (for SET_PLAYBOOK: a playbook change) has not taken effect yet. 01 says this only for the playbook; for
 * promote and rehire it is the owner's reading (crates/rules/src/vote.rs `can_open`).
 */
export function cannotOpen(
  kind: VoteKind,
  rank: RankName,
  status: Status,
  changeWaiting: boolean,
): string | null {
  if (kind === "SET_PLAYBOOK") return changeWaiting ? "a playbook change is waiting" : null;
  // PROPOSAL b: the caller (src/sim/ballots.ts) allows RESUME only while bets are halted and no resume is waiting.
  if (kind === "RESUME") return changeWaiting ? "a resume is waiting" : null;
  if (kind === "REHIRE") {
    if (status !== "FIRED") return "rehire only while fired";
    return changeWaiting ? "a rehire is waiting" : null;
  }
  if (status !== "EMPLOYED") return "only while employed";
  if (kind === "PROMOTE" && rank === "TRADER") return "no rank above TRADER";
  if (kind === "PROMOTE" && changeWaiting) return "a promotion is waiting";
  if (kind === "DEMOTE" && rank === "INTERN") return "no rank below INTERN";
  return null;
}

/**
 * 01 §9.2: promote, rehire and set playbook take effect at the start of the second round to open after the vote
 * passed (one full round runs in between); demote and fire at once, in the round running when they passed.
 */
export function effectiveRound(kind: VoteKind, roundAtPass: number): number {
  return isTightening(kind) ? roundAtPass : roundAtPass + 2;
}

const ORDER: readonly RankName[] = ["INTERN", "ANALYST", "TRADER"];

/** 01 §9.2: promote moves up one rank, demote down one; fire sets FIRED; rehire returns at INTERN. */
export function outcome(kind: VoteKind, rank: RankName, status: Status): { rank: RankName; status: Status } {
  const i = ORDER.indexOf(rank);
  switch (kind) {
    case "PROMOTE":
      return { rank: ORDER[Math.min(i + 1, 2)] ?? rank, status };
    case "DEMOTE":
      return { rank: ORDER[Math.max(i - 1, 0)] ?? rank, status };
    case "FIRE":
      return { rank, status: "FIRED" };
    case "REHIRE":
      return { rank: "INTERN", status: "EMPLOYED" };
    case "SET_PLAYBOOK":
    case "RESUME":
      return { rank, status };
  }
}

/** One vote as the sim keeps it (the fields of 01 §8.1 `Vote` it needs, with rounds instead of times). */
export interface Vote {
  id: number;
  kind: VoteKind;
  opened_by: string;
  opened_round: number;
  /** `vote_ms` is one round length (01 §9.2): a vote opened in round r closes in round r + 1. */
  closes_round: number;
  yes: bigint;
  no: bigint;
  locked_weight_at_open: bigint;
  voters: Set<string>;
  state: "OPEN" | "PASSED" | "FAILED";
  effective_round: number | null;
  /** The opener's own weight as a share of the weight locked at the opening, in basis points (for the report). */
  opener_share_bps: number;
}
