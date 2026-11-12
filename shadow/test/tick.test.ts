import assert from "node:assert/strict";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { RunConfig } from "../src/config.ts";
import { tickId } from "../src/schedule.ts";
import { exchangeDir, readGz, tickDir } from "../src/store.ts";
import { runTick, type ShadowMeta, type TickDeps, type TickSummary } from "../src/tick.ts";
import {
  exists,
  type FakeOptions,
  fakeFetch,
  makeConfig,
  PRICES_BODY,
  TEST_KEY,
  tempDir,
} from "./helpers.ts";

const TICK = Date.parse("2026-11-12T00:15:00.000Z");
const ID = tickId(TICK);
const MODELS = ["Qwen/Qwen3.8-27B", "z-ai/glm-5.3-flash"];
const made: string[] = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

interface Setup {
  runDir: string;
  cfg: RunConfig;
  deps: TickDeps;
  events: Record<string, unknown>[];
  calls: string[];
}

function setup(cfgPatch: Partial<RunConfig> = {}, fake: FakeOptions = {}, nowOffsetMs = 5_000): Setup {
  const runDir = tempDir();
  made.push(runDir);
  const cfg = makeConfig({ models: MODELS, ranks: ["INTERN", "TRADER"], ...cfgPatch });
  const { fetchFn, calls } = fakeFetch(cfg, fake);
  const events: Record<string, unknown>[] = [];
  let n = 0;
  const deps: TickDeps = {
    fetchFn,
    apiKey: TEST_KEY,
    now: () => TICK + nowOffsetMs,
    randomHex: (bytes) => (n++).toString(16).padStart(bytes * 2, "0"),
    log: (e) => events.push(e),
  };
  return { runDir, cfg, deps, events, calls };
}

const nearCalls = (calls: string[]): string[] => calls.filter((c) => c.includes("near.ai"));

