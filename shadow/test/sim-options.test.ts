import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Recorded } from "../src/sim/behaviour.ts";
import {
  ABUSE_CASES,
  CASES,
  compareProposals,
  formatOptionsJson,
  formatOptionsMarkdown,
  OPTION_CASES,
} from "../src/sim/options.ts";
import { PROPOSALS } from "../src/sim/proposals.ts";
import { PINNED_MODEL } from "../src/sim/rules01.ts";
import { prices, SOME_ANSWERS } from "./sim-fixtures.ts";

// The options report on a small run: every proposal against today's rules on the same seeds, and the abuse table.

const BROKEN: Recorded[] = [{ kind: "unreadable", code: "MALFORMED_DECISION" }];

describe("the options comparison", () => {
  const data = compareProposals({
    days: 8,
    seeds: 1,
    minutes: [1440],
    book: prices().book,
    profiles: { [PINNED_MODEL]: SOME_ANSWERS, "Qwen/Qwen3.8-27B": BROKEN },
    model: PINNED_MODEL,
    cost_bps: 17,
    runner_asks: 1,
    prices: "fixture",
    behaviour_run: "test",
  });
  data.generated_at = "2026-11-13T00:00:00.000Z";

  it("tries every proposal in its cases, each case run under today's rules too", () => {
    assert.deepEqual(
      data.options.map((o) => o.info.id),
      PROPOSALS.map((p) => p.id),
    );
    for (const o of data.options) {
      assert.deepEqual(
        o.comparisons.map((c) => c.case),
        OPTION_CASES[o.info.id],
      );
      for (const c of o.comparisons)
        assert.equal(c.today.blocked, 0, "today's rules block nothing by definition");
    }
    for (const name of [...Object.values(OPTION_CASES).flat(), ...ABUSE_CASES]) {
      assert.ok(
        CASES.some((c) => c.name === name),
        name,
      );
    }
  });

  it("labels everything a PROPOSAL and prints the summary, each option and the abuse table", () => {
    const md = formatOptionsMarkdown(data);
    assert.match(md, /\*\*PROPOSALS, not current rules\.\*\*/);
    const summary = md.slice(md.indexOf("## Summary"), md.indexOf("## a."));
    for (const p of PROPOSALS) {
      assert.match(summary, new RegExp(`\\| ${p.id}\\. `));
      assert.match(md, new RegExp(`## ${p.id}\\. .*\\(PROPOSAL\\)`));
    }
    assert.match(md, /## The abuse table/);
    assert.match(
      md,
      /\| Attack \| What it costs the attacker \| What it captures \| The defence today \| The risk left \|/,
    );
    assert.match(md, /### Attacks not modeled/);
    assert.doesNotMatch(md, /undefined|NaN/);
  });

  it("the JSON is small and says what it is", () => {
    const json = formatOptionsJson(data);
    assert.ok(json.length < 200_000, `${json.length} bytes`);
    const parsed = JSON.parse(json) as { kind: string; options: unknown[]; abuse: unknown[] };
    assert.equal(parsed.kind, "PROPOSALS");
    assert.equal(parsed.options.length, PROPOSALS.length);
    assert.ok(parsed.abuse.length > 0);
  });
});
