import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { Position } from "../src/contract.ts";
import {
  analyze,
  type BetReport,
  type Gathered,
  gather,
  type Report,
  type Sources,
  usd,
} from "../src/fills-check.ts";
import { groupFills, matchFills, readSignedOrder } from "../src/fills-match.ts";
import { renderText } from "../src/fills-text.ts";
import { type Fill, readFills } from "../src/hl-exchange.ts";

// Offline, from a real read-only run of `npm run fills-check -- --rounds 60 --save …` on 2026-11-13 at 13:56 UTC:
// every view of coin.desk-lab-2026.testnet it read through https://test.rpc.fastnear.com (rounds 1 to 52, the outbox,
// the feed) and every reply of https://api.hyperliquid-testnet.xyz/info (userFillsByTime, userFunding), as received
// (test/data/fills-check-2026-11-13T135610Z/). And the contract address's whole `userFills` history, saved a minute
// before (fixtures/hl/info/2026-11-13T135610Z/), so every fill in it was ordered before the outbox was read.

const DIR = fileURLToPath(new URL("./data/fills-check-2026-11-13T135610Z/", import.meta.url));
const CHAIN = JSON.parse(readFileSync(`${DIR}chain-views.json`, "utf8"));
const HL = JSON.parse(readFileSync(`${DIR}hl-info.json`, "utf8"));
const fixture = (path: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8"));
const USER_FILLS = fixture("../../fixtures/hl/info/2026-11-13T135610Z/userFills-testnet-contract.json");
// What the runner itself worked out and saved just before it reported round 7, the first fill (2026-11-12).
const ROUND7 = fixture("../../fixtures/hl/exchange/20261112T114914Z-round7-position3-result/result.json");

interface View {
  method: string;
  args: Record<string, unknown>;
  result: unknown;
}

/** Answers every view and /info request from the recording; anything not recorded fails the test. */
function replay(views: View[] = CHAIN.views): Sources {
  return {
    contract: CHAIN.contract,
    view: async (method, args) => {
      const hit = views.find((v) => v.method === method && JSON.stringify(v.args) === JSON.stringify(args));
      if (!hit) throw new Error(`not recorded: ${method} ${JSON.stringify(args)}`);
      return structuredClone(hit.result);
    },
    fetchFn: async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      const body = String(init?.body);
      const hit = HL.records.find((r: { request: unknown }) => JSON.stringify(r.request) === body);
      if (url !== "https://api.hyperliquid-testnet.xyz/info" || !hit)
        throw new Error(`not recorded: ${body}`);
      return new Response(hit.reply, { status: hit.http_status });
    },
    now: () => CHAIN.checked_at_ms,
  };
}

let recorded: Gathered;
before(async () => {
  recorded = await gather(replay(), CHAIN.rounds);
});

/** The recording, changed by `f`, then checked. */
function changed(f: (g: Gathered) => void): Report {
  const g = structuredClone(recorded);
  f(g);
  return analyze(g);
}

function position(g: Gathered, round: number): Position {
  const p = g.positions.find((x) => x.round_id === round);
  if (!p) throw new Error(`no bet in round ${round}`);
  return p;
}

function bet(r: Report, round: number): BetReport {
  const b = r.bets.find((x) => x.round_id === round);
  if (!b) throw new Error(`no bet in round ${round}`);
  return b;
}

