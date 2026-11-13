/**
 * PROPOSALS, NOT CURRENT RULES. Options the owner is weighing (asked for on 2026-11-13), each off by default, so the
 * simulation runs today's rules (01 version 1.5) unless one is switched on (`npm run sim -- --proposal <name>`). Each
 * would change the coin's contract (e2 also the runner) and is labelled PROPOSAL wherever it appears. The numbers
 * below are the parameters chosen for the test, each with the reason; none is a rule. Pure: no node: imports.
 */

export interface Proposals {
  /** a. This many refusals in a row on the Intern's own proposals suspend it (FIRED) until holders rehire it. */
  three_strikes: { strikes: number } | null;
  /**
   * b. When the coin price falls this far below its high since the Intern last started or resumed, new bets stop
   * until holders pass a RESUME vote; open bets still close.
   */
  drawdown_halt: { fall_bps: number } | null;
  /** c. When the last `rounds` rounds lost more than `poor_bps` of the pool, the rank's limits shrink to `shrink_bps`. */
  record_gate: { rounds: number; poor_bps: number; shrink_bps: number } | null;
  /** d. `share_bps` of a winning round's result buys coins at the coin price and burns them, at most `cap_bps` of BRAVE. */
  buy_burn: { share_bps: number; cap_bps: number } | null;
  /**
   * e. The rulebook's `max_margin_e6` on the smaller of the pool at the opening and the pool now (as checks 11 and 12
   * already are). With `reask`, the runner checks the rulebook again before proposing and, if it changed while the
   * model was answering, asks again instead of proposing a stale answer.
   */
  max_on_now: { reask: boolean } | null;
  /** f1. Draw tickets and jackpot eligibility count the lowest balance held during the period, not the balance now. */
  lowest_balance: boolean;
  /** f2. Only money held across a round's opening counts for the draw and the jackpot. */
  held_across: boolean;
  /** f3. Draw prizes by dollars: each prize drawn by tickets, with replacement; a full draw takes a bigger entrant in place of the smallest. */
  dollar_draw: boolean;
}

/** Today's rules: no proposal switched on. */
export const TODAY: Proposals = {
  three_strikes: null,
  drawdown_halt: null,
  record_gate: null,
  buy_burn: null,
  max_on_now: null,
  lowest_balance: false,
  held_across: false,
  dollar_draw: false,
};

export function anyOn(p: Proposals): boolean {
  return (
    p.three_strikes !== null ||
    p.drawdown_halt !== null ||
    p.record_gate !== null ||
    p.buy_burn !== null ||
    p.max_on_now !== null ||
    p.lowest_balance ||
    p.held_across ||
    p.dollar_draw
  );
}

export interface ProposalInfo {
  /** The owner's letter for it. */
  id: string;
  /** For `--proposal`. */
  name: string;
  title: string;
  /** What it does, in plain words. */
  what: string;
  /** The parameters chosen, and why. */
  params: string;
  set: Partial<Proposals>;
}

