// Guards the two runs started on 2026-11-11 (still running from this code): their run.json must load unchanged,
// and a tick with it must write exactly what the code wrote before ask_twice existed. Each case replays a real tick
// offline (test/replay.ts) and compares every file, call and event with test/golden/existing-runs.json.
//
// That snapshot was made by this test on the code of commit e6db110, before tick.ts and config.ts changed. Only if a
// change is meant to alter what every run writes, make it again:
//   SHADOW_WRITE_GOLDEN=1 node --test test/existing-runs.test.ts
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import { configPath, readConfig, validateConfig } from "../src/config.ts";
import { classify, loadRun } from "../src/report.ts";
import { exchangeDir } from "../src/store.ts";
import { runTick } from "../src/tick.ts";
import { tempDir } from "./helpers.ts";
import { DATA, replayTick, snapshot, type TickSnapshot } from "./replay.ts";

const GOLDEN = fileURLToPath(new URL("./golden/existing-runs.json", import.meta.url));
const WRITE = process.env.SHADOW_WRITE_GOLDEN === "1";
const golden: { ticks: Record<string, TickSnapshot> } = existsSync(GOLDEN)
  ? (JSON.parse(readFileSync(GOLDEN, "utf8")) as { ticks: Record<string, TickSnapshot> })
  : { ticks: {} };

const made: string[] = [];
const taken: Record<string, TickSnapshot> = {};
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
  if (WRITE) {
    const made_with =
      "shadow/test/existing-runs.test.ts on the code of commit e6db110, before ask_twice existed";
    writeFileSync(GOLDEN, `${JSON.stringify({ made_with, ticks: taken }, null, 2)}\n`);
  }
});

// The first decision tick of each run.
const CASES = [
  ["2026-11-11-intern", "2026-11-11T1645Z"],
  ["2026-11-11-intern-pressure", "2026-11-11T1707Z"],
] as const;

describe("the runs started on 2026-11-11, with this code", () => {
  for (const [run, tick] of CASES) {
    it(`${run}: run.json loads unchanged, and tick ${tick} writes what it wrote before ask_twice existed`, async () => {
      const real = join(DATA, run);
      const raw = readFileSync(configPath(real), "utf8");
      assert.deepEqual(validateConfig(JSON.parse(raw)), JSON.parse(raw), "nothing added, removed or changed");
      assert.equal("ask_twice" in JSON.parse(raw), false);

      const runDir = tempDir();
      made.push(runDir);
      writeFileSync(configPath(runDir), raw);
      const cfg = readConfig(runDir);
      const replay = replayTick(real, tick, cfg);
      mock.timers.enable({ apis: ["Date"], now: replay.now }); // the response time in meta.json reads Date.now()
      try {
        await runTick(runDir, cfg, replay.tickMs, "decide", replay.deps);
      } finally {
        mock.timers.reset();
      }

      // What the models were sent: byte for byte the requests of the live run.
      for (const model of cfg.models) {
        const name = join(exchangeDir(runDir, tick, model, "INTERN"), "request.bin");
        const live = join(exchangeDir(real, tick, model, "INTERN"), "request.bin");
        assert.ok(
          readFileSync(name).equals(readFileSync(live)),
          `${model}: the request differs from the live run's`,
        );
      }
      // One question per model; the answers are the live run's, and their signatures check against the pinned signers.
      const loaded = loadRun(runDir);
      assert.equal(loaded.exchanges.length, cfg.models.length);
      for (const rec of loaded.exchanges) {
        const v = classify(rec, cfg, { answerRule: "trim", scheme: "ed25519" }).verdict;
        assert.ok(v !== null && !(v.verdict === "NOPE" && v.code === "BAD_MODEL_SIGNATURE"), rec.model);
      }

      // Every file, call and event, as the code before ask_twice wrote them.
      const snap = snapshot(runDir, tick, replay);
      taken[`${run}/${tick}`] = snap;
      if (!WRITE) assert.deepEqual(snap, golden.ticks[`${run}/${tick}`]);
    });
  }
});
