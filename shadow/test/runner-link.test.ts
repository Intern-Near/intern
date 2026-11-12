import assert from "node:assert/strict";
import { describe, it } from "node:test";
// The shadow run reuses the runner's code by relative import (no package link, nothing outside our folders).
// Run `npm ci` in ../runner first.
import { MARKETS } from "../../runner/src/markets.ts";
import { SIGNED_CHAT_MODELS } from "../../runner/src/nearai.ts";

describe("shared code from ../runner", () => {
  it("imports the six markets and the four signed models", () => {
    assert.deepEqual(
      MARKETS.map((m) => m.market),
      ["DOGE", "SHIB", "PEPE", "PENGU", "WIF", "TRUMP"],
    );
    assert.equal(SIGNED_CHAT_MODELS.length, 4);
  });
});
