// npm run sim -- [--days 60] [--seeds 5] [--scenario all|<name>] [--round-minutes 1440|30] [--out <dir>]
//                [--model z-ai/glm-5.3-flash] [--behaviour-run data/2026-11-11-intern] [--answer-rule strict|trim]
//                [--prices fixtures/sim/hl-candles-2026-11-13]
//
// The 60-day simulation of the $INTERN coin (src/sim/). Offline: it reads the saved price fixture and the shadow run's
// raw files, and writes <out>/sim-report.md, <out>/sim-report.json and <out>/projection-kit.json (the inputs the
// website's projection would need). Default --out: data/sim/<round-minutes>m. Nothing is fetched, signed or sent.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AnswerRule } from "../../../runner/src/judge.ts";
import { DEFAULT_SETTINGS } from "../../../runner/src/round.ts";
import { readConfig } from "../config.ts";
import { summarize } from "./behaviour.ts";
import { BASELINE_COMMUNITY } from "./community.ts";
import { type Arm, runSim, type SimConfig } from "./engine.ts";
import { buildProfile, loadPriceFixture } from "./load.ts";
import { type RunResult, resultOf } from "./metrics.ts";
import { formatJson, formatMarkdown, type ReportInput } from "./output.ts";
import { CANDLE_MS, moveTable, windowStarts } from "./prices.ts";
import { hashSeed } from "./rng.ts";
import { clockFor, PINNED_MODEL, roundsPerDay } from "./rules01.ts";
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
const scenarioFlag = flag("--scenario") ?? "all";
const model = flag("--model") ?? PINNED_MODEL;
const behaviourRun = resolve(flag("--behaviour-run") ?? "data/2026-11-11-intern");
const answerRule = (flag("--answer-rule") ?? "strict") as AnswerRule;
if (answerRule !== "strict" && answerRule !== "trim") die("--answer-rule must be strict or trim");
const outDir = resolve(flag("--out") ?? `data/sim/${roundMinutes}m`);

let clock: ReturnType<typeof clockFor>;
try {
  clock = clockFor(roundMinutes);
} catch (e) {
  die(e instanceof Error ? e.message : String(e));
}
let scenarios: Scenario[];
try {
  scenarios = scenarioFlag === "all" ? SCENARIOS : [scenarioByName(scenarioFlag)];
} catch (e) {
  die(e instanceof Error ? e.message : String(e));
}

const fixture = loadPriceFixture(resolve(flag("--prices") ?? newestPrices()));
const profile = buildProfile(behaviourRun, model, { answerRule, scheme: "ed25519" });
const costBps = readConfig(behaviourRun).cost_bps;
const rounds = days * roundsPerDay(clock);
const starts = windowStarts(fixture.book, clock, rounds);
if (starts.length === 0) die(`the price fixture does not hold ${days} days of rounds`);
const windowFor = (seed: number): number => starts[hashSeed(seed, "window") % starts.length] ?? 0;

console.error(
  `simulating ${scenarios.length} scenario(s) x ${seeds} seed(s) x 2 arms, ${rounds} rounds of ${roundMinutes} minutes; ${model}: ${profile.decisions.length} recorded decisions`,
);
const t0 = Date.now();
const results = scenarios.map((scenario) => {
  const runs: RunResult[] = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const start = windowFor(seed);
    const moves = moveTable(fixture.book, clock, start, rounds);
    for (const arm of ["limits", "control"] as Arm[]) {
      const rpd = roundsPerDay(clock);
      const cfg: SimConfig = {
        clock,
        rounds,
        arm,
        intern:
          scenario.intern === "max" ? { kind: "max" } : { kind: "recorded", decisions: profile.decisions },
        asks: scenario.asks === "until-full" ? "until-full" : DEFAULT_SETTINGS.maxAsks,
        moves,
        cost_bps: costBps,
        losing: scenario.losing
          ? {
              from_round: (scenario.losing.from_day - 1) * rpd + 1,
              to_round: (scenario.losing.from_day - 1 + scenario.losing.days) * rpd,
            }
          : null,
        community: scenario.community,
        whale: scenario.whale,
        fakes: scenario.fakes,
        run: scenario.run,
        seed,
      };
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
    start: new Date(windowFor(i + 1)).toISOString(),
  })),
  windows_possible: starts.length,
  profile,
  profile_summary: summarize(profile.decisions),
  cost_bps: costBps,
  runner_asks: DEFAULT_SETTINGS.maxAsks,
  scenarios: results,
  global: globalOutcomes(results.flatMap((s) => s.runs)),
};

mkdirSync(outDir, { recursive: true });
const markdown = formatMarkdown(report, BASELINE_COMMUNITY);
writeFileSync(join(outDir, "sim-report.md"), markdown);
writeFileSync(join(outDir, "sim-report.json"), formatJson(report, BASELINE_COMMUNITY));
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
const start = markdown.indexOf("## Summary");
const end = markdown.indexOf("## Scenario by scenario");
console.log(markdown.slice(start, end).trim());
console.log(`\nwrote ${join(outDir, "sim-report.md")}, sim-report.json and projection-kit.json`);
