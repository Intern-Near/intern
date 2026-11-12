import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ceilTick,
  floorTick,
  HOUR_MS,
  isTickId,
  parseTickId,
  roundIdFor,
  tickId,
  tickRole,
  tickTimes,
} from "../src/schedule.ts";

const at = (iso: string): number => Date.parse(iso);

describe("the run's clock", () => {
  it("rounds to quarter hours in UTC", () => {
    const t = at("2026-11-12T00:07:30.000Z");
    assert.equal(new Date(floorTick(t, 15)).toISOString(), "2026-11-12T00:00:00.000Z");
    assert.equal(new Date(ceilTick(t, 15)).toISOString(), "2026-11-12T00:15:00.000Z");
    const on = at("2026-11-12T00:15:00.000Z");
    assert.equal(ceilTick(on, 15), on);
    assert.equal(floorTick(on, 15), on);
  });

  it("names ticks so the names sort in time order, and reads them back", () => {
    assert.equal(tickId(at("2026-11-12T00:15:00.000Z")), "2026-11-12T0015Z");
    assert.equal(parseTickId("2026-11-12T0015Z"), at("2026-11-12T00:15:00.000Z"));
    assert.ok(isTickId("2026-11-12T0015Z"));
    assert.ok(!isTickId("2026-11-12T00:15Z"));
    assert.ok(!isTickId("README.md"));
    assert.throws(() => parseTickId("2026-11-12"), /not a tick id/);
    const times = tickTimes(at("2026-11-11T23:00:00.000Z"), at("2026-11-12T01:00:00.000Z"), 15);
    const ids = times.map(tickId);
    assert.deepEqual([...ids].sort(), ids);
    assert.deepEqual(ids.map(parseTickId), times);
  });

  it("asks for decisions for 72 hours (288 ticks), then reads prices for 10 more (40 ticks)", () => {
    const first = at("2026-11-12T00:00:00.000Z");
    const cfg = { duration_hours: 72, tail_hours: 10 };
    const roles = tickTimes(first, first + 90 * HOUR_MS, 15).map((t) => tickRole(first, t, cfg));
    assert.equal(roles.filter((r) => r === "decide").length, 288);
    assert.equal(roles.filter((r) => r === "tail").length, 40);
    assert.equal(roles.filter((r) => r === "done").length, 32);
    assert.equal(tickRole(first, first + 72 * HOUR_MS - 1, cfg), "decide");
    assert.equal(tickRole(first, first + 72 * HOUR_MS, cfg), "tail");
    assert.equal(tickRole(first, first + 82 * HOUR_MS, cfg), "done");
  });

  it("gives every tick its own round id", () => {
    const t = at("2026-11-12T00:15:00.000Z");
    assert.equal(roundIdFor(t + 15 * 60_000, 15), roundIdFor(t, 15) + 1);
    assert.ok(Number.isSafeInteger(roundIdFor(t, 15)));
  });
});

describe("the run's clock with an offset", () => {
  it("puts ticks 7 minutes after each quarter hour", () => {
    const t = at("2026-11-12T00:16:00.000Z");
    assert.equal(new Date(ceilTick(t, 15, 7)).toISOString(), "2026-11-12T00:22:00.000Z");
    assert.equal(new Date(floorTick(t, 15, 7)).toISOString(), "2026-11-12T00:07:00.000Z");
    const on = at("2026-11-12T00:22:00.000Z");
    assert.equal(ceilTick(on, 15, 7), on);
    assert.equal(floorTick(at("2026-11-12T00:03:00.000Z"), 15, 7), at("2026-11-11T23:52:00.000Z"));
    assert.equal(tickId(on), "2026-11-12T0022Z");
    assert.equal(roundIdFor(on + 15 * 60_000, 15), roundIdFor(on, 15) + 1);
  });

  it("without an offset, behaves exactly as before", () => {
    const t = at("2026-11-12T00:07:30.000Z");
    assert.equal(ceilTick(t, 15, 0), ceilTick(t, 15));
    assert.equal(floorTick(t, 15, 0), floorTick(t, 15));
  });
});
