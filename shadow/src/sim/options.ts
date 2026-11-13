import type { Recorded } from "./behaviour.ts";
import type { GrieferInputs, SniperInputs, WhaleInputs } from "./community.ts";
import { runSim } from "./engine.ts";
import { type RunResult, resultOf } from "./metrics.ts";
import { moveTable, type PriceBook } from "./prices.ts";
import { PROPOSALS, type ProposalInfo, proposalsFrom } from "./proposals.ts";
import { clockFor, REGISTRATION_NEAR, roundsPerDay } from "./rules01.ts";
import { scenarioConfig, windowOf, windowsFor } from "./runs.ts";
import { type Scenario, scenarioByName } from "./scenarios.ts";

/**
 * The owner's options (PROPOSALS, not current rules: src/sim/proposals.ts), each switched on alone and run against
 * today's rules on the same seeds and the same windows of real prices; and the abuse table. Pure: the caller loads the
 * prices and the recorded answers (src/sim/cli.ts).
 */

/** A situation an option is tried in: a scenario of the main report, or an abuse test built on one. */
export interface Case {
  name: string;
  title: string;
  /** The scenario it starts from (src/sim/scenarios.ts), or a variant of one built here. */
  base: string;
  scenario?: Scenario;
  /** Another model's recorded answers instead of the default. */
  model?: string;
  griefer?: GrieferInputs;
  sniper?: SniperInputs;
  whale?: WhaleInputs;
}

export const CASES: readonly Case[] = [
  { name: "baseline", title: "Baseline", base: "baseline" },
  { name: "losing-streak", title: "A losing streak", base: "losing-streak" },
  { name: "brave-run", title: "A run on BRAVE", base: "brave-run" },
  { name: "always-max", title: "Always the maximum", base: "always-max" },
  { name: "whale-alone", title: "A whale voting alone", base: "whale-alone" },
  { name: "nobody-votes", title: "Nobody votes", base: "nobody-votes" },
  { name: "fake-farm", title: "Fake accounts farming", base: "fake-farm" },
  {
    name: "worst-case",
    title: "Always the maximum, every bet losing for 30 days, nobody voting",
    base: "nobody-votes",
    scenario: {
      ...scenarioByName("nobody-votes"),
      name: "worst-case",
      intern: "max",
      asks: "until-full",
      losing: { from_day: 1, days: 30 },
      community: { ...scenarioByName("nobody-votes").community, cash_out_any_time: false },
    },
  },
  {
    name: "broken-model",
    title: "A model whose answers are all malformed (Qwen3.8-27B, strict)",
    base: "baseline",
    model: "Qwen/Qwen3.8-27B",
  },
  {
    name: "griefer-before",
    title: "A griefer cashing out a cent a minute before each proposal window",
    base: "baseline",
    griefer: { usd: 0.01, at: "before" },
  },
  {
    name: "griefer-in-flight",
    title: "A griefer cashing out a cent while the model answers",
    base: "baseline",
    griefer: { usd: 0.01, at: "in-flight" },
  },
  {
    name: "whale-playbook",
    title: "A whale voting in a playbook of his own",
    base: "whale-alone",
    whale: { share_of_locked: 0.25, fire_every_days: 10, own_playbook: true },
  },
  {
    name: "sniper",
    title: "A vote sniper buying 40% of the locked coins on day 10",
    base: "baseline",
    sniper: { day: 10, share_of_locked: 0.4 },
  },
];

/** The cases each option is tried in: where it is meant to help, and where it could get in the way. */
export const OPTION_CASES: Readonly<Record<string, readonly string[]>> = {
  a: ["baseline", "brave-run", "griefer-before", "broken-model"],
  b: ["baseline", "losing-streak", "always-max", "worst-case", "nobody-votes", "whale-alone"],
  c: ["baseline", "losing-streak", "always-max", "worst-case"],
  d: ["baseline", "always-max"],
  e1: ["baseline", "brave-run", "griefer-before", "griefer-in-flight"],
  e2: ["baseline", "brave-run", "griefer-before", "griefer-in-flight"],
  f1: ["fake-farm", "baseline"],
  f2: ["fake-farm", "baseline"],
  f3: ["fake-farm", "baseline"],
  f: ["fake-farm", "baseline"],
};

export const ABUSE_CASES: readonly string[] = [
  "fake-farm",
  "whale-alone",
  "whale-playbook",
  "sniper",
  "griefer-before",
  "griefer-in-flight",
];

/** One case's runs over the seeds, summed up: medians for prices and results, means for counts. */
export interface CaseSummary {
  runs: number;
  price_end: number;
  price_end_worst: number;
  fall_median: number;
  fall_worst: number;
  supply_end: number;
  placed: number;
  refused: number;
  refused_money_left: number;
  wrong_rulebook: number;
  asked_max: number;
  blocked: number;
  blocked_won: number;
  shrunk: number;
  unblocked: number;
  honest_result: number;
  rounds_fired: number;
  suspensions: number;
  halts: number;
  rounds_halted: number;
  rounds_gated: number;
  burn_spent: number;
  reasks: number;
  draw_fakes: number;
  draw_all: number;
  jackpot_fakes: number;
  jackpot_all: number;
  goldens_fakes: number;
  fake_usd_share: number;
  honest_turned_away: number;
  fakes_bumped: number;
  coach_cut: number;
  trader_share: number;
  sniper_fire_after: number | null;
  attacker_paid_in: number;
  rounds: number;
}

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return 0;
  const m = Math.floor(n / 2);
  return n % 2 === 1 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
};
const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;

