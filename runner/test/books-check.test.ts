import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { type AtBlock, atFinalBlock } from "../src/at-block.ts";
import { type BooksSnapshot, checkBooks, readBooks } from "../src/books-check.ts";
import { renderBooks } from "../src/books-text.ts";
import { loadRecording, type Recording, recordedView, replayRpc } from "./support/rpc-replay.ts";

// Offline, from two real read-only runs on 2026-11-13 at 15:09 UTC (each exchange keeps its own fetched_at):
// `npm run books -- --save …` for coin.desk-lab-2026.testnet (block 277526435) and for
// coin-fast.desk-lab-2026.testnet (block 277526441), both through https://test.rpc.fastnear.com, the lender
// lender.desk-lab-2026.testnet from interface/deployments.json (test/data/books-check-2026-11-13T150922Z/).
const DIR = "./data/books-check-2026-11-13T150922Z/";
const RPC = "https://test.rpc.fastnear.com";
const LENDER = "lender.desk-lab-2026.testnet";

async function snapshotOf(rec: Recording): Promise<BooksSnapshot> {
  const at = await atFinalBlock(RPC, replayRpc(rec.exchanges));
  return readBooks(at, rec.coin, LENDER);
}

/** A copy of a snapshot with some numbers changed. */
function edited(s: BooksSnapshot, change: (c: BooksSnapshot) => void): BooksSnapshot {
  const c = structuredClone(s);
  change(c);
  return c;
}

