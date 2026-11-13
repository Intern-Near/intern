// npm run sim -- [--days 60] [--seeds 5] [--scenario all|<name>] [--round-minutes 1440|30] [--out <dir>]
//                [--model z-ai/glm-5.3-flash] [--behaviour-run data/2026-11-11-intern] [--answer-rule strict|trim]
//                [--prices fixtures/sim/hl-candles-2026-11-13] [--proposal <name>[,<name>...]]
// npm run sim -- --compare-proposals [--days 60] [--seeds 5] [--round-minutes 1440|30] [--out <dir>]
//
// The 60-day simulation of the $INTERN coin (src/sim/). Offline: it reads the saved price fixture and the shadow run's
// raw files. Nothing is fetched, signed or sent.
// - The report: <out>/sim-report.md, <out>/sim-report.json and <out>/projection-kit.json (the inputs the website's
//   projection would need). Default --out: data/sim/<round-minutes>m. With --proposal, the named PROPOSALS (not
//   current rules, src/sim/proposals.ts) are switched on with the limits, the report says so, and the default --out is
//   data/sim/<round-minutes>m-<names>.
// - --compare-proposals: each proposal against today's rules on the same seeds, for both round lengths unless
//   --round-minutes is given; with the abuse table. Writes <out>/options-report.md and <out>/options.json (default
//   data/sim/options).
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AnswerRule } from "../../../runner/src/judge.ts";
import { DEFAULT_SETTINGS } from "../../../runner/src/round.ts";
import { readConfig } from "../config.ts";
import { type Recorded, summarize } from "./behaviour.ts";
import { BASELINE_COMMUNITY } from "./community.ts";
import { type Arm, runSim } from "./engine.ts";
import { buildProfile, loadPriceFixture } from "./load.ts";
import { type RunResult, resultOf } from "./metrics.ts";
import { CASES, compareProposals, formatOptionsJson, formatOptionsMarkdown } from "./options.ts";
import { formatJson, formatMarkdown, type ReportInput } from "./output.ts";
import { CANDLE_MS, moveTable } from "./prices.ts";
import { type Proposals, proposalsFrom } from "./proposals.ts";
import { clockFor, PINNED_MODEL, roundsPerDay } from "./rules01.ts";
import { scenarioConfig, windowOf, windowsFor } from "./runs.ts";
import { SCENARIOS, type Scenario, scenarioByName } from "./scenarios.ts";
import { globalOutcomes, summarizeScenario } from "./summary.ts";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function die(message: string): never {
  console.error(message);
  process.exit(2);
}

function whole(name: string, fallback: number, min: number, max: number): number {
  const raw = flag(name);
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) die(`${name} must be a whole number from ${min} to ${max}`);
  return n;
}

function attempt<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    die(e instanceof Error ? e.message : String(e));
  }
}

/** The newest candle fixture under fixtures/sim. */
function newestPrices(): string {
  const dir = resolve("fixtures/sim");
  const found = existsSync(dir)
    ? readdirSync(dir)
        .filter((d) => d.startsWith("hl-candles-"))
        .sort()
    : [];
  const last = found[found.length - 1];
  if (last === undefined) die("no price fixture in fixtures/sim (run: node src/sim/fetch.ts)");
  return join(dir, last);
}

const days = whole("--days", 60, 1, 365);
const seeds = whole("--seeds", 5, 1, 100);
const roundMinutes = whole("--round-minutes", 1440, 1, 1440);
const model = flag("--model") ?? PINNED_MODEL;
const behaviourRun = resolve(flag("--behaviour-run") ?? "data/2026-11-11-intern");
const answerRule = (flag("--answer-rule") ?? "strict") as AnswerRule;
if (answerRule !== "strict" && answerRule !== "trim") die("--answer-rule must be strict or trim");
const fixture = loadPriceFixture(resolve(flag("--prices") ?? newestPrices()));
const profileOf = (m: string): readonly Recorded[] =>
  attempt(() => buildProfile(behaviourRun, m, { answerRule, scheme: "ed25519" }).decisions);
const costBps = readConfig(behaviourRun).cost_bps;

if (process.argv.includes("--compare-proposals")) {
  const minutes = flag("--round-minutes") === undefined ? [1440, 30] : [roundMinutes];
  for (const m of minutes) attempt(() => clockFor(m));
  const models = new Set([model, ...CASES.flatMap((c) => (c.model ? [c.model] : []))]);
  const profiles: Record<string, readonly Recorded[]> = {};
  for (const m of models) profiles[m] = profileOf(m);
  const outDir = resolve(flag("--out") ?? "data/sim/options");
  const t0 = Date.now();
  const data = compareProposals(
    {
      days,
      seeds,
      minutes,
      book: fixture.book,
      profiles,
      model,
      cost_bps: costBps,
      runner_asks: DEFAULT_SETTINGS.maxAsks,
      prices: fixture.folder,
      behaviour_run: behaviourRun.split("/").pop() ?? "",
    },
    (line) => console.error(`  ${line} (${((Date.now() - t0) / 1000).toFixed(1)} s)`),
  );
  data.generated_at = new Date().toISOString();
  mkdirSync(outDir, { recursive: true });
  const markdown = formatOptionsMarkdown(data);
  writeFileSync(join(outDir, "options-report.md"), markdown);
  writeFileSync(join(outDir, "options.json"), formatOptionsJson(data));
  console.log(markdown.slice(markdown.indexOf("## Summary"), markdown.indexOf("## a.")).trim());
  console.log(`\nwrote ${join(outDir, "options-report.md")} and options.json`);
  process.exit(0);
}

