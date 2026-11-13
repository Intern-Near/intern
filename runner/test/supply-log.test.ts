import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { atFinalBlock } from "../src/at-block.ts";
import { type FeedItem, readSupply, rebuild, type SupplySnapshot } from "../src/supply-log.ts";
import { csvField, renderCsv, renderSupply } from "../src/supply-text.ts";
import { loadRecording, type Recording, recordedView, replayRpc } from "./support/rpc-replay.ts";

// Offline, from two real read-only runs on 2026-11-13 at 15:09 UTC (each exchange keeps its own fetched_at):
// `npm run supply-log -- --save …` for coin.desk-lab-2026.testnet (block 277526446, feed seq 1 to 313) and for
// coin-fast.desk-lab-2026.testnet (block 277526452, feed seq 1 to 103, its round 23 due but not yet written), both
// through https://test.rpc.fastnear.com (test/data/supply-log-2026-11-13T150922Z/).
const DIR = "./data/supply-log-2026-11-13T150922Z/";
const RPC = "https://test.rpc.fastnear.com";
const BOSS1 = "boss1.desk-lab-2026.testnet";
const BOSS2 = "boss2.desk-lab-2026.testnet";

async function snapshotOf(dir: string): Promise<{ rec: Recording; snap: SupplySnapshot }> {
  const rec = loadRecording(new URL(`${DIR}${dir}/rpc.json`, import.meta.url));
  const at = await atFinalBlock(RPC, replayRpc(rec.exchanges));
  return { rec, snap: await readSupply(at, rec.coin) };
}

function edited(s: SupplySnapshot, change: (c: SupplySnapshot) => void): SupplySnapshot {
  const c = structuredClone(s);
  change(c);
  return c;
}

describe("supply-log on the live coin (recorded 2026-11-13 15:09 UTC)", () => {
  let rec: Recording;
  let snap: SupplySnapshot;
  before(async () => {
    ({ rec, snap } = await snapshotOf("coin"));
  });

  it("reads every page of the feed at the one recorded block", () => {
    assert.equal(snap.block.height, 277526446);
    assert.equal(snap.feed.length, 313);
    assert.deepEqual(
      snap.feed.map((f) => f.seq),
      Array.from({ length: 313 }, (_, i) => i + 1),
    );
  });

  it("rebuilds exactly the supply ft_total_supply gives", () => {
    const r = rebuild(snap);
    assert.equal(r.ok, true);
    assert.equal(r.feed.complete, true);
    assert.equal(r.totals.rebuilt_e6, recordedView(rec.exchanges, "ft_total_supply"));
    assert.equal(r.totals.rebuilt_e6, "1298643317");
    assert.equal(r.difference_e6, "0");
    assert.deepEqual(r.gaps, []);
    assert.ok(r.checks.every((c) => c.ok === true));
  });

  it("finds the four openings that made coins, with the contract's rule", () => {
    const r = rebuild(snap);
    const minted = r.rounds.filter((x) => x.minted_e6 !== "0");
    assert.deepEqual(
      minted.map((x) => [x.round_id, x.converted_e6, x.minted_e6, x.locked_e6]),
      [
        [2, "100000000", "100000000", "1000"],
        [3, "900000000", "900000000", "0"],
        [5, "50000000", "49947423", "0"],
        [12, "1000000000", "824695144", "0"],
      ],
    );
    assert.equal(r.totals.minted_e6, "1874642567");
    assert.equal(r.totals.locked_e6, r.now.own_balance_e6);
  });

  it("logs every burn: two cash-outs and two dial turns to SAFE", () => {
    const r = rebuild(snap);
    assert.deepEqual(
      r.events
        .filter((e) => e.kind === "BURN")
        .map((e) => [e.seq, e.account_id, e.coins_e6, e.supply_after_e6]),
      [
        [6, BOSS1, "49999500", "50000500"],
        [17, BOSS1, "100000000", "850000500"],
        [23, BOSS2, "1000000", "898947923"],
        [46, BOSS1, "424999750", "473948173"],
      ],
    );
    assert.equal(r.totals.burned_cash_out_e6, "474999250");
    assert.equal(r.totals.burned_dial_e6, "101000000");
  });

  it("checks each coins_minted against the rule and names the coins not written yet", () => {
    const r = rebuild(snap);
    assert.deepEqual(
      r.events.filter((e) => e.kind === "WRITE").map((e) => [e.seq, e.coins_e6]),
      [
        [5, "99999000"],
        [16, "900000000"],
        [22, "49947423"],
      ],
    );
    assert.deepEqual(r.not_written, [
      { round_id: 12, account_id: BOSS1, dollars_e6: "1000000000", coins_e6: "824695144" },
    ]);
    assert.equal(r.totals.dust_e6, "0");
    assert.equal(r.totals.written_balances_e6, "473948173");
    assert.ok(r.findings.some((f) => f.includes("824.695144 coins (63.5% of the supply)")));
  });

  it("writes the text and the CSV", () => {
    const r = rebuild(snap);
    const text = renderSupply(r).join("\n");
    assert.match(
      text,
      /result: THE FEED ACCOUNTS FOR EVERY COIN: rebuilt 1298\.643317 = ft_total_supply 1298\.643317\./,
    );
    assert.match(text, /round {2}12 {2}boss1\.desk-lab-2026\.testnet +\$1000\.000000 in, 824\.695144 coins/);
    const csv = renderCsv(r).split("\r\n");
    assert.equal(csv[0], "seq,at_utc,round,event,kind,account,dollars,coins,supply_change,supply_after,note");
    assert.equal(csv.length, r.events.length + 2); // the header, one line per event, the final line break
    assert.ok(
      csv.some((l) =>
        l.startsWith("46,2026-11-12T11:58:14.662Z,8,cashed_out,BURN,boss1.desk-lab-2026.testnet,"),
      ),
    );
  });
});

