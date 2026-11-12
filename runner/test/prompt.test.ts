import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { changePct, marketDataMessage } from "../src/prompt.ts";

describe("user message market data", () => {
  it("formats the 24-hour change with a sign and two decimals", () => {
    assert.equal(changePct("1.1459", "1.1303"), "+1.38%");
    assert.equal(changePct("0.068391", "0.068731"), "-0.49%");
    assert.equal(changePct("1", "1"), "+0.00%");
    assert.equal(changePct("0.99999999", "1"), "+0.00%");
    assert.equal(changePct("1", "0"), "n/a");
  });

  it("writes one line per market and marks the per-1,000 markets", () => {
    const text = marketDataMessage(
      [
        { market: "DOGE", hl_name: "DOGE", mark_px: "0.068391", prev_day_px: "0.068731", max_leverage: 10 },
        { market: "SHIB", hl_name: "kSHIB", mark_px: "0.004461", prev_day_px: "0.004418", max_leverage: 10 },
      ],
      "2026-11-11T15:00:00.000Z",
      "mainnet",
    );
    assert.equal(
      text,
      [
        "Market data: Hyperliquid perpetuals (mainnet), mark prices at 2026-11-11T15:00:00.000Z, with the change over 24 hours.",
        "DOGE: 0.068391 USD (24h -0.49%)",
        "SHIB: 0.004461 USD per 1,000 SHIB (24h +0.97%)",
      ].join("\n"),
    );
  });
});
