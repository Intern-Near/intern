import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, describe, it } from "node:test";
import { chainId, finalSnapshot, READ_RPC, type Snapshot } from "../src/chain-snapshot.ts";
import { DEFAULT_TESTNET_RPC } from "../src/near.ts";
import type { RpcExchange } from "../src/near-rpc.ts";
import {
  clock,
  NOT_IN_DRY_RUN,
  QuoteError,
  type QuoteViews,
  quoteFromViews,
  quoteLines,
  readBet,
  readQuoteViews,
  stateFromViews,
} from "../src/quote.ts";
import { buildRulebookV12, longShotMarginE6 } from "../src/rulebook.ts";

// Offline, from one real read-only run of `npm run quote -- --market PEPE --side long --margin 20 --leverage 1 --save
// …` on 2026-11-13 at 15:11 UTC (test/data/quote-2026-11-13T151111Z.json): every NEAR RPC exchange with
// https://test.rpc.fastnear.com (status, the final block 277526635, then six views of coin.desk-lab-2026.testnet at
// that block), as received. Round 54 was in its proposal window and the live runner had just placed bet #35
// (PEPE long $15), so a second bet is refused TOO_MANY_TRADES.

const RECORDED = JSON.parse(
  readFileSync(new URL("./data/quote-2026-11-13T151111Z.json", import.meta.url), "utf8"),
) as { rpc: string; coin: string; exchanges: RpcExchange[] };

/** A fetch answering each JSON-RPC request with the recorded reply for the same URL, method and params. */
function replay(exchanges: readonly RpcExchange[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const sent = JSON.parse(String(init?.body)) as { method: string; params: unknown };
    const hit = exchanges.find(
      (e) =>
        e.url === String(url) &&
        e.request.method === sent.method &&
        JSON.stringify(e.request.params) === JSON.stringify(sent.params),
    );
    if (!hit) throw new Error(`not recorded: ${sent.method} ${JSON.stringify(sent.params)}`);
    return new Response(hit.body, { status: hit.status });
  }) as typeof fetch;
}

const pepe20 = () => {
  const b = readBet({ market: "PEPE", side: "long", margin_usd: "20", leverage: 1 });
  assert.ok(b.ok);
  return b.decision;
};

let snap: Snapshot;
let views: QuoteViews;
before(async () => {
  snap = await finalSnapshot([RECORDED.rpc], RECORDED.coin, replay(RECORDED.exchanges));
  views = await readQuoteViews(snap.view);
});

