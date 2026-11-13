import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { scanContracts } from "../src/contract-scan.ts";
import { analyze, gather, type Sources } from "../src/fills-check.ts";
import { checkKeyScope, type KeyReader } from "../src/key-scope.ts";
import type { RpcExchange } from "../src/near-rpc.ts";
import type { NearblocksExchange } from "../src/nearblocks.ts";
import {
  buildBundle,
  bundleShapeProblems,
  endpointsOf,
  type Job,
  judgeAttestation,
  judgeContractScan,
  judgeFills,
  judgeKeyScope,
  judgeRefusals,
  judgeVerifyRounds,
  runJob,
  SECTION_IDS,
} from "../src/proof.ts";
import { catalogue, findRefusalTx, readAllRefusals, readCodeTable, summarize } from "../src/refusals.ts";
import { viewFinal } from "../src/rpc-read.ts";
import { verifyRound } from "../src/verify-round.ts";
import { readData, replayFetch } from "./support/replay-fetch.ts";

// Offline. Every judge is fed a real tool's output, from recordings made on 2026-11-13: the contract scan and the
// refusal catalogue (test/data/contract-scan-…, refusals-…), fills-check (test/data/fills-check-…), verify-round
// (fixtures/ai/verify-round/), the runner's and relayer's keys (test/data/view-access-key-list-2026-11-13.json).
// The sample bundle is one real run of `npm run proof` (test/data/proof-bundle-2026-11-13T152437Z.json).

const RPC = "https://test.rpc.fastnear.com";
const ARCHIVAL = ["https://archival-rpc.testnet.fastnear.com", "https://archival-rpc.testnet.near.org"];
const COIN = "coin.desk-lab-2026.testnet";
const clock = (step = 5) => {
  let t = Date.parse("2026-11-13T15:00:00Z");
  return () => {
    t += step;
    return t;
  };
};

describe("running sections", () => {
  it("records a section that throws as fail, with its error, and goes on", async () => {
    const s = await runJob(
      {
        id: "x",
        title: "X",
        run: async () => {
          throw new Error("NearBlocks answered HTTP 503");
        },
      },
      clock(),
    );
    assert.equal(s.status, "fail");
    assert.equal(s.data, null);
    assert.equal(s.error, "NearBlocks answered HTTP 503");
    assert.equal(s.sentence, "Could not be checked: NearBlocks answered HTTP 503");
    assert.equal(s.took_ms, 5);
  });

  it("puts the sections together in order and counts them", async () => {
    const job = (id: string, status: "ok" | "warn" | "fail"): Job => ({
      id,
      title: id,
      run: async () => ({ status, sentence: `${id} said ${status}.`, data: { id } }),
    });
    const broken: Job = {
      id: "broken",
      title: "broken",
      run: async () => {
        throw new Error("no");
      },
    };
    const b = await buildBundle({
      jobs: [job("a", "ok"), job("b", "warn"), broken, job("c", "ok")],
      coin: COIN,
      git: { commit: "ea72b1c386dbbdd8bf73225e722a04b8e078d436", ref: "refs/heads/dev/proof-kit" },
      endpoints: endpointsOf({ rpcUrl: RPC }),
      now: clock(),
    });
    assert.deepEqual(
      b.sections.map((s) => [s.id, s.status]),
      [
        ["a", "ok"],
        ["b", "warn"],
        ["broken", "fail"],
        ["c", "ok"],
      ],
    );
    assert.deepEqual([b.summary.ok, b.summary.warn, b.summary.fail], [2, 1, 1]);
    assert.equal(b.summary.sentence, "4 checks: 2 ok, 1 with a caveat, 1 failed (broken).");
    assert.equal(b.endpoints.near_rpc, RPC);
    assert.deepEqual(bundleShapeProblems(b), []);
  });

  it("finds what is wrong with a bundle's shape", () => {
    assert.deepEqual(bundleShapeProblems([]), ["not a JSON object"]);
    const problems = bundleShapeProblems({
      kind: "other",
      version: 2,
      network: "mainnet",
      generated_at: "soon",
      finished_at: "2026-11-13T15:00:00Z",
      coin: COIN,
      git: null,
      endpoints: { near_rpc: RPC },
      summary: { ok: 1, warn: 0, fail: 0, sentence: "" },
      sections: [
        { id: "a", title: "a", sentence: "s", status: "maybe", started_at: "x", took_ms: 1, error: null },
      ],
    });
    assert.deepEqual(problems, [
      'kind is not "intern-proof-bundle"',
      "version is not 1",
      'network is not "testnet"',
      "generated_at is not a time",
      "sections[0].status is not ok, warn or fail",
      "sections[0].started_at is not a time",
      "sections[0].data is missing",
      "summary.ok does not count the sections",
    ]);
  });
});

