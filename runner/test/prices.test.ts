import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parsePrices } from "../src/hyperliquid.ts";

// The real reply to POST https://api.hyperliquid.xyz/info {"type":"metaAndAssetCtxs"} used for the first
// step 1 recordings, saved by `npm run record`.
const SNAPSHOT = new URL(
  "../../fixtures/hl/info/2026-11-11T153837Z/metaAndAssetCtxs-mainnet.json",
  import.meta.url,
);
const BODY = readFileSync(SNAPSHOT, "utf8");

describe("Hyperliquid prices", () => {
  it("reads the six markets' prices at 01 §4's mainnet indexes", () => {
    const rows = parsePrices(BODY, "mainnet");
    assert.deepEqual(
      rows.map((r) => `${r.market}=${r.hl_name}`),
      ["DOGE=DOGE", "SHIB=kSHIB", "PEPE=kPEPE", "PENGU=PENGU", "WIF=WIF", "TRUMP=TRUMP"],
    );
    for (const r of rows) {
      assert.match(r.mark_px, /^[0-9]+(\.[0-9]+)?$/);
      assert.match(r.prev_day_px, /^[0-9]+(\.[0-9]+)?$/);
    }
  });

  it("fails loudly when a market is not at the expected index", () => {
    const data = JSON.parse(BODY) as [{ universe: { name: string }[] }, unknown[]];
    const doge = data[0].universe[12];
    assert.ok(doge !== undefined);
    doge.name = "NOTDOGE";
    assert.throws(() => parsePrices(JSON.stringify(data), "mainnet"), /index 12 is NOTDOGE, not DOGE/);
  });

  it("fails on the wrong shape", () => {
    assert.throws(() => parsePrices("{}", "mainnet"), /expected \[meta, contexts\]/);
    assert.throws(() => parsePrices('[{"universe":[]},[{}]]', "mainnet"), /differ in length/);
  });
});
