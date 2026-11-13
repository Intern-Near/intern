import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type InternSources, internMcpServer, TOOL_NAMES } from "../src/mcp.ts";
import type { RpcExchange } from "../src/near-rpc.ts";
import { NOT_IN_DRY_RUN } from "../src/quote.ts";
import { FakeCoinViews, VIEWS } from "./support/fake-coin-views.ts";
import { graph } from "./support/import-graph.ts";

// The MCP server, offline: an in-process client from the SDK (its in-memory transport) against a fake chain
// (test/support/fake-coin-views.ts) for status, rulebook, quote and feed; against real recorded replies for
// verify-round (fixtures/ai/verify-round/, 2026-11-13 ~14:01 UTC) and fills-check (test/data/fills-check-…/,
// 2026-11-13 13:56 UTC). Every request any tool makes is recorded, to show that all of them only read.

const READ_ONLY =
  "Read-only: it signs nothing, sends no transaction and spends nothing, and it reads no key and no .env.";
const VERIFY_TX = "LNUHvA9cZe5edjeqGMK4htV6rkAuf5uM8VqDN2KDtkz";
const RPCS = [
  "https://test.rpc.fastnear.com",
  "https://archival-rpc.testnet.fastnear.com",
  "https://archival-rpc.testnet.near.org",
];
const HL_INFO = "https://api.hyperliquid-testnet.xyz/info";

const VERIFY_RPC = (
  JSON.parse(
    readFileSync(new URL(`../../fixtures/ai/verify-round/${VERIFY_TX}/rpc.json`, import.meta.url), "utf8"),
  ) as { exchanges: RpcExchange[] }
).exchanges;
const FILLS_DIR = fileURLToPath(new URL("./data/fills-check-2026-11-13T135610Z/", import.meta.url));
const CHAIN = JSON.parse(readFileSync(`${FILLS_DIR}chain-views.json`, "utf8")) as {
  contract: string;
  checked_at_ms: number;
  views: { method: string; args: Record<string, unknown>; result: unknown }[];
};
const HL = JSON.parse(readFileSync(`${FILLS_DIR}hl-info.json`, "utf8")) as {
  records: { request: unknown; reply: string; http_status: number }[];
};

/** Every request any tool sent over fetch: the URL and, for JSON bodies, the RPC method or the /info type. */
const sent: { url: string; what: string }[] = [];

/** Answers NEAR RPC from the verify-round recording and Hyperliquid's /info from the fills-check recording. */
const recordedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const body = String(init?.body);
  const json = JSON.parse(body) as { method?: string; params?: unknown; type?: string };
  sent.push({ url, what: json.method ?? json.type ?? "?" });
  if (url === HL_INFO) {
    const hit = HL.records.find((r) => JSON.stringify(r.request) === body);
    if (!hit) throw new Error(`not recorded: ${body}`);
    return new Response(hit.reply, { status: hit.http_status });
  }
  const hit = VERIFY_RPC.find(
    (e) =>
      e.url === url &&
      e.request.method === json.method &&
      JSON.stringify(e.request.params) === JSON.stringify(json.params),
  );
  if (!hit) throw new Error(`not recorded: ${json.method} on ${url}`);
  return new Response(hit.body, { status: hit.status });
}) as typeof fetch;

