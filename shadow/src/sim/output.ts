import { RANKS } from "../../../runner/src/ranks.ts";
import type { Profile, ProfileSummary } from "./behaviour.ts";
import { COMMUNITY_TEXT, type CommunityInputs } from "./community.ts";
import type { RoundClock } from "./rules01.ts";
import type { PassMark } from "./scenarios.ts";
import type { ArmSummary, MarkOutcome, ScenarioResult, Spread } from "./summary.ts";

/** The simulation's report: markdown for people, JSON for anything else. Pure: it only builds text. */

export interface ReportInput {
  generated_at: string;
  days: number;
  seeds: number;
  round_minutes: number;
  rounds: number;
  clock: RoundClock;
  prices: { folder: string; fetched_at: string; url: string; first_candle: string; last_candle: string };
  /** The 60-day (or `days`) window each seed used: the same for every scenario and both arms. */
  windows: { seed: number; start: string }[];
  windows_possible: number;
  profile: Profile;
  profile_summary: ProfileSummary;
  cost_bps: number;
  runner_asks: number;
  scenarios: ScenarioResult[];
  global: MarkOutcome[];
}

export const NOT_MODELED: readonly string[] = [
  "Visitors' messages from the trick page. The runner asks them after the Intern's own question, up to three a proposal window (runner/src/trick-desk.ts); each could use a bet the rank still has. Only the Intern's own question is simulated, once a round as the runner does, so at ANALYST and TRADER the bets a round may be fewer than in the product; the per-round limit still bounds them.",
  "The long shot (01 §9.7 R6, 1.5).",
  "Funding quotes (01 §7 checks 13 to 16): optional on testnet, never attached here.",
  "Hyperliquid's funding payments, slippage beyond the trading cost, orders that do not fill or fill in part (01 §14 limit 5), and rounds stuck because a bet cannot be closed.",
  "The lender running short of dollars (01 §9.1: a cash-out then pays what is available, TO VERIFY in 01).",
  "Stickers, goal bars, the launchpad and its fees: no money from them reaches BRAVE in the simulation.",
  "How a playbook changes the Intern's answers: the 10% coach cut is simulated, a playbook's effect on choices is not.",
  "Coins changing hands between accounts, and voting power bought or rented (01 §14 limit 7) beyond the whale scenario.",
  "Two limits that are in the contract but not in 01: at most 100 jackpot candidates a round and four lock lots a boss (crates/coin/src/rewards.rs, vote.rs).",
  "Claiming prizes: a prize credited counts as won.",
  "Turning the dial after paying in, and SAFE cash-outs: each deposit is split between BRAVE and SAFE when it is paid in (the dial at that moment); the dial's arithmetic (01 §9.1) is in src/sim/ledger.ts and tested, but no scenario turns it later.",
  "The Intern's skill: each round's answer is drawn at random from the record, so which market it picks is not tied to that day's prices. The prices themselves are real.",
  "NEAR gas and storage costs, except that the fake accounts' registration cost is counted.",
];

export const STAND_INS: readonly string[] = [
  "The community: every number in the table of scenario inputs is assumed. Nobody has measured how bosses behave.",
  "When bosses cash out: at a random moment of the round, so before the proposal (the limit base shrinks, 01 §3), during the hold (the leaver leaves their share of the open bets' margin, 01 §9.1) or after the close; in the two stress scenarios only after the close, so that neither effect spares the pool.",
  "With 30-minute rounds each bet is held for the whole 30-minute candle, about three times the demo's real hold (minute 15 to minute 25): its swings are larger than the demo's would be.",
  "At ANALYST and TRADER the Intern replays its INTERN record: sizes relative to the rulebook it is given, markets, sides and leverage as recorded. No run has recorded a model told a higher rank.",
  "With the limits off the Intern is told the whole idle pool is its largest margin, all six markets and both sides, and keeps its recorded habits. How a model answers when told it may bet everything is not measured (UNVERIFIED).",
  "A bet is liquidated when, at a candle's high or low, its loss reaches the margin (the shadow run's rule, shadow/src/paper.ts). Hyperliquid liquidates earlier (maintenance margin), so with leverage the simulation undercounts liquidations.",
  "The lender's interest is the STAND-IN rate, 5% a year (01 §9.6); on testnet it is worth nothing. It only feeds the payday draw.",
  "`min_first_deposit` is the live testnet coin's $10; 01 gives no number.",
];

