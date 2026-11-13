import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkRule, type FollowRule, nextFollow } from "../src/follow.ts";
import type { FeedItem } from "../src/tailfade.ts";

const T = Date.parse("2026-11-13T18:00:00Z");
const feed: FeedItem[] = [
  { seq: 1, at: T - 60_000, event: "approved", data: { position_id: 7, round_id: 60, market: "PEPE", side: "LONG", margin: "11000000", leverage: 1 } },
  { seq: 2, at: T - 50_000, event: "order_signed", data: { action_id: 1, position_id: 7, kind: "LEVERAGE" } },
  { seq: 3, at: T - 40_000, event: "order_signed", data: { action_id: 2, position_id: 7, kind: "OPEN" } },
];
const rule: FollowRule = { choice: "TAIL", chipUsd: 10, leverage: 2, maxPerDay: 2 };

describe("01 1.7: following the Intern with one rule", () => {
  it("checks the rule", () => {
    assert.equal(checkRule(rule), null);
    assert.match(checkRule({ ...rule, chipUsd: 50 as 10 }) ?? "", /chip/);
    assert.match(checkRule({ ...rule, maxPerDay: 0 }) ?? "", /maxPerDay/);
  });
  it("follows an open window once, and at most maxPerDay a day", () => {
    const w = nextFollow(feed, rule, new Set(), [], T);
    assert.deepEqual([w?.position_id, w?.market, w?.side], [7, "PEPE", "LONG"]);
    assert.equal(nextFollow(feed, rule, new Set([7]), [T - 1_000], T), null, "already followed");
    assert.equal(nextFollow(feed, rule, new Set(), [T - 1_000, T - 2_000], T), null, "two today already");
    assert.notEqual(nextFollow(feed, rule, new Set(), [T - 90_000_000, T - 2_000], T), null, "one is older than a day");
    assert.equal(nextFollow(feed, rule, new Set(), [], T + 11 * 60_000), null, "the window closed");
  });
});