export function summarizeCase(runs: readonly RunResult[]): CaseSummary {
  const m = (f: (r: RunResult) => number): number => mean(runs.map(f));
  const fires = runs
    .map((r) =>
      r.attack.sniper_fired_round !== null && r.attack.sniper_locked_round !== null
        ? r.attack.sniper_fired_round - r.attack.sniper_locked_round
        : null,
    )
    .filter((x): x is number => x !== null);
  return {
    runs: runs.length,
    price_end: median(runs.map((r) => r.price.end)),
    price_end_worst: Math.min(...runs.map((r) => r.price.end)),
    fall_median: median(runs.map((r) => r.price.max_drawdown_pct)),
    fall_worst: Math.max(...runs.map((r) => r.price.max_drawdown_pct)),
    supply_end: median(runs.map((r) => r.supply.end)),
    placed: m((r) => r.bets.yes),
    refused: m((r) => r.bets.refused_total),
    refused_money_left: m((r) => r.bets.refused_money_left),
    wrong_rulebook: m((r) => r.bets.refused.WRONG_RULEBOOK ?? 0),
    asked_max: m((r) => r.bets.asked_max),
    blocked: m((r) => r.proposals.blocked),
    blocked_won: m((r) => r.proposals.blocked_won),
    shrunk: m((r) => r.proposals.shrunk),
    unblocked: m((r) => r.proposals.unblocked),
    honest_result: median(runs.map((r) => r.honest_result)),
    rounds_fired: m((r) => r.rank.rounds_in.FIRED ?? 0),
    suspensions: m((r) => r.proposals.suspensions),
    halts: m((r) => r.proposals.halts),
    rounds_halted: m((r) => r.proposals.rounds_halted),
    rounds_gated: m((r) => r.proposals.rounds_gated),
    burn_spent: m((r) => r.proposals.burn_spent),
    reasks: m((r) => r.proposals.reasks),
    draw_fakes: m((r) => r.rewards.draw_paid.fake),
    draw_all: m((r) => r.rewards.draw_paid.boss + r.rewards.draw_paid.whale + r.rewards.draw_paid.fake),
    jackpot_fakes: m((r) => r.rewards.jackpot_paid.fake),
    jackpot_all: m(
      (r) => r.rewards.jackpot_paid.boss + r.rewards.jackpot_paid.whale + r.rewards.jackpot_paid.fake,
    ),
    goldens_fakes: m((r) => r.rewards.goldens.fake),
    fake_usd_share: m((r) => r.rewards.fake_usd_share_pct),
    honest_turned_away: m((r) => r.rewards.refused_full.boss),
    fakes_bumped: m((r) => r.proposals.bumped.fake),
    coach_cut: m((r) => r.coach_cut),
    trader_share: m((r) => (100 * (r.rank.rounds_in.TRADER ?? 0)) / Math.max(1, r.rounds)),
    sniper_fire_after: fires.length === 0 ? null : median(fires),
    attacker_paid_in: m((r) => r.attack.attacker_paid_in),
    rounds: runs[0]?.rounds ?? 0,
  };
}

export interface Comparison {
  case: string;
  minutes: number;
  today: CaseSummary;
  with: CaseSummary;
  /** The median over seeds of (with − today) in the honest bosses' net result: the option's own effect on them. */
  honest_diff: number;
}

export interface OptionsData {
  generated_at: string;
  days: number;
  seeds: number;
  minutes: number[];
  prices: string;
  behaviour_run: string;
  model: string;
  options: { info: ProposalInfo; comparisons: Comparison[] }[];
  /** Today's rules in each abuse case, per round length. */
  abuse: { case: string; minutes: number; today: CaseSummary }[];
}

export interface CompareInput {
  days: number;
  seeds: number;
  minutes: readonly number[];
  book: PriceBook;
  /** Recorded answers by model: the default model's and any a case names. */
  profiles: Readonly<Record<string, readonly Recorded[]>>;
  model: string;
  cost_bps: number;
  runner_asks: number;
  prices: string;
  behaviour_run: string;
  /** Only these proposals (ids or names); all by default. */
  only?: readonly string[];
}

function caseByName(name: string): Case {
  const c = CASES.find((x) => x.name === name);
  if (!c) throw new Error(`no case "${name}"`);
  return c;
}