describe("fills-check on the recorded real run (coin.desk-lab-2026.testnet, rounds 1 to 52)", () => {
  it("finds what the live run found: 30 OK, 1 NO FILLS, 1 MISMATCH, no stray fill", () => {
    const r = analyze(recorded);
    assert.deepEqual(r.rounds, { from: 1, to: 52, current: 52, missing: [] });
    assert.equal(r.hl.address, "0x46f8eb2a044a826c70e9682fe3bfd65970340132");
    assert.equal(r.summary.bets, 32);
    assert.equal(r.summary.rounds_without_bet, 20);
    assert.deepEqual(r.summary.by_status, {
      OK: 30,
      MISMATCH: 1,
      "NO FILLS": 1,
      "UNMATCHED FILLS": 0,
      "NOT REPORTED": 0,
      "NOT CHECKED": 0,
    });
    assert.equal(r.summary.unmatched_fill_groups, 0);
    assert.equal(r.summary.ok, false);
    assert.equal(r.sources.fills, 62);
    assert.equal(r.sources.outbox_first_id, 1);
  });

  it("round 7, the first fill: the same amount the runner worked out and saved before reporting it", () => {
    const b = bet(analyze(recorded), 7);
    assert.equal(b.status, "OK");
    assert.equal(b.fills_matched, 3);
    assert.equal(b.recomputed?.returned_e6, ROUND7.returned_e6);
    assert.equal(b.recomputed?.detail?.fees_e6, ROUND7.detail.fees_e6);
    assert.deepEqual(
      b.orders.map((o) => [o.kind, o.matched?.oid, o.matched?.filled_sz]),
      [
        ["OPEN", 65161863543, "268"],
        ["CLOSE", 65162270187, "268"],
      ],
    );
  });

  it("round 3: a result reported with no order ever signed (Engine 1's step-4 test) is a MISMATCH", () => {
    const b = bet(analyze(recorded), 3);
    assert.equal(b.status, "MISMATCH");
    assert.equal(b.orders_signed, 0);
    assert.equal(b.reported?.returned_e6, "16000000");
    assert.equal(b.recomputed?.returned_e6, "15000000");
    assert.match(b.reason, /the fills give 15\.000000 back, the runner reported 16\.000000/);
  });

  it("round 6: orders signed while the address held no funds, nothing filled, the margin back: NO FILLS", () => {
    const b = bet(analyze(recorded), 6);
    assert.equal(b.status, "NO FILLS");
    assert.equal(b.orders_signed, 2);
    assert.equal(b.fills_matched, 0);
    assert.equal(b.reported?.returned_e6, b.margin_e6);
  });

  it("every fill the contract's address ever had matches an order the contract signed", () => {
    const coinOf = new Map(recorded.constants.markets.map((m) => [m.hl_asset, m.hl_name] as const));
    const orders = recorded.outbox
      .filter((a) => a.kind !== "LEVERAGE")
      .map((a) => readSignedOrder(a, coinOf));
    const fills = readFills(USER_FILLS);
    const { byAction, unmatched } = matchFills(orders, groupFills(fills));
    assert.equal(fills.length, 62);
    assert.deepEqual(unmatched, []);
    assert.equal(
      [...byAction.values()].reduce((n, g) => n + g.fills.length, 0),
      62,
    );
  });

  it("the text has one line per bet, the reasons, and the counts", () => {
    const text = renderText(analyze(recorded)).join("\n");
    assert.match(
      text,
      /round {2}market {2}side {8}margin {2}orders {2}fills {5}reported {3}recomputed {2}status/,
    );
    assert.match(text, / {4}7 {2}DOGE {4}LONG {5}17\.997883 {7}2 {6}3 {4}-0\.037117 {4}-0\.037117 {2}OK/);
    assert.match(text, /position 1: the fills give 15\.000000 back/);
    assert.match(text, /no bet yet \(phase OPEN\)/);
    assert.match(text, /OK 30, MISMATCH 1, NO FILLS 1, UNMATCHED FILLS 0, NOT REPORTED 0, NOT CHECKED 0/);
  });
});

