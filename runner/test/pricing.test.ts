import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatScaled, limitPxE8, parseScaled, pxFormatOk } from "../src/pricing.ts";

describe("exact decimals", () => {
  it("reads Hyperliquid's strings exactly and refuses what does not fit", () => {
    assert.equal(parseScaled("0.06917", 8), 6_917_000n);
    assert.equal(parseScaled("722.0", 8), 72_200_000_000n);
    assert.equal(parseScaled("-3.625312", 6), -3_625_312n);
    assert.equal(parseScaled("0.0", 6), 0n);
    assert.throws(() => parseScaled("0.0000001", 6), /more than 6 decimals/);
    assert.throws(() => parseScaled("1e-5", 8), /not a decimal/);
    assert.throws(() => parseScaled(" 1.0", 8), /not a decimal/);
  });

  it("writes them back without trailing zeros", () => {
    assert.equal(formatScaled(6_986_100n, 8), "0.069861");
    assert.equal(formatScaled(14_300_000_000n, 8), "143");
    assert.equal(formatScaled(-3_625_312n, 6), "-3.625312");
  });
});

describe("Hyperliquid's price format (01 §4)", () => {
  it("at most 5 significant figures and 6 − size decimals", () => {
    assert.ok(pxFormatOk(parseScaled("0.068837", 8), 0)); // the probe's DOGE price
    assert.ok(!pxFormatOk(parseScaled("0.0688371", 8), 0)); // 7 decimals
    assert.ok(!pxFormatOk(parseScaled("0.12345", 8), 2)); // 5 decimals with 2 size decimals
    assert.ok(pxFormatOk(parseScaled("1.1721", 8), 1)); // TRUMP
    assert.ok(!pxFormatOk(parseScaled("1.17215", 8), 1)); // 6 significant figures
    assert.ok(pxFormatOk(parseScaled("74921", 8), 5)); // the probe's BTC-like price
    assert.ok(!pxFormatOk(0n, 0));
  });
});

describe("limit price of an immediate order", () => {
  // Mid prices from Hyperliquid testnet on 2026-11-11, 100 bps through the market.
  const cases: [string, boolean, number, string][] = [
    ["0.06917", true, 0, "0.069861"], // 0.0698617 → down to 6 decimals
    ["0.06917", false, 0, "0.068479"], // 0.0684783 → up
    ["1.16055", true, 1, "1.1721"], // 1.1721555 → 5 significant figures, down
    ["0.16519", true, 0, "0.16684"], // 0.1668419
    ["0.004484", true, 0, "0.004528"], // 0.00452884 → 6 decimals
    ["74000", true, 5, "74740"],
    ["99999", true, 0, "100990"], // crosses into six digits: 5 significant figures, down
  ];
  for (const [mid, buy, szd, want] of cases) {
    it(`${buy ? "buy" : "sell"} at mid ${mid} (size decimals ${szd}) → ${want}`, () => {
      assert.equal(formatScaled(limitPxE8(parseScaled(mid, 8), buy, 100, szd), 8), want);
    });
  }

  it("for random mids: always in format, never past the requested slippage, and close to it", () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let i = 0; i < 20_000; i++) {
      const midE8 = BigInt(Math.floor(10 ** (3 + rand() * 9))); // 0.00001 to 10,000
      const szd = Math.floor(rand() * 3);
      const bps = 1 + Math.floor(rand() * 500);
      const buy = rand() < 0.5;
      let px: bigint;
      try {
        px = limitPxE8(midE8, buy, bps, szd);
      } catch {
        continue; // a mid too small to write with 6 − szd decimals
      }
      assert.ok(pxFormatOk(px, szd), `${midE8} ${szd}`);
      const target = (midE8 * BigInt(buy ? 10_000 + bps : 10_000 - bps)) / 10_000n;
      if (buy) assert.ok(px <= target + 1n, `buy ${midE8} ${bps} → ${px} > ${target}`);
      else
        assert.ok(px * 10_000n >= midE8 * BigInt(10_000 - bps), `sell ${midE8} ${bps} → ${px} < ${target}`);
      // within one rounding step (5 significant figures, or the decimals rule) of the target
      const step = BigInt(Math.max(10 ** (2 + szd), 10 ** Math.max(0, target.toString().length - 5)));
      const diff = px > target ? px - target : target - px;
      assert.ok(diff <= step, `${midE8} ${bps} ${buy} → ${px}, target ${target}, step ${step}`);
    }
  });

  it("refuses a bad slippage or mid", () => {
    assert.throws(() => limitPxE8(0n, true, 100, 0), /positive/);
    assert.throws(() => limitPxE8(100n, true, 10_000, 0), /basis points/);
    assert.throws(() => limitPxE8(50n, false, 100, 0), /too coarse/); // 0.0000005: rounds up past the mid
    assert.throws(() => limitPxE8(40n, true, 100, 0), /format/); // 0.0000004: rounds down to zero
  });
});
