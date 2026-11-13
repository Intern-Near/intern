import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { KeyPair } from "near-api-js";
import {
  type AccessKey,
  checkKeyScope,
  describeScope,
  judgeKeys,
  type KeyReader,
  type KeyScope,
  keyScopeMode,
  readPermission,
  type ScopeInput,
  signingPublicKey,
  startupKeyScope,
} from "../src/key-scope.ts";
import { memoryLog } from "../src/log.ts";
import { Secret } from "../src/secret.ts";

// Real replies to the RPC query view_access_key_list for the runner's and the relayer's accounts, fetched from
// https://test.rpc.fastnear.com on 2026-11-13 at 13:58 UTC (test/data/view-access-key-list-2026-11-13.json): public
// keys only. Where a test needs a private key (the start-up check derives the public key from it), it makes a random
// throwaway key pair in memory.
const SAVED = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./data/view-access-key-list-2026-11-13.json", import.meta.url)),
    "utf8",
  ),
);
const RUNNER = "intern-runner-ed25519.testnet";
const RELAYER = "intern-relayer-ed25519.testnet";
const COIN = "coin.desk-lab-2026.testnet";
const THREE = ["propose", "sign_next", "report_result"];
const RUNNER_FC = "ed25519:Cd5AKFazydp6F8rvUkKZsxV2mQYpUiAGAPEb464XF9wy";
const RUNNER_FA = "ed25519:5ymHpQp7aMbRG2sLuD4CkvoUoFqfw9uvXoWFoPAiikes";
const RELAYER_FA = "ed25519:5zY72Yfx1wsREXKUbynWnf1z3g5M1HfcQcQPS3BAzrQT";
const OWNER_NOTE =
  "also holds 1 full-access key (normally the account owner's key; whoever holds it can do anything with this account)";

/** A stand-in for the RPC that answers from `results`, and fails like the RPC for any other account. */
function rpcFrom(results: Record<string, unknown>): KeyReader & { asked: string[] } {
  const asked: string[] = [];
  const viewAccessKeyList = async ({ accountId }: { accountId: string }) => {
    asked.push(accountId);
    const r = results[accountId];
    if (r === undefined) throw new Error(`account ${accountId} does not exist while viewing`);
    return r;
  };
  return { asked, viewAccessKeyList: viewAccessKeyList as KeyReader["viewAccessKeyList"] };
}

const fc = (
  receiver_id: string,
  method_names: string[],
  allowance: string | null = "1000000000000000000000000",
) => ({
  FunctionCall: { allowance, method_names, receiver_id },
});
/** Keys named ed25519:key0, ed25519:key1, … with the given permissions. */
const keys = (...permissions: unknown[]): AccessKey[] =>
  permissions.map((p, i) => readPermission(`ed25519:key${i}`, p));
const judge = (ks: AccessKey[], over: Partial<ScopeInput> = {}): KeyScope =>
  judgeKeys(
    {
      accountId: RUNNER,
      expect: "runner",
      contract: COIN,
      contractRunner: RUNNER,
      signingKey: "ed25519:key0",
      ...over,
    },
    ks,
  );
const real = (accountId: string, expect: "runner" | "relayer", signingKey: string | null) =>
  checkKeyScope(rpcFrom(SAVED.results), {
    accountId,
    expect,
    contract: COIN,
    contractRunner: RUNNER,
    signingKey,
  });