describe("supply-log on coin-fast (recorded 2026-11-13 15:09 UTC)", () => {
  it("rebuilds 700 coins and sees round 23 due but not yet written", async () => {
    const { snap } = await snapshotOf("coin-fast");
    const r = rebuild(snap);
    assert.equal(r.ok, true);
    assert.equal(r.totals.rebuilt_e6, "700000000");
    assert.equal(r.feed.last_seq, 103);
    const due = r.rounds.at(-1);
    assert.equal(due?.round_id, 23);
    assert.equal(due?.seq, null);
    assert.equal(due?.minted_e6, "0");
    // Two bosses shared the first conversion: 199.999 coins between them, 0.001 locked.
    assert.deepEqual(
      r.events.filter((e) => e.kind === "WRITE").map((e) => [e.account_id, e.coins_e6]),
      [
        [BOSS1, "99999500"],
        [BOSS2, "99999500"],
      ],
    );
  });
});

describe("supply-log says what the feed cannot account for", () => {
  let snap: SupplySnapshot;
  before(async () => {
    ({ snap } = await snapshotOf("coin"));
  });

  it("a feed that no longer starts at seq 1 cannot be rebuilt, and says what is gone", () => {
    const r = rebuild(edited(snap, (c) => (c.feed = c.feed.filter((f) => f.seq >= 20))));
    assert.equal(r.ok, false);
    assert.equal(r.feed.complete, false);
    assert.equal(r.totals.rebuilt_e6, null);
    assert.equal(r.difference_e6, null);
    assert.equal(r.checks[0]?.ok, null);
    assert.match(r.gaps[0] ?? "", /starts at seq 20: events 1 to 19 are gone/);
    // What the kept window does show, exactly.
    assert.equal(r.totals.burned_cash_out_e6, "424999750");
    assert.equal(r.totals.burned_dial_e6, "1000000");
    assert.equal(r.totals.written_e6, "49947423");
    assert.equal(r.rounds.find((x) => x.round_id === 12)?.minted_e6, null);
    assert.match(renderSupply(r).join("\n"), /THE FEED DOES NOT ACCOUNT FOR EVERY COIN/);
  });

  it("an event 01 §10 does not list is a gap", () => {
    const r = rebuild(
      edited(snap, (c) =>
        c.feed.push({ seq: 314, at: 1794582600000, event: "coins_airdropped", data: { coins: "5" } }),
      ),
    );
    assert.equal(r.ok, false);
    assert.deepEqual(r.feed.unknown_events, [{ event: "coins_airdropped", seqs: [314] }]);
    assert.match(r.gaps.join("\n"), /"coins_airdropped" \(seq 314\): not an event 01 §10 lists/);
  });

  it("a coins_minted that is not what the rule gives is caught", () => {
    const r = rebuild(
      edited(snap, (c) => {
        const five = c.feed.find((f) => f.seq === 5);
        if (five) five.data.coins = "99999001";
      }),
    );
    assert.equal(r.ok, false);
    assert.equal(r.checks.find((c) => c.rule.startsWith("every coins_minted"))?.ok, false);
    assert.match(r.gaps.join("\n"), /got 99\.999001 coins of round 2; the rule gives 99\.999000/);
  });

  it("more coins in ft_total_supply than the feed shows is a difference", () => {
    const r = rebuild(edited(snap, (c) => (c.ft_total_supply += 7n)));
    assert.equal(r.ok, false);
    assert.equal(r.difference_e6, "7");
    assert.match(r.gaps.join("\n"), /0\.000007 coins more exist than the feed shows/);
  });

  it("an opening that is due counts the dollars waiting, as the views do", () => {
    // A $50 pay-in after round 54 opened, and round 55 due: get_round shows the new pool before any write.
    const last = snap.feed.findLast((f) => f.event === "settled");
    const pool = BigInt(String(last?.data.brave_after));
    const supply = 1_298_643_317n;
    const coins = (50_000_000n * supply) / pool;
    const r = rebuild(
      edited(snap, (c) => {
        c.feed.push({
          seq: 314,
          at: 1794582700000,
          event: "paid_in",
          data: { account_id: BOSS2, pool: "BRAVE", amount: "50000000", pending: true },
        });
        c.round = { id: 55, started_at: 1794583440000, brave_at_open: pool + 50_000_000n };
        c.ft_total_supply = supply + coins;
        c.pot.coin_supply = supply + coins;
      }),
    );
    assert.equal(r.ok, true, r.gaps.join("\n"));
    const mint = r.events.at(-1);
    assert.equal(mint?.seq, null);
    assert.equal(mint?.event, "round_opened (due)");
    assert.equal(mint?.coins_e6, coins.toString());
    assert.deepEqual(r.not_written.at(-1), {
      round_id: 55,
      account_id: BOSS2,
      dollars_e6: "50000000",
      coins_e6: coins.toString(),
    });
  });
});

