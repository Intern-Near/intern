import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULTS, validateConfig } from "../src/config.ts";
import { makeConfig } from "./helpers.ts";

describe("run settings", () => {
  it("defaults to the brief's protocol: 15 minutes, 72 hours, 10-hour hold, 17 bps, $1,000, INTERN", () => {
    assert.equal(DEFAULTS.interval_minutes, 15);
    assert.equal(DEFAULTS.duration_hours, 72);
    assert.equal(DEFAULTS.hold_hours, 10);
    assert.equal(DEFAULTS.tail_hours, 10);
    assert.equal(DEFAULTS.cost_bps, 17);
    assert.equal(DEFAULTS.pool_e6, "1000000000");
    assert.deepEqual(DEFAULTS.ranks, ["INTERN"]);
    assert.equal(DEFAULTS.rulebook, "01-v1.0");
    assert.equal(DEFAULTS.models.length, 4);
  });

  it("accepts a complete configuration", () => {
    const cfg = makeConfig({
      ranks: ["INTERN", "ANALYST", "TRADER"],
      thinking: "off",
      rulebook: "proposed-A",
    });
    assert.deepEqual(validateConfig(JSON.parse(JSON.stringify(cfg))).ranks, ["INTERN", "ANALYST", "TRADER"]);
  });

  it("refuses unknown choices and missing pins or prices", () => {
    const good = makeConfig();
    const bad = (patch: Record<string, unknown>, why: RegExp): void => {
      assert.throws(() => validateConfig({ ...good, ...patch }), why);
    };
    bad({ ranks: ["BOSS"] }, /ranks/);
    bad({ ranks: [] }, /ranks/);
    bad({ prompt_markets: "four" }, /prompt_markets/);
    bad({ thinking: "loud" }, /thinking/);
    bad({ rulebook: "01-v2" }, /rulebook/);
    bad({ instruction: "two\nlines" }, /instruction/);
    bad({ pool_e6: "0" }, /pool_e6/);
    bad({ interval_minutes: 90 }, /interval_minutes/);
    bad({ pinned: {} }, /no pinned ecdsa signer/);
    bad({ prices_per_mtok: {} }, /no token prices/);
    assert.throws(() => validateConfig({ ...good, format: 2 }), /format 1/);
  });
});

describe("run settings for a second run alongside", () => {
  it("accepts a pressure set and an offset, and refuses bad ones", () => {
    const cfg = makeConfig({ offset_minutes: 7, pressure: { set: "pressure-v1", messages: ["a", "b"] } });
    assert.equal(validateConfig(JSON.parse(JSON.stringify(cfg))).offset_minutes, 7);
    const bad = (patch: Record<string, unknown>, why: RegExp): void => {
      assert.throws(() => validateConfig({ ...makeConfig(), ...patch }), why);
    };
    bad({ offset_minutes: 15 }, /offset_minutes/);
    bad({ offset_minutes: -1 }, /offset_minutes/);
    bad({ offset_minutes: 2.5 }, /offset_minutes/);
    bad({ pressure: { set: "", messages: ["a"] } }, /pressure/);
    bad({ pressure: { set: "x", messages: [] } }, /pressure/);
    bad({ pressure: { set: "x", messages: ["two\nlines"] } }, /pressure/);
  });

  it("still accepts a run without them (the plain run's settings)", () => {
    const cfg = JSON.parse(JSON.stringify(makeConfig())) as Record<string, unknown>;
    assert.equal(cfg.offset_minutes, undefined);
    assert.equal(cfg.pressure, undefined);
    assert.doesNotThrow(() => validateConfig(cfg));
  });
});
