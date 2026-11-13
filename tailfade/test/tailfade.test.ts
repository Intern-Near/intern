import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { fromHex, l1Digest, type Packable, recoverAddress, signDigest, toHex } from "../src/hash.ts";
import type { Market } from "../src/hl.ts";
import {
  addressFromDerivedKey,
  PATH,
  SIGNER,
  sigFromOutcome,
  sigFromSignResult,
  signTransaction,
} from "../src/mpc.ts";
import {
  agentFromHex,
  agentToHex,
  approveAgent,
  type FeedItem,
  HL_NAME,
  iocOrder,
  isBuy,
  leverageAction,
  liquidationMovePct,
  newAgent,
  openWindow,
  placeChip,
  roundPx,
  sizeFor,
  TAIL_OR_FADE,
  wire,
} from "../src/tailfade.ts";

const V = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url), "utf8")) as {
  keys_are_test_only: { agent: string };
  cases: { id: string; action: Record<string, Packable>; digest: string; nonce?: number }[];
};
const vec = (id: string) => {
  const v = V.cases.find((c) => c.id === id);
  if (!v) throw new Error(id);
  return v;
};
const DOGE: Market = { name: "DOGE", asset: 173, szDecimals: 0, maxLeverage: 10 };

describe("the visitor's Hyperliquid address and their wallet's one transaction", () => {
  it("the address from NEAR's signing network (a real derived key recorded on testnet)", () => {
    const probe = JSON.parse(readFileSync(new URL("./derived-key-probe.json", import.meta.url), "utf8")) as {
      result: string;
      address: string;
    };
    assert.equal(addressFromDerivedKey(probe.result), probe.address);
    assert.throws(() => addressFromDerivedKey("ed25519:abc"), /not a secp256k1 key/);
  });

  it("the wallet's transaction: sign on the signing network, 1 yocto, our path, the digest as hex", () => {
    const d = new Uint8Array(32).fill(7);
    const tx = signTransaction(d);
    assert.equal(tx.receiverId, SIGNER);
    const call = tx.actions[0]?.params;
    assert.equal(call?.methodName, "sign");
    assert.equal(call?.deposit, "1");
    assert.deepEqual(call?.args, {
      request: { path: PATH, domain_id: 0, payload_v2: { Ecdsa: "07".repeat(32) } },
    });
    assert.throws(() => signTransaction(new Uint8Array(31)), /32 bytes/);
  });

  it("reads the signing network's answer as a signature that recovers to the signer", () => {
    const key = secp256k1.utils.randomSecretKey();
    const digest = new Uint8Array(32).fill(9);
    const s = signDigest(key, digest);
    const answer = {
      big_r: { affine_point: `02${s.r.slice(2)}` },
      s: { scalar: s.s.slice(2) },
      recovery_id: s.v - 27,
    };
    const sig = sigFromSignResult(answer);
    assert.deepEqual(sig, s);
    const outcome = { status: { SuccessValue: btoa(JSON.stringify(answer)) } };
    assert.deepEqual(sigFromOutcome(outcome), s);
    assert.equal(recoverAddress(digest, sig), agentFromHex(toHex(key)).address);
    assert.throws(
      () => sigFromSignResult({ big_r: {}, s: {}, recovery_id: 3 }),
      /not a signing-network signature/,
    );
    assert.throws(() => sigFromOutcome({ status: { Failure: {} } }), /did not succeed/);
  });
});

describe("approvals and orders, exactly as the SDK builds them", () => {
  it("approveAgent reproduces the SDK's digest for the same key and nonce", () => {
    const agent = agentFromHex(V.keys_are_test_only.agent);
    const { action, digest } = approveAgent(agent.address, 1794500000000);
    assert.deepEqual(action, vec("approve-agent-1794500000000").action);
    assert.equal(toHex(digest), vec("approve-agent-1794500000000").digest);
  });

  it("isolated 2x leverage and IOC orders reproduce the SDK's actions and digests", () => {
    assert.deepEqual(leverageAction(DOGE), vec("leverage-isolated-2x").action);
    const cases: [string, boolean, number, number, boolean][] = [
      ["order-tail-doge", true, 0.069421, 300, false],
      ["order-fade-doge", false, 0.067998, 721, false],
      ["order-close-doge", false, 0.06801, 300, true],
    ];
    for (const [id, buy, px, sz, reduce] of cases) {
      const a = iocOrder(DOGE, buy, px, sz, reduce);
      assert.deepEqual(a, vec(id).action, id);
      assert.equal(toHex(l1Digest(a, vec(id).nonce ?? 0, true)), vec(id).digest, id);
    }
    assert.throws(() => leverageAction({ ...DOGE, maxLeverage: 1 }), /at most 1x/);
  });

  it("trading keys: random, kept as hex, restored to the same address", () => {
    const a = newAgent();
    const b = agentFromHex(agentToHex(a));
    assert.equal(b.address, a.address);
    assert.notEqual(newAgent().address, a.address);
    assert.throws(() => agentFromHex("0x1234"), /32 bytes/);
  });
});