describe("key scope of the real accounts (saved replies)", () => {
  it("the runner signing with its function-call key: AS DECLARED, its full-access key a note", async () => {
    const s = await real(RUNNER, "runner", RUNNER_FC);
    assert.equal(s.verdict, "as declared");
    assert.deepEqual(s.reasons, []);
    assert.deepEqual(s.notes, [OWNER_NOTE]);
    assert.deepEqual(
      s.keys.map((k) => [k.public_key, k.signing, k.fit]),
      [
        [RUNNER_FA, false, "broader"],
        [RUNNER_FC, true, "as declared"],
      ],
    );
    assert.match(
      describeScope(s),
      /^intern-runner-ed25519\.testnet: as declared: signs with ed25519:Cd5AK.*\(propose, sign_next, report_result; allowance 0\.874 NEAR\); also holds 1 full-access key/,
    );
  });

  it("the runner signing with its full-access key: NOT AS DECLARED", async () => {
    const s = await real(RUNNER, "runner", RUNNER_FA);
    assert.equal(s.verdict, "not as declared");
    assert.match(s.reasons.join(), /the signing key ed25519:5ymH\w+: full access/);
    assert.equal(s.notes.length, 1); // the function-call key, listed
    assert.match(s.notes[0] ?? "", /^also holds a function-call key for coin\.desk-lab-2026\.testnet/);
  });

  it("the runner without a signing key: no verdict, and which key would pass", async () => {
    const s = await real(RUNNER, "runner", null);
    assert.equal(s.verdict, "no verdict");
    assert.deepEqual(s.passing, [RUNNER_FC]);
    assert.equal(
      s.keys[0]?.note,
      "a full-access key: would not pass as the runner's signing key (normally the account owner's key; whoever holds it can do anything with this account)",
    );
    assert.match(s.keys[1]?.note ?? "", /: would pass as the runner's signing key$/);
    assert.match(
      describeScope(s),
      /no verdict on which key the runner uses; would pass as its signing key: ed25519:Cd5AK/,
    );
  });

  it("the relayer signing with its full-access key: AS DECLARED", async () => {
    const s = await real(RELAYER, "relayer", RELAYER_FA);
    assert.equal(s.verdict, "as declared");
    assert.deepEqual(s.notes, []);
    assert.deepEqual(s.passing, [RELAYER_FA]);
  });

  it("an account the RPC does not know fails, it is not taken for an empty one", async () => {
    await assert.rejects(real("nobody.testnet", "runner", RUNNER_FC), /does not exist/);
  });
});

describe("key scope: the runner's signing key", () => {
  it("a function-call key for the coin's three calls exactly: as declared", () => {
    assert.equal(judge(keys(fc(COIN, THREE))).verdict, "as declared");
  });

  it("a key that can do more is NOT AS DECLARED: full access, another contract, every method, one more method", () => {
    for (const k of [
      "FullAccess",
      fc("other.testnet", THREE),
      fc(COIN, []),
      fc(COIN, [...THREE, "settle"]),
    ]) {
      const s = judge(keys(k));
      assert.equal(s.verdict, "not as declared", JSON.stringify(k));
      assert.equal(s.reasons.length, 1);
    }
    assert.match(judge(keys(fc(COIN, []))).reasons.join(), /every method of the coin/);
    assert.match(judge(keys(fc(COIN, [...THREE, "settle"]))).reasons.join(), /it also allows settle/);
  });

  it("a key that can do less, or that is not on the account, is UNUSABLE", () => {
    assert.equal(judge(keys(fc(COIN, ["propose"]))).verdict, "unusable");
    assert.match(judge(keys(fc(COIN, ["propose"]))).reasons.join(), /it lacks sign_next, report_result/);
    const missing = judge(keys(fc(COIN, THREE)), { signingKey: "ed25519:elsewhere" });
    assert.equal(missing.verdict, "unusable");
    assert.match(missing.reasons.join(), /is not a key of intern-runner-ed25519\.testnet/);
  });

  it("the account's other keys are notes, never a failure", () => {
    const s = judge(keys(fc(COIN, THREE), "FullAccess", fc("other.testnet", [])));
    assert.equal(s.verdict, "as declared");
    assert.deepEqual(s.notes, [
      OWNER_NOTE,
      "also holds a function-call key for other.testnet (every method; allowance 1.000 NEAR)",
    ]);
  });

  it("an account that is not the contract's runner is UNUSABLE as the runner", () => {
    const s = judge(keys(fc(COIN, THREE)), { contractRunner: "someone.testnet" });
    assert.equal(s.verdict, "unusable");
    assert.match(s.reasons.join(), /the contract's runner is someone\.testnet/);
    assert.deepEqual(s.passing, []);
  });

  it("a signing key with a permission it does not know cannot be checked: NOT AS DECLARED", () => {
    assert.equal(judge(keys({ SomethingNew: {} })).verdict, "not as declared");
    assert.equal(judge(keys(fc(COIN, THREE), { SomethingNew: {} })).verdict, "as declared");
  });
});

describe("key scope: the relayer's signing key", () => {
  const relayer = (ks: AccessKey[], over: Partial<ScopeInput> = {}) =>
    judge(ks, { accountId: RELAYER, expect: "relayer", ...over });

  it("full access, as declared; a second full-access key is a note", () => {
    const s = relayer(keys("FullAccess", "FullAccess"));
    assert.equal(s.verdict, "as declared");
    assert.deepEqual(s.notes, [OWNER_NOTE]);
  });

  it("a function-call key cannot attach the 1 yocto close needs: UNUSABLE", () => {
    const s = relayer(keys(fc(COIN, ["close"])));
    assert.equal(s.verdict, "unusable");
    assert.match(s.reasons.join(), /cannot attach the 1 yocto/);
  });

  it("the contract's runner as the relayer: NOT AS DECLARED", () => {
    const s = relayer(keys("FullAccess"), { accountId: RUNNER });
    assert.equal(s.verdict, "not as declared");
    assert.match(s.reasons.join(), /the relayer must be a separate account/);
  });
});

describe("key scope without a signing key", () => {
  it("names the keys that would pass; none passing is said plainly", () => {
    const none = judge(keys("FullAccess", fc(COIN, ["propose"])), { signingKey: null });
    assert.equal(none.verdict, "no verdict");
    assert.deepEqual(none.passing, []);
    assert.match(none.reasons.join(), /no key of this account would pass as the runner's signing key/);
    assert.match(none.keys[1]?.note ?? "", /would not pass as the runner's signing key \(it lacks sign_next/);
  });

  it("with nothing expected, the keys are only listed", () => {
    const s = judge(keys("FullAccess"), { expect: null, signingKey: null });
    assert.equal(s.verdict, "no verdict");
    assert.deepEqual([s.reasons, s.notes, s.passing], [[], [], []]);
    assert.match(describeScope(s), /ed25519:key0: a full-access key/);
  });
});

describe("reading a permission", () => {
  it("allowance null is no limit; NEAR's gas keys read like the plain kinds", () => {
    assert.equal(keys(fc(COIN, THREE, null))[0]?.allowance, null);
    const [full, call] = keys(
      { GasKeyFullAccess: { balance: "0", num_nonces: 1 } },
      { GasKeyFunctionCall: { balance: "0", num_nonces: 1, receiver_id: COIN, method_names: THREE } },
    );
    assert.equal(full?.kind, "full-access");
    assert.equal(full?.gas_key, true);
    assert.equal(call?.kind, "function-call");
    assert.equal(call?.receiver_id, COIN);
  });

  it("an allowance that is not a decimal string is a permission it does not know, not a guess", () => {
    const [k] = keys({ FunctionCall: { allowance: 8.7e23, method_names: THREE, receiver_id: COIN } });
    assert.equal(k?.kind, "unknown");
  });
});

describe("the signing key from a private key", () => {
  it("is the key pair's public key, as the runner loads it", async () => {
    const pair = KeyPair.fromRandom("ed25519");
    assert.equal(await signingPublicKey(new Secret(pair.toString())), pair.getPublicKey().toString());
  });

  it("a key that cannot be read fails without its text", async () => {
    await assert.rejects(signingPublicKey(new Secret("ed25519:NOTAKEY-SECRET-TEXT")), (e: Error) => {
      assert.match(e.message, /could not be read/);
      assert.doesNotMatch(e.message, /SECRET-TEXT/);
      return true;
    });
  });
});

describe("INTERN_KEY_SCOPE at the runner's start", () => {
  // Throwaway key pairs made in memory: the runner's function-call key and the relayer's full-access key.
  const runnerPair = KeyPair.fromRandom("ed25519");
  const relayerPair = KeyPair.fromRandom("ed25519");
  const entry = (pair: KeyPair, permission: unknown) => ({
    public_key: pair.getPublicKey().toString(),
    access_key: { nonce: 1, permission },
  });
  /** The runner's account as on testnet: the owner's full-access key and the runner's signing key. */
  const lists = (runnerSigning: unknown) => ({
    [RUNNER]: { keys: [SAVED.results[RUNNER].keys[0], entry(runnerPair, runnerSigning)] },
    [RELAYER]: { keys: [entry(relayerPair, "FullAccess")] },
  });
  const accounts = [
    { accountId: RUNNER, expect: "runner" as const, key: new Secret(runnerPair.toString()) },
    { accountId: RELAYER, expect: "relayer" as const, key: new Secret(relayerPair.toString()) },
  ];
  const start = (env: Record<string, string | undefined>, results: Record<string, unknown>) => {
    const log = memoryLog();
    const rpc = rpcFrom(results);
    const done = startupKeyScope({ env, rpc, contract: COIN, contractRunner: RUNNER, accounts, log });
    return { log, rpc, done };
  };

  it("unset is warn; off, warn and strict as written; anything else is warn, with a note", () => {
    assert.deepEqual(keyScopeMode({}), { mode: "warn", note: null });
    assert.equal(keyScopeMode({ INTERN_KEY_SCOPE: "off" }).mode, "off");
    assert.equal(keyScopeMode({ INTERN_KEY_SCOPE: "strict" }).mode, "strict");
    const odd = keyScopeMode({ INTERN_KEY_SCOPE: "STRICT" });
    assert.equal(odd.mode, "warn");
    assert.match(odd.note ?? "", /not off, warn or strict/);
  });

  it("warn: one line per account, on the key it signs with, with the owner's key as a note", async () => {
    const { log, done } = start({}, lists(fc(COIN, THREE)));
    assert.equal(await done, true);
    assert.deepEqual(
      log.lines.map((l) => [l.step, l.account_id, l.signing_key, l.verdict]),
      [
        ["key scope", RUNNER, runnerPair.getPublicKey().toString(), "as declared"],
        ["key scope", RELAYER, relayerPair.getPublicKey().toString(), "as declared"],
      ],
    );
    assert.deepEqual(log.lines[0]?.notes, [OWNER_NOTE]);
  });

  it("strict: the account owner's full-access key does not stop the runner; a broader signing key does", async () => {
    assert.equal(await start({ INTERN_KEY_SCOPE: "strict" }, lists(fc(COIN, THREE))).done, true);
    assert.equal(await start({ INTERN_KEY_SCOPE: "strict" }, lists("FullAccess")).done, false);
    assert.equal(
      await start({ INTERN_KEY_SCOPE: "strict" }, lists(fc(COIN, [...THREE, "settle"]))).done,
      false,
    );
    // Not broader: it stops nothing here (the key check before it already stops a runner whose key cannot work).
    assert.equal(await start({ INTERN_KEY_SCOPE: "strict" }, lists(fc(COIN, ["propose"]))).done, true);
  });

  it("warn: a broader signing key is logged, and the runner goes on", async () => {
    const { log, done } = start({}, lists("FullAccess"));
    assert.equal(await done, true);
    assert.equal(log.lines[0]?.verdict, "not as declared");
  });

  it("a check that cannot run is logged and stops nothing, even with strict", async () => {
    const { log, done } = start({ INTERN_KEY_SCOPE: "strict" }, {});
    assert.equal(await done, true);
    assert.equal(log.lines[0]?.step, "key scope failed");
  });

  it("off: reads nothing and logs nothing", async () => {
    const { log, rpc, done } = start({ INTERN_KEY_SCOPE: "off" }, lists(fc(COIN, THREE)));
    assert.equal(await done, true);
    assert.deepEqual(rpc.asked, []);
    assert.deepEqual(log.lines, []);
  });

  it("no private key's text ever reaches the log", async () => {
    const { log, done } = start({}, lists(fc(COIN, THREE)));
    await done;
    const text = JSON.stringify(log.lines);
    for (const pair of [runnerPair, relayerPair]) {
      const secret = pair.toString().split(":")[1] ?? "";
      assert.equal(secret.length > 0 && text.includes(secret), false);
    }
  });
});
