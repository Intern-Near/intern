import type { Arm } from "./engine.ts";
import type { RunResult } from "./metrics.ts";
import { REGISTRATION_NEAR } from "./rules01.ts";
import { GLOBAL_MARKS, type PassMark, type Scenario } from "./scenarios.ts";

/** Many seeds of one scenario, summed up; and each pass mark checked on every seed. Pure. */

/** The middle seed, and the worst and best ones (which way is worse depends on the number). */
export interface Spread {
  median: number;
  worst: number;
  best: number;
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

function spread(xs: readonly number[], lowIsBad: boolean): Spread {
  if (xs.length === 0) return { median: 0, worst: 0, best: 0 };
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  return { median: median(xs), worst: lowIsBad ? lo : hi, best: lowIsBad ? hi : lo };
}

const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;

function addUp(target: Record<string, number>, source: Record<string, number>): void {
  for (const [k, n] of Object.entries(source)) target[k] = (target[k] ?? 0) + n;
}

export interface ArmSummary {
  arm: Arm;
  seeds: number;
  price: { start: number; min: Spread; end: Spread; floor_pct: Spread; drawdown_pct: Spread };
  brave: { start: number; min: Spread; end: Spread; drawdown_pct: Spread };
  supply: { start: number; min: number; max: number; end: Spread };
  /** Means per run. */
  bets: {
    asked: number;
    yes: number;
    skip: number;
    refused: number;
    refused_money_left: number;
    asked_max: number;
    not_placeable: number;
    liquidated: number;
  };
  /** Summed over all seeds. */
  refused_by_code: Record<string, number>;
  rank_changes: number;
  finals: Record<string, number>;
  rounds_in: Record<string, number>;
  votes_opened: Record<string, number>;
  votes_passed: Record<string, number>;
  worst_round_loss_pct: number;
  worst_loss_vs_limit: number;
  coach_cut: number;
  bets_result: Spread;
  income: number;
  cashouts: { count: number; paid: number; forfeited: number };
  rewards: {
    interest: number;
    draw_paid: { boss: number; whale: number; fake: number };
    jackpot_paid: { boss: number; whale: number; fake: number };
    guesses: { boss: number; whale: number; fake: number };
    goldens: { boss: number; whale: number; fake: number };
    refused_full: { boss: number; whale: number; fake: number };
    fake_usd_share_pct: number;
  };
  book_failures: number;
}

const kinds = (
  rs: readonly RunResult[],
  f: (r: RunResult) => { boss: number; whale: number; fake: number },
) => ({
  boss: mean(rs.map((r) => f(r).boss)),
  whale: mean(rs.map((r) => f(r).whale)),
  fake: mean(rs.map((r) => f(r).fake)),
});

export function summarizeArm(arm: Arm, runs: readonly RunResult[]): ArmSummary {
  const refusedByCode: Record<string, number> = {};
  const finals: Record<string, number> = {};
  const roundsIn: Record<string, number> = {};
  const opened: Record<string, number> = {};
  const passed: Record<string, number> = {};
  for (const r of runs) {
    addUp(refusedByCode, r.bets.refused);
    finals[r.rank.final] = (finals[r.rank.final] ?? 0) + 1;
    addUp(roundsIn, r.rank.rounds_in);
    addUp(opened, r.votes.opened);
    addUp(passed, r.votes.passed);
  }
  return {
    arm,
    seeds: runs.length,
    price: {
      start: median(runs.map((r) => r.price.start)),
      min: spread(
        runs.map((r) => r.price.min),
        true,
      ),
      end: spread(
        runs.map((r) => r.price.end),
        true,
      ),
      floor_pct: spread(
        runs.map((r) => r.metrics.price_floor_pct),
        true,
      ),
      drawdown_pct: spread(
        runs.map((r) => r.price.max_drawdown_pct),
        false,
      ),
    },
    brave: {
      start: median(runs.map((r) => r.brave.start)),
      min: spread(
        runs.map((r) => r.brave.min),
        true,
      ),
      end: spread(
        runs.map((r) => r.brave.end),
        true,
      ),
      drawdown_pct: spread(
        runs.map((r) => r.brave.max_drawdown_pct),
        false,
      ),
    },
    supply: {
      start: median(runs.map((r) => r.supply.start)),
      min: Math.min(...runs.map((r) => r.supply.min)),
      max: Math.max(...runs.map((r) => r.supply.max)),
      end: spread(
        runs.map((r) => r.supply.end),
        true,
      ),
    },
    bets: {
      asked: mean(runs.map((r) => r.bets.asked)),
      yes: mean(runs.map((r) => r.bets.yes)),
      skip: mean(runs.map((r) => r.bets.skip)),
      refused: mean(runs.map((r) => r.bets.refused_total)),
      refused_money_left: mean(runs.map((r) => r.bets.refused_money_left)),
      asked_max: mean(runs.map((r) => r.bets.asked_max)),
      not_placeable: mean(runs.map((r) => r.bets.not_placeable)),
      liquidated: mean(runs.map((r) => r.bets.liquidated)),
    },
    refused_by_code: refusedByCode,
    rank_changes: runs.reduce((s, r) => s + r.rank.changes.length, 0),
    finals,
    rounds_in: roundsIn,
    votes_opened: opened,
    votes_passed: passed,
    worst_round_loss_pct: Math.max(0, ...runs.map((r) => r.worst_round_loss_pct)),
    worst_loss_vs_limit: Math.max(0, ...runs.map((r) => r.worst_loss_vs_limit)),
    coach_cut: mean(runs.map((r) => r.coach_cut)),
    bets_result: spread(
      runs.map((r) => r.bets_result),
      true,
    ),
    income: mean(runs.map((r) => r.income)),
    cashouts: {
      count: mean(runs.map((r) => r.cashouts.count)),
      paid: mean(runs.map((r) => r.cashouts.paid)),
      forfeited: mean(runs.map((r) => r.cashouts.forfeited)),
    },
    rewards: {
      interest: mean(runs.map((r) => r.rewards.interest)),
      draw_paid: kinds(runs, (r) => r.rewards.draw_paid),
      jackpot_paid: kinds(runs, (r) => r.rewards.jackpot_paid),
      guesses: kinds(runs, (r) => r.rewards.guesses),
      goldens: kinds(runs, (r) => r.rewards.goldens),
      refused_full: kinds(runs, (r) => r.rewards.refused_full),
      fake_usd_share_pct: mean(runs.map((r) => r.rewards.fake_usd_share_pct)),
    },
    book_failures: runs.reduce((s, r) => s + r.invariant_failures.length, 0),
  };
}

export interface Check {
  pass: boolean;
  /** The worst seed's value. */
  worst: number;
  failed_seeds: number[];
  seeds: number;
}

/** A mark passes only if every seed passes it. */
export function check(mark: PassMark, runs: readonly RunResult[]): Check {
  const ok = (x: number): boolean => (mark.op === ">=" ? x >= mark.value : x <= mark.value);
  const values = runs.map((r) => r.metrics[mark.metric]);
  const failed = runs.filter((r) => !ok(r.metrics[mark.metric])).map((r) => r.seed);
  const worst = values.length === 0 ? 0 : mark.op === ">=" ? Math.min(...values) : Math.max(...values);
  return { pass: failed.length === 0, worst, failed_seeds: failed, seeds: runs.length };
}

export interface MarkOutcome {
  mark: PassMark;
  scenario: string;
  /** The verdict: the runs with the limits on. */
  limits: Check;
  /** The same mark on the runs with the limits off, for contrast (not a verdict). */
  control: Check | null;
}

export interface ScenarioResult {
  scenario: Scenario;
  limits: ArmSummary;
  control: ArmSummary;
  marks: MarkOutcome[];
  line: string;
  runs: RunResult[];
}

const pct = (x: number): string => `${x.toFixed(1)}%`;
const money = (x: number): string =>
  `${x < 0 ? "-" : ""}$${Math.abs(x).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

/** One plain line on what a scenario says, from its numbers. */
function lineFor(s: Scenario, lim: ArmSummary, ctl: ArmSummary, marks: MarkOutcome[]): string {
  const passed = marks.filter((m) => m.limits.pass).length;
  const base = `With the limits the coin price's deepest fall was ${pct(lim.price.drawdown_pct.worst)} in the worst seed (median ${pct(lim.price.drawdown_pct.median)}); with them off, ${pct(ctl.price.drawdown_pct.worst)} (median ${pct(ctl.price.drawdown_pct.median)}). ${passed} of ${marks.length} pass marks passed.`;
  switch (s.name) {
    case "losing-streak":
      return `${base} The bets' net result a run was ${money(lim.bets_result.median)} with the limits (worst seed ${money(lim.bets_result.worst)}) and ${money(ctl.bets_result.median)} without (worst ${money(ctl.bets_result.worst)}); tips added about ${money(lim.income)} a run either way.`;
    case "always-max": {
      const zero = lim.refused_by_code.ZERO_MARGIN ?? 0;
      const refusals =
        lim.bets.refused === 0
          ? "no ask was refused"
          : `${lim.bets.refused.toFixed(1)} asks a run were refused${zero > 0 ? ` (${zero} ZERO_MARGIN over all seeds: at TRADER two bets of 10% fill the round's 20%, so a third ask is for nothing)` : ""}`;
      return `${base} With the limits ${refusals}. Without them ${ctl.bets.liquidated.toFixed(1)} bets a run were liquidated, the worst round lost ${pct(ctl.worst_round_loss_pct)} of the pool, and once a pool is nearly empty new money buys coins for almost nothing, so the supply explodes (highest ${ctl.supply.max.toExponential(1)} coins).`;
    }
    case "baseline":
      return `${base} The Intern asked for exactly the rulebook's largest margin ${lim.bets.asked_max.toFixed(1)} times a run; ${lim.bets.refused_money_left.toFixed(1)} of those (of ${lim.bets.refused.toFixed(1)} refusals in all) were refused OVER_TRADE_LIMIT only because someone had cashed out between the round's opening and the proposal (01 §3 calls this rare).`;
    case "brave-run":
      return `${base} Cash-outs paid ${money(lim.cashouts.paid)} a run on average and left ${money(lim.cashouts.forfeited)} of margin on open bets to those who stayed; ${lim.bets.refused_money_left.toFixed(1)} bets a run were refused only because money left between the opening and the proposal.`;
    case "whale-alone":
      return `${base} Alone, the whale passed ${lim.votes_passed.PROMOTE ?? 0} promotions and ${(lim.votes_passed.FIRE ?? 0) + (lim.votes_passed.DEMOTE ?? 0)} firings or demotions over all seeds; the Intern spent ${lim.rounds_in.TRADER ?? 0} of ${Object.values(lim.rounds_in).reduce((a, b) => a + b, 0)} rounds at TRADER.`;
    case "nobody-votes":
      return `${base} With no votes the Intern stayed ${Object.keys(lim.finals).join(", ")} throughout.`;
    case "fake-farm": {
      const d = lim.rewards.draw_paid;
      const j = lim.rewards.jackpot_paid;
      const drawShare = d.boss + d.whale + d.fake === 0 ? 0 : (100 * d.fake) / (d.boss + d.whale + d.fake);
      const jackShare = j.boss + j.whale + j.fake === 0 ? 0 : (100 * j.fake) / (j.boss + j.whale + j.fake);
      const n = s.fakes?.count ?? 0;
      const parked = n * ((s.fakes?.brave_usd ?? 0) + (s.fakes?.safe_usd ?? 0));
      return `${base} Holding ${pct(lim.rewards.fake_usd_share_pct)} of the dollars, the ${n} fake accounts took ${pct(drawShare)} of the draw prizes and ${pct(jackShare)} of the jackpot; ${lim.rewards.refused_full.boss.toFixed(0)} honest bosses a run were turned away from the full draw. What it cost them: ${(n * REGISTRATION_NEAR).toFixed(2)} NEAR of registration (01 §9.1) and ${money(parked)} parked, almost all of it in SAFE, at no risk.`;
    }
    default:
      return base;
  }
}

export function summarizeScenario(s: Scenario, runs: RunResult[]): ScenarioResult {
  const lim = runs.filter((r) => r.arm === "limits");
  const ctl = runs.filter((r) => r.arm === "control");
  const limits = summarizeArm("limits", lim);
  const control = summarizeArm("control", ctl);
  const marks: MarkOutcome[] = s.marks.map((mark) => ({
    mark,
    scenario: s.name,
    limits: check(mark, lim),
    control: ctl.length > 0 ? check(mark, ctl) : null,
  }));
  return { scenario: s, limits, control, marks, line: lineFor(s, limits, control, marks), runs };
}

/** The marks checked on every run: the books on both arms, the per-bet limit on the limits arm. */
export function globalOutcomes(all: readonly RunResult[]): MarkOutcome[] {
  return GLOBAL_MARKS.map((mark) => {
    const lim = all.filter((r) => r.arm === "limits");
    const ctl = all.filter((r) => r.arm === "control");
    return {
      mark,
      scenario: "all",
      limits: check(mark, mark.metric === "book_failures" ? all : lim),
      control: mark.metric === "book_failures" ? null : check(mark, ctl),
    };
  });
}
