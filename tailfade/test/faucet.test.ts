import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { Faucet, isAccountId, usdSend } from "../src/faucet.ts";
import { addressOfPrivateKey, fromHex, recoverAddress, toHex, userActionDigest } from "../src/hash.ts";

const V = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url), "utf8")) as {
  keys_are_test_only: { faucet: string };
  cases: { id: string; action: Record<string, string | number>; digest: string }[];
};
const KEY = fromHex(V.keys_are_test_only.faucet);
const DERIVED =
  "secp256k1:5PQMKrnErXPZohJepKB6aHonYVmdNGLZVWwecXNb3m2XjRb8FP3D4hbdpbPDXHfvZxqg1y5X7DooCwobXDNxddBj";
const DERIVED_ADDR = "0x283779ffb96dc9ac3a03333e39b18ed0a793e040";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fake NEAR RPC and Hyperliquid: `accounts` exist; `values` are Hyperliquid account values by address. */
function world(opts: { accounts?: string[]; values?: Record<string, number>; reply?: unknown } = {}) {
  const accounts = new Set(opts.accounts ?? ["visitor.testnet", "two.testnet", "three.testnet"]);
  const values: Record<string, number> = { [addressOfPrivateKey(KEY)]: 500, ...opts.values };
  const sent: {
    action: Record<string, unknown>;
    nonce: number;
    signature: { r: string; s: string; v: number };
  }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (url.includes("rpc")) {
      const p = body.params;
      if (p.request_type === "view_account")
        return Response.json(
          accounts.has(p.account_id) ? { result: { amount: "1" } } : { error: { cause: "UNKNOWN_ACCOUNT" } },
        );
      if (p.method_name === "derived_public_key")
        return Response.json({
          result: { result: Array.from(new TextEncoder().encode(JSON.stringify(DERIVED))) },
        });
    }
    if (url.endsWith("/info") && body.type === "clearinghouseState") {
      const v = values[body.user] ?? 0;
      return Response.json({
        marginSummary: { accountValue: String(v) },
        withdrawable: String(v),
        assetPositions: [],
      });
    }
    if (url.endsWith("/exchange")) {
      sent.push(body);
      return Response.json(opts.reply ?? { status: "ok", response: { type: "default" } });
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  return { fetchFn, sent, values };
}

function faucet(w: ReturnType<typeof world>, o: { key?: Uint8Array | null; max?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "faucet-"));
  dirs.push(dir);
  const file = join(dir, "data", "grants.jsonl");
  const make = () =>
    new Faucet({
      key: o.key === undefined ? KEY : o.key,
      file,
      usd: 30,
      maxAccounts: o.max ?? 30,
      salt: "s",
      rpc: "https://rpc.test",
      hlUrl: "https://hl.test",
      fetchFn: w.fetchFn,
      now: () => 1_794_500_001_000,
    });
  return { make, file };
}

describe("the transfer it signs", () => {
  it("is the SDK's usdSend, byte for byte", () => {
    const v = V.cases.find((c) => c.id === "usd-send-1794500001000");
    assert.ok(v);
    const { action, digest } = usdSend(
      String(v.action.destination),
      String(v.action.amount),
      Number(v.action.time),
    );
    assert.deepEqual(action, v.action);
    assert.equal(toHex(digest), v.digest);
  });
});

describe("the faucet", () => {
  it("funds a real NEAR account's derived address once, signed by the faucet's key", async () => {
    const w = world();
    const f = faucet(w);
    const r = await f.make().grant("visitor.testnet", "198.51.100.1");
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.hl_address, DERIVED_ADDR);
    assert.equal(w.sent.length, 1);
    const sent = w.sent[0];
    assert.equal(sent?.action.destination, DERIVED_ADDR);
    assert.equal(sent?.action.amount, "30");
    const digest = userActionDigest("HyperliquidTransaction:UsdSend", sent?.action ?? {});
    assert.equal(recoverAddress(digest, sent?.signature ?? { r: "", s: "", v: 0 }), addressOfPrivateKey(KEY));
    // Once only, and remembered after a restart.
    const again = await f.make().grant("visitor.testnet", "198.51.100.9");
    assert.equal(!again.ok && again.status, 409);
    assert.equal(readFileSync(f.file, "utf8").includes("198.51.100"), false); // addresses are never stored
  });

  it("refuses names that are not accounts, accounts that do not exist, and addresses already funded", async () => {
    const w = world({ values: { [DERIVED_ADDR]: 45 } });
    const f = faucet(w).make();
    assert.equal(((await f.grant("Not Valid", "a")) as { status: number }).status, 400);
    assert.equal(((await f.grant("ghost.testnet", "a")) as { status: number }).status, 404);
    const funded = await f.grant("visitor.testnet", "a");
    assert.equal(!funded.ok && funded.status, 409);
    assert.equal(w.sent.length, 0);
  });

  it("caps: two accounts a day from one address, a total cap, and an empty faucet", async () => {
    const w = world();
    const f = faucet(w, { max: 3 }).make();
    assert.equal((await f.grant("visitor.testnet", "203.0.113.7")).ok, true);
    // A fresh derived address each time is not possible in this fake, so free it again for the next account.
    w.values[DERIVED_ADDR] = 0;
    assert.equal((await f.grant("two.testnet", "203.0.113.7")).ok, true);
    const third = await f.grant("three.testnet", "203.0.113.7");
    assert.equal(!third.ok && third.status, 429);
    assert.equal((await f.grant("three.testnet", "203.0.113.8")).ok, true);
    const capped = await f.grant("four.testnet", "203.0.113.9");
    assert.equal(!capped.ok && capped.status, 503);

    const empty = world({ values: { [addressOfPrivateKey(KEY)]: 10 } });
    const r = await faucet(empty).make().grant("visitor.testnet", "a");
    assert.equal(!r.ok && r.error, "the faucet is empty");
  });

  it("without a key it says so, and Hyperliquid's refusals are passed on", async () => {
    const none = await faucet(world(), { key: null }).make().grant("visitor.testnet", "a");
    assert.deepEqual(none, { ok: false, status: 503, error: "the faucet has no key yet" });
    const st = await faucet(world(), { key: null }).make().status();
    assert.equal(st.configured, false);

    const w = world({ reply: { status: "err", response: "Insufficient balance" } });
    const r = await faucet(w).make().grant("visitor.testnet", "a");
    assert.equal(!r.ok && r.status, 502);
    assert.match(!r.ok ? r.error : "", /Insufficient balance/);
  });

  it("account ids follow NEAR's rules", () => {
    assert.equal(isAccountId("boss2.desk-lab-2026.testnet"), true);
    assert.equal(isAccountId("Bad.testnet"), false);
    assert.equal(isAccountId("a"), false);
  });
});