/** Runs one case for every seed, with the limits on, under today's rules or with the named proposal. */
function runCase(input: CompareInput, c: Case, minutes: number, proposal: string | null): RunResult[] {
  const clock = clockFor(minutes);
  const starts = windowsFor(input.book, clock, input.days);
  if (starts.length === 0) throw new Error(`the price fixture does not hold ${input.days} days of rounds`);
  const decisions = input.profiles[c.model ?? input.model];
  if (!decisions) throw new Error(`no recorded answers loaded for ${c.model ?? input.model}`);
  const rounds = input.days * roundsPerDay(clock);
  const out: RunResult[] = [];
  for (let seed = 1; seed <= input.seeds; seed++) {
    const start = windowOf(starts, seed);
    const cfg = scenarioConfig(c.scenario ?? scenarioByName(c.base), {
      clock,
      days: input.days,
      arm: "limits",
      moves: moveTable(input.book, clock, start, rounds),
      cost_bps: input.cost_bps,
      seed,
      decisions,
      runner_asks: input.runner_asks,
      ...(proposal ? { proposals: proposalsFrom([proposal]) } : {}),
      ...(c.griefer ? { griefer: c.griefer } : {}),
      ...(c.sniper ? { sniper: c.sniper } : {}),
      ...(c.whale ? { whale: c.whale } : {}),
    });
    out.push(
      resultOf(runSim(cfg), {
        scenario: c.name,
        arm: "limits",
        seed,
        window_start: new Date(start).toISOString(),
        rounds,
      }),
    );
  }
  return out;
}

export function compareProposals(
  input: CompareInput,
  progress: (line: string) => void = () => {},
): OptionsData {
  const today = new Map<string, RunResult[]>();
  const todayOf = (name: string, minutes: number): RunResult[] => {
    const key = `${name}|${minutes}`;
    let runs = today.get(key);
    if (!runs) {
      runs = runCase(input, caseByName(name), minutes, null);
      today.set(key, runs);
    }
    return runs;
  };
  const options: OptionsData["options"] = [];
  for (const info of PROPOSALS) {
    if (input.only && !input.only.includes(info.id) && !input.only.includes(info.name)) continue;
    const comparisons: Comparison[] = [];
    for (const name of OPTION_CASES[info.id] ?? []) {
      for (const minutes of input.minutes) {
        const base = todayOf(name, minutes);
        const withIt = runCase(input, caseByName(name), minutes, info.name);
        comparisons.push({
          case: name,
          minutes,
          today: summarizeCase(base),
          with: summarizeCase(withIt),
          honest_diff: median(withIt.map((r, i) => r.honest_result - (base[i]?.honest_result ?? 0))),
        });
      }
    }
    options.push({ info, comparisons });
    progress(`${info.id}. ${info.title}: done`);
  }
  const abuse: OptionsData["abuse"] = [];
  if (!input.only) {
    for (const name of ABUSE_CASES) {
      for (const minutes of input.minutes)
        abuse.push({ case: name, minutes, today: summarizeCase(todayOf(name, minutes)) });
    }
    progress("abuse cases: done");
  }
  return {
    generated_at: "",
    days: input.days,
    seeds: input.seeds,
    minutes: [...input.minutes],
    prices: input.prices,
    behaviour_run: input.behaviour_run,
    model: input.model,
    options,
    abuse,
  };
}

// ---------------------------------------------------------------- the report

const usd = (x: number, digits = 0): string =>
  `${x < 0 ? "-" : ""}$${Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const price = (x: number): string => `$${x.toFixed(4)}`;
const pct = (x: number): string => `${x.toFixed(1)}%`;
const one = (x: number): string => (Math.abs(x) >= 100 || Number.isInteger(x) ? x.toFixed(0) : x.toFixed(1));
const share = (part: number, all: number): number => (all === 0 ? 0 : (100 * part) / all);
const coins = (x: number): string => x.toLocaleString("en-US", { maximumFractionDigits: 0 });
const clockName = (minutes: number): string => (minutes === 1440 ? "24 h" : `${minutes} min`);
const arrow = (a: string, b: string): string => (a === b ? `${a} (same)` : `${a} → ${b}`);

function find(cs: readonly Comparison[], name: string, minutes: number): Comparison | undefined {
  return cs.find((c) => c.case === name && c.minutes === minutes);
}

/** The column of each option's own effect. */
function ownColumn(id: string): { head: string; cell: (c: Comparison) => string } {
  switch (id) {
    case "a":
      return {
        head: "Suspensions a run; rounds fired: today → with it",
        cell: (c) =>
          `${one(c.with.suspensions)}; ${arrow(one(c.today.rounds_fired), one(c.with.rounds_fired))}`,
      };
    case "b":
      return {
        head: "Halts a run; rounds halted a run",
        cell: (c) => `${one(c.with.halts)}; ${one(c.with.rounds_halted)}`,
      };
    case "c":
      return { head: "Rounds with the limits halved, a run", cell: (c) => one(c.with.rounds_gated) };
    case "d":
      return {
        head: "Coin supply at the end: today → with it; spent buying coins, a run",
        cell: (c) =>
          `${arrow(coins(c.today.supply_end), coins(c.with.supply_end))}; ${usd(c.with.burn_spent)}`,
      };
    case "e1":
    case "e2":
      return {
        head: "Refused for money that left: today → with it; WRONG_RULEBOOK a run; asked again a run",
        cell: (c) =>
          `${arrow(one(c.today.refused_money_left), one(c.with.refused_money_left))}; ${one(c.with.wrong_rulebook)}; ${one(c.with.reasks)}`,
      };
    default:
      return {
        head: "Fakes' share of the draw; of the jackpot (today → with it); honest bosses turned away a run",
        cell: (c) =>
          `${arrow(pct(share(c.today.draw_fakes, c.today.draw_all)), pct(share(c.with.draw_fakes, c.with.draw_all)))}; ${arrow(pct(share(c.today.jackpot_fakes, c.today.jackpot_all)), pct(share(c.with.jackpot_fakes, c.with.jackpot_all)))}; ${arrow(one(c.today.honest_turned_away), one(c.with.honest_turned_away))}`,
      };
  }
}

function optionTable(id: string, cs: readonly Comparison[]): string[] {
  const own = ownColumn(id);
  const L = [
    `| Case | Rounds | Coin price at the end, median (worst seed): today → with it | Deepest fall, worst seed: today → with it | Bets placed a run: today → with it | Refused a run: today → with it | Good bets blocked a run (would have won) | Bets shrunk / let through a run | Honest bosses' result a run: today → with it (paired difference) | ${own.head} |`,
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const c of cs) {
    L.push(
      `| ${c.case} | ${clockName(c.minutes)} | ${arrow(`${price(c.today.price_end)} (${price(c.today.price_end_worst)})`, `${price(c.with.price_end)} (${price(c.with.price_end_worst)})`)} | ${arrow(pct(c.today.fall_worst), pct(c.with.fall_worst))} | ${arrow(one(c.today.placed), one(c.with.placed))} | ${arrow(one(c.today.refused), one(c.with.refused))} | ${one(c.with.blocked)} (${one(c.with.blocked_won)}) | ${one(c.with.shrunk)} / ${one(c.with.unblocked)} | ${arrow(usd(c.today.honest_result), usd(c.with.honest_result))} (${usd(c.honest_diff)}) | ${own.cell(c)} |`,
    );
  }
  return L;
}

