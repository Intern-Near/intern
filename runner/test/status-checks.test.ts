import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JsonRpcProvider } from "near-api-js";
import { statusChecks } from "../src/status-checks.ts";
import { ALL_MIDS } from "./support/fake-services.ts";

// `status`'s three extra lines, against stand-ins: NEAR AI's GET /v1/models answered in its documented shape (as in
// nearai.test.ts), Hyperliquid testnet's allMids with the real reply saved on 2026-11-11
// (fixtures/hl/info/2026-11-11T173427Z/allMids-testnet.json), and view_account's balance.

const MODEL = "z-ai/glm-5.3-flash";

function fetchFn(models: string[] | "down", mids: string | "down" = ALL_MIDS): typeof fetch {
  return async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://cloud-api.near.ai/v1/models") {
      if (models === "down") throw new Error("fetch failed");
      return new Response(JSON.stringify({ data: models.map((id) => ({ id, owned_by: "near" })) }));
    }
    if (url === "https://api.hyperliquid-testnet.xyz/info") {
      if (mids === "down") return new Response("bad gateway", { status: 502 });
      return new Response(mids);
    }
    throw new Error(`no route ${url}`);
  };
}

function rpc(amount: bigint | "down"): Pick<JsonRpcProvider, "viewAccount"> {
  return {
    viewAccount: async () => {
      if (amount === "down") throw new Error("account intern-relayer-ed25519.testnet does not exist");
      return { amount };
    },
  } as unknown as Pick<JsonRpcProvider, "viewAccount">;
}

const run = (
  models: string[] | "down",
  balance: bigint | "down",
  relayer: string | null = "intern-relayer-ed25519.testnet",
  mids: string | "down" = ALL_MIDS,
) => statusChecks({ fetchFn: fetchFn(models, mids), rpc: rpc(balance), model: MODEL, relayer, now: () => 0 });

describe("status: NEAR AI, Hyperliquid, the relayer", () => {
  it("all three answer", async () => {
    const lines = await run([MODEL, "other/model"], 9_910_000_000_000_000_000_000_000n);
    assert.deepEqual(
      lines.map((l) => [l.what, l.ok]),
      [
        ["NEAR AI", true],
        ["Hyperliquid testnet /info", true],
        ["relayer", true],
      ],
    );
    assert.equal(
      lines[0]?.detail,
      `reachable in 0 ms (GET /v1/models): 2 models listed; the pinned ${MODEL} is listed`,
    );
    assert.equal(lines[1]?.detail, "reachable in 0 ms (allMids): mid prices for 6 of the 6 markets");
    assert.equal(lines[2]?.detail, "intern-relayer-ed25519.testnet: 9.910 NEAR");
  });

  it("the pinned model missing from NEAR AI's list is not ok", async () => {
    const [ai] = await run(["other/model"], 10n ** 24n);
    assert.equal(ai?.ok, false);
    assert.match(ai?.detail ?? "", /is NOT listed/);
  });

  it("a service that does not answer is a line, not a crash", async () => {
    const lines = await run("down", "down", "intern-relayer-ed25519.testnet", "down");
    assert.match(lines[0]?.detail ?? "", /^UNREACHABLE \(GET \/v1\/models\): fetch failed/);
    assert.match(lines[1]?.detail ?? "", /^UNREACHABLE \(allMids\): .*HTTP 502/);
    assert.match(lines[2]?.detail ?? "", /balance not read: account .* does not exist/);
    assert.equal(
      lines.every((l) => !l.ok),
      true,
    );
  });

  it("a market without a mid price is named", async () => {
    const mids = JSON.parse(ALL_MIDS);
    delete mids.kPEPE;
    const [, hl] = await run([MODEL], 10n ** 24n, null, JSON.stringify(mids));
    assert.equal(hl?.ok, false);
    assert.match(hl?.detail ?? "", /5 of the 6 markets; none for kPEPE/);
  });

  it("the relayer: not named, or low on NEAR", async () => {
    const [, , none] = await run([MODEL], 10n ** 24n, null);
    assert.match(none?.detail ?? "", /not named: set RELAYER_ACCOUNT_ID or pass --relayer/);
    const [, , low] = await run([MODEL], 10n ** 23n);
    assert.equal(low?.ok, false);
    assert.match(low?.detail ?? "", /0\.100 NEAR \(low: under 0\.5 NEAR/);
  });
});
