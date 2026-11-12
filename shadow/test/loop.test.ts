import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { after, describe, it } from "node:test";
import { configPath, type RunConfig } from "../src/config.ts";
import { type LoopDeps, runLoop } from "../src/loop.ts";
import { tickId } from "../src/schedule.ts";
import { tickDir } from "../src/store.ts";
import type { TickSummary } from "../src/tick.ts";
import { makeConfig, TEST_KEY, tempDir } from "./helpers.ts";

const MIN = 60_000;
const at = (hhmm: string): number => Date.parse(`2026-11-12T${hhmm}:00.000Z`);
const made: string[] = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** A run of 1 hour of decisions and 30 minutes of prices, with a virtual clock and a stand-in for the tick. */
function harness(
  startAt: number,
  tickTakesMs: number,
  existing: string[] = [],
  patch: Partial<RunConfig> = {},
) {
  const runDir = tempDir();
  made.push(runDir);
  writeFileSync(
    configPath(runDir),
    JSON.stringify(makeConfig({ duration_hours: 1, tail_hours: 0.5, ...patch })),
  );
  for (const id of existing) mkdirSync(tickDir(runDir, id), { recursive: true });
  let clock = startAt;
  const ran: string[] = [];
  const events: Record<string, unknown>[] = [];
  const deps: LoopDeps = {
    fetchFn: fetch,
    apiKey: TEST_KEY,
    now: () => clock,
    randomHex: () => "00",
    log: (e) => events.push(e),
    sleep: async (ms) => {
      clock += ms;
    },
    runTick: async (dir, _cfg, t, role) => {
      assert.equal(clock, t, "a tick runs exactly at its time");
      mkdirSync(tickDir(dir, tickId(t)), { recursive: true });
      ran.push(`${tickId(t).slice(11)} ${role}`);
      clock += tickTakesMs;
      return {} as TickSummary;
    },
  };
  return { runDir, deps, ran, events };
}

describe("the loop", () => {
  it("starts at the next quarter hour, decides for an hour, reads prices for half an hour, then stops", async () => {
    const h = harness(at("00:07"), 3 * MIN);
    assert.equal(await runLoop(h.runDir, h.deps), "finished");
    assert.deepEqual(h.ran, [
      "0015Z decide",
      "0030Z decide",
      "0045Z decide",
      "0100Z decide",
      "0115Z tail",
      "0130Z tail",
    ]);
    assert.equal(h.events[0]?.step, "run start");
    assert.equal(h.events.at(-1)?.step, "run finished");
  });

  it("after a restart, keeps the first tick on disk and picks up at the next tick time", async () => {
    const h = harness(at("00:40"), 3 * MIN, ["2026-11-12T0015Z", "2026-11-12T0030Z"]);
    await runLoop(h.runDir, h.deps);
    assert.deepEqual(h.ran, ["0045Z decide", "0100Z decide", "0115Z tail", "0130Z tail"]);
    assert.equal(h.events[0]?.step, "run resume");
    assert.equal(h.events[0]?.first_tick, "2026-11-12T0015Z");
  });

  it("does not run again a tick that had started before a restart", async () => {
    const h = harness(at("00:30"), 3 * MIN, ["2026-11-12T0015Z", "2026-11-12T0030Z"]);
    await runLoop(h.runDir, h.deps);
    assert.equal(h.ran[0], "0045Z decide");
  });

  it("never runs a missed tick late: a 20-minute tick leaves a gap", async () => {
    const h = harness(at("00:07"), 20 * MIN);
    await runLoop(h.runDir, h.deps);
    assert.deepEqual(h.ran, ["0015Z decide", "0045Z decide", "0115Z tail"]);
  });

  it("does nothing when started after the run is over", async () => {
    const h = harness(at("05:00"), 3 * MIN, ["2026-11-12T0015Z"]);
    assert.equal(await runLoop(h.runDir, h.deps), "finished");
    assert.deepEqual(h.ran, []);
  });

  it("with a 7-minute offset, ticks at :07, :22, :37 and :52", async () => {
    const h = harness(at("00:16"), 3 * MIN, [], { offset_minutes: 7 });
    await runLoop(h.runDir, h.deps);
    assert.deepEqual(h.ran, [
      "0022Z decide",
      "0037Z decide",
      "0052Z decide",
      "0107Z decide",
      "0122Z tail",
      "0137Z tail",
    ]);
  });
});