/** The option's summary row and its paragraph, in plain words; every claim is checked against its numbers. */
function says(id: string, cs: readonly Comparison[]): { changes: string; effects: string } {
  const runs = (name: string): Comparison[] =>
    [1440, 30].map((m) => find(cs, name, m)).filter((c): c is Comparison => c !== undefined);
  /** "x (24 h) and y (30 min)". */
  const list = (name: string, f: (c: Comparison) => string): string =>
    runs(name)
      .map((c) => `${f(c)} (${clockName(c.minutes)})`)
      .join(" and ");
  const none = (name: string, f: (c: Comparison) => number): boolean => runs(name).every((c) => f(c) === 0);
  const fakeDraw = (c: Comparison): string =>
    arrow(pct(share(c.today.draw_fakes, c.today.draw_all)), pct(share(c.with.draw_fakes, c.with.draw_all)));
  const fakeJackpot = (c: Comparison): string =>
    arrow(
      pct(share(c.today.jackpot_fakes, c.today.jackpot_all)),
      pct(share(c.with.jackpot_fakes, c.with.jackpot_all)),
    );
  // e1, e2: what the bets they let through did to the honest bosses, on these prices.
  const base = runs("baseline");
  const lettingThrough =
    base.length > 0 && base.every((c) => c.honest_diff < 0)
      ? `The max-size bets it lets through lost money on these prices: the honest bosses' result moved ${list("baseline", (c) => usd(c.honest_diff))} a run in the baseline, so today's refusals had been sparing the pool by accident.`
      : `The bets it lets through moved the honest bosses' result ${list("baseline", (c) => usd(c.honest_diff))} a run in the baseline.`;
  switch (id) {
    case "a": {
      const ownFault = runs("baseline").every((c) => c.today.refused === c.today.refused_money_left);
      const baseline = none("baseline", (c) => c.with.suspensions)
        ? "The pinned model, which broke no rule when recorded, was never suspended in the baseline: a skip or a bet between two refusals starts the count again."
        : `The pinned model, which broke no rule when recorded, was suspended ${list("baseline", (c) => one(c.with.suspensions))} times a run in the baseline${ownFault ? ", every strike a bet refused only because money left before the proposal (finding 1)" : ""}.`;
      const griefer = none("griefer-before", (c) => c.with.suspensions)
        ? "A griefer cashing out a cent before each window never got it suspended."
        : `A griefer cashing out a cent before each window got it suspended ${list("griefer-before", (c) => one(c.with.suspensions))} times a run, stopping ${list("griefer-before", (c) => `${one(c.with.blocked)} good bets`)} a run until holders rehired it.`;
      return {
        changes: `Suspends the Intern after 3 refusals in a row. ${baseline} A model whose answers are all malformed is suspended at its third answer and then spends ${list("broken-model", (c) => one(c.with.rounds_fired))} rounds a run fired, where today it stays employed and every answer is refused.`,
        effects: `${griefer} Each suspension stops every bet until a rehire vote passes, days later, and the rehire returns the Intern at INTERN.`,
      };
    }
    case "b": {
      const worst = list("worst-case", (c) => arrow(pct(c.today.fall_worst), pct(c.with.fall_worst)));
      const elsewhere = ["baseline", "losing-streak", "always-max"].every((n) =>
        none(n, (c) => c.with.halts),
      );
      const nobody = none("nobody-votes", (c) => c.with.rounds_halted)
        ? "It did not trip with nobody voting and an ordinary Intern"
        : `With nobody voting it never lifts: ${list("nobody-votes", (c) => one(c.with.rounds_halted))} rounds halted a run`;
      const whale = none("whale-alone", (c) => c.with.rounds_halted)
        ? "nor with a whale voting alone"
        : `and a whale voting alone never resumes it: ${list("whale-alone", (c) => one(c.with.rounds_halted))} rounds halted`;
      return {
        changes: `Stops new bets after a 10% fall of the coin price until holders vote to resume. In the worst case (always the maximum, every bet losing for 30 days, nobody voting) it tripped ${list("worst-case", (c) => one(c.with.halts))} times a run and the worst fall went ${worst}${elsewhere ? "; with the limits on and an ordinary Intern the coin never fell 10%, so it never tripped" : ""}.`,
        effects: `With nobody voting a halt never lifts (${list("worst-case", (c) => one(c.with.rounds_halted))} rounds halted a run in the worst case, every later bet blocked: ${list("worst-case", (c) => `${one(c.with.blocked)} good bets, ${one(c.with.blocked_won)} of them winners`)}). ${nobody}, ${whale}.`,
      };
    }
    case "c": {
      const acted = ["always-max", "worst-case", "losing-streak", "baseline"].find(
        (n) => !none(n, (c) => c.with.rounds_gated),
      );
      if (acted === undefined) {
        return {
          changes:
            "Halves the limits after a week whose bets lost more than 1% of the pool. No week lost that much in these runs, so it never shut.",
          effects: "None measured.",
        };
      }
      const where =
        acted === "always-max"
          ? "with an Intern always betting the maximum"
          : acted === "worst-case"
            ? "in the worst case"
            : `in the ${acted} case`;
      return {
        changes: `Halves the limits after a week whose bets lost more than 1% of the pool. It shut ${list(acted, (c) => one(c.with.rounds_gated))} rounds a run ${where}, whose worst fall went ${list(acted, (c) => arrow(pct(c.today.fall_worst), pct(c.with.fall_worst)))}. At INTERN, where a bet is at most 2% of the pool and real moves are a few percent, a week rarely loses 1%: even in the worst case it shut ${list("worst-case", (c) => one(c.with.rounds_gated))} rounds a run.`,
        effects: `When shut it shrinks every bet, the winners too: ${list(acted, (c) => `${one(c.with.shrunk)} bets shrunk and ${one(c.with.blocked)} stopped (${one(c.with.blocked_won)} of them winners)`)} a run ${where}, and the honest bosses' result moved ${list(acted, (c) => usd(c.honest_diff))} a run. It opens again by itself as the losses leave the 7-round window: no vote needed.`,
      };
    }
    case "d": {
      const still = runs("baseline").every((c) => Math.abs(c.today.price_end - c.with.price_end) < 0.0005);
      return {
        changes: `Buys and burns coins with 10% of winning rounds: the coin supply at the end goes ${list("always-max", (c) => arrow(coins(c.today.supply_end), coins(c.with.supply_end)))} with an Intern always betting the maximum.`,
        effects: `The coin price ${still ? "does not move" : "barely moves"} (${list("baseline", (c) => arrow(price(c.today.price_end), price(c.with.price_end)))} in the baseline): every coin can already be cashed out at its share of the pool, so buying coins at that price only hands holders their own money in another form, while the pool, and the Intern's limits with it, shrink. It would lift the price only where the coin trades below its pool value, on a DEX, which the sim does not have.`,
      };
    }
    case "e1": {
      const honest = none("baseline", (c) => c.with.wrong_rulebook)
        ? "honest cash-outs never landed in the seconds the model takes to answer"
        : `honest cash-outs landing in the seconds the model answers caused ${list("baseline", (c) => one(c.with.wrong_rulebook))} such refusals a run in the baseline`;
      return {
        changes: `Ends the refusals of max-size bets for money that left before the proposal: ${list("baseline", (c) => arrow(one(c.today.refused_money_left), one(c.with.refused_money_left)))} a run in the baseline, ${list("griefer-before", (c) => arrow(one(c.today.refused_money_left), one(c.with.refused_money_left)))} against a griefer cashing out before each window.`,
        effects: `A cash-out while the model is answering now changes the rulebook, so the answer is refused WRONG_RULEBOOK, a skip included: ${honest}, but a griefer who times a cent for those seconds gets every proposal refused (${list("griefer-in-flight", (c) => one(c.with.wrong_rulebook))} a run), a wider hole than today's. ${lettingThrough}`,
      };
    }
    case "e2":
      return {
        changes: `As e1, and the runner asks again when the rulebook changed while the model answered: refused for money that left ${list("baseline", (c) => arrow(one(c.today.refused_money_left), one(c.with.refused_money_left)))} a run in the baseline; against the griefer who times a cent for those seconds, WRONG_RULEBOOK ${list("griefer-in-flight", (c) => one(c.with.wrong_rulebook))} a run.`,
        effects: `Each change costs another answer from the model (${list("griefer-in-flight", (c) => one(c.with.reasks))} re-asks a run against that griefer), and the answer asked again can differ from the first, so its "blocked" and "let through" compare two answers; the bets placed say more (${list("griefer-in-flight", (c) => arrow(one(c.today.placed), one(c.with.placed)))} a run against that griefer). ${lettingThrough} A griefer sending a cash-out every few seconds could outlast the three re-asks; that costs gas, which the sim does not count.`,
      };
    case "f1":
    case "f2": {
      const untouched = runs("fake-farm").every(
        (c) => c.today.draw_fakes === c.with.draw_fakes && c.today.jackpot_fakes === c.with.jackpot_fakes,
      );
      return {
        changes: `${id === "f1" ? "Counts the lowest balance held during the period" : "Counts only money held across a round's opening"}: fakes' share of the draw ${list("fake-farm", fakeDraw)}; of the jackpot ${list("fake-farm", fakeJackpot)}.`,
        effects: `It stops money that comes in just for a draw or a streak${untouched ? ", but the fake accounts here hold their $10 from the first round to the last, so it does not touch them" : ""}. Honest bosses' result: ${list("baseline", (c) => arrow(usd(c.today.honest_result), usd(c.with.honest_result)))} in the baseline.`,
      };
    }
    case "f3":
      return {
        changes: `Draws by dollars and keeps the 200 places for the biggest entrants: fakes' share of the draw ${list("fake-farm", fakeDraw)}, holding ${list("fake-farm", (c) => pct(c.with.fake_usd_share))} of the dollars; honest bosses turned away ${list("fake-farm", (c) => arrow(one(c.today.honest_turned_away), one(c.with.honest_turned_away)))} a run.`,
        effects: `It does nothing for the streak jackpot (${list("fake-farm", fakeJackpot)}): a free guess per account still lets a script cover every answer. The fakes still win a little more than their dollar share, because they joined first and count every round of every period.`,
      };
    default:
      return {
        changes: `All three farming fixes: fakes' share of the draw ${list("fake-farm", fakeDraw)}; of the jackpot ${list("fake-farm", fakeJackpot)}.`,
        effects:
          "The draw is fixed by f3 alone; the jackpot stays open to patient fake accounts. A jackpot free guesses cannot farm needs a cost per guess or a stake that grows with the prize: not tested here.",
      };
  }
}

