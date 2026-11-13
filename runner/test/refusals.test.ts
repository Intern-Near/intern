import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RpcExchange } from "../src/near-rpc.ts";
import { blockMs, type NearblocksExchange, receiptsCalling, txLink } from "../src/nearblocks.ts";
import {
  COIN_FAST,
  type CoinCatalogue,
  catalogue,
  describeRefusal,
  findRefusalTx,
  type Refusal,
  readAllRefusals,
  readCodeTable,
  renderRefusals,
  summarize,
} from "../src/refusals.ts";
import { viewFinal } from "../src/rpc-read.ts";
import { REFUSAL_CODES } from "../src/rules.ts";
import { readData, replayFetch } from "./support/replay-fetch.ts";

// Real replies of `npm run refusals -- --save` on 2026-11-13 at 15:12 UTC (test/data/refusals-2026-11-13T151222Z/,
// each with its own fetched_at): get_refusals of both coins from https://test.rpc.fastnear.com; NearBlocks' propose
// receipts at each first example's time (https://api-testnet.nearblocks.io); and the four transactions, read with `tx`
// (5JND4c… from the archival node: the regular one no longer had it). Replayed offline.
const SAVED = readData<{ checked_at: string; rpc: RpcExchange[]; nearblocks: NearblocksExchange[] }>(
  "refusals-2026-11-13T151222Z/replies.json",
);
const RPC = "https://test.rpc.fastnear.com";
const RPCS = [RPC, "https://archival-rpc.testnet.fastnear.com", "https://archival-rpc.testnet.near.org"];
const COIN = "coin.desk-lab-2026.testnet";
const { codes } = readCodeTable();

async function recordedCatalogue(coin: string, withTx = true): Promise<CoinCatalogue> {
  const fetchFn = replayFetch(SAVED.rpc, SAVED.nearblocks);
  const refusals = await readAllRefusals((m, a) => viewFinal({ urls: [RPC], fetchFn }, coin, m, a));
  return catalogue(
    coin,
    refusals,
    codes,
    withTx ? (r) => findRefusalTx({ fetchFn, rpcs: RPCS }, coin, r) : null,
  );
}

const refusal = (over: Partial<Refusal> = {}): Refusal => ({
  id: 1,
  round_id: 2,
  code: "OVER_TRADE_LIMIT",
  at: 1794422593911,
  asked: "10000000",
  limit: "1000010",
  decision: { action: "BET", market: "DOGE", side: "LONG", margin: "10000000", leverage: 1 },
  is_first: true,
  credited_to: null,
  ...over,
});

describe("the sixteen codes", () => {
  it("come from interface/refusal-codes.json in check order, the same as the runner's copy", () => {
    assert.deepEqual(
      codes.map((c) => c.code),
      [...REFUSAL_CODES],
    );
    assert.deepEqual(
      codes.map((c) => c.check),
      REFUSAL_CODES.map((_, i) => i + 1),
    );
    const fallback = readCodeTable("/nonexistent/refusal-codes.json");
    assert.match(fallback.source, /rules\.ts/);
    assert.equal(fallback.codes.length, 16);
  });
});

