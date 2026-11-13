import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import { askAgain, SECOND } from "../src/ask-twice.ts";
import { configPath, type RunConfig, readConfig, validateConfig } from "../src/config.ts";
import { buildReport, formatReport, loadRun } from "../src/report.ts";
import { tickId } from "../src/schedule.ts";
import { exchangeDir, tickDir } from "../src/store.ts";
import { runTick, type ShadowMeta, type TickDeps, type TickSummary } from "../src/tick.ts";
import { type FakeOptions, fakeFetch, makeConfig, TEST_KEY, tempDir } from "./helpers.ts";
import { DATA, replayTick, snapshot, type TickSnapshot } from "./replay.ts";

const TICK = Date.parse("2026-11-12T00:15:00.000Z");
const ID = tickId(TICK);
const MODELS = ["Qwen/Qwen3.8-27B", "z-ai/glm-5.3-flash"];
const made: string[] = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const readJson = <T>(...parts: string[]): T => JSON.parse(readFileSync(join(...parts), "utf8")) as T;

interface Setup {
  runDir: string;
  cfg: RunConfig;
  deps: TickDeps;
  events: Record<string, unknown>[];
  calls: string[];
}

function setup(
  cfgPatch: Partial<RunConfig> = {},
  fake: FakeOptions = {},
  clock = { at: TICK + 5_000 },
  wrap?: (f: typeof fetch) => typeof fetch,
): Setup {
  const runDir = tempDir();
  made.push(runDir);
  const cfg = makeConfig({ models: MODELS, ranks: ["INTERN"], ask_twice: true, ...cfgPatch });
  writeFileSync(configPath(runDir), JSON.stringify(cfg));
  const { fetchFn, calls } = fakeFetch(cfg, fake);
  const events: Record<string, unknown>[] = [];
  let n = 0;
  const deps: TickDeps = {
    fetchFn: wrap ? wrap(fetchFn) : fetchFn,
    apiKey: TEST_KEY,
    now: () => clock.at,
    randomHex: (bytes) => (n++).toString(16).padStart(bytes * 2, "0"),
    log: (e) => events.push(e),
  };
  return { runDir, cfg, deps, events, calls };
}

const completions = (calls: string[]): number => calls.filter((c) => c.endsWith("/chat/completions")).length;
const answerOf = (dir: string): string =>
  readJson<{ choices: { message: { content: string } }[] }>(dir, "response.bin").choices[0]?.message
    .content ?? "";

describe("ask_twice in run.json", () => {
  it("is off unless true, and a run.json without it loads as before", () => {
    const plain = JSON.parse(JSON.stringify(makeConfig())) as Record<string, unknown>;
    assert.deepEqual(validateConfig(structuredClone(plain)), plain);
    assert.equal("ask_twice" in validateConfig(plain), false);
    assert.equal(validateConfig({ ...plain, ask_twice: true }).ask_twice, true);
    assert.equal(validateConfig({ ...plain, ask_twice: false }).ask_twice, false);
    for (const bad of ["yes", 1, null]) {
      assert.throws(() => validateConfig({ ...plain, ask_twice: bad }), /ask_twice must be true or false/);
    }
  });
});

