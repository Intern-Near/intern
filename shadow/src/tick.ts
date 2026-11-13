import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { requestBody, runExchange, writeNew } from "../../runner/src/exchange.ts";
import { fetchPrices, type PriceRow } from "../../runner/src/hyperliquid.ts";
import { SIGNING_ALGOS } from "../../runner/src/nearai.ts";
import type { RankName } from "../../runner/src/ranks.ts";
import type { RecordingMeta } from "../../runner/src/recordings.ts";
import type { Secret } from "../../runner/src/secret.ts";
import { parseSignatureReply } from "../../runner/src/signature.ts";
import { askAgain } from "./ask-twice.ts";
import type { RunConfig } from "./config.ts";
import { instructionFor, requestExtras, rulebookFor, userMessageFor } from "./prompts.ts";
import { intervalMs, roundIdFor, type TickRole, tickId } from "./schedule.ts";
import { exchangeDir, tickDir, writeNewGz } from "./store.ts";

export interface TickDeps {
  fetchFn: typeof fetch;
  apiKey: Secret;
  now: () => number;
  /** `bytes` random bytes as lower-case hex. */
  randomHex: (bytes: number) => string;
  /** A structured event: printed, and appended to events.jsonl by the caller. */
  log: (event: Record<string, unknown>) => void;
}

/** One exchange's meta.json in a shadow run: a step 1 recording's fields, plus where it sits in the run. */
export type ShadowMeta = Omit<RecordingMeta, "response"> & {
  response: RecordingMeta["response"] | null;
  shadow: {
    run_id: string;
    tick: string;
    rank: RankName;
    prompt_markets: string;
    thinking: string;
    rulebook: string;
    /** In a run with a pressure set: which of its messages this exchange's user message ended with. */
    pressure_index?: number;
    /** In a run with `ask_twice`: 2 in the second answer's meta.json (src/ask-twice.ts). Absent everywhere else. */
    ask?: 2;
  };
};

export type ExchangeStatus = {
  model: string;
  rank: RankName;
  status: "ok" | "failed" | "skipped";
  detail?: string;
  /** In a run with `ask_twice` only: how the second question with the same request went. */
  second?: { status: "ok" | "failed" | "skipped"; detail?: string };
};

export interface TickSummary {
  tick: string;
  role: TickRole;
  started_at: string;
  finished_at: string;
  prices_pre: { fetched_at: string } | { error: string };
  prices_post: { fetched_at: string } | { error: string };
  exchanges: ExchangeStatus[];
}

/** Stop starting new exchanges this long before the next tick, so a tick never runs into the next one. */
const TICK_MARGIN_MS = 60_000;
/** Do not start an exchange with less time than this left in the tick. */
const MIN_EXCHANGE_MS = 30_000;

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function savePrices(
  dir: string,
  name: "pre" | "post",
  deps: TickDeps,
): Promise<{ rows: PriceRow[]; at: string } | { error: string }> {
  try {
    const p = await fetchPrices("mainnet", deps.fetchFn);
    const at = new Date(deps.now()).toISOString();
    await writeNewGz(join(dir, `prices-${name}.json.gz`), p.body);
    await writeNew(
      join(dir, `prices-${name}.meta.json`),
      `${JSON.stringify({ fetched_at: at, source: p.source })}\n`,
    );
    return { rows: p.rows, at };
  } catch (e) {
    return { error: message(e) };
  }
}

async function oneExchange(
  runDir: string,
  cfg: RunConfig,
  tickMs: number,
  model: string,
  rank: RankName,
  prices: { rows: PriceRow[]; at: string },
  deps: TickDeps,
): Promise<ExchangeStatus> {
  const id = tickId(tickMs);
  const remaining = tickMs + intervalMs(cfg) - TICK_MARGIN_MS - deps.now();
  if (remaining < MIN_EXCHANGE_MS)
    return { model, rank, status: "skipped", detail: "no time left in this tick" };

  const dir = exchangeDir(runDir, id, model, rank);
  const expected = { round_id: roundIdFor(tickMs, cfg.interval_minutes), nonce: deps.randomHex(8) };
  const rulebook = rulebookFor(cfg.rulebook, {
    ...expected,
    rank,
    brave_at_open_e6: BigInt(cfg.pool_e6),
    bets_used: 0,
    at_risk_e6: 0n,
    playbook: null,
  });
  const instruction = instructionFor(cfg, expected.round_id);
  const user = userMessageFor(prices.rows, prices.at, cfg.prompt_markets, rank, instruction.text);
  const extra = requestExtras(model, cfg.thinking);
  const requestBytes = requestBody(model, rulebook, user, extra ? { extra } : {});
  const log = (line: string): void => deps.log({ tick: id, model, rank, step: "exchange", detail: line });
  const recordedAt = new Date(deps.now()).toISOString();

  const result = await runExchange({
    dir,
    requestBytes,
    apiKey: deps.apiKey,
    fetchFn: deps.fetchFn,
    log,
    timeoutMs: remaining,
    now: () => new Date(deps.now()),
  });

  const meta: ShadowMeta = {
    format: 1,
    model,
    case: `shadow ${rank}`,
    what: `Shadow run ${cfg.run_id}, tick ${id}, told rank ${rank} on a paper pool of ${cfg.pool_e6} (6 decimals).`,
    recorded_at: recordedAt,
    expected: { ...expected, rulebook },
    market_data: {
      source: "prices-pre.json.gz in this tick",
      fetched_at: prices.at,
      saved_as: "../../prices-pre.json.gz",
    },
    request: result.request,
    response: result.response,
    preflight: cfg.pinned[model] as RecordingMeta["preflight"],
    signatures: result.signatures,
    ...(result.error === undefined ? {} : { error: result.error }),
    shadow: {
      run_id: cfg.run_id,
      tick: id,
      rank,
      prompt_markets: cfg.prompt_markets,
      thinking: cfg.thinking,
      rulebook: cfg.rulebook,
      ...(instruction.index === null ? {} : { pressure_index: instruction.index }),
    },
  };
  await writeNew(join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);

  // A signer that differs from the pinned one would stop every proposal in the product. Say so loudly.
  for (const algo of SIGNING_ALGOS) {
    const path = join(dir, `signature-${algo}.json`);
    if (!existsSync(path)) continue;
    try {
      const reply = parseSignatureReply(readFileSync(path, "utf8"));
      const pinned = cfg.pinned[model]?.[algo]?.signing_address ?? "";
      if (
        reply.signing_address.toLowerCase().replace(/^0x/, "") !== pinned.toLowerCase().replace(/^0x/, "")
      ) {
        deps.log({
          tick: id,
          model,
          rank,
          step: "SIGNER CHANGED",
          algo,
          signer: reply.signing_address,
          pinned,
        });
      }
    } catch (e) {
      deps.log({ tick: id, model, rank, step: "signature unavailable", algo, detail: message(e) });
    }
  }

  return result.error === undefined
    ? { model, rank, status: "ok" }
    : { model, rank, status: "failed", detail: result.error };
}

