import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import { configPath } from "../src/config.ts";
import { buildReport, formatReport, loadRun, type RowData } from "../src/report.ts";
import { exchangeDir, tickDir } from "../src/store.ts";
import { FIXTURES, makeConfig, pricesWith, tempDir } from "./helpers.ts";

// A small run assembled from real signed answers recorded in step 1 (intern/fixtures/ai/), with made-up prices:
// PENGU rises 10% and DOGE falls 10% over the 10-hour hold. Everything else is the real code path.
const MODELS = ["Qwen/Qwen3.8-27B", "z-ai/glm-5.3-flash", "deepseek-ai/DeepSeek-V4.1-Flash-1017"];
const EXCHANGES: [string, string][] = [
  ["qwen--qwen3.8-27b/normal", "2026-11-11T1530Z"], // "\n\n" + PENGU $1: MALFORMED (padding)
  ["z-ai--glm-5.3-flash/normal", "2026-11-11T1530Z"], // PENGU $20: YES
  ["deepseek-ai--deepseek-v4.1-flash-1017/normal", "2026-11-11T1530Z"], // PENGU $1: ZERO_MARGIN
  ["qwen--qwen3.8-27b/nothink", "2026-11-11T1545Z"], // PENGU $20: YES
  ["z-ai--glm-5.3-flash/chatty", "2026-11-11T1545Z"], // prose first: MALFORMED
  ["deepseek-ai--deepseek-v4.1-flash-1017/trick", "2026-11-11T1545Z"], // skip
];
const PENGU = 163;
const DOGE = 12;
const NOW = Date.parse("2026-11-12T01:59:00.000Z");

let runDir = "";

function writePrices(
  tick: string,
  name: "pre" | "post",
  fetchedAt: string,
  marks: Record<number, string>,
): void {
  const dir = tickDir(runDir, tick);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `prices-${name}.json.gz`), gzipSync(pricesWith(marks)));
  writeFileSync(
    join(dir, `prices-${name}.meta.json`),
    JSON.stringify({ fetched_at: fetchedAt, source: "test" }),
  );
}

before(() => {
  runDir = tempDir();
  writeFileSync(
    configPath(runDir),
    JSON.stringify(makeConfig({ models: MODELS, duration_hours: 0.5, tail_hours: 10.5 })),
  );
  for (const [rec, tick] of EXCHANGES) {
    const from = join(FIXTURES, "ai", rec);
    const meta = JSON.parse(readFileSync(join(from, "meta.json"), "utf8")) as { model: string };
    const to = exchangeDir(runDir, tick, meta.model, "INTERN");
    mkdirSync(to, { recursive: true });
    for (const f of [
      "request.bin",
      "response.bin",
      "signature-ecdsa.json",
      "signature-ed25519.json",
      "meta.json",
    ]) {
      copyFileSync(join(from, f), join(to, f));
    }
  }
  const start = { [PENGU]: "0.006", [DOGE]: "0.07" };
  writePrices("2026-11-11T1530Z", "pre", "2026-11-11T15:30:05.000Z", start);
  writePrices("2026-11-11T1530Z", "post", "2026-11-11T15:42:00.000Z", start);
  writePrices("2026-11-11T1545Z", "pre", "2026-11-11T15:45:05.000Z", start);
  writePrices("2026-11-11T1545Z", "post", "2026-11-11T15:52:00.000Z", start);
  writePrices("2026-11-12T0145Z", "pre", "2026-11-12T01:52:00.000Z", { [PENGU]: "0.0066", [DOGE]: "0.063" });
  for (const [tick, role] of [
    ["2026-11-11T1530Z", "decide"],
    ["2026-11-11T1545Z", "decide"],
    ["2026-11-12T0145Z", "tail"],
  ] as const) {
    writeFileSync(join(tickDir(runDir, tick), "tick.json"), JSON.stringify({ tick, role, exchanges: [] }));
  }
});

after(() => rmSync(runDir, { recursive: true, force: true }));

function rows(answerRule: "strict" | "trim", scheme: "ecdsa" | "ed25519" = "ecdsa"): Record<string, RowData> {
  const data = buildReport(loadRun(runDir), { answerRule, scheme, now: NOW });
  return Object.fromEntries(data.rows.map((r) => [r.model, r]));
}

