import { coinPriceE6, lockedOf } from "./ledger.ts";
import {
  canFinishEarly,
  cannotOpen,
  effectiveRound,
  isTightening,
  outcome,
  passed,
  type Vote,
  type VoteKind,
  weightOf,
} from "./votes.ts";
import type { World } from "./world.ts";

/** Votes on the simulated coin: opening, casting, finishing and taking effect (01 §9.2, §9.5). Pure. */

/**
 * Opens a vote: only a boss with locked coins, one open vote per kind, and the opening rules of 01 §9.2 (1.1).
 * Returns null when the vote cannot be opened.
 */
export function openVote(w: World, kind: VoteKind, openerId: string): Vote | null {
  const opener = w.byId.get(openerId);
  if (!opener || lockedOf(opener) === 0n) return null;
  if (w.votes.some((v) => v.state === "OPEN" && v.kind === kind)) return null;
  const waiting = kind === "SET_PLAYBOOK" ? w.playbook.waiting_round !== null : w.waiting !== null;
  if (cannotOpen(kind, w.rank, w.status, waiting) !== null) return null;
  let total = 0n;
  for (const a of w.accounts) total += weightOf(a.lots, w.round);
  const own = weightOf(opener.lots, w.round);
  const vote: Vote = {
    id: w.votes.length + 1,
    kind,
    opened_by: openerId,
    opened_round: w.round,
    closes_round: w.round + 1,
    yes: 0n,
    no: 0n,
    locked_weight_at_open: total,
    voters: new Set(),
    state: "OPEN",
    effective_round: null,
    opener_share_bps: total === 0n ? 0 : Number((own * 10_000n) / total),
  };
  w.votes.push(vote);
  return vote;
}

/**
 * One boss's vote, once per vote (01 §9.2). Its weight counts only coins locked before the vote opened and still
 * locked now. A demote or fire vote finishes the moment it has passed (1.1, 1.2).
 */
export function cast(w: World, vote: Vote, voterId: string, support: boolean): void {
  const a = w.byId.get(voterId);
  if (vote.state !== "OPEN" || vote.voters.has(voterId) || !a || lockedOf(a) === 0n) return;
  const weight = weightOf(a.lots, vote.opened_round);
  vote.voters.add(voterId);
  if (support) vote.yes += weight;
  else vote.no += weight;
  if (canFinishEarly(vote.kind, vote)) finish(w, vote, w.round);
}

/** Every open vote whose time is up. Called in each round's opening phase, before any proposal. */
export function finishDue(w: World): void {
  for (const v of w.votes) if (v.state === "OPEN" && v.closes_round <= w.round) finish(w, v, w.round);
}

/**
 * Finishes a vote in `round` (01 §9.2, 1.1). Demote and fire act at once and cancel a promotion still waiting;
 * promote, rehire and set playbook wait for the second round to open after it.
 */
export function finish(w: World, vote: Vote, round: number): void {
  if (vote.state !== "OPEN") return;
  if (!passed(vote.kind, vote)) {
    vote.state = "FAILED";
    w.failed_round[vote.kind] = round;
    return;
  }
  vote.state = "PASSED";
  const eff = effectiveRound(vote.kind, round);
  vote.effective_round = eff;
  if (vote.kind === "SET_PLAYBOOK") {
    w.playbook.waiting_round = eff;
  } else if (isTightening(vote.kind)) {
    if (w.waiting?.kind === "PROMOTE") w.waiting = null;
    changeRank(w, vote.kind, round);
  } else {
    w.waiting = { kind: vote.kind === "REHIRE" ? "REHIRE" : "PROMOTE", effective_round: eff };
  }
}

/** At a round's opening: a waiting promotion, rehire or playbook whose round has come takes effect. */
export function applyWaiting(w: World): void {
  if (w.waiting && w.waiting.effective_round <= w.round) {
    const kind = w.waiting.kind;
    w.waiting = null;
    changeRank(w, kind, w.round);
  }
  if (w.playbook.waiting_round !== null && w.playbook.waiting_round <= w.round) {
    w.playbook.active = true;
    w.playbook.waiting_round = null;
  }
}

function changeRank(w: World, kind: VoteKind, round: number): void {
  const next = outcome(kind, w.rank, w.status);
  const from = w.status === "FIRED" ? "FIRED" : w.rank;
  const to = next.status === "FIRED" ? "FIRED" : next.rank;
  w.rank = next.rank;
  w.status = next.status;
  if (from === to) return;
  w.counters.rank_changes.push({ round, from, to, by: kind });
  w.change_round = round;
  const price = coinPriceE6(w.pot);
  w.price_at_change = price;
  w.price_high = price;
  w.fired_round = next.status === "FIRED" ? round : null;
}