export const NOT_MODELED_ATTACKS: readonly string[] = [
  "Trading against the Intern's open bets. Its orders and positions on Hyperliquid are public; someone large could push a thin market against a bet, or hunt its liquidation price. The sim has no market impact.",
  "Steering answers through the trick page. A visitor's message can make the model answer differently, but the trick page is asked after the Intern's own question (so the guess game is untouched) and the rank still bounds every bet. Trick-page proposals are not simulated.",
  "The runner picking among several answers (01 §6.3, §14 limit 6): the proof shows which model answered, not that the runner did not ask twice.",
  "Buying or renting votes from other holders, beyond one whale or sniper holding the coins themselves (01 §14 limit 7).",
  "Moving the coin's price on a DEX, if it is ever listed: the sim's only price is the pool's.",
  "A block producer biasing the payday draw (01 §14 limit 13).",
  "Filling the contract's 100 jackpot candidates a round with fake accounts so that honest players on six right are left out: a contract limit not in 01.",
  "A griefer sending cash-outs every few seconds to outlast e2's re-asks: needs NEAR gas, which the sim does not count.",
];

interface AbuseRow {
  attack: string;
  cost: string;
  captures: string;
  defence: string;
  risk: string;
}

function abuseRows(d: OptionsData): AbuseRow[] {
  const today = (name: string, m: number): CaseSummary | undefined =>
    d.abuse.find((x) => x.case === name && x.minutes === m)?.today;
  const opt = (id: string, name: string, m: number): Comparison | undefined =>
    find(d.options.find((o) => o.info.id === id)?.comparisons ?? [], name, m);
  const daysRun = d.days;
  const per = (x: number): string => `${usd(x / daysRun, 2)} a day, ${usd(x)} a run`;
  const by = (f: (m: number) => string | null): string =>
    d.minutes
      .map((m) => {
        const s = f(m);
        return s === null ? null : `${clockName(m)}: ${s}`;
      })
      .filter((x) => x !== null)
      .join("; ");
  const fakes = 200;
  const rows: AbuseRow[] = [];
  rows.push({
    attack: `${fakes} fake accounts farm the payday draw`,
    cost: `${(fakes * REGISTRATION_NEAR).toFixed(2)} NEAR of registration (01 §9.1); ${usd(fakes * 10.01)} parked, ${usd(fakes * 0.01)} of it in BRAVE, the rest in SAFE at no risk`,
    captures: by((m) => {
      const t = today("fake-farm", m);
      return t
        ? `${per(t.draw_fakes)} (${pct(share(t.draw_fakes, t.draw_all))} of the draw, holding ${pct(t.fake_usd_share)} of the dollars); ${one(t.honest_turned_away)} honest bosses turned away a run`
        : null;
    }),
    defence:
      "None: the draw's 200 places go to whoever joins first, and every runner-up gets the same share whatever its tickets (01 §9.7)",
    risk: by((m) => {
      const c = opt("f3", "fake-farm", m);
      return c ? `all of the draw today; with f3, ${pct(share(c.with.draw_fakes, c.with.draw_all))}` : null;
    }),
  });
  rows.push({
    attack: `The same ${fakes} accounts farm the free guess and the streak jackpot`,
    cost: "The same accounts; each guess is free",
    captures: by((m) => {
      const t = today("fake-farm", m);
      return t
        ? `${per(t.jackpot_fakes)} (${pct(share(t.jackpot_fakes, t.jackpot_all))} of the jackpot) and ${one(t.goldens_fakes)} golden stickers a run`
        : null;
    }),
    defence: "$10 held and a boss for 7 rounds (01 §9.7)",
    risk: by((m) => {
      const c = opt("f", "fake-farm", m);
      return c
        ? `most of the jackpot; with f1, f2 and f3 together still ${pct(share(c.with.jackpot_fakes, c.with.jackpot_all))}`
        : null;
    }),
  });
  rows.push({
    attack: "A whale with 25% of the locked weight votes alone",
    cost: by((m) => {
      const t = today("whale-alone", m);
      return t ? `${usd(t.attacker_paid_in)} of coins locked, at the Intern's risk like everyone's` : null;
    }),
    captures: by((m) => {
      const t = today("whale-alone", m);
      return t ? `control of the rank: TRADER ${pct(t.trader_share)} of the time; no money directly` : null;
    }),
    defence:
      "Promote needs 20% of the locked weight to vote and a majority; fire and demote need 34% of all locked weight; weight grows over 7 rounds; the limits never change (01 §9.2, §3)",
    risk: "With 20% of the locked weight a whale promotes the Intern alone when nobody else votes; with 34% it fires it alone",
  });
  rows.push({
    attack: "The whale votes in a playbook of his own",
    cost: "As above",
    captures: by((m) => {
      const t = today("whale-playbook", m);
      return t ? `the coach cut: ${per(t.coach_cut)}` : null;
    }),
    defence: "SET_PLAYBOOK passes like a promotion (01 §9.5); the cut is 10% of winning rounds only",
    risk: "10% of every winning round goes to him for as long as the playbook stays",
  });
  rows.push({
    attack: "A vote sniper buys 40% of the locked coins on day 10 and opens a firing every round",
    cost: by((m) => {
      const t = today("sniper", m);
      return t ? `${usd(t.attacker_paid_in)} of coins locked` : null;
    }),
    captures: by((m) => {
      const t = today("sniper", m);
      return t
        ? t.sniper_fire_after === null
          ? "never fired the Intern"
          : `fires the Intern ${one(t.sniper_fire_after)} rounds after locking; ${one(t.rounds_fired)} rounds fired a run`
        : null;
    }),
    defence:
      "Only coins locked before a vote opened count, and their weight grows over 7 rounds (01 §9.2): no firing on fresh coins",
    risk: "Anyone who holds 34% of the locked weight for about a week can fire the Intern alone, as often as rehires let them",
  });
  rows.push({
    attack: "A griefer cashes out a cent of coins a minute before every proposal window",
    cost: "One NEAR transaction a round (gas not modeled); the cent stays his",
    captures: by((m) => {
      const t = today("griefer-before", m);
      const b = opt("e1", "baseline", m)?.today;
      return t
        ? `nothing for himself; every bet of exactly the largest margin is refused: ${one(t.refused_money_left)} a run (honest cash-outs alone: ${one(b?.refused_money_left ?? 0)})`
        : null;
    }),
    defence:
      "None (01 §3, §6.1: the rulebook's max is on the pool at the opening, the check on the smaller of that and the pool now)",
    risk: by((m) => {
      const c = opt("e1", "griefer-before", m);
      return c ? `with e1, ${one(c.with.refused_money_left)} a run` : null;
    }),
  });
  rows.push({
    attack: "The griefer times the cent for while the model answers",
    cost: "As above",
    captures: by((m) => {
      const t = today("griefer-in-flight", m);
      return t
        ? `today the same as before the window: ${one(t.refused_money_left)} max-size bets refused a run`
        : null;
    }),
    defence: "As above",
    risk: by((m) => {
      const e1 = opt("e1", "griefer-in-flight", m);
      const e2 = opt("e2", "griefer-in-flight", m);
      return e1 && e2
        ? `with e1 every proposal is refused WRONG_RULEBOOK (${one(e1.with.wrong_rulebook)} a run, skips too); with e2 ${one(e2.with.wrong_rulebook)} a run, at ${one(e2.with.reasks)} extra answers`
        : null;
    }),
  });
  rows.push({
    attack: "A holder leaves while a bet is losing, to dodge the loss",
    cost: "Their share of the margin out on open bets",
    captures:
      "Nothing: the leaver gives up their share of every open bet, win or lose (01 §9.1, 1.1); no cash-out lowered the coin price in any run (pass mark RB1)",
    defence: "01 §9.1 (1.1)",
    risk: "None found",
  });
  return rows;
}

