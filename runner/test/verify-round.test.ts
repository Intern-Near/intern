import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { type RpcExchange, rpcCall } from "../src/near-rpc.ts";
import {
  coinEvents,
  compareVerdict,
  requestShapeProblems,
  rulebookRoundAndNonce,
  strictBase64,
  verifyRound,
} from "../src/verify-round.ts";

// Real NEAR RPC replies, saved by `npm run verify-round -- <tx> --save <dir>` on 2026-11-13 around 14:01 UTC (each
// exchange in rpc.json carries its own fetched_at). LNUHvA9…: the live coin's proposal of round 51, 13:39 UTC, a YES
// for GLM's PEPE bet, read from the regular node. 5JND4c…: the coin's first proposal ever, 2026-11-11, step 4, when
// its AI check was the stand-in that accepts "FAKE"; the regular node no longer had it, so it came from an archival
// node. Everything here runs offline: the replies are replayed by a fake fetch.
const YES_TX = "LNUHvA9cZe5edjeqGMK4htV6rkAuf5uM8VqDN2KDtkz";
const OLD_TX = "5JND4cTbyXHN5FMEMURukEt2HVnWtjmgRky4fvWBzmtW";
const RPCS = [
  "https://test.rpc.fastnear.com",
  "https://archival-rpc.testnet.fastnear.com",
  "https://archival-rpc.testnet.near.org",
];

function recorded(tx: string): RpcExchange[] {
  const file = new URL(`../../fixtures/ai/verify-round/${tx}/rpc.json`, import.meta.url);
  return (JSON.parse(readFileSync(file, "utf8")) as { exchanges: RpcExchange[] }).exchanges;
}

/** A fetch that answers each JSON-RPC request with the recorded reply for the same URL, method and params. */
function replay(exchanges: readonly RpcExchange[]): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const sent = JSON.parse(String(init?.body)) as { method: string; params: unknown };
    calls.push(`${sent.method} ${String(url)}`);
    const hit = exchanges.find(
      (e) =>
        e.url === String(url) &&
        e.request.method === sent.method &&
        JSON.stringify(e.request.params) === JSON.stringify(sent.params),
    );
    if (!hit) throw new Error(`no recorded reply for ${sent.method} on ${String(url)}`);
    return new Response(hit.body, { status: hit.status });
  }) as typeof fetch & { calls: string[] };
  fn.calls = calls;
  return fn;
}

/** The recorded exchanges with the `tx` reply's propose arguments changed by `edit`. */
function withArgs(exchanges: RpcExchange[], edit: (args: Record<string, string>) => void): RpcExchange[] {
  return exchanges.map((e) => {
    if (e.request.method !== "tx" || !e.body.includes('"result"')) return e;
    const body = JSON.parse(e.body);
    const call = body.result.transaction.actions[0].FunctionCall;
    const args = JSON.parse(Buffer.from(call.args, "base64").toString("utf8"));
    edit(args);
    call.args = Buffer.from(JSON.stringify(args)).toString("base64");
    return { ...e, body: JSON.stringify(body) };
  });
}

function flipBase64Byte(value: string, at: (len: number) => number): string {
  const bytes = Buffer.from(value, "base64");
  const i = at(bytes.length);
  bytes[i] = (bytes[i] ?? 0) ^ 0x01;
  return bytes.toString("base64");
}

const run = (exchanges: RpcExchange[], tx = YES_TX, sender = "intern-runner-ed25519.testnet") =>
  verifyRound({ txHash: tx, sender, rpcs: RPCS, fetchFn: replay(exchanges) });