const usd = (x: number, digits = 0): string =>
  `${x < 0 ? "-" : ""}$${Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const price = (x: number): string => `$${x.toFixed(4)}`;
const pct = (x: number): string => `${x.toFixed(1)}%`;
const coins = (x: number): string => x.toLocaleString("en-US", { maximumFractionDigits: 0 });
const one = (x: number): string => (Number.isInteger(x) ? String(x) : x.toFixed(1));
const spreadOf = (s: Spread, f: (x: number) => string): string => `${f(s.median)} (worst ${f(s.worst)})`;
const counts = (r: Record<string, number>): string =>
  Object.keys(r).length === 0
    ? "none"
    : Object.entries(r)
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${k} ${n}`)
        .join(", ");

function markText(m: PassMark): string {
  return `${m.text} (${m.metric} ${m.op} ${m.value})`;
}

function verdictCell(o: MarkOutcome): string {
  const c = o.limits;
  return c.pass
    ? "PASS"
    : `**FAIL** (${c.failed_seeds.length} of ${c.seeds} seeds: ${c.failed_seeds.join(", ")})`;
}

function controlCell(o: MarkOutcome): string {
  if (!o.control) return "-";
  return o.control.pass
    ? `would pass (worst ${one(o.control.worst)})`
    : `would fail (${o.control.failed_seeds.length} of ${o.control.seeds}; worst ${one(o.control.worst)})`;
}

function armRow(name: string, label: string, a: ArmSummary, marks: string): string {
  const votesPassed = Object.values(a.votes_passed).reduce((s, n) => s + n, 0);
  const votesOpened = Object.values(a.votes_opened).reduce((s, n) => s + n, 0);
  return `| ${name} | ${label} | ${price(a.price.start)} → ${spreadOf(a.price.end, price)} | ${spreadOf(a.price.drawdown_pct, pct)} | ${usd(a.brave.start)} / ${usd(a.brave.min.median)} / ${usd(a.brave.end.median)} | ${coins(a.supply.start)} → ${coins(a.supply.end.median)} | ${one(a.bets.yes)} / ${one(a.bets.refused)} / ${one(a.bets.skip)} | ${spreadOf(a.bets_result, (v) => usd(v))} | ${a.rank_changes}; ${votesPassed} / ${votesOpened} | ${marks} |`;
}

function inputsDiff(c: CommunityInputs, base: CommunityInputs): string[] {
  const out: string[] = [];
  for (const k of Object.keys(c) as (keyof CommunityInputs)[]) {
    if (JSON.stringify(c[k]) !== JSON.stringify(base[k])) {
      out.push(`${COMMUNITY_TEXT[k]}: ${JSON.stringify(c[k])} (baseline ${JSON.stringify(base[k])})`);
    }
  }
  return out;
}