describe("prices, sizes, sides", () => {
  it("wire form: up to 8 decimals, no trailing zeros", () => {
    assert.equal(wire(300), "300");
    assert.equal(wire(0.06801), "0.06801");
    assert.equal(wire(12.5), "12.5");
    assert.throws(() => wire(0.123456789), /rounded/);
  });

  it("prices: 5 significant figures, at most 6 − szDecimals decimals", () => {
    assert.equal(roundPx(0.0694213, 0), 0.069421);
    assert.equal(roundPx(0.00532311, 0), 0.005323);
    assert.equal(roundPx(12.345678, 1), 12.346);
    assert.equal(roundPx(107123.4, 5), 107120);
    assert.equal(roundPx(42, 2), 42);
  });

  it("sizes: the chip's notional at 2x, to the market's decimals, never under $10", () => {
    assert.equal(sizeFor(20, 0.0666, 0), 300);
    assert.equal(sizeFor(50, 0.0666, 0), 751);
    assert.equal(sizeFor(20, 13.37, 1), 1.5);
    assert.ok(sizeFor(10, 0.0666, 0) * 0.0666 >= 10);
    assert.ok(sizeFor(9, 3.3, 0) * 3.3 >= 10);
  });

  it("TAIL goes the Intern's way, FADE the other way", () => {
    assert.equal(isBuy("TAIL", "LONG"), true);
    assert.equal(isBuy("FADE", "LONG"), false);
    assert.equal(isBuy("TAIL", "SHORT"), false);
    assert.equal(isBuy("FADE", "SHORT"), true);
  });

  it("the Intern's markets map to Hyperliquid's names", () => {
    assert.equal(HL_NAME.SHIB, "kSHIB");
    assert.equal(HL_NAME.PEPE, "kPEPE");
    assert.equal(HL_NAME.DOGE, "DOGE");
  });
});

describe("bigger chips (reward ladder R5)", () => {
  it("5x and 10x where the market allows; the size grows with the leverage", () => {
    assert.deepEqual(leverageAction(DOGE, 10), {
      type: "updateLeverage",
      asset: 173,
      isCross: false,
      leverage: 10,
    });
    assert.throws(() => leverageAction({ ...DOGE, name: "WIF", maxLeverage: 5 }, 10), /at most 5x/);
    assert.equal(sizeFor(10 * 5, 0.0666, 0), 751);
    assert.equal(sizeFor(10 * 10, 0.0666, 0), 1502);
    assert.equal(liquidationMovePct(2), 45);
    assert.equal(liquidationMovePct(10), 9);
  });
});

describe("the window", () => {
  const T = 1_794_507_000_000;
  const feed: FeedItem[] = [
    {
      seq: 1,
      at: T - 30_000,
      event: "approved",
      data: { position_id: 5, round_id: 12, market: "DOGE", side: "LONG" },
    },
    {
      seq: 2,
      at: T - 20_000,
      event: "order_signed",
      data: { action_id: 10, position_id: 5, kind: "LEVERAGE" },
    },
    { seq: 3, at: T, event: "order_signed", data: { action_id: 11, position_id: 5, kind: "OPEN" } },
  ];
  it("opens when the Intern's opening order is signed, for its market and side, for 10 minutes", () => {
    assert.deepEqual(openWindow(feed, T + 60_000), {
      position_id: 5,
      round_id: 12,
      market: "DOGE",
      side: "LONG",
      opens_at: T,
      closes_at: T + TAIL_OR_FADE.windowMs,
    });
    assert.equal(openWindow(feed, T + TAIL_OR_FADE.windowMs), null);
    assert.equal(openWindow(feed.slice(0, 2), T), null); // leverage alone does not open it
    assert.equal(openWindow([], T), null);
  });
});

describe("placing a chip", () => {
  it("isolated 2x first, then an IOC order through the mid; both signed by the trading key", async () => {
    const agent = newAgent();
    const posted: { action: Packable; nonce: number; signature: { r: string; s: string; v: number } }[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (url.endsWith("/info") && body.type === "meta")
        return Response.json({
          universe: [
            ...Array.from({ length: 173 }, () => ({ name: "X", szDecimals: 0, maxLeverage: 3 })),
            { name: "DOGE", szDecimals: 0, maxLeverage: 10 },
          ],
        });
      if (url.endsWith("/info") && body.type === "allMids") return Response.json({ DOGE: "0.0666" });
      if (url.endsWith("/exchange")) {
        posted.push(body);
        return Response.json({ status: "ok", response: { type: "default" } });
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
    const realFetch = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      let t = 1_794_507_100_000;
      const r = await placeChip({
        agent,
        market: "DOGE",
        choice: "FADE",
        internSide: "LONG",
        chipUsd: 10,
        now: () => t++,
      });
      assert.equal(r.buy, false);
      assert.equal(r.sz, "300");
      assert.equal(r.px, wire(roundPx(0.0666 * 0.99, 0)));
      assert.equal(posted.length, 2);
      assert.deepEqual(posted[0]?.action, {
        type: "updateLeverage",
        asset: 173,
        isCross: false,
        leverage: 2,
      });
      for (const p of posted)
        assert.equal(recoverAddress(l1Digest(p.action, p.nonce, true), p.signature), agent.address);
      assert.ok((posted[1]?.nonce ?? 0) > (posted[0]?.nonce ?? 0));
      // 10x: the leverage action says 10, the order is five times the 2x size.
      posted.length = 0;
      const ten = await placeChip({
        agent,
        market: "DOGE",
        choice: "TAIL",
        internSide: "LONG",
        chipUsd: 10,
        leverage: 10,
        now: () => t++,
      });
      assert.deepEqual(posted[0]?.action, {
        type: "updateLeverage",
        asset: 173,
        isCross: false,
        leverage: 10,
      });
      assert.equal(ten.sz, "1502");
      await assert.rejects(
        placeChip({
          agent,
          market: "DOGE",
          choice: "TAIL",
          internSide: "LONG",
          chipUsd: 10,
          leverage: 3 as 2,
          now: () => t++,
        }),
        /leverage must be one of 2, 5, 10/,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.ok(fromHex(agentToHex(agent)).length === 32);
  });
});