describe("supply-log's rule on small feeds", () => {
  const item = (seq: number, event: string, data: Record<string, unknown>): FeedItem => ({
    seq,
    at: 1_794_400_000_000 + seq * 1000,
    event,
    data,
  });
  const opened = (seq: number, round: number, bao: string) =>
    item(seq, "round_opened", { round_id: round, rank: "INTERN", status: "EMPLOYED", brave_at_open: bao });
  const snapshot = (
    feed: FeedItem[],
    supply: bigint,
    pending: bigint,
    round: number,
    own = 0n,
  ): SupplySnapshot => ({
    coin: "coin.test",
    rpc: "test",
    block: { height: 1, hash: "h", at_ms: 1_794_500_000_000 },
    min_first_deposit: 10_000_000n,
    feed,
    ft_total_supply: supply,
    pot: { coin_supply: supply, pending, bosses: 1 },
    round: { id: round, started_at: 0, brave_at_open: 0n },
    own_balance: own,
  });

  it("a first deposit under min_first_deposit keeps waiting", () => {
    const feed = [
      opened(1, 1, "0"),
      item(2, "paid_in", { account_id: BOSS1, pool: "BRAVE", amount: "5000000", pending: true }),
      opened(3, 2, "0"),
    ];
    const r = rebuild(snapshot(feed, 0n, 5_000_000n, 2));
    assert.equal(r.ok, true, r.gaps.join("\n"));
    assert.equal(r.totals.rebuilt_e6, "0");
    assert.match(
      r.events.at(-1)?.note ?? "",
      /under min_first_deposit \$10\.000000: the money keeps waiting/,
    );
  });

  it("takes back waiting dollars, locks 1,000 units at the first conversion, burns at cash-out", () => {
    const feed = [
      opened(1, 1, "0"),
      item(2, "paid_in", { account_id: BOSS1, pool: "BRAVE", amount: "30000000", pending: true }),
      item(3, "cashed_out", { account_id: BOSS1, pool: "BRAVE", coins: null, paid: "10000000" }),
      item(4, "paid_in", { account_id: BOSS1, pool: "SAFE", amount: "7000000", pending: false }),
      opened(5, 2, "20000000"),
      item(6, "coins_minted", { account_id: BOSS1, coins: "19999000", round_id: 2 }),
      item(7, "cashed_out", { account_id: BOSS1, pool: "BRAVE", coins: "9999500", paid: "10000000" }),
      item(8, "cashed_out", { account_id: BOSS1, pool: "SAFE", coins: null, paid: "7000000" }),
    ];
    const r = rebuild(snapshot(feed, 10_000_500n, 0n, 2, 1_000n));
    assert.equal(r.ok, true, r.gaps.join("\n"));
    assert.deepEqual(
      r.events.map((e) => [e.seq, e.kind, e.supply_after_e6]),
      [
        [2, "WAIT", "0"],
        [3, "TAKEN BACK", "0"],
        [5, "MINT", "20000000"],
        [6, "WRITE", "20000000"],
        [7, "BURN", "10000500"],
      ],
    );
    assert.equal(r.rounds[1]?.locked_e6, "1000");
    assert.equal(r.rounds[1]?.converted_e6, "20000000");
  });

  it("dollars turned from SAFE to BRAVE wait like a pay-in; coins turned to SAFE burn", () => {
    const feed = [
      opened(1, 1, "0"),
      item(2, "dial_turned", { account_id: BOSS2, to: "BRAVE", amount: "20000000" }),
      opened(3, 2, "20000000"),
      item(4, "coins_minted", { account_id: BOSS2, coins: "19999000", round_id: 2 }),
      item(5, "dial_turned", { account_id: BOSS2, to: "SAFE", amount: "5000000" }),
    ];
    const r = rebuild(snapshot(feed, 15_000_000n, 0n, 2, 1_000n));
    assert.equal(r.ok, true, r.gaps.join("\n"));
    assert.equal(r.totals.burned_dial_e6, "5000000");
  });

  it("quotes CSV fields that need it", () => {
    assert.equal(csvField("plain"), "plain");
    assert.equal(csvField('a, "b"'), '"a, ""b"""');
  });
});