export function formatOptionsMarkdown(d: OptionsData): string {
  const L: string[] = [];
  L.push("# $INTERN: the owner's options, simulated");
  L.push("");
  L.push(
    `**PROPOSALS, not current rules.** Generated ${d.generated_at} by \`npm run sim -- --compare-proposals\` (shadow/src/sim/options.ts). Each option is switched on alone, with the rank limits, and compared with today's rules (01-SHARED-INTERFACE.md version 1.5) on the same ${d.seeds} seeds and the same ${d.days}-day windows of real Hyperliquid prices (${d.prices}), for ${d.minutes.map((m) => (m === 1440 ? "24-hour rounds (the product)" : `${m}-minute rounds (the demo)`)).join(" and ")}. The Intern replays \`${d.model}\`'s recorded answers (${d.behaviour_run}); the community is the main report's assumed one (data/sim/1440m/sim-report.md). Counts are means a run; prices and results are medians, with the worst seed.`,
  );
  L.push("");
  L.push(
    "How a blocked bet is counted: every answer is also judged the way today's rules would judge it at that moment. A good bet blocked is one today's rules would have approved and the option stopped (refused it, or did not ask while the Intern was suspended or halted); it would have won if it made money at that round's close on the real prices. The honest bosses' result is what the ordinary bosses hold at the end plus what they took out and won, minus what they paid in; the paired difference is the median over seeds of (with it − today), which leaves out the noise that both share.",
  );
  L.push("");
  L.push("## Summary");
  L.push("");
  L.push("| Option | What it changes | Side effects |");
  L.push("|---|---|---|");
  for (const o of d.options) {
    const s = says(o.info.id, o.comparisons);
    L.push(`| ${o.info.id}. ${o.info.title} | ${s.changes} | ${s.effects} |`);
  }
  L.push("");
  for (const o of d.options) {
    const s = says(o.info.id, o.comparisons);
    L.push(`## ${o.info.id}. ${o.info.title} (PROPOSAL)`);
    L.push("");
    L.push(o.info.what);
    L.push("");
    L.push(`**Parameters:** ${o.info.params}`);
    L.push("");
    L.push(...optionTable(o.info.id, o.comparisons));
    L.push("");
    L.push(`**What it changes:** ${s.changes}`);
    L.push("");
    L.push(`**Side effects:** ${s.effects}`);
    L.push("");
  }
  if (d.abuse.length > 0) {
    L.push("## The abuse table");
    L.push("");
    L.push(
      `From the runs under today's rules (and, for the risk left, with the fixes above). Per day is the ${d.days}-day run divided by ${d.days}; the cases are listed in shadow/src/sim/options.ts.`,
    );
    L.push("");
    L.push("| Attack | What it costs the attacker | What it captures | The defence today | The risk left |");
    L.push("|---|---|---|---|---|");
    for (const r of abuseRows(d))
      L.push(`| ${r.attack} | ${r.cost} | ${r.captures} | ${r.defence} | ${r.risk} |`);
    L.push("");
    L.push("### Attacks not modeled");
    L.push("");
    for (const x of NOT_MODELED_ATTACKS) L.push(`- ${x}`);
    L.push("");
  }
  return `${L.join("\n")}\n`;
}