describe("the catalogue on the recorded replies", () => {
  it("finds the live coin's one refusal and its transaction, confirmed on an archival node", async () => {
    const c = await recordedCatalogue(COIN);
    assert.equal(c.refusals, 1);
    assert.deepEqual(c.with_example, ["OVER_TRADE_LIMIT"]);
    assert.equal(c.without_example.length, 15);
    const e = c.codes.find((x) => x.code === "OVER_TRADE_LIMIT");
    assert.equal(e?.count, 1);
    assert.equal(e?.first?.round_id, 2);
    assert.equal(
      e?.first?.detail,
      "DOGE long $10.000000 at 1x; asked $10.000000 (margin); limit $1.000010 (per-bet limit in dollars)",
    );
    const tx = e?.first?.tx;
    assert.equal(tx?.tx_hash, "5JND4cTbyXHN5FMEMURukEt2HVnWtjmgRky4fvWBzmtW");
    assert.equal(tx?.link, "https://testnet.nearblocks.io/txns/5JND4cTbyXHN5FMEMURukEt2HVnWtjmgRky4fvWBzmtW");
    assert.equal(tx?.sender, "runner.desk-lab-2026.testnet");
    assert.equal(tx?.confirmed, true);
    assert.equal(tx?.read_from, "https://archival-rpc.testnet.fastnear.com");
    assert.match(tx?.note ?? "", /returned NOPE OVER_TRADE_LIMIT, refusal 1, and logged the refused event/);
  });

  it("finds coin-fast's three, one code each, every transaction confirmed", async () => {
    const c = await recordedCatalogue(COIN_FAST);
    assert.deepEqual(c.with_example, ["FIRED", "NOT_ON_LIST", "OVER_LEVERAGE"]);
    assert.deepEqual(
      c.codes
        .filter((e) => e.first)
        .map((e) => [e.code, e.first?.refusal_id, e.first?.tx?.tx_hash, e.first?.tx?.confirmed]),
      [
        ["FIRED", 1, "DuTxFWRfc9hde1upCbeiDfThcAuzUM9ef7ABbZsJnXBD", true],
        ["NOT_ON_LIST", 2, "4VoxFZW92Qyd6ALLE5H7Gp1qgH2y8cJfNr6WCuXZUhrx", true],
        ["OVER_LEVERAGE", 3, "2VzPaXTJJcEJHJcHuCdvvEzjoQRmfq2qd8fmSJZrGKSK", true],
      ],
    );
    const fired = c.codes.find((e) => e.code === "FIRED")?.first;
    assert.equal(fired?.detail, "no decision recorded");
    assert.match(
      c.codes.find((e) => e.code === "NOT_ON_LIST")?.first?.detail ?? "",
      /credited to boss2\.desk-lab-2026\.testnet/,
    );
  });

  it("sums both coins: 4 codes with an example, 12 without, and prints them", async () => {
    const rep = summarize([await recordedCatalogue(COIN), await recordedCatalogue(COIN_FAST)], {
      checked_at: SAVED.checked_at,
      rpc: RPC,
      nearblocks: "https://api-testnet.nearblocks.io",
      codes_source: "interface/refusal-codes.json",
    });
    assert.equal(rep.summary.refusals, 4);
    assert.deepEqual(rep.summary.with_example, ["FIRED", "NOT_ON_LIST", "OVER_LEVERAGE", "OVER_TRADE_LIMIT"]);
    assert.equal(rep.summary.without_example.length, 12);
    assert.equal(rep.summary.first_tx_confirmed, 4);
    const text = renderRefusals(rep).join("\n");
    assert.match(text, / {2}11 OVER_TRADE_LIMIT {7}1 {2}first: refusal 1, round 2/);
    assert.match(text, /no example yet \(13\): OUTSIDE_WINDOW, BAD_MODEL_SIGNATURE/);
    assert.match(text, /4 confirmed, 0 found but not confirmed, 0 not found/);
  });

  it("does not look transactions up with --no-tx", async () => {
    const c = await recordedCatalogue(COIN, false);
    const f = c.codes.find((x) => x.code === "OVER_TRADE_LIMIT")?.first;
    assert.equal(f?.tx, null);
    assert.equal(f?.tx_note, "not looked up (--no-tx)");
  });
});

describe("reading get_refusals page by page", () => {
  it("reads 250 refusals from the newest, 100 at a time, and returns them oldest first", async () => {
    const asked: unknown[] = [];
    const view = async (_m: string, args: Record<string, unknown>) => {
      asked.push(args.from);
      const top = typeof args.from === "number" ? args.from : 250;
      const ids = Array.from({ length: Math.min(100, top) }, (_, i) => top - i);
      return ids.map((id) => ({ ...refusal({ id }), decision: null }));
    };
    const all = await readAllRefusals(view);
    assert.equal(all.length, 250);
    assert.deepEqual(asked, [undefined, 150, 50]);
    assert.equal(all[0]?.id, 1);
    assert.equal(all[249]?.id, 250);
  });

  it("refuses a list whose ids do not go down, or a malformed refusal", async () => {
    await assert.rejects(
      readAllRefusals(async () => [refusal({ id: 1 }), refusal({ id: 2 })]),
      /do not go down/,
    );
    await assert.rejects(
      readAllRefusals(async () => [{ ...refusal(), at: "soon" }]),
      /at: not a whole number/,
    );
    await assert.rejects(
      readAllRefusals(async () => ({})),
      /expected a list/,
    );
  });
});

describe("describing a refusal", () => {
  it("writes dollars for the dollar codes, raw numbers for the others", () => {
    assert.equal(
      describeRefusal(refusal({ code: "ZERO_MARGIN", asked: "5000000", limit: "11000000" }), undefined),
      "DOGE long $10.000000 at 1x; asked $5.000000; limit $11.000000",
    );
    assert.equal(
      describeRefusal(
        refusal({ code: "OVER_LEVERAGE", asked: "10", limit: "1", credited_to: "v.testnet" }),
        undefined,
      ),
      "DOGE long $10.000000 at 1x; asked 10; limit 1; credited to v.testnet",
    );
    assert.equal(
      describeRefusal(refusal({ decision: { action: "SKIP" }, asked: null, limit: null }), undefined),
      "a skip",
    );
  });
});