describe("fills-check on the recording, changed", () => {
  it("a reported result one micro-dollar off is a MISMATCH", () => {
    const r = changed((g) => {
      const p = position(g, 51);
      p.returned = (BigInt(p.returned ?? "0") + 1n).toString();
      for (const f of g.feed)
        if (f.event === "result_reported" && f.data.position_id === p.id) f.data.returned = p.returned;
    });
    assert.equal(bet(r, 51).status, "MISMATCH");
    assert.match(bet(r, 51).reason, /off by 0\.000001/);
  });

  it("the feed's result_reported disagreeing with get_positions is a MISMATCH", () => {
    const r = changed((g) => {
      const p = position(g, 50);
      for (const f of g.feed)
        if (f.event === "result_reported" && f.data.position_id === p.id) f.data.returned = "1";
    });
    assert.equal(bet(r, 50).status, "MISMATCH");
    assert.match(bet(r, 50).reason, /the feed's result_reported/);
  });

  it("no result yet: NOT REPORTED, with what the fills give so far", () => {
    const r = changed((g) => {
      const p = position(g, 51);
      p.returned = null;
      p.result = null;
      p.status = "CLOSE_SIGNED";
    });
    const b = bet(r, 51);
    assert.equal(b.status, "NOT REPORTED");
    assert.equal(b.recomputed?.returned_e6, "19951975");
    assert.equal(r.summary.ok, false); // round 3's MISMATCH is still there
  });

  it("a reported result where Hyperliquid shows no fill at all is a MISMATCH (the margin would be back)", () => {
    const r = changed((g) => {
      const oids = new Set(bet(analyze(g), 51).orders.map((o) => o.matched?.oid));
      g.fills = g.fills.filter((f) => !oids.has(f.oid));
    });
    assert.equal(bet(r, 51).status, "MISMATCH");
    assert.match(bet(r, 51).reason, /the fills give 20\.000000 back, the runner reported 19\.951975/);
  });

  it("an extra fill inside a bet's window that its orders cannot account for: UNMATCHED FILLS", () => {
    const r = changed((g) => {
      const open = bet(analyze(g), 51).orders.find((o) => o.kind === "OPEN");
      const f = g.fills.find((x) => x.oid === open?.matched?.oid);
      if (!f) throw new Error("round 51 has no opening fill in the recording");
      g.fills.push({ ...f, oid: 1, tid: 2, time: f.time + 1_000 });
    });
    assert.equal(bet(r, 51).status, "UNMATCHED FILLS");
    assert.equal(r.summary.unmatched_fill_groups, 1);
    assert.equal(r.unmatched_fills[0]?.round_id, 51);
    assert.equal(r.summary.ok, false);
  });

  it("a fill in a round with no bet is reported against that round", () => {
    const r = changed((g) => {
      const f = g.fills[0] as Fill;
      g.fills.push({ ...f, oid: 1, tid: 2, time: CHAIN.checked_at_ms - 60_000 });
    });
    assert.equal(r.round_rows.find((x) => x.round_id === 52)?.unmatched_fill_groups, 1);
    assert.match(renderText(r).join("\n"), /unmatched: oid 1, .* round 52/);
  });

  it("orders the contract no longer keeps: NOT CHECKED, and their fills are set apart, not called unmatched", () => {
    // As if get_outbox had dropped its oldest actions (it keeps the last 200): here the first six.
    const r = changed((g) => {
      g.outbox = g.outbox.filter((a) => a.id > 6);
    });
    assert.equal(bet(r, 6).status, "NOT CHECKED");
    assert.equal(bet(r, 7).status, "NOT CHECKED");
    assert.equal(bet(r, 7).orders_signed, null);
    assert.equal(r.summary.unmatched_fill_groups, 0);
    assert.equal(r.summary.older_fill_groups, 2); // round 7's opening and closing orders
    assert.equal(bet(r, 11).status, "OK");
  });
});

describe("matching orders to fills", () => {
  const coinOf = new Map([[173, "DOGE"]]);
  // Round 7's opening order, as get_outbox gave it (fixtures/hl/exchange/20261112T113940Z-round7-…/meta.json).
  const META = fixture("../../fixtures/hl/exchange/20261112T113940Z-round7-position3-open-action5/meta.json");
  const open = readSignedOrder(META.action, coinOf);
  const fill = (over: Partial<Fill>): Fill => ({
    coin: "DOGE",
    px: "0.06647",
    sz: "268.0",
    side: "B",
    time: open.nonce + 7_000,
    dir: "Open Long",
    closedPnl: "0.0",
    fee: "0.007507",
    feeToken: "USDC",
    oid: 10,
    tid: 11,
    ...over,
  });
  const matched = (fills: Fill[]) => matchFills([open], groupFills(fills));

  it("reads the signed order: coin, side, direction, size", () => {
    assert.equal(open.coin, "DOGE");
    assert.equal(open.fill_side, "B");
    assert.equal(open.dir, "Open Long");
    assert.equal(open.sz_e8, 26_800_000_000n);
  });

  it("a fill in part matches; more than the order's size does not", () => {
    assert.equal(matched([fill({ sz: "100.0" })]).byAction.get(open.action_id)?.oid, 10);
    assert.equal(matched([fill({ sz: "269.0" })]).unmatched.length, 1);
  });

  it("the fills of one Hyperliquid order count together", () => {
    const m = matched([fill({ sz: "251.0" }), fill({ sz: "17.0", tid: 12 })]);
    assert.equal(m.byAction.get(open.action_id)?.fills.length, 2);
    assert.equal(matched([fill({ sz: "251.0" }), fill({ sz: "18.0", tid: 12 })]).unmatched.length, 1);
  });

  it("another side, direction or coin, or a time outside the order's window, does not match", () => {
    assert.equal(matched([fill({ side: "A" })]).unmatched.length, 1);
    assert.equal(matched([fill({ dir: "Close Short" })]).unmatched.length, 1);
    assert.equal(matched([fill({ coin: "kPEPE" })]).unmatched.length, 1);
    assert.equal(matched([fill({ time: open.nonce - 11_000 })]).unmatched.length, 1);
    assert.equal(matched([fill({ time: open.expires_after + 11_000 })]).unmatched.length, 1);
    assert.equal(matched([fill({ time: open.expires_after + 9_000 })]).unmatched.length, 0);
  });

  it("of two orders that fit, the one signed last before the fills wins", () => {
    const later = {
      ...open,
      action_id: 99,
      nonce: open.nonce + 30_000,
      expires_after: open.expires_after + 30_000,
    };
    const m = matchFills([open, later], groupFills([fill({ time: later.nonce + 2_000 })]));
    assert.equal(m.byAction.has(99), true);
    assert.equal(m.byAction.has(open.action_id), false);
  });

  it("refuses an action that is not one order in hl-order's shape", () => {
    assert.throws(() => readSignedOrder({ ...META.action, kind: "LEVERAGE" }, coinOf), /sets leverage/);
    assert.throws(() => readSignedOrder(META.action, new Map()), /asset 173 is not in/);
    assert.throws(() => readSignedOrder({ ...META.action, kind: "CLOSE" }, coinOf), /reduce-only false/);
    assert.throws(
      () => readSignedOrder({ ...META.action, action: { type: "cancel" } }, coinOf),
      /not one order/,
    );
  });
});

describe("fills-check's limits", () => {
  it("reads 1 to 200 rounds", async () => {
    await assert.rejects(gather(replay(), 0), /from 1 to 200/);
    await assert.rejects(gather(replay(), 201), /from 1 to 200/);
  });

  it("reads testnet only", async () => {
    const views = structuredClone(CHAIN.views) as View[];
    for (const v of views)
      if (v.method === "get_constants") (v.result as { network: string }).network = "mainnet";
    await assert.rejects(gather(replay(views), 10), /testnet only/);
  });

  it("writes dollars with six decimals", () => {
    assert.equal(usd(-28_930n), "-0.028930");
    assert.equal(usd(17_960_766n), "17.960766");
    assert.equal(usd(0n), "0.000000");
  });
});