describe("the sample bundle", () => {
  const sample = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("./data/proof-bundle-2026-11-13T152437Z.json", import.meta.url)),
      "utf8",
    ),
  );

  it("has the documented shape and the six sections, in order", () => {
    assert.deepEqual(bundleShapeProblems(sample), []);
    assert.deepEqual(
      sample.sections.map((s: { id: string }) => s.id),
      [...SECTION_IDS],
    );
    assert.equal(sample.generated_at, "2026-11-13T15:24:38.423Z");
    assert.match(sample.git.commit, /^[0-9a-f]{40}$/);
  });
});

describe("judging each tool's real output", () => {
  it("contract-scan: a caveat while the contracts keep their keys", async () => {
    const saved = readData<{ exchanges: RpcExchange[] }>("contract-scan-2026-11-13T151137Z/rpc.json.gz");
    const rep = await scanContracts(
      { urls: [RPC], fetchFn: replayFetch(saved.exchanges) },
      [{ account_id: "lender.desk-lab-2026.testnet", label: "lender" }],
      {
        recorded: {
          file: "docs/REPRODUCIBLE-BUILD.md",
          heading: "The expected hashes (2026-11-13, interface 1.5)",
          rows: [
            {
              account_id: "lender.desk-lab-2026.testnet",
              hash: "2uAJpQ3nxMsXYA5MHtVHTBMxa1WYjFaB2QAnK9uAu9Em",
              size: 131977,
            },
          ],
        },
        skipNonContracts: true,
        now: () => new Date("2026-11-13T15:11:37Z"),
      },
    );
    const j = judgeContractScan(rep);
    assert.equal(j.status, "warn");
    assert.equal(
      j.sentence,
      "1 contract, each running exactly the build docs/REPRODUCIBLE-BUILD.md records; each still has a full-access key, so its holder can change it; all import the host functions that deploy code or change keys (near-sdk links them), so the code alone does not show it never will.",
    );
    assert.equal(j.data, rep);
    const failed = judgeContractScan({
      ...rep,
      failed: [{ account_id: "x.testnet", label: null, error: "boom" }],
      summary: { ...rep.summary, ok: false },
    });
    assert.equal(failed.status, "fail");
    assert.match(failed.sentence, /boom/);
  });

  it("key-scope: the runner's function-call key and the relayer's full-access key would pass", async () => {
    const saved = readData<{ results: Record<string, unknown> }>("view-access-key-list-2026-11-13.json");
    const rpc = {
      viewAccessKeyList: (async ({ accountId }: { accountId: string }) =>
        saved.results[accountId]) as KeyReader["viewAccessKeyList"],
    };
    const base = { contract: COIN, contractRunner: "intern-runner-ed25519.testnet", signingKey: null };
    const runner = await checkKeyScope(rpc, {
      ...base,
      accountId: "intern-runner-ed25519.testnet",
      expect: "runner",
    });
    const relayer = await checkKeyScope(rpc, {
      ...base,
      accountId: "intern-relayer-ed25519.testnet",
      expect: "relayer",
    });
    const j = judgeKeyScope(runner, relayer);
    assert.equal(j.status, "ok");
    assert.match(
      j.sentence,
      /^The runner intern-runner-ed25519\.testnet: a function-call key for coin\.desk-lab-2026\.testnet \(propose, sign_next, report_result; allowance 0\.874 NEAR\) would pass as its signing key; it also holds a full-access key, normally the owner's\./,
    );
    assert.match(
      j.sentence,
      /The relayer intern-relayer-ed25519\.testnet: a full-access key would pass as its signing key\. No private key was read/,
    );
    // The runner's account judged as the relayer: its function-call key cannot attach 1 yocto, and it is the runner.
    const wrong = await checkKeyScope(rpc, {
      ...base,
      accountId: "intern-runner-ed25519.testnet",
      expect: "relayer",
    });
    assert.equal(judgeKeyScope(runner, wrong).status, "fail");
  });

  it("fills-check: ok when every result matches the fills", async () => {
    const dir = fileURLToPath(new URL("./data/fills-check-2026-11-13T135610Z/", import.meta.url));
    const chain = JSON.parse(readFileSync(`${dir}chain-views.json`, "utf8"));
    const hl = JSON.parse(readFileSync(`${dir}hl-info.json`, "utf8"));
    const src: Sources = {
      contract: chain.contract,
      view: async (method, args) => {
        const hit = chain.views.find(
          (v: { method: string; args: unknown }) =>
            v.method === method && JSON.stringify(v.args) === JSON.stringify(args),
        );
        if (!hit) throw new Error(`not recorded: ${method}`);
        return structuredClone(hit.result);
      },
      fetchFn: async (_input, init) => {
        const hit = hl.records.find(
          (r: { request: unknown }) => JSON.stringify(r.request) === String(init?.body),
        );
        if (!hit) throw new Error("not recorded");
        return new Response(hit.reply, { status: hit.http_status });
      },
      now: () => chain.checked_at_ms,
    };
    // The recording read all 52 rounds; round 3's result was reported with no order ever signed (runner/README).
    const g = await gather(src, chain.rounds);
    const bad = judgeFills(analyze(g, RPC));
    assert.equal(bad.status, "fail");
    assert.equal(
      bad.sentence,
      "Rounds 1 to 52: 32 bets (30 OK, 1 MISMATCH, 1 NO FILLS); every fill on the contract's Hyperliquid address is tied to an order the contract signed.",
    );
    // Without that test bet, everything matches.
    const clean = structuredClone(g);
    clean.positions = clean.positions.filter((p) => p.round_id !== 3);
    const j = judgeFills(analyze(clean, RPC));
    assert.equal(j.status, "ok");
    assert.match(j.sentence, /^Rounds 1 to 52: 31 bets \(30 OK, 1 NO FILLS\); every fill/);
  });

  it("verify-round: ok for the live coin's proposal, fail for the stand-in signature", async () => {
    const recorded = (tx: string): RpcExchange[] =>
      JSON.parse(
        readFileSync(
          fileURLToPath(new URL(`../../fixtures/ai/verify-round/${tx}/rpc.json`, import.meta.url)),
          "utf8",
        ),
      ).exchanges;
    const check = async (tx: string, sender: string) => ({
      tx_hash: tx,
      link: `https://testnet.nearblocks.io/txns/${tx}`,
      sender,
      block_height: null,
      at: "2026-11-13T13:39:28.531Z",
      report: await verifyRound({
        txHash: tx,
        sender,
        rpcs: [RPC, ...ARCHIVAL],
        fetchFn: replayFetch(recorded(tx)),
      }),
    });
    const live = await check("LNUHvA9cZe5edjeqGMK4htV6rkAuf5uM8VqDN2KDtkz", "intern-runner-ed25519.testnet");
    const ok = judgeVerifyRounds([live]);
    assert.equal(ok.status, "ok");
    assert.match(ok.sentence, /^The last 1 proposal re-checked from public data/);
    const fake = await check("5JND4cTbyXHN5FMEMURukEt2HVnWtjmgRky4fvWBzmtW", "runner.desk-lab-2026.testnet");
    const mixed = judgeVerifyRounds([live, fake]);
    assert.equal(mixed.status, "fail");
    assert.equal(
      mixed.sentence,
      "Of the last 2 proposals, 1 verified from public data, 1 with a problem, 0 with a part not checked.",
    );
    assert.equal(judgeVerifyRounds([]).status, "warn");
  });

  it("attestation: ok only when every check and call passed", () => {
    const ok = judgeAttestation(
      { lines: ["RESULT  every check above passed"], failures: 0, callFailures: 0 },
      "z-ai/glm-5.3-flash",
      "ed25519",
    );
    assert.equal(ok.status, "ok");
    assert.match(ok.sentence, /6 parts stay UNVERIFIED/);
    assert.equal(
      judgeAttestation({ lines: [], failures: 1, callFailures: 0 }, "m", "ed25519").status,
      "fail",
    );
    assert.equal(
      judgeAttestation({ lines: [], failures: 0, callFailures: 1 }, "m", "ed25519").status,
      "fail",
    );
  });

  it("refusals: ok when each first example is tied to a confirmed transaction", async () => {
    const saved = readData<{ rpc: RpcExchange[]; nearblocks: NearblocksExchange[] }>(
      "refusals-2026-11-13T151222Z/replies.json",
    );
    const fetchFn = replayFetch(saved.rpc, saved.nearblocks);
    const { codes } = readCodeTable();
    const coins = [];
    for (const coin of [COIN, "coin-fast.desk-lab-2026.testnet"]) {
      const refusals = await readAllRefusals((m, a) => viewFinal({ urls: [RPC], fetchFn }, coin, m, a));
      coins.push(
        await catalogue(coin, refusals, codes, (r) =>
          findRefusalTx({ fetchFn, rpcs: [RPC, ...ARCHIVAL] }, coin, r),
        ),
      );
    }
    const rep = summarize(coins, {
      checked_at: "2026-11-13T15:12:22.762Z",
      rpc: RPC,
      nearblocks: "x",
      codes_source: "y",
    });
    const j = judgeRefusals(rep);
    assert.equal(j.status, "ok");
    assert.equal(
      j.sentence,
      "4 refusals on 2 coins: 4 of the 16 codes have an example (FIRED, NOT_ON_LIST, OVER_LEVERAGE, OVER_TRADE_LIMIT), 12 have none yet; each code's first example is tied to its transaction, confirmed on chain.",
    );
  });
});
