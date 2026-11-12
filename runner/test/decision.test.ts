import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Decision, decisionLine, readDecisionLine } from "../src/decision.ts";
import { MARKETS } from "../src/markets.ts";

const EXPECT = { round_id: 42, nonce: "9f2c41d07ab35e16" };
const D1 = '{"v":1,"round":42,"nonce":"9f2c41d07ab35e16","action":"skip"}';
const D2 =
  '{"v":1,"round":42,"nonce":"9f2c41d07ab35e16","action":"bet","market":"DOGE","side":"long","margin_e6":"20000000","leverage":1}';

const read = (text: string) => readDecisionLine(text, EXPECT);
const malformed = (text: string): void => {
  const r = read(text);
  assert.equal(r.ok, false, `expected MALFORMED_DECISION for ${JSON.stringify(text)}`);
};

describe("decision line, 01 §12 cases D1-D12", () => {
  it("D1 skip", () => assert.deepEqual(read(D1), { ok: true, decision: { action: "SKIP" } }));

  it("D2 bet", () =>
    assert.deepEqual(read(D2), {
      ok: true,
      decision: { action: "BET", market: "DOGE", side: "LONG", margin_e6: 20_000_000n, leverage: 1 },
    }));

  it("D3 a space after any colon", () => {
    const colons = [...D2.matchAll(/:/g)].map((m) => m.index);
    assert.equal(colons.length, 8);
    for (const i of colons) malformed(`${D2.slice(0, i + 1)} ${D2.slice(i + 1)}`);
  });

  it("D4 wrapped in a code fence", () => {
    malformed(`\`\`\`json\n${D2}\n\`\`\``);
    malformed(`\`\`\`\n${D2}\n\`\`\``);
    malformed(`\`${D2}\``);
  });

  it("D5 margin as a number", () => malformed(D2.replace('"margin_e6":"20000000"', '"margin_e6":20000000')));
  it("D6 another round", () => malformed(D2.replace('"round":42', '"round":41')));
  it("D7 another nonce", () => malformed(D2.replace("9f2c41d07ab35e16", "9f2c41d07ab35e17")));
  it("D8 market in lower case", () => malformed(D2.replace('"DOGE"', '"doge"')));
  it("D9 margin with a leading zero", () => malformed(D2.replace('"20000000"', '"020000000"')));

  it("D10 WIF: the shape is right, the rank check refuses it later", () => {
    const r = read(D2.replace('"DOGE"', '"WIF"'));
    assert.ok(r.ok && r.decision.action === "BET" && r.decision.market === "WIF");
  });

  it("D11 a sentence before the line", () => {
    malformed(`I think DOGE looks good. ${D2}`);
    malformed(`I think DOGE looks good.\n${D2}`);
  });

  it("D12 a trailing newline", () => malformed(`${D1}\n`));
});

describe("decision line, more cases", () => {
  it("refuses another key order, an extra key, a duplicate key and an escaped character", () => {
    malformed('{"round":42,"v":1,"nonce":"9f2c41d07ab35e16","action":"skip"}');
    malformed('{"v":1,"round":42,"nonce":"9f2c41d07ab35e16","action":"skip","why":"bored"}');
    malformed('{"v":1,"round":42,"nonce":"9f2c41d07ab35e16","action":"bet","action":"skip"}');
    malformed(D2.replace('"DOGE"', '"DOG\\u0045"'));
    malformed(D1.replace('"skip"', '"sk\\u0069p"'));
  });

  it("refuses other spellings of numbers, sides and actions", () => {
    malformed(D2.replace('"leverage":1', '"leverage":1.0'));
    malformed(D2.replace('"leverage":1', '"leverage":1e0'));
    malformed(D2.replace('"leverage":1', '"leverage":"1"'));
    malformed(D2.replace('"leverage":1', '"leverage":0'));
    malformed(D2.replace('"long"', '"LONG"'));
    malformed(D2.replace('"long"', '"up"'));
    malformed(D1.replace('"skip"', '"SKIP"'));
    malformed(D1.replace('"v":1', '"v":2'));
    malformed(D2.replace('"20000000"', '"-20000000"'));
    malformed(D2.replace('"20000000"', '"20000000.5"'));
    malformed(D2.replace('"20000000"', `"${(1n << 128n).toString()}"`));
  });

  it("reads a margin of 0 as a bet (01 test case 7 expects ZERO_MARGIN from the rank checks)", () => {
    const r = read(D2.replace('"20000000"', '"0"'));
    assert.ok(r.ok && r.decision.action === "BET" && r.decision.margin_e6 === 0n);
  });

  it("refuses a market outside the six (open point C in 01)", () => malformed(D2.replace('"DOGE"', '"BTC"')));

  it("refuses empty, non-object and truncated text", () => {
    for (const t of ["", " ", "null", "[]", '"skip"', D2.slice(0, -1), `${D2}}`, `\ufeff${D1}`]) malformed(t);
  });

  it("reads back every canonical line it writes", () => {
    const decisions: Decision[] = [{ action: "SKIP" }];
    for (const m of MARKETS) {
      for (const side of ["LONG", "SHORT"] as const) {
        for (const margin_e6 of [0n, 1n, 20_000_000n, (1n << 128n) - 1n]) {
          for (const leverage of [1, 2, 4_294_967_295]) {
            decisions.push({ action: "BET", market: m.market, side, margin_e6, leverage });
          }
        }
      }
    }
    for (const d of decisions) {
      assert.deepEqual(read(decisionLine(42, EXPECT.nonce, d)), { ok: true, decision: d });
    }
  });
});
