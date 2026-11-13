import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MARKETS, type Market } from "../../runner/src/markets.ts";
import {
  buildBook,
  CANDLE_MS,
  type Candle,
  candleRequest,
  moveOver,
  moveTable,
  parseCandles,
  windowStarts,
} from "../src/sim/prices.ts";
import { DEMO_CLOCK, PRODUCT_CLOCK } from "../src/sim/rules01.ts";
import { prices } from "./sim-fixtures.ts";

const DAY0 = Date.parse("2026-09-01T00:00:00Z");
const c = (t: number, o: number, h: number, l: number, cl: number): Record<string, unknown> => ({
  t,
  T: t + CANDLE_MS - 1,
  s: "DOGE",
  i: "30m",
  o: String(o),
  h: String(h),
  l: String(l),
  c: String(cl),
  v: "1.0",
  n: 1,
});

describe("Hyperliquid candles", () => {
  it("the request is the docs' candleSnapshot shape", () => {
    assert.equal(
      candleRequest("kPEPE", 1, 2),
      '{"type":"candleSnapshot","req":{"coin":"kPEPE","interval":"30m","startTime":1,"endTime":2}}',
    );
  });

  it("reads prices exactly, sorted, without duplicates; refuses a wrong coin, interval or shape", () => {
    const body = JSON.stringify([
      c(DAY0 + CANDLE_MS, 0.1, 0.11, 0.09, 0.105),
      c(DAY0, 0.1, 0.1, 0.1, 0.1),
      c(DAY0, 0.1, 0.1, 0.1, 0.1),
    ]);
    const list = parseCandles(body, "DOGE");
    assert.equal(list.length, 2);
    assert.equal(list[0]?.t, DAY0);
    assert.equal(list[1]?.c, 10_500_000n);
    assert.throws(() => parseCandles(body, "WIF"), /coin DOGE, expected WIF/);
    assert.throws(
      () => parseCandles(JSON.stringify([{ ...c(DAY0, 1, 1, 1, 1), i: "1h" }]), "DOGE"),
      /interval/,
    );
    assert.throws(() => parseCandles(JSON.stringify([c(DAY0 + 1, 1, 1, 1, 1)]), "DOGE"), /grid/);
    assert.throws(() => parseCandles(JSON.stringify([c(DAY0, 1, 1, 1.5, 1)]), "DOGE"), /bound/);
  });
});

/** A book where every market climbs 1% a candle from 100, with lows 2% under the open and highs 3% over it. */
function climbingBook(count: number): ReturnType<typeof buildBook> {
  const byMarket = {} as Record<Market, Candle[]>;
  for (const { market } of MARKETS) {
    byMarket[market] = Array.from({ length: count }, (_, i) => {
      const o = BigInt(Math.round(100 * 1.01 ** i * 1e6)) * 100n;
      const close = BigInt(Math.round(100 * 1.01 ** (i + 1) * 1e6)) * 100n;
      return { t: DAY0 + i * CANDLE_MS, o, c: close, l: (o * 98n) / 100n, h: (close * 103n) / 100n };
    });
  }
  return buildBook(byMarket, DAY0 + count * CANDLE_MS);
}

describe("a bet's move over its hold", () => {
  const book = climbingBook(48 * 3);

  it("24-hour rounds: from the 12:00 candle's open to the 21:30 candle's close (01 §5)", () => {
    const m = moveOver(
      book,
      "DOGE",
      DAY0 + PRODUCT_CLOCK.propose_from_ms,
      DAY0 + PRODUCT_CLOCK.close_from_ms,
    );
    // 12:00 is candle 24, 21:30 is candle 43: 20 candles of +1%.
    assert.ok(m);
    assert.ok(Math.abs(m.exit_ppm - 1.01 ** 20 * 1e6) <= 1, String(m.exit_ppm));
    assert.equal(m.low_ppm, 980_000);
  });

  it("30-minute rounds: the whole candle", () => {
    const m = moveOver(book, "PEPE", DAY0 + DEMO_CLOCK.propose_from_ms, DAY0 + DEMO_CLOCK.close_from_ms);
    assert.ok(m);
    assert.equal(m.exit_ppm, 1_010_000);
    assert.equal(m.high_ppm, 1_040_300);
  });

  it("windows fit inside the book; a table has one move per round", () => {
    assert.deepEqual(windowStarts(book, PRODUCT_CLOCK, 2), [DAY0, DAY0 + 86_400_000]);
    assert.deepEqual(windowStarts(book, PRODUCT_CLOCK, 4), []);
    const t = moveTable(book, PRODUCT_CLOCK, DAY0, 3);
    assert.equal(t.moves.TRUMP.length, 3);
    assert.ok(t.moves.TRUMP.every((m) => m !== null));
  });

  it("a gap gives no move", () => {
    const gappy = climbingBook(48);
    gappy.candles.WIF[30] = null;
    assert.equal(
      moveOver(gappy, "WIF", DAY0 + PRODUCT_CLOCK.propose_from_ms, DAY0 + PRODUCT_CLOCK.close_from_ms),
      null,
    );
  });
});

describe("the saved fixture (fetched 2026-11-13)", () => {
  it("holds about 104 days of all six markets, closed candles only, no gaps", () => {
    const fx = prices();
    assert.equal(fx.url, "https://api.hyperliquid.xyz/info");
    assert.equal(fx.book.first_t, Date.parse("2026-08-01T09:30:00Z"));
    assert.equal(fx.book.count, 5_000, "5001 fetched, the last still open when fetched");
    for (const { market } of MARKETS)
      assert.ok(
        fx.book.candles[market].every((x) => x !== null),
        market,
      );
    assert.equal(windowStarts(fx.book, PRODUCT_CLOCK, 60).length, 45);
  });
});