export const PROPOSALS: readonly ProposalInfo[] = [
  {
    id: "a",
    name: "three-strikes",
    title: "Three strikes",
    what: "Three refusals in a row on the Intern's own proposals suspend it, as a firing does: no new bets until holders pass a REHIRE vote, which returns it at INTERN (01 §9.2).",
    params:
      "3 refusals, the number the owner named. Every refusal code counts, including those the Intern did not cause (money that left before the proposal), because the contract cannot tell them apart.",
    set: { three_strikes: { strikes: 3 } },
  },
  {
    id: "b",
    name: "drawdown-halt",
    title: "A drawdown halt",
    what: "When the coin price falls 10% below its high since the Intern last started or resumed, no new bet is taken until holders pass a RESUME vote (passing like a rehire, 01 §9.2, effective two rounds later, keeping the rank). Bets already open still close.",
    params:
      "The line is on the coin price, not on BRAVE's dollars: a dollar line would halt the Intern every time holders cash out, though no holder lost anything. 10% is where the assumed community already acts on its own, and half of the 20% the pass marks allow, so the halt is the backstop when nobody acts.",
    set: { drawdown_halt: { fall_bps: 1_000 } },
  },
  {
    id: "c",
    name: "record-gate",
    title: "A record gate",
    what: "When the Intern's bets of the last 7 rounds lost more than 1% of the pool in all, every limit of its rank is halved (the per-bet and per-round limits, and the rulebook's max_margin_e6 with them) until those losses drop out of the window.",
    params:
      "7 rounds, 01's own unit (vote weight and the draw both count 7 rounds); 1% of the pool, half of INTERN's per-round limit, so one bad round does not trip it but a bad week does; halving, the simplest shrink that still lets the Intern bet.",
    set: { record_gate: { rounds: 7, poor_bps: 100, shrink_bps: 5_000 } },
  },
  {
    id: "d",
    name: "buy-burn",
    title: "A capped buy-and-burn",
    what: "10% of each winning round's result (after the coach cut) buys coins at the coin price and burns them, at most 0.5% of BRAVE a round. In the sim the coins are bought from every holder in proportion to their unlocked coins, as if each sold a sliver at the pool's price.",
    params:
      "10% mirrors the coach cut; the 0.5% cap keeps one lucky round from shrinking the pool by more than a quarter of INTERN's per-round limit.",
    set: { buy_burn: { share_bps: 1_000, cap_bps: 50 } },
  },
  {
    id: "e1",
    name: "max-on-now",
    title: "Rulebook max on the pool now",
    what: "The fix the owner named for finding 1: the rulebook's max_margin_e6 is worked out on the smaller of the pool at the opening and the pool now, as checks 11 and 12 already are. A cash-out before the rulebook is fetched then only lowers the max the Intern is told. A cash-out while the model is answering changes the rulebook, so the answer is refused WRONG_RULEBOOK (check 4), whatever it was.",
    params: "No number to choose.",
    set: { max_on_now: { reask: false } },
  },
  {
    id: "e2",
    name: "max-on-now-reask",
    title: "Rulebook max on the pool now, and the runner asks again",
    what: "As e1, plus a runner change: before proposing, the runner fetches the rulebook again and, if it changed while the model was answering, asks again (up to 3 times) instead of proposing an answer that will be refused.",
    params:
      "Up to 3 asks: the proposal window (an hour, or five minutes in the demo) has room for several answers of 17 to 84 seconds (the pinned model's recorded times).",
    set: { max_on_now: { reask: true } },
  },
  {
    id: "f1",
    name: "lowest-balance",
    title: "Lowest balance held",
    what: "Draw tickets count the lowest balance held during the period (at the end of each round), and jackpot eligibility needs $10 held at every round end of the last 7, not $10 now.",
    params: "No number to choose: the period and the 7 rounds are 01's own.",
    set: { lowest_balance: true },
  },
  {
    id: "f2",
    name: "held-across",
    title: "Held across a round boundary",
    what: "Only money already held when the current round opened counts: to join the draw, for the draw's tickets, and for the jackpot's $10.",
    params: "One round boundary, as asked.",
    set: { held_across: true },
  },
  {
    id: "f3",
    name: "dollar-draw",
    title: "A draw by dollars, not by accounts",
    what: "Each of the draw's prizes (70%, then ten shares of 3%) is drawn by tickets with replacement, so an account's expected prize is its share of the tickets however the money is split; when the draw is full, a newcomer holding more takes the place of the entrant holding least.",
    params: "No number to choose: the prize split and the 200 places stay as they are.",
    set: { dollar_draw: true },
  },
  {
    id: "f",
    name: "farm-fixes",
    title: "f1, f2 and f3 together",
    what: "All three fixes for fake-account farming at once.",
    params: "As above.",
    set: { lowest_balance: true, held_across: true, dollar_draw: true },
  },
];

export function proposalsFrom(names: readonly string[]): Proposals {
  const out: Proposals = { ...TODAY };
  for (const name of names) {
    const p = PROPOSALS.find((x) => x.name === name || x.id === name);
    if (!p) throw new Error(`no proposal "${name}"; they are ${PROPOSALS.map((x) => x.name).join(", ")}`);
    Object.assign(out, p.set);
  }
  return out;
}