/** The summary fields each option's table shows; the JSON keeps only these. */
const COMMON_FIELDS: readonly (keyof CaseSummary)[] = [
  "price_end",
  "price_end_worst",
  "fall_median",
  "fall_worst",
  "placed",
  "refused",
  "blocked",
  "blocked_won",
  "shrunk",
  "unblocked",
  "honest_result",
];
const FARM_FIELDS: readonly (keyof CaseSummary)[] = [
  "draw_fakes",
  "draw_all",
  "jackpot_fakes",
  "jackpot_all",
  "fake_usd_share",
  "honest_turned_away",
  "fakes_bumped",
  "goldens_fakes",
];
const MAX_FIELDS: readonly (keyof CaseSummary)[] = [
  "refused_money_left",
  "wrong_rulebook",
  "reasks",
  "asked_max",
];
const OWN_FIELDS: Readonly<Record<string, readonly (keyof CaseSummary)[]>> = {
  a: ["suspensions", "rounds_fired"],
  b: ["halts", "rounds_halted"],
  c: ["rounds_gated"],
  d: ["supply_end", "burn_spent"],
  e1: MAX_FIELDS,
  e2: MAX_FIELDS,
  f1: FARM_FIELDS,
  f2: FARM_FIELDS,
  f3: FARM_FIELDS,
  f: FARM_FIELDS,
};