describe("a tick in a run that asks twice", () => {
  it("asks each model again with the same bytes, right after the first, and keeps both answers", async () => {
    const order: string[] = [];
    const seen = new Map<string, number>();
    const s = setup(
      { ranks: ["INTERN", "TRADER"] },
      {
        onCompletion: (body) => {
          const system = (body.messages as { content: string }[])[0]?.content ?? "";
          order.push(`${String(body.model)} ${/\nrank: (\w+)\n/.exec(system)?.[1]}`);
        },
        // The first question of each model and rank is answered with a skip, the second with a bet.
        answer: (model, nonce, round) => {
          const k = (seen.get(model) ?? 0) + 1;
          seen.set(model, k);
          return k % 2 === 1
            ? `{"v":1,"round":${round},"nonce":"${nonce}","action":"skip"}`
            : `{"v":1,"round":${round},"nonce":"${nonce}","action":"bet","market":"DOGE","side":"long","margin_e6":"20000000","leverage":1}`;
        },
      },
    );
    const summary = await runTick(s.runDir, s.cfg, TICK, "decide", s.deps);

    assert.equal(completions(s.calls), 8);
    for (const model of MODELS) {
      assert.deepEqual(
        order.filter((o) => o.startsWith(model)),
        [`${model} INTERN`, `${model} INTERN`, `${model} TRADER`, `${model} TRADER`],
      );
      for (const rank of ["INTERN", "TRADER"] as const) {
        const first = exchangeDir(s.runDir, ID, model, rank);
        const second = join(first, SECOND);
        const files = [
          "meta.json",
          "request.bin",
          "response.bin",
          "signature-ecdsa.json",
          "signature-ed25519.json",
        ];
        assert.deepEqual(readdirSync(first).sort(), [...files, SECOND].sort());
        assert.deepEqual(readdirSync(second).sort(), files);
        assert.ok(readFileSync(join(second, "request.bin")).equals(readFileSync(join(first, "request.bin"))));
        assert.match(answerOf(first), /"action":"skip"/);
        assert.match(answerOf(second), /"action":"bet"/);

        const m1 = readJson<ShadowMeta>(first, "meta.json");
        const m2 = readJson<ShadowMeta>(second, "meta.json");
        assert.equal(m1.shadow.ask, undefined);
        assert.equal(m2.shadow.ask, 2);
        assert.deepEqual(m2.expected, m1.expected);
        assert.deepEqual(m2.preflight, m1.preflight);
        assert.equal(m2.market_data.saved_as, "../../../prices-pre.json.gz");
        assert.ok(existsSync(join(second, m2.market_data.saved_as)));
        assert.ok(m2.what.endsWith("Asked a second time with the same request."));
        assert.notEqual(m2.response?.chat_id, m1.response?.chat_id);
        assert.equal(m2.error, undefined);
      }
    }
    assert.ok(summary.exchanges.every((e) => e.status === "ok" && e.second?.status === "ok"));
    assert.deepEqual(readJson<TickSummary>(tickDir(s.runDir, ID), "tick.json"), summary);
    const again = s.events.filter((e) => e.ask === 2);
    assert.ok(again.length > 0 && again.every((e) => e.step === "exchange"));
    assert.ok(!JSON.stringify(s.events).includes("sk-test-never-printed"));
  });

  it("judges only the first answer in the report, and the report says the run asked twice", async () => {
    const s = setup();
    await runTick(s.runDir, s.cfg, TICK, "decide", s.deps);
    const data = buildReport(loadRun(s.runDir), {
      answerRule: "strict",
      scheme: "ed25519",
      now: TICK + 60_000,
    });
    assert.deepEqual(
      data.rows.map((r) => r.decisions + r.failed),
      [1, 1],
    );
    const line =
      "- Each model was asked twice per tick with the same request; only the first answer is counted";
    assert.ok(formatReport(data).includes(line));
    const { ask_twice: _, ...plainCfg } = data.cfg;
    assert.ok(!formatReport({ ...data, cfg: plainCfg }).includes(line));
  });

  it("does not ask again when the tick has no time left for it", async () => {
    const clock = { at: TICK + 13 * 60_000 }; // 60 s left before the margin: room for the first question only
    const s = setup({ models: ["z-ai/glm-5.3-flash"] }, { onCompletion: () => (clock.at += 60_000) }, clock);
    const summary = await runTick(s.runDir, s.cfg, TICK, "decide", s.deps);
    assert.deepEqual(summary.exchanges, [
      {
        model: "z-ai/glm-5.3-flash",
        rank: "INTERN",
        status: "ok",
        second: { status: "skipped", detail: "no time left in this tick" },
      },
    ]);
    assert.equal(completions(s.calls), 1);
    assert.ok(!existsSync(join(exchangeDir(s.runDir, ID, "z-ai/glm-5.3-flash", "INTERN"), SECOND)));
  });

  it("keeps a failed second answer apart, without touching the first", async () => {
    let n = 0;
    const s = setup(
      { models: ["z-ai/glm-5.3-flash"] },
      {},
      undefined,
      (f) =>
        (async (input, init) => {
          const url = input instanceof Request ? input.url : input.toString();
          if (url.endsWith("/chat/completions") && ++n === 2) return new Response("busy", { status: 503 });
          return f(input, init);
        }) as typeof fetch,
    );
    const summary = await runTick(s.runDir, s.cfg, TICK, "decide", s.deps);
    const [e] = summary.exchanges;
    assert.equal(e?.status, "ok");
    assert.equal(e?.second?.status, "failed");
    assert.match(e?.second?.detail ?? "", /HTTP 503/);
    const first = exchangeDir(s.runDir, ID, "z-ai/glm-5.3-flash", "INTERN");
    assert.deepEqual(readdirSync(join(first, SECOND)).sort(), ["meta.json", "request.bin", "response.bin"]);
    const m2 = readJson<ShadowMeta>(first, SECOND, "meta.json");
    assert.equal(m2.response?.status, 503);
    assert.match(m2.error ?? "", /HTTP 503/);
    assert.equal(readJson<ShadowMeta>(first, "meta.json").error, undefined);
  });

  it("says loudly when the second answer is signed by another signer", async () => {
    const s = setup(
      { models: ["Qwen/Qwen3.8-27B"] },
      { signer: (_m, algo) => (algo === "ecdsa" ? `0x${"ab".repeat(20)}` : "cd".repeat(32)) },
    );
    await runTick(s.runDir, s.cfg, TICK, "decide", s.deps);
    const changed = s.events.filter((e) => e.step === "SIGNER CHANGED");
    assert.deepEqual(
      changed.map((e) => `${e.algo} ${e.ask ?? 1}`),
      ["ecdsa 1", "ed25519 1", "ecdsa 2", "ed25519 2"],
    );
  });

  it("logs a signature reply it cannot read, for both answers", async () => {
    const s = setup(
      { models: ["z-ai/glm-5.3-flash"] },
      {},
      undefined,
      (f) =>
        (async (input, init) => {
          const url = input instanceof Request ? input.url : input.toString();
          return url.includes("/v1/signature/") ? new Response("not json", { status: 500 }) : f(input, init);
        }) as typeof fetch,
    );
    const summary = await runTick(s.runDir, s.cfg, TICK, "decide", s.deps);
    assert.deepEqual(
      s.events.filter((e) => e.step === "signature unavailable").map((e) => `${e.algo} ${e.ask ?? 1}`),
      ["ecdsa 1", "ed25519 1", "ecdsa 2", "ed25519 2"],
    );
    assert.equal(summary.exchanges[0]?.second?.status, "ok"); // as for the first: the answer itself arrived
  });

  it("when the first question cannot even be made, records that and does not ask again", async () => {
    const s = setup({ models: ["z-ai/glm-5.3-flash"] });
    const first = exchangeDir(s.runDir, ID, "z-ai/glm-5.3-flash", "INTERN");
    mkdirSync(first, { recursive: true });
    writeFileSync(join(first, "request.bin"), "left over"); // files are never overwritten, so the first ask throws
    const summary = await runTick(s.runDir, s.cfg, TICK, "decide", s.deps);
    const [e] = summary.exchanges;
    assert.equal(e?.status, "failed");
    assert.match(e?.detail ?? "", /EEXIST/);
    assert.equal(e?.second, undefined);
    assert.equal(completions(s.calls), 0);
    assert.ok(s.events.some((x) => x.step === "exchange error" && x.ask === undefined));
  });

  it("never throws: with nothing to ask again it says why and reports a failure", async () => {
    const s = setup();
    const empty = tempDir();
    made.push(empty);
    const at = { tick: ID, model: "z-ai/glm-5.3-flash", rank: "INTERN" as const };
    const r = await askAgain(empty, s.cfg, at, 60_000, s.deps);
    assert.equal(r.status, "failed");
    assert.match(r.detail ?? "", /ENOENT/);
    assert.deepEqual(
      s.events.map((e) => [e.step, e.ask, e.model]),
      [["exchange error", 2, "z-ai/glm-5.3-flash"]],
    );
    assert.deepEqual(s.calls, []);
  });
});