const scenarioFlag = flag("--scenario") ?? "all";
const proposalNames = (flag("--proposal") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s !== "");
const proposals: Proposals | undefined =
  proposalNames.length > 0 ? attempt(() => proposalsFrom(proposalNames)) : undefined;
const outDir = resolve(
  flag("--out") ??
    (proposalNames.length > 0
      ? `data/sim/${roundMinutes}m-${proposalNames.join("-")}`
      : `data/sim/${roundMinutes}m`),
);
const clock = attempt(() => clockFor(roundMinutes));
const scenarios: Scenario[] = attempt(() =>
  scenarioFlag === "all" ? SCENARIOS : [scenarioByName(scenarioFlag)],
);
const profile = attempt(() => buildProfile(behaviourRun, model, { answerRule, scheme: "ed25519" }));
const rounds = days * roundsPerDay(clock);
const starts = windowsFor(fixture.book, clock, days);
if (starts.length === 0) die(`the price fixture does not hold ${days} days of rounds`);

console.error(
  `simulating ${scenarios.length} scenario(s) x ${seeds} seed(s) x 2 arms, ${rounds} rounds of ${roundMinutes} minutes; ${model}: ${profile.decisions.length} recorded decisions${proposals ? `; PROPOSALS: ${proposalNames.join(", ")}` : ""}`,
);
const t0 = Date.now();
const results = scenarios.map((scenario) => {
  const runs: RunResult[] = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const start = windowOf(starts, seed);
    const moves = moveTable(fixture.book, clock, start, rounds);
    for (const arm of ["limits", "control"] as Arm[]) {
      const cfg = scenarioConfig(scenario, {
        clock,
        days,
        arm,
        moves,
        cost_bps: costBps,
        seed,
        decisions: profile.decisions,
        runner_asks: DEFAULT_SETTINGS.maxAsks,
        ...(proposals ? { proposals } : {}),
      });
      const w = runSim(cfg);
      runs.push(
        resultOf(w, {
          scenario: scenario.name,
          arm,
          seed,
          window_start: new Date(start).toISOString(),
          rounds,
        }),
      );
    }
  }
  console.error(`  ${scenario.name}: done (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  return summarizeScenario(scenario, runs);
});

const first = fixture.book.first_t;
const report: ReportInput = {
  generated_at: new Date().toISOString(),
  days,
  seeds,
  round_minutes: roundMinutes,
  rounds,
  clock,
  prices: {
    folder: fixture.folder,
    fetched_at: fixture.fetched_at,
    url: fixture.url,
    first_candle: new Date(first).toISOString(),
    last_candle: new Date(first + (fixture.book.count - 1) * CANDLE_MS).toISOString(),
  },
  windows: Array.from({ length: seeds }, (_, i) => ({
    seed: i + 1,
    start: new Date(windowOf(starts, i + 1)).toISOString(),
  })),
  windows_possible: starts.length,
  profile,
  profile_summary: summarize(profile.decisions),
  cost_bps: costBps,
  runner_asks: DEFAULT_SETTINGS.maxAsks,
  proposals: proposalNames,
  scenarios: results,
  global: globalOutcomes(results.flatMap((s) => s.runs)),
};

mkdirSync(outDir, { recursive: true });
const markdown = formatMarkdown(report, BASELINE_COMMUNITY);
writeFileSync(join(outDir, "sim-report.md"), markdown);
writeFileSync(join(outDir, "sim-report.json"), formatJson(report, BASELINE_COMMUNITY));
if (!proposals) {
  // The projection's inputs for the website: the recorded answers and the latest window's price moves.
  const latest = starts[starts.length - 1] ?? 0;
  writeFileSync(
    join(outDir, "projection-kit.json"),
    `${JSON.stringify({
      label: "PROJECTION KIT",
      note: "Inputs for src/sim/projection.ts fastForward: recorded answers and past price moves. A projection is not a forecast.",
      round_minutes: roundMinutes,
      cost_bps: costBps,
      model,
      behaviour_run: profile.run_folder,
      prices: fixture.folder,
      decisions: profile.decisions,
      moves: moveTable(fixture.book, clock, latest, rounds),
    })}\n`,
  );
}
const start = markdown.indexOf("## Summary");
const end = markdown.indexOf("## Scenario by scenario");
console.log(markdown.slice(start, end).trim());
console.log(
  `\nwrote ${join(outDir, "sim-report.md")} and sim-report.json${proposals ? "" : " and projection-kit.json"}`,
);