describe("quote on the recorded live run (round 54, during the proposal window)", () => {
  it("reads testnet, the final block and the six views at that block", async () => {
    assert.equal(await chainId([RECORDED.rpc], replay(RECORDED.exchanges)), "testnet");
    assert.deepEqual(snap.block, {
      height: 277526635,
      hash: "2ZYNChAsZyKaLVpVHS9TuLbEffwoYztNKpDenGMRqXxQ",
      time_ms: Date.parse("2026-11-13T15:11:10.223Z"),
    });
    assert.equal(views.round.id, 54);
    assert.equal(views.rulebook.round_id, 54);
    assert.deepEqual(
      views.positions.map((p) => [p.id, p.market, p.side, p.margin, p.leverage]),
      [[35, "PEPE", "LONG", "15000000", 1]],
    );
  });

  it("builds the state as propose does: the rank now, the pool at open and now, the counters, min_notional", () => {
    const { state, notes } = stateFromViews(views, snap.block.time_ms);
    assert.deepEqual(state, {
      phase: "PROPOSE",
      status: "EMPLOYED",
      rank: "INTERN",
      brave_at_open_e6: 1_572_985_657n,
      brave_now_e6: 1_572_985_657n,
      bets_used: 1,
      at_risk_e6: 15_000_000n,
      ms_into_round: Date.parse("2026-11-13T15:11:10.223Z") - views.round.started_at,
      propose_from_ms: 900_000,
      propose_until_ms: 1_200_000,
      min_notional_e6: 11_000_000n,
    });
    assert.deepEqual(notes, []);
  });

  it("PEPE long $20: NOPE TOO_MANY_TRADES (bet #35 is in), and check 12 alone would also refuse it", () => {
    const q = quoteFromViews(views, pepe20(), {
      coin: RECORDED.coin,
      now_ms: snap.block.time_ms,
      block: snap.block,
    });
    const e = q.explanation;
    assert.deepEqual(
      [e.verdict, e.code, e.check, e.asked, e.limit],
      ["NOPE", "TOO_MANY_TRADES", 10, "2", "1"],
    );
    assert.equal(e.steps[5]?.detail, "margin $20.00 is within the per-bet limit $31.459713");
    assert.deepEqual([e.steps[6]?.outcome, e.steps[6]?.would], ["not reached", "fail"]);
    assert.equal(q.round.limit_base_e6, "1572985657");
    assert.equal(q.block?.time, "2026-11-13T15:11:10.223Z");
    assert.match(q.checks_1_and_2_now, /check 1 would pass now \(17:10 into the round, phase PROPOSE/);
    assert.match(q.checks_1_and_2_now, /check 2 would pass \(the Intern is EMPLOYED\)/);
  });

  it("other bets on the same state, one per code of checks 6 to 9", () => {
    const at = { coin: RECORDED.coin, now_ms: snap.block.time_ms, block: snap.block };
    const code = (market: string, side: string, margin: string, leverage: number) => {
      const b = readBet({ market, side, margin_usd: margin, leverage });
      assert.ok(b.ok);
      const e = quoteFromViews(views, b.decision, at).explanation;
      return `${e.verdict}${e.code ? ` ${e.code} ${e.asked}/${e.limit}` : ""}`;
    };
    assert.equal(code("WIF", "long", "20", 1), "NOPE NOT_ON_LIST null/null");
    assert.equal(code("doge", "SHORT", "20", 1), "NOPE SHORT_NOT_UNLOCKED null/null");
    assert.equal(code("DOGE", "long", "5", 2), "NOPE ZERO_MARGIN 10000000/11000000");
    assert.equal(code("DOGE", "long", "20", 2), "NOPE OVER_LEVERAGE 2/1");
  });

  it("as text: the bet, the round, the pool, the verdict and plainly what a dry run does not cover", () => {
    const text = quoteLines(
      quoteFromViews(views, pepe20(), { coin: RECORDED.coin, now_ms: snap.block.time_ms, block: snap.block }),
    ).join("\n");
    assert.match(text, /views at block 277526635 \(2026-11-13T15:11:10.223Z\); nothing signed or sent/);
    assert.match(
      text,
      /the round: {2}54, phase PROPOSE, 17:10 in; rank INTERN \(EMPLOYED\); bets so far 1 of 1, \$15.00 at risk/,
    );
    assert.match(text, /#35 PEPE long \$15.00 ×1 \(OPEN_SIGNED\)/);
    assert.match(text, /VERDICT of checks 6 to 12: NOPE TOO_MANY_TRADES \(check 10\)/);
    assert.ok(text.includes(NOT_IN_DRY_RUN));
    assert.match(NOT_IN_DRY_RUN, /^Checks 1 to 5 are not part of a dry run/);
  });
});

describe("quote refuses when its verdict would not be the contract's", () => {
  const changed = (f: (v: QuoteViews) => void): QuoteViews => {
    const v = structuredClone(views);
    f(v);
    return v;
  };

  it("the contract's rank limits differ from ranks.ts", () => {
    const v = changed((x) => {
      x.constants.ranks = x.constants.ranks.map((r) =>
        r.rank === "INTERN" ? { ...r, per_bet_bps: 300 } : r,
      );
    });
    assert.throws(
      () => stateFromViews(v, 0),
      (e: unknown) => e instanceof QuoteError && /INTERN: the contract has/.test(e.message),
    );
  });

  it("the rulebook is for another round, or the network is not testnet", () => {
    assert.throws(
      () =>
        stateFromViews(
          changed((x) => (x.rulebook.round_id = 53)),
          0,
        ),
      /get_rulebook is for round 53 but get_round is round 54/,
    );
    assert.throws(
      () =>
        stateFromViews(
          changed((x) => (x.constants.network = "mainnet")),
          0,
        ),
      /testnet only/,
    );
  });
});

describe("quote's state in other rounds", () => {
  const atOpen = 1_572_985_657n;
  const ticketRound = (margin: bigint): QuoteViews => {
    const v = structuredClone(views);
    v.rulebook.text = buildRulebookV12({
      round_id: 54,
      nonce: v.rulebook.nonce,
      rank: "INTERN",
      brave_at_open_e6: atOpen,
      bets_used: 1,
      at_risk_e6: 15_000_000n,
      playbook: null,
      long_shot: { margin_e6: margin, max_leverage: 10 },
    });
    return v;
  };

  it("a ticket round: the rulebook's long_shot line becomes the ticket, judged as the contract does", () => {
    const margin = longShotMarginE6(atOpen); // 0.5% of $1,572.985657, rounded down
    assert.equal(margin, 7_864_928n);
    const v = ticketRound(margin);
    const { state, notes } = stateFromViews(v, 0);
    assert.deepEqual(state.ticket, { margin_e6: margin, max_leverage: 10 });
    assert.deepEqual(notes, []);
    const b = readBet({ market: "DOGE", side: "long", margin_usd: "7.864928", leverage: 10 });
    assert.ok(b.ok);
    const e = quoteFromViews(v, b.decision, { coin: "c", now_ms: 0, block: null }).explanation;
    // One extra bet: bet #35 does not stop it, and $15 + $7.864928 is inside the round's $31.459713.
    assert.deepEqual([e.verdict, e.long_shot, e.notional_e6], ["YES", true, "78649280"]);
  });

  it("a rulebook ticket that is not 01 1.5's share is used as stated, with a note", () => {
    const { state, notes } = stateFromViews(ticketRound(7_000_000n), 0);
    assert.equal(state.ticket?.margin_e6, 7_000_000n);
    assert.match(
      notes[0] ?? "",
      /is not 01 1\.5's share of the pool at round open \(7864928, rulebook\.ts\)/,
    );
  });

  it("after a demotion the rank now counts, with a note; a fired Intern is said, not judged", () => {
    const v = structuredClone(views);
    v.round.rank = "TRADER";
    v.rank.status = "FIRED";
    v.round.phase = "OPEN"; // as get_round says it 1:40 into a round (the views and the time come from one block)
    const q = quoteFromViews(v, pepe20(), { coin: "c", now_ms: v.round.started_at + 100_000, block: null });
    assert.equal(q.round.rank, "INTERN");
    assert.match(q.notes[0] ?? "", /the round opened at TRADER and the rank now is INTERN/);
    assert.equal(q.explanation.code, "TOO_MANY_TRADES"); // checks 6 to 12 only
    assert.match(
      q.checks_1_and_2_now,
      /check 1 would refuse a proposal now with OUTSIDE_WINDOW \(1:40 into the round, phase OPEN/,
    );
    assert.match(q.checks_1_and_2_now, /check 2 would refuse it with FIRED/);
  });
});

describe("reading a bet", () => {
  it("takes dollars up to 6 decimals and either case for the market and side", () => {
    const b = readBet({ market: "pepe", side: "LONG", margin_usd: " 12.5 ", leverage: 1 });
    assert.deepEqual(b, {
      ok: true,
      decision: { action: "BET", market: "PEPE", side: "LONG", margin_e6: 12_500_000n, leverage: 1 },
    });
    assert.deepEqual(readBet({ market: "DOGE", side: "long", margin_usd: "0", leverage: 1 }).ok, true);
  });

  it("refuses what cannot be a decision line, with check 5's own reason", () => {
    const why = (market: string, side: string, margin: string, leverage: number) => {
      const b = readBet({ market, side, margin_usd: margin, leverage });
      return b.ok ? "ok" : b.reason;
    };
    assert.match(why("BTC", "long", "20", 1), /MALFORMED_DECISION: market is not one of the six/);
    assert.match(
      why("DOGE", "long", "20", 0),
      /MALFORMED_DECISION: leverage is not a whole number from 1 to 4294967295/,
    );
    assert.match(why("DOGE", "long", "20", 1.5), /leverage is not a whole number/);
    assert.match(why("DOGE", "long", "20", 2 ** 32), /leverage is not a whole number/);
    assert.match(why("DOGE", "long", (2n ** 128n).toString(), 1), /margin_e6 does not fit in u128/);
    assert.match(why("DOGE", "long", "20.0000001", 1), /not dollars with up to 6 decimals/);
    assert.match(why("DOGE", "long", "1e3", 1), /not dollars with up to 6 decimals/);
    assert.match(why("DOGE", "long", "-5", 1), /cannot be negative/);
    assert.match(why("DOGE", "up", "5", 1), /long or short/);
    assert.match(why("DOGE", "long", "5", Number.NaN), /whole number/);
  });
});

describe("small pieces", () => {
  it("the read-only default RPC is the runner's own", () => {
    assert.equal(READ_RPC, DEFAULT_TESTNET_RPC);
    const deployments = JSON.parse(
      readFileSync(new URL("../../interface/deployments.json", import.meta.url), "utf8"),
    );
    assert.equal(READ_RPC, deployments.testnet.rpc);
  });

  it("writes offsets into the round as m:ss or h:mm:ss", () => {
    assert.equal(clock(900_000), "15:00");
    assert.equal(clock(1_030_223), "17:10");
    assert.equal(clock(43_200_000), "12:00:00");
    assert.equal(clock(-5_000), "-0:05");
  });
});