/** In a run with `ask_twice`: the same request a second time, under the same time limits as the first. */
async function secondAsk(
  runDir: string,
  cfg: RunConfig,
  tickMs: number,
  model: string,
  rank: RankName,
  deps: TickDeps,
): Promise<NonNullable<ExchangeStatus["second"]>> {
  const remaining = tickMs + intervalMs(cfg) - TICK_MARGIN_MS - deps.now();
  if (remaining < MIN_EXCHANGE_MS) return { status: "skipped", detail: "no time left in this tick" };
  const id = tickId(tickMs);
  return askAgain(exchangeDir(runDir, id, model, rank), cfg, { tick: id, model, rank }, remaining, deps);
}

/**
 * One tick: prices before, one decision per model and rank (models in parallel, ranks one after another), prices
 * after, then tick.json. In a "tail" tick only prices are read. Every file is written as soon as it exists.
 */
export async function runTick(
  runDir: string,
  cfg: RunConfig,
  tickMs: number,
  role: TickRole,
  deps: TickDeps,
): Promise<TickSummary> {
  const id = tickId(tickMs);
  const dir = tickDir(runDir, id);
  if (existsSync(join(dir, "tick.json"))) throw new Error(`tick ${id} already ran`);
  const startedAt = new Date(deps.now()).toISOString();
  deps.log({ tick: id, step: "tick start", role });

  const pre = await savePrices(dir, "pre", deps);
  if ("error" in pre) deps.log({ tick: id, step: "prices-pre failed", detail: pre.error });

  const exchanges: ExchangeStatus[] = [];
  if (role === "decide") {
    if ("error" in pre) {
      for (const model of cfg.models) {
        for (const rank of cfg.ranks) exchanges.push({ model, rank, status: "skipped", detail: "no prices" });
      }
    } else {
      await Promise.all(
        cfg.models.map(async (model) => {
          for (const rank of cfg.ranks) {
            try {
              const status = await oneExchange(runDir, cfg, tickMs, model, rank, pre, deps);
              // Only a run whose run.json says ask_twice: true asks again (none of the runs started on 2026-11-11).
              if (cfg.ask_twice === true)
                status.second = await secondAsk(runDir, cfg, tickMs, model, rank, deps);
              exchanges.push(status);
            } catch (e) {
              exchanges.push({ model, rank, status: "failed", detail: message(e) });
              deps.log({ tick: id, model, rank, step: "exchange error", detail: message(e) });
            }
          }
        }),
      );
    }
  }

  const post = role === "decide" ? await savePrices(dir, "post", deps) : { error: "not read in a tail tick" };
  if (role === "decide" && "error" in post)
    deps.log({ tick: id, step: "prices-post failed", detail: post.error });

  const summary: TickSummary = {
    tick: id,
    role,
    started_at: startedAt,
    finished_at: new Date(deps.now()).toISOString(),
    prices_pre: "error" in pre ? { error: pre.error } : { fetched_at: pre.at },
    prices_post: "error" in post ? { error: post.error } : { fetched_at: post.at },
    exchanges,
  };
  await writeNew(join(dir, "tick.json"), `${JSON.stringify(summary, null, 2)}\n`);
  deps.log({
    tick: id,
    step: "tick end",
    role,
    ok: exchanges.filter((e) => e.status === "ok").length,
    failed: exchanges.filter((e) => e.status === "failed").length,
    skipped: exchanges.filter((e) => e.status === "skipped").length,
  });
  return summary;
}
