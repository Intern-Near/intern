import type { Ms, Phase, Round, Status } from "../chain/types";

/** The phase right now, from the round's own times. Polls are seconds apart; the clock is not. */
export function phaseAt(round: Round, now: Ms): Phase {
  if (now >= round.close_from) return "CLOSE";
  if (now >= round.propose_until) return "HOLD";
  if (now >= round.propose_from) return "PROPOSE";
  return "OPEN";
}

export type NextMoment = { label: string; at: Ms | null };

/** What the big countdown counts to, and what happens at zero. */
export function nextMoment(round: Round, now: Ms, status: Status = round.status): NextMoment {
  if (status === "FIRED") return { label: "No bets. The Intern is fired", at: null };
  if (round.settled) return { label: "Next shift starts in", at: round.ends_at };
  if (!round.settled && now > round.ends_at) return { label: "Round is stuck. A bet is still open", at: null };
  switch (phaseAt(round, now)) {
    case "OPEN":
      return { label: "Today's bet in", at: round.propose_from };
    case "PROPOSE":
      return { label: "Betting window closes in", at: round.propose_until };
    case "HOLD":
      return { label: "Bets close in", at: round.close_from };
    case "CLOSE":
      return { label: "Shift ends in", at: round.ends_at };
  }
}

/** Today's shift as four steps. Returns how many are done and which is current (0–3). */
export function shiftStep(round: Round, now: Ms): number {
  if (round.settled) return 4;
  return { OPEN: 0, PROPOSE: 1, HOLD: 2, CLOSE: 3 }[phaseAt(round, now)];
}