function detail(s: ScenarioResult, base: CommunityInputs): string[] {
  const L: string[] = [];
  const { limits: a, control: b } = s;
  L.push(`### ${s.scenario.name}: ${s.scenario.title}`);
  L.push("");
  L.push(s.scenario.about);
  const diff = inputsDiff(s.scenario.community, base);
  if (diff.length > 0) L.push("", `Community inputs that differ from the baseline: ${diff.join("; ")}.`);
  L.push("");
  L.push("| | With the rank limits | Limits off (control) |");
  L.push("|---|---|---|");
  const row = (label: string, f: (x: ArmSummary) => string): void => {
    L.push(`| ${label} | ${f(a)} | ${f(b)} |`);
  };
  row("Coin price at the start", (x) => price(x.price.start));
  row("Coin price at the end, median (worst seed)", (x) => spreadOf(x.price.end, price));
  row("Lowest coin price, median (worst seed)", (x) => spreadOf(x.price.min, price));
  row("Deepest fall from a high, median (worst seed)", (x) => spreadOf(x.price.drawdown_pct, pct));
  row(
    "BRAVE pool: start / lowest / end, median",
    (x) => `${usd(x.brave.start)} / ${usd(x.brave.min.median)} / ${usd(x.brave.end.median)}`,
  );
  row("BRAVE pool's deepest fall, median (worst seed)", (x) => spreadOf(x.brave.drawdown_pct, pct));
  row(
    "Coin supply: start / lowest / highest / end (median)",
    (x) =>
      `${coins(x.supply.start)} / ${coins(x.supply.min)} / ${coins(x.supply.max)} / ${coins(x.supply.end.median)}`,
  );
  row(
    "Proposals a run: asked / YES / skipped / refused",
    (x) => `${one(x.bets.asked)} / ${one(x.bets.yes)} / ${one(x.bets.skip)} / ${one(x.bets.refused)}`,
  );
  row("Refusals by code, all seeds", (x) => counts(x.refused_by_code));
  row("Bets asked at exactly the largest margin allowed, a run", (x) => one(x.bets.asked_max));
  row("Refused only because money left after the opening, a run", (x) => one(x.bets.refused_money_left));
  row("Bets not placeable on Hyperliquid (under $10), a run", (x) => one(x.bets.not_placeable));
  row("Bets liquidated, a run", (x) => one(x.bets.liquidated));
  row("Worst round's loss, % of the pool at its opening", (x) => pct(x.worst_round_loss_pct));
  row("Worst round's loss / its rank's per-round limit", (x) => x.worst_loss_vs_limit.toFixed(2));
  row("Rank changes, all seeds", (x) => String(x.rank_changes));
  row("Rounds at each rank, all seeds", (x) => counts(x.rounds_in));
  row("Rank at the end, by seed", (x) => counts(x.finals));
  row("Votes opened, all seeds", (x) => counts(x.votes_opened));
  row("Votes passed, all seeds", (x) => counts(x.votes_passed));
  row("Bets' net result a run, after costs, median (worst seed)", (x) =>
    spreadOf(x.bets_result, (v) => usd(v, 2)),
  );
  row("Outside income to BRAVE (half of the tips), a run", (x) => usd(x.income, 2));
  row("Coach cut paid to the playbook's authors, a run", (x) => usd(x.coach_cut, 2));
  row(
    "Cash-outs a run: count / paid / margin left on open bets",
    (x) => `${one(x.cashouts.count)} / ${usd(x.cashouts.paid)} / ${usd(x.cashouts.forfeited, 2)}`,
  );
  row("Lender's interest to the draw, a run", (x) => usd(x.rewards.interest, 2));
  row(
    "Draw prizes a run: bosses / whale / fakes",
    (x) =>
      `${usd(x.rewards.draw_paid.boss, 2)} / ${usd(x.rewards.draw_paid.whale, 2)} / ${usd(x.rewards.draw_paid.fake, 2)}`,
  );
  row(
    "Jackpot prizes a run: bosses / whale / fakes",
    (x) =>
      `${usd(x.rewards.jackpot_paid.boss, 2)} / ${usd(x.rewards.jackpot_paid.whale, 2)} / ${usd(x.rewards.jackpot_paid.fake, 2)}`,
  );
  if (s.scenario.fakes) {
    row(
      "Guesses a run: bosses / fakes",
      (x) => `${coins(x.rewards.guesses.boss + x.rewards.guesses.whale)} / ${coins(x.rewards.guesses.fake)}`,
    );
    row(
      "Golden stickers a run: bosses / fakes",
      (x) => `${one(x.rewards.goldens.boss)} / ${one(x.rewards.goldens.fake)}`,
    );
    row("Fakes' share of dollars held, at the draws", (x) => pct(x.rewards.fake_usd_share_pct));
    row("Honest bosses turned away from the full draw, a run", (x) => one(x.rewards.refused_full.boss));
  }
  L.push("");
  for (const o of s.marks)
    L.push(
      `- ${o.mark.id} ${verdictCell(o)}: ${o.mark.text}. Worst seed: ${one(o.limits.worst)}. Limits off: ${controlCell(o)}.`,
    );
  L.push("");
  L.push(`**What it says:** ${s.line}`);
  L.push("");
  return L;
}