/** NearBlocks' reply with these propose receipts. */
const receipts = (rows: { hash: string; ns: string; from?: string }[]) =>
  JSON.stringify({
    data: rows.map((r, i) => ({
      actions: [{ action: "FUNCTION_CALL", method: "propose" }],
      block: { block_hash: "h", block_height: `${100 + i}`, block_timestamp: r.ns },
      outcome: { status: true },
      predecessor_account_id: r.from ?? "runner.testnet",
      receipt_id: `r${i}`,
      receiver_account_id: COIN,
      transaction_hash: r.hash,
    })),
  });
const nbUrl = (at: number) =>
  `https://api-testnet.nearblocks.io/v3/accounts/${COIN}/receipts?method=propose&limit=10&before_ts=${(BigInt(at) + 1n) * 1_000_000n}`;

describe("finding a refusal's transaction", () => {
  const r = refusal();
  const tx5 = SAVED.rpc.filter(
    (e) => e.request.params.tx_hash === "5JND4cTbyXHN5FMEMURukEt2HVnWtjmgRky4fvWBzmtW",
  );

  it("says so when NearBlocks lists no propose receipt at that millisecond", async () => {
    const body = receipts([
      { hash: "5JND4cTbyXHN5FMEMURukEt2HVnWtjmgRky4fvWBzmtW", ns: "1794422593910999999" },
    ]);
    const fetchFn = replayFetch([], [{ url: nbUrl(r.at), status: 200, body, fetched_at: "" }]);
    await assert.rejects(findRefusalTx({ fetchFn, rpcs: RPCS }, COIN, r), /lists no propose receipt/);
  });

  it("reports NearBlocks' rate limit instead of retrying", async () => {
    const fetchFn = replayFetch([], [{ url: nbUrl(r.at), status: 429, body: "slow down", fetched_at: "" }]);
    await assert.rejects(findRefusalTx({ fetchFn, rpcs: RPCS }, COIN, r), /HTTP 429: its rate limit/);
    assert.equal(fetchFn.calls.length, 1);
  });

  it("does not take a transaction that returned another refusal", async () => {
    const body = receipts([
      {
        hash: "5JND4cTbyXHN5FMEMURukEt2HVnWtjmgRky4fvWBzmtW",
        ns: "1794422593911504350",
        from: "runner.desk-lab-2026.testnet",
      },
    ]);
    const fetchFn = replayFetch(tx5, [{ url: nbUrl(r.at), status: 200, body, fetched_at: "" }]);
    await assert.rejects(
      findRefusalTx({ fetchFn, rpcs: RPCS }, COIN, { ...r, id: 7 }),
      /returned refusal 7: 5JND4c\S* returned NOPE/,
    );
  });

  it("gives the only candidate, marked not confirmed, when the RPC cannot read it", async () => {
    const body = receipts([
      { hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", ns: "1794422593911000000" },
    ]);
    const fetchFn = replayFetch([], [{ url: nbUrl(r.at), status: 200, body, fetched_at: "" }]);
    const found = await findRefusalTx({ fetchFn, rpcs: RPCS }, COIN, r);
    assert.equal(found.confirmed, false);
    assert.equal(found.read_from, null);
    assert.match(
      found.note,
      /the only propose receipt NearBlocks lists at that millisecond; AAAA\S* could not be read/,
    );
  });

  it("keeps a failed lookup as a note in the catalogue", async () => {
    const c = await catalogue(COIN, [r], codes, async () => {
      throw new Error("NearBlocks answered HTTP 503");
    });
    const f = c.codes.find((x) => x.code === "OVER_TRADE_LIMIT")?.first;
    assert.equal(f?.tx, null);
    assert.equal(f?.tx_note, "NearBlocks answered HTTP 503");
  });

  it("asks NearBlocks with a 19-digit nanosecond time and reads block times as the contract does", async () => {
    await assert.rejects(
      receiptsCalling(replayFetch([]), { account: COIN, method: "propose", beforeNs: 5n, limit: 1 }),
      /19 digits/,
    );
    const body = receipts([{ hash: "x", ns: "1794422593911504350" }]);
    const { rows, next } = await receiptsCalling(
      replayFetch([], [{ url: nbUrl(r.at), status: 200, body, fetched_at: "" }]),
      { account: COIN, method: "propose", beforeNs: (BigInt(r.at) + 1n) * 1_000_000n, limit: 10 },
    );
    assert.equal(next, null);
    assert.equal(rows[0] && blockMs(rows[0]), 1794422593911);
    assert.equal(rows[0]?.block_height, 100);
    assert.equal(txLink("abc"), "https://testnet.nearblocks.io/txns/abc");
  });
});