async function connect(src: InternSources): Promise<Client> {
  const server = internMcpServer(src);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "intern-test-client", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

const fake = new FakeCoinViews();
const sources = (f: FakeCoinViews): InternSources => ({
  coin: "coin.fake.testnet",
  rpc: RPCS[0] as string,
  snapshot: f.snapshot,
  fetchFn: recordedFetch,
  verifyRpcs: RPCS,
  now: () => f.block.time_ms,
});

type Result = Awaited<ReturnType<Client["callTool"]>>;
function text(r: Result, i = 0): string {
  const c = (r.content as { type: string; text?: string }[])[i];
  assert.equal(c?.type, "text");
  return c?.text ?? "";
}
const data = (r: Result) => r.structuredContent as Record<string, unknown>;

after(() => {
  // Read-only, shown from the requests themselves: views only on the coin; on the network, NEAR RPC reads (tx, block,
  // query, status) and Hyperliquid /info reads, never /exchange and never a method that sends a transaction.
  assert.ok(fake.calls.length > 0);
  for (const c of fake.calls) assert.ok((VIEWS as readonly string[]).includes(c.method), c.method);
  assert.ok(sent.length > 0);
  for (const s of sent) {
    assert.ok(!s.url.endsWith("/exchange"), s.url);
    assert.ok(["tx", "block", "query", "status", "userFillsByTime", "userFunding"].includes(s.what), s.what);
  }
});

describe("the MCP server's tools, over the SDK's in-memory transport", () => {
  it("lists six tools, each saying it is read-only and marked read-only", async () => {
    const client = await connect(sources(fake));
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name),
      [...TOOL_NAMES],
    );
    for (const t of tools) {
      assert.ok(t.description?.includes(READ_ONLY), t.name);
      assert.equal(t.annotations?.readOnlyHint, true, t.name);
      assert.equal(t.annotations?.destructiveHint, false, t.name);
    }
    const quote = tools.find((t) => t.name === "intern_quote");
    const props = quote?.inputSchema.properties as Record<string, { enum?: string[]; default?: unknown }>;
    assert.deepEqual(props.market?.enum, ["DOGE", "SHIB", "PEPE", "PENGU", "WIF", "TRUMP"]);
    assert.deepEqual(props.side?.enum, ["long", "short"]);
    assert.equal(props.leverage?.default, 1);
    assert.deepEqual([...(quote?.inputSchema.required ?? [])].sort(), ["margin_usd", "market", "side"]);
    await client.close();
  });

  it("intern_status: rank, round, phase, pool, the limits now and this round's bets", async () => {
    const f = new FakeCoinViews();
    f.round.bets_used = 1;
    f.round.at_risk = "15000000";
    f.positions = [
      {
        id: 35,
        round_id: 54,
        market: "PEPE",
        side: "LONG",
        margin: "15000000",
        leverage: 1,
        notional: "15000000",
        status: "OPEN_SIGNED",
        approved_at: f.round.propose_from + 1_000,
        open_signed_at: f.round.propose_from + 9_000,
        close_signed_at: null,
        settled_at: null,
        sz_e8: "240900000000",
        returned: null,
        result: null,
        result_source: null,
      },
    ];
    const client = await connect(sources(f));
    const r = await client.callTool({ name: "intern_status", arguments: {} });
    assert.equal(r.isError, undefined);
    const t = text(r);
    assert.match(
      t,
      /^\$INTERN, coin\.fake\.testnet on testnet, block 277000000 \(2026-11-13T15:16:40\.000Z\)\. Read-only/,
    );
    assert.match(t, /\nrank INTERN, EMPLOYED since round 1\n/);
    assert.match(
      t,
      /\nround 54: phase PROPOSE, 16:40 in; proposals 15:00 to 20:00, closing from 25:00; ends /,
    );
    assert.match(
      t,
      /\npool: BRAVE \$1,000.00 \(at round open \$1,000.00; idle \$85.00, lent \$900.00, in play \$15.00/,
    );
    assert.match(
      t,
      /\nlimits now \(INTERN, from get_constants\): per bet \$20.00, per round \$20.00 \(\$5.00 left\), bets 1 of 1/,
    );
    assert.match(t, /\nbets this round: #35 PEPE long \$15.00 ×1 OPEN_SIGNED$/);
    const d = data(r);
    assert.deepEqual(d.limits_now, {
      rank: "INTERN",
      status: "EMPLOYED",
      limit_base_e6: "1000000000",
      per_bet_e6: "20000000",
      per_round_e6: "20000000",
      round_left_e6: "5000000",
      bets_left: 0,
      max_bets: 1,
      max_leverage: 1,
      markets: ["DOGE", "SHIB", "PEPE", "PENGU"],
      sides: ["LONG"],
      min_notional_e6: "11000000",
      long_shot: null,
    });
    assert.equal((d.round as { ms_into_round: number }).ms_into_round, 1_000_000);
    assert.equal((d.bets_this_round as unknown[]).length, 1);
    // The second text block is the same data as JSON.
    assert.deepEqual(JSON.parse(text(r, 1)), d);
    for (const c of f.calls) assert.ok((VIEWS as readonly string[]).includes(c.method));
    await client.close();
  });

  it("intern_rulebook: the exact text get_rulebook serves", async () => {
    const client = await connect(sources(fake));
    const r = await client.callTool({ name: "intern_rulebook", arguments: {} });
    const served = (await fake.view("get_rulebook", {})) as { text: string };
    assert.equal(data(r).text, served.text);
    assert.ok(text(r).endsWith(`\n\n${served.text}`));
    assert.match(text(r), /round 54, nonce 0123456789abcdef/);
    await client.close();
  });

  it("intern_quote: the verdict of checks 6 to 12 with the rule, its section and the numbers", async () => {
    const client = await connect(sources(fake));
    const yes = await client.callTool({
      name: "intern_quote",
      arguments: { market: "PEPE", side: "long", margin_usd: "20", leverage: 1 },
    });
    const e = (data(yes).explanation ?? {}) as Record<string, unknown>;
    assert.deepEqual([e.verdict, e.notional_e6], ["YES", "20000000"]);
    assert.ok(text(yes).includes(NOT_IN_DRY_RUN));

    const nope = await client.callTool({
      name: "intern_quote",
      arguments: { market: "DOGE", side: "long", margin_usd: 25 }, // leverage defaults to 1; a number is accepted
    });
    const n = (data(nope).explanation ?? {}) as Record<string, unknown>;
    assert.deepEqual(
      [n.verdict, n.code, n.check, n.asked, n.limit],
      ["NOPE", "OVER_TRADE_LIMIT", 11, "25000000", "20000000"],
    );
    assert.equal(n.section, "01 §7 check 11; the limit base is in §3 (1.1)");
    assert.match(
      String(n.limit_from),
      /^The per-bet limit \$20.00 is 2% \(INTERN's per_bet_bps 200, 01 §3\)/,
    );
    assert.match(text(nope), /VERDICT of checks 6 to 12: NOPE OVER_TRADE_LIMIT \(check 11\)/);
    await client.close();
  });

  it("intern_quote refuses what it cannot quote, as a tool error with the reason", async () => {
    const client = await connect(sources(fake));
    const bad = await client.callTool({
      name: "intern_quote",
      arguments: { market: "DOGE", side: "long", margin_usd: "12.3456789" },
    });
    assert.equal(bad.isError, true);
    assert.match(
      text(bad),
      /^This bet cannot be quoted: margin "12.3456789" is not dollars with up to 6 decimals/,
    );
    const schema = await client.callTool({
      name: "intern_quote",
      arguments: { market: "BTC", side: "long", margin_usd: "20" },
    });
    assert.equal(schema.isError, true);
    assert.match(text(schema), /Input validation error/);

    const f = new FakeCoinViews();
    (f.constants.ranks as { rank: string; per_bet_bps: number }[])[0] = {
      ...(f.constants.ranks as { rank: string; per_bet_bps: number }[])[0],
      rank: "INTERN",
      per_bet_bps: 300,
    };
    const other = await connect(sources(f));
    const differ = await other.callTool({
      name: "intern_quote",
      arguments: { market: "DOGE", side: "long", margin_usd: "20" },
    });
    assert.equal(differ.isError, true);
    assert.match(text(differ), /^No quote: the contract's rank limits differ from ranks\.ts/);
    await client.close();
    await other.close();
  });

  it("intern_quote in a long-shot round: the ticket is judged as the contract judges it", async () => {
    const f = new FakeCoinViews();
    f.longShot = { margin_e6: 5_000_000n, max_leverage: 10 };
    const client = await connect(sources(f));
    const r = await client.callTool({
      name: "intern_quote",
      arguments: { market: "DOGE", side: "long", margin_usd: "5", leverage: 10 },
    });
    const e = (data(r).explanation ?? {}) as Record<string, unknown>;
    assert.deepEqual([e.verdict, e.long_shot, e.notional_e6], ["YES", true, "50000000"]);
    assert.deepEqual((data(r).round as { long_shot: unknown }).long_shot, {
      margin_e6: "5000000",
      max_leverage: 10,
    });
    await client.close();
  });

  it("intern_feed: recent events, oldest first, and the seq to continue from", async () => {
    const f = new FakeCoinViews();
    const client = await connect(sources(f));
    const latest = await client.callTool({ name: "intern_feed", arguments: {} });
    assert.deepEqual(
      (data(latest).items as { seq: number }[]).map((i) => i.seq),
      [1, 2],
    );
    assert.match(
      text(latest),
      /#2 2026-11-13T15:15:05\.000Z refused \{"refusal_id":9,"round_id":54,"code":"OVER_TRADE_LIMIT"/,
    );
    assert.match(text(latest), /call again with after_seq 2\.$/);
    const newer = await client.callTool({ name: "intern_feed", arguments: { after_seq: 1, limit: 5 } });
    assert.deepEqual(
      (data(newer).items as { seq: number }[]).map((i) => i.seq),
      [2],
    );
    assert.deepEqual(
      f.calls.filter((c) => c.method === "get_feed").map((c) => c.args),
      [{ limit: 20 }, { limit: 5, after_seq: 1 }],
    );
    await client.close();
  });

  it("intern_verify_round: a real proposal re-checked from recorded public data; the sender is the runner", async () => {
    const client = await connect(sources(fake));
    const r = await client.callTool({ name: "intern_verify_round", arguments: { tx_hash: VERIFY_TX } });
    const d = data(r);
    assert.deepEqual(
      [d.sender, d.verified, d.failures, d.unverified, d.fatal],
      ["intern-runner-ed25519.testnet", true, 0, 0, null],
    );
    assert.match(text(r), /RESULT {2}verified from public data: z-ai\/glm-5\.3-flash signed this answer/);
    const badHash = await client.callTool({
      name: "intern_verify_round",
      arguments: { tx_hash: "not-a-hash" },
    });
    assert.equal(badHash.isError, true);
    await client.close();
  });

  it("intern_fills_check: the recorded run's summary (52 rounds: 30 OK, 1 NO FILLS, 1 MISMATCH)", async () => {
    const views: string[] = [];
    const client = await connect({
      coin: CHAIN.contract,
      rpc: RPCS[0] as string,
      snapshot: async () => ({
        block: {
          height: 1,
          hash: "RecordedRun1111111111111111111111111111111111",
          time_ms: CHAIN.checked_at_ms,
        },
        view: async (method, args) => {
          views.push(method);
          const hit = CHAIN.views.find(
            (v) => v.method === method && JSON.stringify(v.args) === JSON.stringify(args),
          );
          if (!hit) throw new Error(`not recorded: ${method} ${JSON.stringify(args)}`);
          return structuredClone(hit.result);
        },
      }),
      fetchFn: recordedFetch,
      verifyRpcs: RPCS,
      now: () => CHAIN.checked_at_ms,
    });
    const r = await client.callTool({ name: "intern_fills_check", arguments: { rounds: 60 } });
    const d = data(r);
    const summary = d.summary as { bets: number; by_status: Record<string, number>; ok: boolean };
    assert.equal(summary.bets, 32);
    assert.deepEqual(
      [summary.by_status.OK, summary.by_status["NO FILLS"], summary.by_status.MISMATCH],
      [30, 1, 1],
    );
    assert.equal(summary.ok, false);
    assert.equal((d.bets as unknown[]).length, 32);
    assert.match(text(r), /^fills-check at block 1\. Read-only/);
    assert.ok(views.every((m) => m.startsWith("get_")));
    const tooMany = await client.callTool({ name: "intern_fills_check", arguments: { rounds: 500 } });
    assert.equal(tooMany.isError, true);
    await client.close();
  });
});

describe("the server cannot sign and reads no key", () => {
  const SRC = fileURLToPath(new URL("../src/", import.meta.url));

  it("its code never loads the modules that sign or hold keys", () => {
    const g = graph(`${SRC}cli/mcp.ts`);
    for (const f of [
      "near.ts",
      "chain.ts",
      "secret.ts",
      "key-scope.ts",
      "round.ts",
      "nearai.ts",
      "exchange.ts",
    ])
      assert.ok(!g.files.includes(f), f);
    assert.ok(!g.outside.includes("near-api-js"));
    for (const o of g.outside)
      assert.ok(/^(node:|@modelcontextprotocol\/sdk\/|zod$|@noble\/(curves|hashes)\/)/.test(o), o);
  });

  it("nor does it read the environment or a .env file", () => {
    for (const f of ["mcp.ts", "cli/mcp.ts", "chain-snapshot.ts", "quote.ts", "explain.ts"]) {
      const src = readFileSync(`${SRC}${f}`, "utf8");
      assert.doesNotMatch(src, /process\.env|env-file|readSecret/, f);
    }
  });
});