export function formatMarkdown(r: ReportInput, base: CommunityInputs): string {
  const L: string[] = [];
  const kind =
    r.round_minutes === 1440 ? "24-hour rounds, as in the product" : "30-minute rounds, as in the demo";
  L.push(`# $INTERN: ${r.days} days simulated, ${kind}`);
  L.push("");
  L.push(
    `Generated ${r.generated_at} by \`npm run sim\` (shadow/src/sim). **A simulation, not a forecast:** real past Hyperliquid prices and the AI's real recorded answers, with assumed community behaviour; test dollars only. ${r.seeds} seeds per scenario, each run twice: with the rank limits and, as a control, with them switched off.`,
  );
  L.push("");
  L.push("## Pass marks (set before the results)");
  L.push("");
  L.push(
    "Our bar for the parameters, written into the code (src/sim/scenarios.ts) before the first full run. A mark passes only if every seed passes it; it is judged on the runs with the limits on, and shown for the control for contrast.",
  );
  L.push("");
  L.push("| Mark | Scenario | Pass mark | Why this number |");
  L.push("|---|---|---|---|");
  for (const o of r.global) L.push(`| ${o.mark.id} | every run | ${markText(o.mark)} | ${o.mark.why} |`);
  for (const s of r.scenarios) {
    for (const o of s.marks)
      L.push(`| ${o.mark.id} | ${s.scenario.name} | ${markText(o.mark)} | ${o.mark.why} |`);
  }
  L.push("");
  L.push("## What went in");
  L.push("");
  L.push(
    "- **Rules:** 01-SHARED-INTERFACE.md version 1.5. The rank limits are `runner/src/ranks.ts` and every proposal is judged by `runner/src/rules.ts`, the same code the runner and the shadow run use; the rulebook's `max_margin_e6` is the runner's own `maxMarginE6`. Every other rule and number is in src/sim/rules01.ts with its section of 01; test/sim-rules01.test.ts checks them against the live testnet coin's views of 2026-11-13.",
  );
  L.push(
    `- **Rounds:** ${r.round_minutes} minutes (01 §5), ${r.rounds} rounds. Bets are proposed when the proposal window opens and held to the close (${r.round_minutes === 1440 ? "12:00 to 22:00 UTC" : "the whole 30-minute candle; the demo holds from minute 15 to 25"}). The runner asks the Intern ${r.runner_asks === 1 ? "once" : `${r.runner_asks} times`} a round (runner/src/round.ts), never while it is FIRED.`,
  );
  L.push(
    `- **Prices:** Hyperliquid mainnet 30-minute candles of DOGE, kSHIB, kPEPE, PENGU, WIF and TRUMP, from \`POST ${r.prices.url} {"type":"candleSnapshot"}\` (read-only), fetched ${r.prices.fetched_at}, saved in shadow/fixtures/sim/${r.prices.folder}: ${r.prices.first_candle} to ${r.prices.last_candle}. Of the ${r.windows_possible} possible ${r.days}-day windows, each seed uses one: ${r.windows.map((w) => `seed ${w.seed} from ${w.start.slice(0, 10)}`).join(", ")}. Trading cost ${r.cost_bps} bps of the notional per round trip (the shadow run's).`,
  );
  const ps = r.profile_summary;
  L.push(
    `- **The Intern:** \`${r.profile.model}\`'s ${ps.decisions} answered decisions in shadow run \`${r.profile.run_folder}\` (${r.profile.first_tick} to ${r.profile.last_tick}), read from the raw files and judged as the shadow report judges them (${r.profile.answer_rule} answer rule): ${ps.skips} skips, ${ps.bets} bets, ${ps.unreadable} unreadable answers; ${r.profile.failed} exchanges failed and are left out. Of the bets, ${ps.sizes.example} were exactly the rulebook's example amount, ${ps.sizes.max} exactly the largest margin allowed and ${ps.sizes.share} some other share of it; markets ${counts(ps.markets)}; sides ${counts(ps.sides)}; leverage ${counts(ps.leverages)}. When recorded (told rank ${r.profile.told.rank}, max_margin_e6 ${r.profile.told.max_margin_e6}, example ${r.profile.told.example_e6}) the verdicts were ${counts(r.profile.verdicts_when_recorded)}. Each round one answer is drawn at random from the record and sized against today's rulebook (src/sim/behaviour.ts).`,
  );
  L.push(
    `- **Ranks:** ${(["INTERN", "ANALYST", "TRADER"] as const).map((k) => `${k} ${RANKS[k].per_bet_bps / 100}% a bet, ${RANKS[k].per_round_bps / 100}% a round, ${RANKS[k].max_bets} ${RANKS[k].max_bets === 1 ? "bet" : "bets"}, ${RANKS[k].max_leverage}x`).join("; ")} (01 §3, PROPOSED).`,
  );
  L.push(
    "- **The control:** the same seeds with checks 6 to 12 switched off and the Intern told the whole idle pool is its limit; a bet is capped only by the idle pool and Hyperliquid's own maximum leverage, and must reach Hyperliquid's $10 minimum.",
  );
  L.push("");
  L.push("## Summary");
  L.push("");
  L.push(
    "Medians over the seeds, worst seed in brackets. Bets are per run (a mean); rank changes and votes are totals over all seeds.",
  );
  L.push("");
  L.push(
    "| Scenario | Limits | Coin price: start → end | Deepest fall | BRAVE pool: start / lowest / end | Coin supply: start → end | Bets a run: YES / refused / skipped | Bets' net result a run | Rank changes; votes passed / opened | Pass marks |",
  );
  L.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const s of r.scenarios) {
    const passed = s.marks.filter((o) => o.limits.pass).length;
    const failed = s.marks.filter((o) => !o.limits.pass).map((o) => o.mark.id);
    const ctlPassed = s.marks.filter((o) => o.control?.pass).length;
    L.push(
      armRow(
        s.scenario.name,
        "on",
        s.limits,
        `${passed} of ${s.marks.length}${failed.length > 0 ? `; **FAIL ${failed.join(", ")}**` : ""}`,
      ),
    );
    L.push(armRow("", "off", s.control, `(${ctlPassed} of ${s.marks.length} would pass)`));
  }
  L.push("");
  L.push("## Pass or fail");
  L.push("");
  L.push("| Mark | Scenario | Result, limits on | Worst seed | Limits off (contrast) |");
  L.push("|---|---|---|---|---|");
  for (const o of [...r.global, ...r.scenarios.flatMap((s) => s.marks)]) {
    L.push(
      `| ${o.mark.id} | ${o.scenario} | ${verdictCell(o)} | ${one(o.limits.worst)} | ${controlCell(o)} |`,
    );
  }
  L.push("");
  L.push("## Scenario by scenario");
  L.push("");
  for (const s of r.scenarios) L.push(...detail(s, base));
  L.push("## Scenario inputs (assumed, not contract rules)");
  L.push("");
  L.push("The baseline community; each scenario above says what it changes.");
  L.push("");
  L.push("| Input | Baseline | Meaning |");
  L.push("|---|---|---|");
  for (const k of Object.keys(base) as (keyof CommunityInputs)[]) {
    L.push(`| ${k} | ${JSON.stringify(base[k])} | ${COMMUNITY_TEXT[k]} |`);
  }
  L.push("");
  L.push("## Not modeled");
  L.push("");
  for (const x of NOT_MODELED) L.push(`- ${x}`);
  L.push("");
  L.push("## Stand-ins");
  L.push("");
  for (const x of STAND_INS) L.push(`- ${x}`);
  L.push("");
  return `${L.join("\n")}\n`;
}

