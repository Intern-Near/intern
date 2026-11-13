import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { summarize } from "../src/sim/behaviour.ts";
import { BASELINE_COMMUNITY } from "../src/sim/community.ts";
import { runSim } from "../src/sim/engine.ts";
import { type RunResult, resultOf } from "../src/sim/metrics.ts";
import { formatJson, formatMarkdown, type ReportInput } from "../src/sim/output.ts";
import { clockFor } from "../src/sim/rules01.ts";
import { SCENARIOS } from "../src/sim/scenarios.ts";
import { globalOutcomes, summarizeScenario } from "../src/sim/summary.ts";
import { config, flatMoves, SOME_ANSWERS } from "./sim-fixtures.ts";

function report(): ReportInput {
  const picked = SCENARIOS.filter((s) => s.name === "baseline" || s.name === "fake-farm");
  const scenarios = picked.map((s) => {
    const runs: RunResult[] = [];
    for (const seed of [1, 2]) {
      for (const arm of ["limits", "control"] as const) {
        const w = runSim(
          config({
            seed,
            arm,
            rounds: 15,
            moves: flatMoves(15, 990_000, 970_000, 1_020_000),
            fakes: s.fakes ? { ...s.fakes, count: 20 } : null,
          }),
        );
        runs.push(
          resultOf(w, { scenario: s.name, arm, seed, window_start: "2026-09-01T00:00:00.000Z", rounds: 15 }),
        );
      }
    }
    return summarizeScenario(s, runs);
  });
  return {
    generated_at: "2026-11-13T00:00:00.000Z",
    days: 15,
    seeds: 2,
    round_minutes: 1440,
    rounds: 15,
    clock: clockFor(1440),
    prices: { folder: "f", fetched_at: "t", url: "u", first_candle: "a", last_candle: "b" },
    windows: [{ seed: 1, start: "2026-09-01T00:00:00.000Z" }],
    windows_possible: 1,
    profile: {
      model: "m",
      run_folder: "r",
      answer_rule: "strict",
      first_tick: null,
      last_tick: null,
      told: { rank: "INTERN", max_margin_e6: "20000000", example_e6: "10000000" },
      decisions: SOME_ANSWERS,
      failed: 0,
      verdicts_when_recorded: {},
    },
    profile_summary: summarize(SOME_ANSWERS),
    cost_bps: 17,
    runner_asks: 1,
    scenarios,
    global: globalOutcomes(scenarios.flatMap((s) => s.runs)),
  };
}

describe("the report", () => {
  const r = report();
  const md = formatMarkdown(r, BASELINE_COMMUNITY);

  it("states the pass marks before any result, then pass or fail for each", () => {
    const marks = md.indexOf("## Pass marks (set before the results)");
    assert.ok(marks >= 0);
    assert.ok(marks < md.indexOf("## Summary"));
    assert.ok(marks < md.indexOf("## Pass or fail"));
    const table = md.slice(md.indexOf("## Pass or fail"), md.indexOf("## Scenario by scenario"));
    for (const id of ["G1", "G2", "BL1", "BL2", "FF1", "FF2", "FF3", "FF4"]) {
      assert.match(table, new RegExp(`\\| ${id} \\| [a-z-]+ \\| (PASS|\\*\\*FAIL\\*\\*)`), id);
    }
  });

  it("says what each scenario says, what is assumed and what is not modeled", () => {
    assert.equal((md.match(/\*\*What it says:\*\*/g) ?? []).length, 2);
    assert.match(md, /## Scenario inputs \(assumed, not contract rules\)/);
    assert.match(md, /## Not modeled/);
    assert.match(md, /## Stand-ins/);
    assert.match(md, /A simulation, not a forecast/);
  });

  it("the JSON carries every run and the pass marks", () => {
    const data = JSON.parse(formatJson(r, BASELINE_COMMUNITY)) as {
      kind: string;
      scenarios: { runs: unknown[] }[];
      pass_marks: { scenarios: unknown[] };
    };
    assert.equal(data.kind, "SIMULATION");
    assert.equal(data.scenarios[0]?.runs.length, 4);
    assert.equal(data.pass_marks.scenarios.length, 6);
  });
});