describe("books-check on the live coin (recorded 2026-11-13 15:09 UTC)", () => {
  let rec: Recording;
  let snap: BooksSnapshot;
  before(async () => {
    rec = loadRecording(new URL(`${DIR}coin/rpc.json`, import.meta.url));
    snap = await snapshotOf(rec);
  });

  it("reads every number at the one recorded block", () => {
    assert.equal(snap.block.height, 277526435);
    assert.equal(snap.block.hash, rec.block.hash);
    assert.equal(snap.usdc_token, "usdc.desk-lab-2026.testnet");
    // The figures the tool parsed are the ones in the raw replies.
    const usdc = recordedView(rec.exchanges, "ft_balance_of", JSON.stringify({ account_id: rec.coin }));
    assert.equal(snap.usdc_of_coin.toString(), usdc);
  });

  it("finds the books adding up to the micro-dollar, place by place", () => {
    const r = checkBooks(snap);
    assert.equal(r.verdict, "ADD UP");
    assert.equal(r.ok, true);
    assert.equal(r.owed_total_e6, "1894091972");
    assert.equal(r.held_total_e6, "1894091972");
    assert.equal(r.difference_e6, "0");
    assert.deepEqual(
      r.places.map((p) => [p.place, p.should_hold_e6, p.holds_e6, p.difference_e6]),
      [
        ["the coin's USDC", "351951646", "351951646", "0"],
        ["the lender, for this coin", "1542140326", "1542140326", "0"],
      ],
    );
    assert.ok(r.checks.every((c) => c.ok));
  });

  it("takes every bucket from the coin's views, none invented", () => {
    const r = checkBooks(snap);
    assert.deepEqual(
      r.owed.map((o) => o.source),
      [
        "get_pot.brave.total",
        "get_pot.brave.idle",
        "get_pot.brave.in_play",
        "get_pot.brave.lent",
        "get_pot.brave.pending",
        "get_pot.brave.income_waiting",
        "get_pot.safe.total",
        "get_rewards.jackpot",
        "get_rewards.draw_pot",
        "get_rewards.prizes_owed",
        "get_bounty.pot", // 01 1.7: 0 on the recorded 1.6 coin
        "get_rescue.fund",
      ],
    );
    // brave.interest is a running total, not money held: it is shown, never added.
    assert.ok(!r.owed.some((o) => o.source.includes("interest")));
    assert.ok(r.info.some((i) => i.startsWith("interest collected so far 0.000110")));
  });

  it("says plainly what is not in these books", () => {
    const text = renderBooks(checkBooks(snap)).join("\n");
    assert.match(text, /margin was funded by hand, not by the contract: a stand-in \(01 §14\.3/);
    assert.match(text, /0x46f8eb2a044a826c70e9682fe3bfd65970340132/);
    assert.match(text, /The lender is a stand-in \(lending\.mode STANDIN/);
    assert.match(text, /result: THE BOOKS ADD UP\./);
  });
});

describe("books-check verdicts, on edited copies of the recorded snapshot", () => {
  let snap: BooksSnapshot;
  before(async () => {
    snap = await snapshotOf(loadRecording(new URL(`${DIR}coin/rpc.json`, import.meta.url)));
  });

  it("coin-fast's recorded books add up too", async () => {
    const r = checkBooks(
      await snapshotOf(loadRecording(new URL(`${DIR}coin-fast/rpc.json`, import.meta.url))),
    );
    assert.equal(r.verdict, "ADD UP");
    assert.equal(r.owed_total_e6, "703800000");
  });

  it("one micro-dollar too many in the coin is a SURPLUS", () => {
    const r = checkBooks(edited(snap, (c) => (c.usdc_of_coin += 1n)));
    assert.equal(r.verdict, "SURPLUS");
    assert.equal(r.difference_e6, "1");
    assert.equal(r.ok, false);
    assert.match(renderBooks(r).at(-1) ?? "", /SURPLUS of 0\.000001/);
  });

  it("less at the lender than the coin says it lent is SHORT, at the lender's line", () => {
    const r = checkBooks(
      edited(snap, (c) => {
        if (c.lender) c.lender.principal -= 5_000_000n;
      }),
    );
    assert.equal(r.verdict, "SHORT");
    assert.equal(r.difference_e6, "-5000000");
    assert.equal(r.places[0]?.difference_e6, "0");
    assert.equal(r.places[1]?.difference_e6, "-5000000");
    assert.match(renderBooks(r).at(-1) ?? "", /SHORT by 5\.000000/);
  });

  it("a repayment between the lender and the coin, half done, adds up in total: MOVING", () => {
    // The coin wrote its loan down first; the lender has not paid yet (lending.rs withdraw_then).
    const r = checkBooks(
      edited(snap, (c) => {
        c.brave.lent -= 20_000_000n;
        c.brave.idle += 20_000_000n;
      }),
    );
    assert.equal(r.verdict, "MOVING");
    assert.equal(r.difference_e6, "0");
    assert.deepEqual(
      r.places.map((p) => p.difference_e6),
      ["-20000000", "20000000"],
    );
    assert.equal(r.ok, false);
  });

  it("money lent with no lender read is NOT CHECKED", () => {
    const r = checkBooks(edited(snap, (c) => (c.lender = null)));
    assert.equal(r.verdict, "NOT CHECKED");
    assert.equal(r.held_total_e6, null);
    assert.equal(r.places[1]?.holds_e6, null);
  });

  it("a coin that lends nothing needs no lender", () => {
    const r = checkBooks(
      edited(snap, (c) => {
        c.lender = null;
        c.lending_mode = "NONE";
        c.usdc_of_coin += c.brave.lent;
        c.brave.idle += c.brave.lent;
        c.brave.lent = 0n;
      }),
    );
    assert.equal(r.verdict, "ADD UP");
    assert.equal(r.places.length, 1);
    assert.ok(r.checks.some((c) => c.rule.startsWith("nothing is lent while lending.mode is NONE") && c.ok));
  });

  it("a pool whose parts do not add up to its total fails 01 §9.6's check even when the dollars match", () => {
    // get_pot computes idle with saturating_sub: lent + in play above the total would show idle 0.
    const r = checkBooks(edited(snap, (c) => (c.brave.idle += 1n)));
    assert.equal(r.verdict, "ADD UP");
    assert.equal(r.ok, false);
    assert.equal(r.checks[0]?.ok, false);
  });
});

describe("books-check reading", () => {
  const block = { height: 1, hash: "11111111111111111111111111111111", at_ms: 0 };
  const fake = (answers: Record<string, unknown>): AtBlock => ({
    rpc: "test",
    block,
    view: async (contract, method) => {
      const v = answers[`${contract} ${method}`];
      if (v === undefined) throw new Error(`not in the fake: ${contract} ${method}`);
      return structuredClone(v);
    },
  });

  it("refuses an amount sent as a JSON number, naming the field", async () => {
    const rec = loadRecording(new URL(`${DIR}coin/rpc.json`, import.meta.url));
    const pot = recordedView(rec.exchanges, "get_pot") as { brave: Record<string, unknown> };
    pot.brave.total = 1572985657;
    const at = fake({
      [`${rec.coin} get_constants`]: recordedView(rec.exchanges, "get_constants"),
      [`${rec.coin} get_pot`]: pot,
      [`${rec.coin} get_rewards`]: recordedView(rec.exchanges, "get_rewards"),
    });
    await assert.rejects(readBooks(at, rec.coin, null), /get_pot\.brave\.total: expected a decimal string/);
  });

  it("will not read a node that is not testnet", async () => {
    const mainnet = (async () =>
      new Response(
        JSON.stringify({ jsonrpc: "2.0", id: "x", result: { chain_id: "mainnet" } }),
      )) as typeof fetch;
    await assert.rejects(atFinalBlock("https://example.invalid", mainnet), /serves mainnet, not testnet/);
  });
});
