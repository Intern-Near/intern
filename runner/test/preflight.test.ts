import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { type JsonRpcProvider, KeyPair } from "near-api-js";
import type { Constants } from "../src/contract.ts";
import { type Line, preflight, rulebookDifferences } from "../src/preflight.ts";
import { Secret } from "../src/secret.ts";
import { FakeChain, fakeConstants, T0 } from "./support/fake-chain.ts";
import { ALL_MIDS } from "./support/fake-services.ts";

// preflight against the in-memory stand-in for the program and stand-ins for the RPC and the services, built from
// real saved replies: NEAR's signing network's real derived key for the research probe (its address is the one in
// the stand-in's constants), a real NEAR AI attestation report for z-ai/glm-5.3-flash (ed25519), and the real
// Hyperliquid testnet reply for the probe's address (no funds).

const DATA = fileURLToPath(new URL("./data/", import.meta.url));
const DERIVED = JSON.parse(readFileSync(`${DATA}derived-public-key-probe.json`, "utf8"));
const ATTESTATION = readFileSync(`${DATA}attestation-glm-5.3-flash-ed25519-trimmed.json`, "utf8");
const CLEARINGHOUSE = readFileSync(
  fileURLToPath(
    new URL(
      "../../fixtures/hl/info/2026-11-11T173427Z/clearinghouseState-testnet-probe.json",
      import.meta.url,
    ),
  ),
  "utf8",
);
const GLM_SIGNER = "5a0210f2442c79355784f9de021985429561da5bacc3a4424b01ac52b7e0caff";
const MODEL = "z-ai/glm-5.3-flash";

interface World {
  constants: Constants;
  runnerPermission: unknown;
  relayerPermission: unknown;
  relayerBalance: bigint;
  signerInReport: string;
}

function world(over: Partial<World> = {}): World {
  return {
    constants: fakeConstants({ id: MODEL, signing_algo: "ed25519", signer: GLM_SIGNER }),
    runnerPermission: {
      FunctionCall: {
        allowance: null,
        receiver_id: "hlguard1.hackcheck-2026-1103.testnet",
        method_names: ["propose", "sign_next", "report_result"],
      },
    },
    relayerPermission: "FullAccess",
    relayerBalance: 5n * 10n ** 24n,
    signerInReport: GLM_SIGNER,
    ...over,
  };
}

async function run(w: World): Promise<Line[]> {
  const clock = { now: T0 + 950_000 };
  const chain = new FakeChain(w.constants, clock);
  // The stand-in for chain views is answered by FakeChain; preflight also uses the RPC directly for these:
  const rpc = {
    callFunction: async ({ contractId, method }: { contractId: string; method: string }) => {
      if (method === "get_active_playbook") return null;
      if (contractId === "v1.signer-prod.testnet" && method === "derived_public_key") return DERIVED.result;
      throw new Error(`no view ${contractId} ${method}`);
    },
    viewAccessKey: async ({ accountId }: { accountId: string }) => ({
      permission: accountId === "runner.test" ? w.runnerPermission : w.relayerPermission,
    }),
    viewAccount: async ({ accountId }: { accountId: string }) => ({
      amount: accountId === "relayer.test" ? w.relayerBalance : 10n ** 25n,
    }),
  } as unknown as JsonRpcProvider;
  // FakeChain's contract id is "fake-contract.test"; the real derived key is for the probe, so pretend that id.
  Object.defineProperty(chain, "contractId", { value: "hlguard1.hackcheck-2026-1103.testnet" });
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname === "/v1/models")
      return new Response(JSON.stringify({ data: [{ id: MODEL, owned_by: "near" }] }));
    if (url.pathname === "/v1/attestation/report") {
      const report = JSON.parse(ATTESTATION);
      report.model_attestations[0].request_nonce = url.searchParams.get("nonce");
      report.model_attestations[0].signing_address = w.signerInReport;
      return new Response(JSON.stringify(report));
    }
    if (url.href === "https://api.hyperliquid-testnet.xyz/info") {
      const req = JSON.parse(String(init?.body));
      if (req.type === "clearinghouseState") return new Response(CLEARINGHOUSE);
      if (req.type === "allMids") return new Response(ALL_MIDS);
    }
    throw new Error(`no route ${url.href}`);
  };
  const key = () => new Secret(KeyPair.fromRandom("ed25519").toString());
  return preflight({
    rpc,
    chain,
    fetchFn,
    env: { NEARAI_API_KEY: "x" },
    runner: { id: "runner.test", key: key() },
    relayer: { id: "relayer.test", key: key() },
  });
}

const marks = (lines: Line[]) => Object.fromEntries(lines.map((l) => [l.what, l.mark]));