function slim(id: string, s: CaseSummary): Partial<CaseSummary> {
  const out: Partial<Record<keyof CaseSummary, unknown>> = {};
  for (const k of [...COMMON_FIELDS, ...(OWN_FIELDS[id] ?? [])]) out[k] = s[k];
  return out as Partial<CaseSummary>;
}

/** The numbers behind the report, small: each option's table fields only, no day-by-day series. */
export function formatOptionsJson(d: OptionsData): string {
  const round = (v: unknown): unknown =>
    typeof v === "number" && !Number.isInteger(v) ? Number(v.toFixed(3)) : v;
  return `${JSON.stringify(
    {
      kind: "PROPOSALS",
      note: "Options the owner is weighing, not current rules; each compared with today's rules on the same seeds. A simulation, not a forecast.",
      generated_at: d.generated_at,
      days: d.days,
      seeds: d.seeds,
      round_minutes: d.minutes,
      prices: d.prices,
      behaviour_run: d.behaviour_run,
      model: d.model,
      options: d.options.map((o) => ({
        id: o.info.id,
        name: o.info.name,
        title: o.info.title,
        what: o.info.what,
        params: o.info.params,
        set: o.info.set,
        ...says(o.info.id, o.comparisons),
        comparisons: o.comparisons.map((c) => ({
          case: c.case,
          round_minutes: c.minutes,
          honest_diff: c.honest_diff,
          today: slim(o.info.id, c.today),
          with: slim(o.info.id, c.with),
        })),
      })),
      abuse: d.abuse.length > 0 ? abuseRows(d) : [],
      not_modeled_attacks: NOT_MODELED_ATTACKS,
    },
    (_k, v) => round(v),
  )}\n`;
}
