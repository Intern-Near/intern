import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  cannotDeliver,
  exchangeBody,
  fetchFills,
  parseExchangeReply,
  readFills,
  readFunding,
  type SignedForDelivery,
} from "../src/hl-exchange.ts";

const INFO = fileURLToPath(new URL("../../fixtures/hl/info/2026-11-11T173427Z/", import.meta.url));
const read = (name: string): unknown => JSON.parse(readFileSync(`${INFO}${name}`, "utf8"));

// The probe's opening order as the research contract signed it (research-scripts/hl_guard_e2e_output.txt). The
// signature here is dummy bytes; the probe's own r and s were not printed.
const OPEN: SignedForDelivery = {
  action: {
    type: "order",
    orders: [{ a: 173, b: true, p: "0.068795", s: "177", r: false, t: { limit: { tif: "Ioc" } } }],
    grouping: "na",
  },
  nonce: 1794375990906,
  expires_after: 1794376110906,
  signature: { r: `0x${"ab".repeat(32)}`, s: `0x${"cd".repeat(32)}`, v: 28 },
};

describe("delivering a signed action", () => {
  it("sends exactly {action, nonce, signature, vaultAddress: null, expiresAfter}, as the SDK and the probe do", () => {
    assert.equal(
      exchangeBody(OPEN),
      `{"action":{"type":"order","orders":[{"a":173,"b":true,"p":"0.068795","s":"177","r":false,"t":{"limit":{"tif":"Ioc"}}}],"grouping":"na"},"nonce":1794375990906,"signature":{"r":"0x${"ab".repeat(32)}","s":"0x${"cd".repeat(32)}","v":28},"vaultAddress":null,"expiresAfter":1794376110906}`,
    );
  });

  it("does not send an expired action, or a v other than 27 or 28 (item N)", () => {
    assert.equal(cannotDeliver(OPEN, OPEN.nonce + 1_000), null);
    assert.match(cannotDeliver(OPEN, OPEN.expires_after - 1_000) ?? "", /expired/);
    assert.match(
      cannotDeliver({ ...OPEN, signature: { ...OPEN.signature, v: 1 } }, OPEN.nonce) ?? "",
      /item N/,
    );
  });
});

describe("Hyperliquid's replies to /exchange", () => {
  it("the documented forms", () => {
    assert.deepEqual(parseExchangeReply('{"status":"ok","response":{"type":"default"}}'), {
      kind: "ok",
      type: "default",
      statuses: [],
    });
    assert.deepEqual(
      parseExchangeReply(
        '{"status":"ok","response":{"type":"order","data":{"statuses":[{"resting":{"oid":77738308}}]}}}',
      ),
      { kind: "ok", type: "order", statuses: [{ resting: { oid: 77738308 } }] },
    );
    assert.deepEqual(
      parseExchangeReply(
        '{"status":"ok","response":{"type":"order","data":{"statuses":[{"filled":{"totalSz":"0.02","avgPx":"1891.4","oid":77747314}}]}}}',
      ),
      {
        kind: "ok",
        type: "order",
        statuses: [{ filled: { totalSz: "0.02", avgPx: "1891.4", oid: 77747314 } }],
      },
    );
    assert.deepEqual(
      parseExchangeReply(
        '{"status":"ok","response":{"type":"order","data":{"statuses":[{"error":"Order must have minimum value of $10."}]}}}',
      ),
      { kind: "ok", type: "order", statuses: [{ error: "Order must have minimum value of $10." }] },
    );
  });

  it("the probe's real refusal (an account with no deposit)", () => {
    assert.deepEqual(
      parseExchangeReply(
        '{"status":"err","response":"User or API Wallet 0x283779ffb96dc9ac3a03333e39b18ed0a793e040 does not exist."}',
      ),
      {
        kind: "err",
        message: "User or API Wallet 0x283779ffb96dc9ac3a03333e39b18ed0a793e040 does not exist.",
      },
    );
  });

  it("anything else is refused", () => {
    assert.throws(() => parseExchangeReply('{"status":"ok"}'), /unexpected reply/);
    assert.throws(
      () =>
        parseExchangeReply(
          '{"status":"ok","response":{"type":"order","data":{"statuses":[{"waiting":{}}]}}}',
        ),
      /unexpected order status/,
    );
  });
});

describe("fills and funding (live replies saved on 2026-11-11)", () => {
  it("reads real fills and funding records", () => {
    const fills = readFills(read("userFillsByTime-mainnet-sample.json"));
    assert.equal(fills.length, 2);
    assert.equal(fills[0]?.dir, "Open Short");
    assert.equal(fills[1]?.dir, "Close Short");
    assert.equal(fills[1]?.feeToken, "USDC");
    const funding = readFunding(read("userFunding-mainnet-sample.json"));
    // A short (szi < 0) at a positive rate receives funding: usdc > 0. This is the sign the runner relies on.
    assert.equal(funding[0]?.coin, "BTC");
    assert.ok(Number(funding[0]?.szi) < 0 && Number(funding[0]?.usdc) > 0);
    assert.deepEqual(readFills(read("userFillsByTime-testnet-probe.json")), []); // the probe's address: no fill ever
  });

  it("pages through full replies and drops repeats", async () => {
    const make = (tid: number, time: number) => ({
      coin: "DOGE",
      px: "0.07",
      sz: "143.0",
      side: "B",
      time,
      startPosition: "0.0",
      dir: "Open Long",
      closedPnl: "0.0",
      hash: "0x0",
      oid: tid,
      crossed: true,
      fee: "0.004",
      tid,
      feeToken: "USDC",
    });
    const all = Array.from({ length: 750 }, (_, i) => make(i, 1_000 + Math.floor(i / 2)));
    const seen: number[] = [];
    const fakeFetch: typeof fetch = async (_url, init) => {
      const req = JSON.parse(String(init?.body));
      seen.push(req.startTime);
      return new Response(JSON.stringify(all.filter((f) => f.time >= req.startTime).slice(0, 500)));
    };
    const fills = await fetchFills("0xabc", 1_000, 2_000, fakeFetch);
    assert.equal(fills.length, 750);
    assert.deepEqual(seen, [1_000, 1_249]);
  });

  it("an unexpected shape is refused", () => {
    assert.throws(() => readFills([{ coin: "DOGE" }]), /entry 0/);
    assert.throws(() => readFunding([{ time: 1, delta: { type: "deposit" } }]), /entry 0/);
  });
});