describe("one tick", () => {
  it("saves prices, every exchange and tick.json; the request is on disk before it is sent", async () => {
    let s: Setup | undefined;
    const seenOnDisk: boolean[] = [];
    s = setup(
      {},
      {
        onCompletion: (body) => {
          const system = (body.messages as { content: string }[])[0]?.content ?? "";
          const rank = /\nrank: (\w+)\n/.exec(system)?.[1] ?? "";
          const dir = exchangeDir(s?.runDir ?? "", ID, String(body.model), rank);
          seenOnDisk.push(exists(dir, "request.bin") && !exists(dir, "response.bin"));
        },
      },
    );
    const summary = await runTick(s.runDir, s.cfg, TICK, "decide", s.deps);

    assert.deepEqual(seenOnDisk, [true, true, true, true]);
    assert.equal(summary.exchanges.length, 4);
    assert.ok(summary.exchanges.every((e) => e.status === "ok"));
    const dir = tickDir(s.runDir, ID);
    assert.equal(readGz(join(dir, "prices-pre.json.gz")), PRICES_BODY); // the exact body, gzipped losslessly
    assert.ok(exists(dir, "prices-post.json.gz") && exists(dir, "prices-pre.meta.json"));
    const saved = JSON.parse(readFileSync(join(dir, "tick.json"), "utf8")) as TickSummary;
    assert.deepEqual(saved, summary);

    for (const model of MODELS) {
      for (const rank of ["INTERN", "TRADER"] as const) {
        const ed = exchangeDir(s.runDir, ID, model, rank);
        assert.deepEqual(readdirSync(ed).sort(), [
          "meta.json",
          "request.bin",
          "response.bin",
          "signature-ecdsa.json",
          "signature-ed25519.json",
        ]);
        const meta = JSON.parse(readFileSync(join(ed, "meta.json"), "utf8")) as ShadowMeta;
        assert.equal(meta.model, model);
        assert.equal(meta.shadow.rank, rank);
        assert.ok(meta.expected.rulebook.includes(`\nrank: ${rank}\n`));
        assert.equal(meta.request.headers.authorization, "Bearer [redacted]");
        const request = JSON.parse(readFileSync(join(ed, "request.bin"), "utf8")) as {
          messages: { content: string }[];
        };
        assert.equal(request.messages[0]?.content, meta.expected.rulebook);
        assert.ok(request.messages[1]?.content.endsWith("\nDecide this round's bet."));
      }
    }
    assert.ok(s.events.some((e) => e.step === "tick start") && s.events.some((e) => e.step === "tick end"));
    assert.ok(!JSON.stringify(s.events).includes("sk-test-never-printed"));
  });

  it("never runs the same tick twice", async () => {
    const s = setup();
    await runTick(s.runDir, s.cfg, TICK, "decide", s.deps);
    await assert.rejects(runTick(s.runDir, s.cfg, TICK, "decide", s.deps), /already ran/);
  });

  it("starts no exchange with less than a minute and a half left in the tick", async () => {
    const s = setup({}, {}, 14 * 60_000);
    const summary = await runTick(s.runDir, s.cfg, TICK, "decide", s.deps);
    assert.ok(
      summary.exchanges.every((e) => e.status === "skipped" && e.detail === "no time left in this tick"),
    );
    assert.deepEqual(nearCalls(s.calls), []);
  });

  it("asks nothing when prices cannot be read, and says so", async () => {
    const s = setup({}, { hlStatus: 500 });
    const summary = await runTick(s.runDir, s.cfg, TICK, "decide", s.deps);
    assert.ok("error" in summary.prices_pre);
    assert.ok(summary.exchanges.every((e) => e.status === "skipped" && e.detail === "no prices"));
    assert.deepEqual(nearCalls(s.calls), []);
    assert.ok(exists(tickDir(s.runDir, ID), "tick.json"));
  });

  it("keeps a failed completion and does not ask for its signature", async () => {
    const s = setup({ models: ["z-ai/glm-5.3-flash"], ranks: ["INTERN"] }, { completionStatus: 500 });
    const summary = await runTick(s.runDir, s.cfg, TICK, "decide", s.deps);
    assert.equal(summary.exchanges[0]?.status, "failed");
    const ed = exchangeDir(s.runDir, ID, "z-ai/glm-5.3-flash", "INTERN");
    assert.deepEqual(readdirSync(ed).sort(), ["meta.json", "request.bin", "response.bin"]);
    const meta = JSON.parse(readFileSync(join(ed, "meta.json"), "utf8")) as ShadowMeta;
    assert.equal(meta.response?.status, 500);
    assert.match(meta.error ?? "", /HTTP 500/);
    assert.ok(!s.calls.some((c) => c.includes("/v1/signature/")));
  });

  it("reports loudly when a signature comes from a different signer than the pinned one", async () => {
    const s = setup(
      { models: ["Qwen/Qwen3.8-27B"], ranks: ["INTERN"] },
      { signer: (_m, algo) => (algo === "ecdsa" ? `0x${"ab".repeat(20)}` : "cd".repeat(32)) },
    );
    await runTick(s.runDir, s.cfg, TICK, "decide", s.deps);
    const changed = s.events.filter((e) => e.step === "SIGNER CHANGED");
    assert.deepEqual(
      changed.map((e) => e.algo),
      ["ecdsa", "ed25519"],
    );
  });

  it("reads only prices in a tail tick", async () => {
    const s = setup();
    const summary = await runTick(s.runDir, s.cfg, TICK, "tail", s.deps);
    assert.deepEqual(summary.exchanges, []);
    assert.deepEqual(readdirSync(tickDir(s.runDir, ID)).sort(), [
      "prices-pre.json.gz",
      "prices-pre.meta.json",
      "tick.json",
    ]);
    assert.deepEqual(nearCalls(s.calls), []);
  });

  it("in a run with a pressure set, ends every user message with the tick's message and records which", async () => {
    const messages = ["Message A.", "Message B.", "Message C."];
    const bodies: Record<string, unknown>[] = [];
    const s = setup(
      { ranks: ["INTERN"], pressure: { set: "test", messages } },
      { onCompletion: (b) => bodies.push(b) },
    );
    await runTick(s.runDir, s.cfg, TICK, "decide", s.deps);
    const index = Math.floor(TICK / (15 * 60_000)) % 3;
    assert.equal(bodies.length, 2);
    for (const b of bodies) {
      const user = (b.messages as { content: string }[])[1]?.content ?? "";
      assert.ok(user.endsWith(`\n${messages[index]}`), user);
    }
    for (const model of MODELS) {
      const ed = exchangeDir(s.runDir, ID, model, "INTERN");
      const meta = JSON.parse(readFileSync(join(ed, "meta.json"), "utf8")) as ShadowMeta;
      assert.equal(meta.shadow.pressure_index, index);
    }
  });

  it("in a plain run, records no pressure index", async () => {
    const s = setup({ models: ["z-ai/glm-5.3-flash"], ranks: ["INTERN"] });
    await runTick(s.runDir, s.cfg, TICK, "decide", s.deps);
    const ed = exchangeDir(s.runDir, ID, "z-ai/glm-5.3-flash", "INTERN");
    const meta = JSON.parse(readFileSync(join(ed, "meta.json"), "utf8")) as ShadowMeta;
    assert.equal(meta.shadow.pressure_index, undefined);
  });

  it("sends the thinking switch to Qwen models only, when the run asks for it", async () => {
    const bodies: Record<string, unknown>[] = [];
    const s = setup({ thinking: "off", ranks: ["INTERN"] }, { onCompletion: (b) => bodies.push(b) });
    await runTick(s.runDir, s.cfg, TICK, "decide", s.deps);
    const byModel = Object.fromEntries(bodies.map((b) => [String(b.model), b]));
    assert.deepEqual(byModel["Qwen/Qwen3.8-27B"]?.chat_template_kwargs, { enable_thinking: false });
    assert.equal(byModel["z-ai/glm-5.3-flash"]?.chat_template_kwargs, undefined);
    assert.equal(byModel["z-ai/glm-5.3-flash"]?.stream, false);
  });
});