describe("verify-round on a real proposal", () => {
  it("verifies the round-51 YES from the saved replies alone", async () => {
    const r = await run(recorded(YES_TX));
    const text = r.lines.join("\n");
    assert.equal(r.fatal, null);
    assert.equal(r.failures, 0, text);
    assert.equal(r.unverified, 0, text);
    assert.match(text, /OK +model: z-ai\/glm-5\.3-flash named in the request/);
    assert.match(text, /OK +signer: the ed25519 signature verifies with the pinned key 5a0210f2442c7935/);
    assert.match(
      text,
      /OK +rulebook: the system message equals, byte for byte.*round 51, nonce ff0388b1b803fd25/,
    );
    assert.match(
      text,
      /the answer: \{"v":1,"round":51,"nonce":"ff0388b1b803fd25","action":"bet","market":"PEPE"/,
    );
    assert.match(text, /OK +decision line: exact.*bet PEPE long, margin_e6 20000000 \(\$20\.000000\) at 1x/);
    assert.match(text, /return value: YES, position 32/);
    assert.match(text, /OK +agreement: the contract passed checks 3 to 5, and so does this re-check/);
    assert.match(text, /^RESULT +verified from public data/m);
  });

  it("finds a changed byte in the response: the signature no longer verifies, and disagrees with the YES", async () => {
    const r = await run(
      withArgs(recorded(YES_TX), (a) => {
        a.response = flipBase64Byte(a.response ?? "", (n) => n - 5);
      }),
    );
    const text = r.lines.join("\n");
    assert.match(text, /FAIL +signer: the 64-byte signature does not verify/);
    assert.match(
      text,
      /FAIL +agreement: the contract passed checks 3 to 5; this re-check fails BAD_MODEL_SIGNATURE/,
    );
  });

  it("names the signer when another model's recorded key signed the exchange", async () => {
    // A real signed exchange of Qwen3.8-27B (step 1 recording), put in place of the round-51 proposal's arguments.
    const qwen = new URL("../../fixtures/ai/qwen--qwen3.8-27b/normal/", import.meta.url);
    const reply = JSON.parse(readFileSync(new URL("signature-ed25519.json", qwen), "utf8")) as {
      signature: string;
    };
    const r = await run(
      withArgs(recorded(YES_TX), (a) => {
        a.request = readFileSync(new URL("request.bin", qwen)).toString("base64");
        a.response = readFileSync(new URL("response.bin", qwen)).toString("base64");
        a.signature = Buffer.from(reply.signature, "hex").toString("base64");
      }),
    );
    const text = r.lines.join("\n");
    assert.match(text, /FAIL +model: Qwen\/Qwen3\.8-27B named in the request/);
    assert.match(text, /FAIL +signer: .*it is Qwen\/Qwen3\.8-27B's ed25519 key 89154a43a476847/);
  });

  it("finds a changed byte in the signature", async () => {
    const r = await run(
      withArgs(recorded(YES_TX), (a) => {
        a.signature = flipBase64Byte(a.signature ?? "", () => 10);
      }),
    );
    assert.match(
      r.lines.join("\n"),
      /FAIL +signer: the 64-byte signature does not verify.*no key recorded for the four signed models verifies it/,
    );
  });

  it("finds a system message that is not the rulebook served at that block", async () => {
    const exchanges = recorded(YES_TX).map((e) => {
      if (e.request.params.method_name !== "get_rulebook") return e;
      const body = JSON.parse(e.body);
      const value = JSON.parse(Buffer.from(body.result.result).toString("utf8"));
      value.text = value.text.replace("max_margin_e6: 31462890", "max_margin_e6: 31462891");
      body.result.result = [...Buffer.from(JSON.stringify(value))];
      return { ...e, body: JSON.stringify(body) };
    });
    const r = await run(exchanges);
    const text = r.lines.join("\n");
    assert.match(text, /FAIL +rulebook: the system message is not the rulebook/);
    assert.match(text, /FAIL +agreement: .*WRONG_RULEBOOK/);
  });

  it("refuses a transaction that is not a proposal", async () => {
    const exchanges = recorded(YES_TX).map((e) =>
      e.request.method === "tx"
        ? { ...e, body: e.body.replace('"method_name":"propose"', '"method_name":"sign_next"') }
        : e,
    );
    const r = await run(exchanges);
    assert.match(r.fatal ?? "", /not a single propose call/);
  });

  it("falls back to an archival node for an old transaction, and names the stand-in signature", async () => {
    const fetchFn = replay(recorded(OLD_TX));
    const r = await verifyRound({
      txHash: OLD_TX,
      sender: "runner.desk-lab-2026.testnet",
      rpcs: RPCS,
      fetchFn,
    });
    const text = r.lines.join("\n");
    assert.deepEqual(fetchFn.calls.slice(0, 2), [
      "tx https://test.rpc.fastnear.com",
      "tx https://archival-rpc.testnet.fastnear.com",
    ]);
    // Once the regular node lacked the transaction, the block and the views go straight to the archival node.
    assert.ok(
      fetchFn.calls.slice(2).every((c) => c.endsWith("archival-rpc.testnet.fastnear.com")),
      fetchFn.calls.join(", "),
    );
    assert.match(text, /read from https:\/\/archival-rpc\.testnet\.fastnear\.com/);
    assert.match(text, /it is the text FAKE: coin-fast's stand-in AI check accepts that/);
    assert.match(text, /FAIL +contract's pin: get_constants\(\)\.model then: FAKE-AI-CHECK/);
    assert.match(text, /return value: NOPE OVER_TRADE_LIMIT/);
    assert.ok(r.failures > 0);
  });
});

describe("verify-round pieces", () => {
  it("reads base64 strictly, as the contract does", () => {
    assert.deepEqual(strictBase64("RkFLRQ=="), Buffer.from("FAKE"));
    assert.equal(strictBase64("RkFLRQ"), null); // no padding
    assert.equal(strictBase64("RkFL RQ=="), null);
    assert.equal(strictBase64("RkFLRR=="), null); // not canonical: decodes, but does not encode back the same
    assert.equal(strictBase64(42), null);
  });

  const good = (extra = ""): Buffer =>
    Buffer.from(
      `{"model":"z-ai/glm-5.3-flash","messages":[{"role":"system","content":"RB"},{"role":"user","content":"hi"}],"stream":false${extra}}`,
    );

  it("accepts 01 §6.3's request shape and names each way out of it", () => {
    assert.deepEqual(requestShapeProblems(good(), "z-ai/glm-5.3-flash", "RB"), []);
    assert.deepEqual(
      requestShapeProblems(
        good(',"chat_template_kwargs":{"enable_thinking":false}'),
        "z-ai/glm-5.3-flash",
        "RB",
      ),
      [],
    );
    assert.deepEqual(requestShapeProblems(good(',"temperature":0,"seed":42'), "z-ai/glm-5.3-flash", "RB"), [
      "keys 01 §6.3 does not allow: temperature, seed",
    ]);
    assert.deepEqual(requestShapeProblems(good(), "z-ai/glm-5.3-flash", "another rulebook"), [
      "the system message is not the rulebook",
    ]);
    assert.deepEqual(
      requestShapeProblems(
        good(',"chat_template_kwargs":{"enable_thinking":true}'),
        "z-ai/glm-5.3-flash",
        "RB",
      ),
      ['chat_template_kwargs is not exactly {"enable_thinking": false}'],
    );
    const streamed = Buffer.from(good().toString().replace('"stream":false', '"stream":true'));
    assert.deepEqual(requestShapeProblems(streamed, "z-ai/glm-5.3-flash", "RB"), ["stream is not false"]);
    assert.deepEqual(requestShapeProblems(Buffer.from("[1]"), "z-ai/glm-5.3-flash", "RB"), [
      "the request is not a JSON object in UTF-8",
    ]);
  });

  it("reads round and nonce from a rulebook text", () => {
    assert.deepEqual(rulebookRoundAndNonce("You are...\nround: 51\nnonce: ff0388b1b803fd25\nrank: INTERN"), {
      round_id: 51,
      nonce: "ff0388b1b803fd25",
    });
    assert.equal(rulebookRoundAndNonce("round: 51"), null);
  });

  it("reads the coin's NEP-297 events and skips other logs", () => {
    const events = coinEvents([
      'EVENT_JSON:{"standard":"intern","version":"1.0.0","event":"refused","data":[{"refusal_id":3,"code":"OVER_LEVERAGE"}]}',
      'EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_mint","data":[{"amount":"1"}]}',
      "plain log",
      "EVENT_JSON:{broken",
    ]);
    assert.deepEqual(events, [{ event: "refused", data: { refusal_id: 3, code: "OVER_LEVERAGE" } }]);
  });

  it("compares the contract's verdict with the re-check of checks 3 to 5", () => {
    const skip = { code: null, decision: { action: "SKIP" } } as const;
    const badSig = { code: "BAD_MODEL_SIGNATURE", reason: "x" } as const;
    const nope = (code: "OUTSIDE_WINDOW" | "BAD_MODEL_SIGNATURE" | "OVER_TRADE_LIMIT") =>
      ({ verdict: "NOPE", refusal_id: 1, code, asked: null, limit: null }) as const;
    assert.equal(compareVerdict({ verdict: "SKIP" }, skip, null), null);
    assert.equal(compareVerdict(nope("BAD_MODEL_SIGNATURE"), badSig, null), null);
    assert.equal(compareVerdict(nope("OUTSIDE_WINDOW"), badSig, null), "not compared");
    assert.match(compareVerdict(nope("OVER_TRADE_LIMIT"), badSig, null) ?? "", /passed checks 3 to 5/);
    assert.match(
      compareVerdict({ verdict: "YES", position_id: 1 }, skip, null) ?? "",
      /the answer is a skip/,
    );
  });

  it("tries the next node only when a node does not have the data", async () => {
    const replies: Record<string, string> = {
      a: '{"jsonrpc":"2.0","error":{"name":"HANDLER_ERROR","cause":{"name":"UNKNOWN_TRANSACTION"},"code":-32000}}',
      b: '{"jsonrpc":"2.0","result":{"ok":true}}',
      c: '{"jsonrpc":"2.0","error":{"name":"REQUEST_VALIDATION_ERROR","cause":{"name":"PARSE_ERROR"},"data":"bad"}}',
    };
    const fetchFn = (async (url: string | URL | Request) =>
      new Response(replies[String(url)] ?? "")) as typeof fetch;
    assert.deepEqual(await rpcCall(["a", "b"], "tx", {}, fetchFn), { url: "b", result: { ok: true } });
    await assert.rejects(rpcCall(["c", "b"], "tx", {}, fetchFn), /PARSE_ERROR/);
    await assert.rejects(rpcCall(["a"], "tx", {}, fetchFn), /no node had it \(a: UNKNOWN_TRANSACTION\)/);
  });
});