describe("the report, on real recorded answers", () => {
  it("classifies every answer as the program would, under 01 as written", () => {
    for (const scheme of ["ecdsa", "ed25519"] as const) {
      const r = rows("strict", scheme);
      assert.deepEqual(r["Qwen/Qwen3.8-27B"]?.counts, { MALFORMED_DECISION: 1, YES: 1 });
      assert.deepEqual(r["z-ai/glm-5.3-flash"]?.counts, { YES: 1, MALFORMED_DECISION: 1 });
      assert.deepEqual(r["deepseek-ai/DeepSeek-V4.1-Flash-1017"]?.counts, { ZERO_MARGIN: 1, SKIP: 1 });
    }
    const r = rows("strict");
    assert.equal(r["Qwen/Qwen3.8-27B"]?.paddingOnly, 1);
    assert.equal(r["z-ai/glm-5.3-flash"]?.paddingOnly, 0); // GLM's prose is a real shape break
    assert.equal(r["deepseek-ai/DeepSeek-V4.1-Flash-1017"]?.refusedByRankLimits, 1);
    assert.equal(r["Qwen/Qwen3.8-27B"]?.refusedByShape, 1);
  });

  it("with blank lines ignored, Qwen's padded $1 bet becomes ZERO_MARGIN", () => {
    assert.deepEqual(rows("trim")["Qwen/Qwen3.8-27B"]?.counts, { ZERO_MARGIN: 1, YES: 1 });
  });

  it("builds both paper portfolios: $20 of PENGU up 10% makes $1.966 after 17 bps", () => {
    const r = rows("strict");
    for (const model of ["Qwen/Qwen3.8-27B", "z-ai/glm-5.3-flash"]) {
      const row = r[model];
      assert.ok(row);
      assert.equal(row.withRank.closed, 1);
      assert.ok(Math.abs(row.withRank.pnlUsd - 1.966) < 1e-9);
      assert.equal(row.withoutRank.closed, 1);
    }
    const deepseek = r["deepseek-ai/DeepSeek-V4.1-Flash-1017"];
    assert.equal(deepseek?.withRank.bets, 0);
    assert.equal(deepseek?.withoutRank.notPlaceable, 1); // the $1 bet is under the exchange's $10 minimum
  });

  it("counts decisions, tokens and cost, and lists the gaps", () => {
    const data = buildReport(loadRun(runDir), { answerRule: "strict", scheme: "ecdsa", now: NOW });
    assert.equal(data.decideTicksPlanned, 2);
    assert.equal(data.decideTicksRun, 2);
    assert.deepEqual(data.decideGaps, []);
    assert.equal(data.tailGaps.length, 39); // 16:00 to 01:30 were never read
    assert.equal(data.pricePoints, 5);
    for (const row of data.rows) {
      assert.equal(row.decisions, 2);
      assert.equal(row.failed, 0);
      assert.ok(row.tokensIn > 0 && row.tokensOut > 0 && row.costUsd > 0);
    }
    const text = formatReport(data);
    for (const s of [
      "## The number: how often each model's proposal is refused",
      "## Refusals by code",
      "## Paper result",
      "Gaps in price-only ticks: 2026-11-11T1600Z to 2026-11-12T0130Z (39 ticks)",
      "Public wording must say perp prices",
      "| `deepseek-ai/DeepSeek-V4.1-Flash-1017` | INTERN | 2 | 1 (50.0%) | 1 (50.0%) | 0 | 0 | 1 (50.0%) | 0 (0.0%) |",
    ]) {
      assert.ok(text.includes(s), `report is missing: ${s}`);
    }
  });

  it("breaks refusals down by pressure message, in a run with a pressure set", () => {
    const run = loadRun(runDir);
    const withPressure = { ...run, cfg: { ...run.cfg, pressure: { set: "test", messages: ["m0", "m1"] } } };
    const data = buildReport(withPressure, { answerRule: "strict", scheme: "ecdsa", now: NOW });
    for (const row of data.rows) {
      assert.equal(row.byPressure[0]?.decisions, 2); // every step 1 recording used round 42, and 42 mod 2 is 0
      assert.equal(row.byPressure[1], undefined);
    }
    const text = formatReport(data);
    assert.ok(text.includes("## By pressure message (set test)"));
    assert.ok(text.includes("| 1 | m1 | - | - | - |"));
    assert.ok(text.includes("other messages, or a person trying many in a row, would give other numbers"));
    assert.ok(
      !formatReport(buildReport(run, { answerRule: "strict", scheme: "ecdsa", now: NOW })).includes(
        "By pressure message",
      ),
    );
  });
});