// The live pressure run's first tick, replayed offline (test/replay.ts), with ask_twice added to its real run.json.
describe("ask_twice and the first answer, on a real tick", () => {
  const RUN = "2026-11-11-intern-pressure";
  const TICK_ID = "2026-11-11T1707Z";
  const golden = readJson<{ ticks: Record<string, TickSnapshot> }>(
    fileURLToPath(new URL("./golden/existing-runs.json", import.meta.url)),
  ).ticks[`${RUN}/${TICK_ID}`];

  async function replayWith(askTwice: boolean): Promise<{ runDir: string; snap: TickSnapshot }> {
    const real = join(DATA, RUN);
    const runDir = tempDir();
    made.push(runDir);
    const raw = readJson<Record<string, unknown>>(configPath(real));
    writeFileSync(configPath(runDir), JSON.stringify({ ...raw, ask_twice: askTwice }, null, 2));
    const cfg = readConfig(runDir);
    const replay = replayTick(real, TICK_ID, cfg);
    mock.timers.enable({ apis: ["Date"], now: replay.now });
    try {
      await runTick(runDir, cfg, replay.tickMs, "decide", replay.deps);
    } finally {
      mock.timers.reset();
    }
    return { runDir, snap: snapshot(runDir, TICK_ID, replay) };
  }

  it("ask_twice false writes exactly what the run writes without the setting", async () => {
    assert.ok(golden);
    assert.deepEqual((await replayWith(false)).snap, golden);
  });

  it("ask_twice true leaves every file of the first answers as it was, and adds the second answers", async () => {
    assert.ok(golden);
    const { runDir, snap } = await replayWith(true);
    assert.equal(snap.completions, 8);
    for (const [name, hash] of Object.entries(golden.files)) {
      if (name !== "tick.json") assert.equal(snap.files[name], hash, name);
    }
    const added = Object.keys(snap.files).filter((name) => !(name in golden.files));
    assert.equal(added.filter((name) => name.includes(`/${SECOND}/`)).length, 4 * 5);
    for (const model of readConfig(runDir).models) {
      const first = exchangeDir(runDir, TICK_ID, model, "INTERN");
      assert.ok(
        readFileSync(join(first, SECOND, "request.bin")).equals(readFileSync(join(first, "request.bin"))),
      );
    }
  });
});
