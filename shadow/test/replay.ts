import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import type { RunConfig } from "../src/config.ts";
import { parseTickId } from "../src/schedule.ts";
import { exchangeDir, readGz, tickDir } from "../src/store.ts";
import type { ShadowMeta, TickDeps, TickSummary } from "../src/tick.ts";
import { TEST_KEY } from "./helpers.ts";

/** shadow/data/: the two real runs started on 2026-11-11, committed as the live run wrote them. Read only. */
export const DATA = fileURLToPath(new URL("../data/", import.meta.url));

export interface Replay {
  deps: TickDeps;
  tickMs: number;
  /** The tick's clock: when its prices were read before the decisions. */
  now: number;
  /** Every call the code made, in order ("POST https://…"). */
  calls: string[];
  events: Record<string, unknown>[];
}

/**
 * A fake Hyperliquid and NEAR AI that answer as they did in one real tick of a real run: the same price bodies,
 * and for each model the same response and signature bytes. With the tick's own clock and nonces, the code under
 * test must send exactly the requests the live run sent. Offline: nothing leaves the machine.
 */
export function replayTick(realRunDir: string, tick: string, cfg: RunConfig): Replay {
  if (cfg.ranks.length !== 1) throw new Error("replayTick handles runs with one rank");
  const [rank = "INTERN"] = cfg.ranks;
  const dir = tickDir(realRunDir, tick);
  const prices = [readGz(join(dir, "prices-pre.json.gz")), readGz(join(dir, "prices-post.json.gz"))];
  const answers = new Map<string, Buffer>();
  const chats = new Map<string, string>();
  const nonces: string[] = [];
  for (const model of cfg.models) {
    const ed = exchangeDir(realRunDir, tick, model, rank);
    const meta = JSON.parse(readFileSync(join(ed, "meta.json"), "utf8")) as ShadowMeta;
    answers.set(model, readFileSync(join(ed, "response.bin")));
    chats.set(meta.response?.chat_id ?? "", ed);
    // The code asks for one nonce per exchange, in the run's model order, before its first await.
    nonces.push(meta.expected.nonce);
  }
  const calls: string[] = [];
  let hl = 0;
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    calls.push(`${init?.method ?? "GET"} ${url.origin}${url.pathname}`);
    if (url.href === "https://api.hyperliquid.xyz/info") return new Response(prices[hl++] ?? prices[0]);
    if (url.href === "https://cloud-api.near.ai/v1/chat/completions") {
      const body = JSON.parse(Buffer.from(init?.body as Uint8Array).toString("utf8")) as { model: string };
      const answer = answers.get(body.model);
      if (!answer) throw new Error(`no recorded answer for ${body.model}`);
      return new Response(new Uint8Array(answer), { headers: { "content-type": "application/json" } });
    }
    if (url.pathname.startsWith("/v1/signature/")) {
      const ed = chats.get(decodeURIComponent(url.pathname.slice("/v1/signature/".length)));
      if (!ed) throw new Error(`no recorded chat ${url.pathname}`);
      const algo = url.searchParams.get("signing_algo");
      return new Response(new Uint8Array(readFileSync(join(ed, `signature-${algo}.json`))));
    }
    throw new Error(`unexpected call ${url.href}`);
  }) as typeof fetch;
  const pre = JSON.parse(readFileSync(join(dir, "prices-pre.meta.json"), "utf8")) as { fetched_at: string };
  const now = Date.parse(pre.fetched_at);
  const events: Record<string, unknown>[] = [];
  let n = 0;
  const deps: TickDeps = {
    fetchFn,
    apiKey: TEST_KEY,
    now: () => now,
    randomHex: () => nonces[n++] ?? "",
    log: (e) => events.push(e),
  };
  return { deps, tickMs: parseTickId(tick), now, calls, events };
}

const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)],
  );
}

export interface TickSnapshot {
  /** Calls to NEAR AI's chat completions. */
  completions: number;
  /** sha256 of every call made ("POST https://…"), one per line, sorted (models run in parallel). */
  calls: string;
  /** sha256 of the logged events, one JSON line each, sorted (models run in parallel, so their order varies). */
  events: string;
  /** sha256 of every file the tick wrote, by path inside the tick folder. */
  files: Record<string, string>;
}

/**
 * What a tick wrote, as hashes. Two things are put in a fixed order first, because they follow the order in which
 * parallel exchanges finish: tick.json's list of exchanges, and the events. Gzip files are hashed by their content.
 */
export function snapshot(runDir: string, tick: string, replay: Replay): TickSnapshot {
  const dir = tickDir(runDir, tick);
  const files: Record<string, string> = {};
  for (const path of filesUnder(dir).sort()) {
    const name = relative(dir, path).split(sep).join("/");
    let bytes: Uint8Array | string = readFileSync(path);
    if (name.endsWith(".gz")) bytes = gunzipSync(bytes);
    if (name === "tick.json") {
      const t = JSON.parse(readFileSync(path, "utf8")) as TickSummary;
      t.exchanges.sort((a, b) => `${a.model}|${a.rank}`.localeCompare(`${b.model}|${b.rank}`));
      bytes = `${JSON.stringify(t, null, 2)}\n`;
    }
    files[name] = sha256(bytes);
  }
  const lines = (xs: string[]): string => sha256(`${[...xs].sort().join("\n")}\n`);
  return {
    completions: replay.calls.filter((c) => c.endsWith("/v1/chat/completions")).length,
    calls: lines(replay.calls),
    events: lines(replay.events.map((e) => JSON.stringify(e))),
    files,
  };
}
