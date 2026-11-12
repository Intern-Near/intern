import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Fill, FundingPayment } from "../src/hl-exchange.ts";
import { type BetOnExchange, workOutReturned } from "../src/result.ts";

// What a bet returned, from fills in the shape Hyperliquid returns (field names as in the live replies of
// fixtures/hl/info/2026-11-11T173427Z/). The numbers are made up; no order of ours has ever filled.

const OPEN_AT = 1_794_400_000_000;
const CLOSE_AT = OPEN_AT + 600_000;
let tid = 0;
const fill = (dir: string, px: string, sz: string, fee: string, time: number, coin = "DOGE"): Fill => ({
  coin,
  px,
  sz,
  side: dir === "Open Long" || dir === "Close Short" ? "B" : "A",
  time,
  dir,
  closedPnl: "0.0",
  fee,
  feeToken: "USDC",
  oid: 9_000 + tid,
  tid: ++tid,
});

const long: BetOnExchange = {
  position_id: 1,
  coin: "DOGE",
  side: "LONG",
  margin_e6: 20_000_000n,
  ordered_sz_e8: 28_600_000_000n, // 286
  open: { from: OPEN_AT - 1_000, to: OPEN_AT + 119_000 },
  close: [{ from: CLOSE_AT - 1_000, to: CLOSE_AT + 119_000 }],
};

describe("what a bet returned", () => {
  it("long, opened and closed in full: margin + (close − open value) − fees", () => {
    const fills = [
      fill("Open Long", "0.069861", "286", "0.008991", OPEN_AT),
      fill("Close Long", "0.071", "286", "0.009138", CLOSE_AT),
    ];
    const o = workOutReturned(long, fills, [], []);
    assert.equal(o.kind, "returned");
    // open 286 × 0.069861 = 19.980246; close 286 × 0.071 = 20.306; result +0.325754; fees 0.018129
    assert.equal(o.kind === "returned" ? o.returned_e6 : 0n, 20_000_000n + 325_754n - 18_129n);
  });

  it("short: the sign is the other way", () => {
    const short: BetOnExchange = { ...long, side: "SHORT" };
    const fills = [
      fill("Open Short", "0.07", "286", "0.009", OPEN_AT),
      fill("Close Short", "0.069", "286", "0.0089", CLOSE_AT),
    ];
    const o = workOutReturned(short, fills, [], []);
    // open 20.02, close 19.734: +0.286; fees 0.0179
    assert.equal(o.kind === "returned" ? o.returned_e6 : 0n, 20_000_000n + 286_000n - 17_900n);
  });

  it("TRUMP: sizes with a decimal stay exact", () => {
    const bet: BetOnExchange = { ...long, coin: "TRUMP", ordered_sz_e8: 1_700_000_000n };
    const fills = [
      fill("Open Long", "1.1721", "17.0", "0.008966", OPEN_AT, "TRUMP"),
      fill("Close Long", "1.1755", "16.5", "0.008727", CLOSE_AT, "TRUMP"),
      fill("Close Long", "1.17", "0.5", "0.000263", CLOSE_AT + 1, "TRUMP"),
    ];
    const o = workOutReturned(bet, fills, [], []);
    // open 19.9257; close 19.39575 + 0.585 = 19.98075; +0.05505; fees 0.017956
    assert.equal(o.kind === "returned" ? o.returned_e6 : 0n, 20_000_000n + 55_050n - 17_956n);
  });

  it("funding paid while the bet was held is counted; before or after, or on another coin, is not", () => {
    const fills = [
      fill("Open Long", "0.07", "286", "0", OPEN_AT),
      fill("Close Long", "0.07", "286", "0", CLOSE_AT),
    ];
    const funding: FundingPayment[] = [
      { time: OPEN_AT + 300_000, coin: "DOGE", usdc: "-0.0021", szi: "286.0" },
      { time: OPEN_AT - 300_000, coin: "DOGE", usdc: "-5.0", szi: "286.0" },
      { time: CLOSE_AT + 300_000, coin: "DOGE", usdc: "-5.0", szi: "0.0" },
      { time: OPEN_AT + 300_000, coin: "WIF", usdc: "-5.0", szi: "10.0" },
    ];
    const o = workOutReturned(long, fills, funding, []);
    assert.equal(o.kind === "returned" ? o.returned_e6 : 0n, 20_000_000n - 2_100n);
  });

  it("no opening fill: the margin back in full, and it says so", () => {
    const o = workOutReturned(long, [], [], []);
    assert.equal(o.kind, "returned");
    assert.equal(o.kind === "returned" ? o.returned_e6 : 0n, 20_000_000n);
    assert.match(o.kind === "returned" ? o.note : "", /did not fill/);
  });

  it("a part fill of the opening order is named in the note", () => {
    const fills = [
      fill("Open Long", "0.07", "100", "0", OPEN_AT),
      fill("Close Long", "0.07", "100", "0", CLOSE_AT),
    ];
    const o = workOutReturned(long, fills, [], []);
    assert.match(o.kind === "returned" ? o.note : "", /only in part/);
  });

  it("not fully closed yet: waits", () => {
    const fills = [
      fill("Open Long", "0.07", "286", "0", OPEN_AT),
      fill("Close Long", "0.07", "200", "0", CLOSE_AT),
    ];
    assert.equal(workOutReturned(long, fills, [], []).kind, "waiting");
  });

  it("needs a person: two bets on the same coin at once, a strange fill, a fee in another token, a loss past the margin", () => {
    const other: BetOnExchange = {
      ...long,
      position_id: 2,
      open: { from: OPEN_AT + 5_000, to: OPEN_AT + 125_000 },
    };
    assert.equal(workOutReturned(long, [], [], [other]).kind, "needs-person");

    const flip = [fill("Long > Short", "0.07", "286", "0", OPEN_AT)];
    assert.equal(workOutReturned(long, flip, [], []).kind, "needs-person");

    const hype = [{ ...fill("Open Long", "0.07", "286", "0.1", OPEN_AT), feeToken: "HYPE" }];
    assert.equal(workOutReturned(long, hype, [], []).kind, "needs-person");

    const crash = [
      fill("Open Long", "0.07", "286", "0", OPEN_AT),
      fill("Close Long", "0.001", "286", "0", CLOSE_AT),
    ];
    assert.equal(workOutReturned({ ...long, margin_e6: 10_000_000n }, crash, [], []).kind, "needs-person");
  });

  it("fills outside the bet's own order windows are not counted as its own", () => {
    const fills = [
      fill("Open Long", "0.07", "286", "0", OPEN_AT),
      fill("Close Long", "0.07", "286", "0", CLOSE_AT),
      fill("Open Long", "0.07", "50", "0", CLOSE_AT + 3_600_000),
    ];
    assert.equal(workOutReturned(long, fills, [], []).kind, "returned");
  });
});