/**
 * Everything in the report, and every run with its day-by-day pool, price and supply, as JSON (bigints written as
 * decimal strings). Written compact: it is for programs; the markdown is for people.
 */
export function formatJson(r: ReportInput, base: CommunityInputs): string {
  const data = {
    kind: "SIMULATION",
    note: "A simulation on past prices and recorded AI answers with assumed community behaviour. Not a forecast.",
    generated_at: r.generated_at,
    days: r.days,
    seeds: r.seeds,
    round_minutes: r.round_minutes,
    rounds: r.rounds,
    clock: r.clock,
    prices: r.prices,
    windows: r.windows,
    windows_possible: r.windows_possible,
    cost_bps: r.cost_bps,
    runner_asks: r.runner_asks,
    intern: { profile: { ...r.profile, decisions: undefined }, summary: r.profile_summary },
    baseline_community: base,
    pass_marks: {
      global: r.global,
      scenarios: r.scenarios.flatMap((s) => s.marks),
    },
    scenarios: r.scenarios.map((s) => ({
      name: s.scenario.name,
      title: s.scenario.title,
      about: s.scenario.about,
      inputs: s.scenario,
      limits: s.limits,
      control: s.control,
      line: s.line,
      runs: s.runs,
    })),
    not_modeled: NOT_MODELED,
    stand_ins: STAND_INS,
  };
  return `${JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}\n`;
}