describe("preflight", () => {
  it("everything right: all checks pass; the unfunded Hyperliquid account is a warning", async () => {
    // The runner is the stand-in's runner.test only if the constants say so.
    const w = world();
    const lines = await run(w);
    const m = marks(lines);
    for (const what of [
      "get_constants",
      "get_rank",
      "get_round",
      "get_positions",
      "get_rulebook",
      "get_outbox",
      "Hyperliquid address",
      "NEAR AI model",
      "NEARAI_API_KEY",
      "runner account",
      "relayer account",
    ]) {
      assert.equal(m[what], "ok", `${what}: ${lines.find((l) => l.what === what)?.detail}`);
    }
    assert.equal(m["Hyperliquid testnet account"], "warn");
    assert.match(
      lines.find((l) => l.what === "Hyperliquid address")?.detail ?? "",
      /0x283779ffb96dc9ac3a03333e39b18ed0a793e040/,
    );
  });

  it("a wrong Hyperliquid address in the constants fails", async () => {
    const w = world();
    w.constants = {
      ...w.constants,
      hl: { ...w.constants.hl, address: "0x0000000000000000000000000000000000000001" },
    };
    assert.equal(marks(await run(w))["Hyperliquid address"], "fail");
  });

  it("a signer that NEAR AI no longer reports fails", async () => {
    assert.equal(marks(await run(world({ signerInReport: "11".repeat(32) })))["NEAR AI model"], "fail");
  });

  it("a full-access runner key, a key for another contract, or extra methods all fail", async () => {
    assert.equal(marks(await run(world({ runnerPermission: "FullAccess" })))["runner account"], "fail");
    const other = {
      FunctionCall: { allowance: null, receiver_id: "other.testnet", method_names: ["propose"] },
    };
    assert.equal(marks(await run(world({ runnerPermission: other })))["runner account"], "fail");
    const extra = {
      FunctionCall: {
        allowance: null,
        receiver_id: "hlguard1.hackcheck-2026-1103.testnet",
        method_names: [],
      },
    };
    assert.equal(marks(await run(world({ runnerPermission: extra })))["runner account"], "fail");
    // 01 1.0's two methods are no longer enough: the runner signs sign_next too (01 1.1).
    const old = {
      FunctionCall: {
        allowance: null,
        receiver_id: "hlguard1.hackcheck-2026-1103.testnet",
        method_names: ["propose", "report_result"],
      },
    };
    const lines = await run(world({ runnerPermission: old }));
    assert.equal(marks(lines)["runner account"], "fail");
    assert.match(
      lines.find((l) => l.what === "runner account")?.detail ?? "",
      /exactly propose, sign_next, report_result/,
    );
  });

  it("a relayer with a function-call key fails; a low balance is a warning", async () => {
    const fc = { FunctionCall: { allowance: null, receiver_id: "x", method_names: [] } };
    assert.equal(marks(await run(world({ relayerPermission: fc })))["relayer account"], "fail");
    assert.equal(marks(await run(world({ relayerBalance: 10n ** 23n })))["relayer account"], "warn");
  });

  it("mainnet constants fail", async () => {
    const w = world();
    w.constants = { ...w.constants, network: "mainnet" };
    assert.equal(marks(await run(w))["constants against 01"], "fail");
  });
});

describe("the rulebook against 01 1.2 §6.1", () => {
  const round = {
    id: 42,
    phase: "PROPOSE" as const,
    settled: false,
    stuck: false,
    started_at: 0,
    propose_from: 0,
    propose_until: 0,
    close_from: 0,
    ends_at: 0,
    rank: "INTERN" as const,
    status: "EMPLOYED" as const,
    brave_at_open: "1000000000",
    bets_used: 0,
    at_risk: "0",
    skipped: 0,
    refused: 0,
    result: null,
  };
  // Engine 1's rulebook case R1 (round 42, INTERN, $1,000, no bet yet), from intern/interface/vectors/checks.json.
  const checks = JSON.parse(
    readFileSync(fileURLToPath(new URL("../../interface/vectors/checks.json", import.meta.url)), "utf8"),
  );
  const r1 = checks.rulebook_cases.cases[0];
  const text: string = r1.text;

  it("is equal to the template for this round", () => {
    assert.equal(r1.id, "R1");
    assert.deepEqual(rulebookDifferences(text, round, "9f2c41d07ab35e16", null, 11_000_000n), []);
  });

  it("names each line that differs (for example 01 1.0's $1 example bet)", () => {
    const changed = text.replace('"margin_e6":"11000000"', '"margin_e6":"1000000"');
    const d = rulebookDifferences(changed, round, "9f2c41d07ab35e16", null, 11_000_000n);
    assert.equal(d.length, 1);
    assert.equal(d[0]?.line, 15);
  });
});
