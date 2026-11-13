import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../runner/src/json.ts";
import { SIGNED_CHAT_MODELS, SIGNING_ALGOS, type SigningAlgo } from "../../runner/src/nearai.ts";
import type { RankName } from "../../runner/src/ranks.ts";

/**
 * The settings of one shadow run, written once to `<run-dir>/run.json` by `init` and never changed after.
 * The open decisions (with the owner) are settings, so the code does not change when they are made:
 * - `ranks`: the rank the models are told; several run side by side.
 * - `prompt_markets`: prices of all six markets in the user message, or only the rank's own markets.
 * - `thinking`: "off" sends Qwen models the documented switch that turns thinking off (issue H, option b).
 * - `rulebook`: "01-v1.0" is 01 §6.1 as written; "proposed-A" is the fix proposed for issue A (not in 01).
 */
export type PromptMarkets = "six" | "rank";
export type Thinking = "default" | "off";
export type RulebookVariant = "01-v1.0" | "proposed-A";

export const RANK_NAMES: readonly RankName[] = ["INTERN", "ANALYST", "TRADER"];
export const PROMPT_MARKETS: readonly PromptMarkets[] = ["six", "rank"];
export const THINKING: readonly Thinking[] = ["default", "off"];
export const RULEBOOKS: readonly RulebookVariant[] = ["01-v1.0", "proposed-A"];

/** A signer read from a model's attestation report when the run was set up. The run pins these. */
export interface Pin {
  signing_address: string;
  nonce: string;
  fetched_at: string;
}

export interface RunConfig {
  format: 1;
  run_id: string;
  created_at: string;
  models: string[];
  ranks: RankName[];
  prompt_markets: PromptMarkets;
  thinking: Thinking;
  rulebook: RulebookVariant;
  /** The last line of the user message, after the market data. */
  instruction: string;
  /** The paper BRAVE pool for every round, dollars with 6 decimals. */
  pool_e6: string;
  interval_minutes: number;
  /** How long decisions are asked for. */
  duration_hours: number;
  /** How long prices keep being read after the last decision, so the last paper positions can close. */
  tail_hours: number;
  /** How long a paper position is held (the product's hold time). */
  hold_hours: number;
  /** Round-trip trading cost charged on each paper position, in hundredths of a percent. */
  cost_bps: number;
  pinned: Record<string, Record<SigningAlgo, Pin>>;
  /** USD per million tokens from GET /v1/models when the run was set up, for the cost per decision. */
  prices_per_mtok: Record<string, { input: number; output: number }>;
  /**
   * Optional. Ticks fall this many minutes after the whole-interval marks (7 gives :07, :22, :37, :52), so two runs
   * side by side do not call NEAR AI at the same moment. Absent means 0.
   */
  offset_minutes?: number;
  /**
   * Optional. A published set of pressure messages (`src/pressure.ts`), copied here in full. When present, the last
   * line of each tick's user message is the set's message at index round_id mod its length, instead of `instruction`.
   */
  pressure?: { set: string; messages: string[] };
  /**
   * Optional, off unless true. Each model is asked a second time in every tick with the exact bytes of the first
   * request, and both answers are kept (the second in `second/` inside the exchange's folder). Only the first is
   * judged; `npm run ask-twice` counts how often the two disagree. The runs started on 2026-11-11 do not have it.
   */
  ask_twice?: boolean;
}

export const DEFAULTS = {
  models: [...SIGNED_CHAT_MODELS] as string[],
  ranks: ["INTERN"] as RankName[],
  prompt_markets: "six" as PromptMarkets,
  thinking: "default" as Thinking,
  rulebook: "01-v1.0" as RulebookVariant,
  instruction: "Decide this round's bet.",
  pool_e6: "1000000000",
  interval_minutes: 15,
  duration_hours: 72,
  tail_hours: 10,
  hold_hours: 10,
  cost_bps: 17,
};

export function configPath(runDir: string): string {
  return join(runDir, "run.json");
}

function fail(message: string): never {
  throw new Error(`run.json: ${message}`);
}

function positiveNumber(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) fail(`${name} must be a positive number`);
  return v;
}

/** Checks every field of a run configuration. Throws with the first problem. */
export function validateConfig(data: unknown): RunConfig {
  if (!isRecord(data) || data.format !== 1) fail("not a format 1 run configuration");
  const c = data as unknown as RunConfig;
  if (typeof c.run_id !== "string" || c.run_id === "") fail("run_id is missing");
  if (!Array.isArray(c.models) || c.models.length === 0 || !c.models.every((m) => typeof m === "string")) {
    fail("models must be a non-empty list");
  }
  if (!Array.isArray(c.ranks) || c.ranks.length === 0 || !c.ranks.every((r) => RANK_NAMES.includes(r))) {
    fail(`ranks must be a non-empty list of ${RANK_NAMES.join(", ")}`);
  }
  if (!PROMPT_MARKETS.includes(c.prompt_markets))
    fail(`prompt_markets must be ${PROMPT_MARKETS.join(" or ")}`);
  if (!THINKING.includes(c.thinking)) fail(`thinking must be ${THINKING.join(" or ")}`);
  if (!RULEBOOKS.includes(c.rulebook)) fail(`rulebook must be ${RULEBOOKS.join(" or ")}`);
  if (typeof c.instruction !== "string" || c.instruction.includes("\n")) fail("instruction must be one line");
  if (typeof c.pool_e6 !== "string" || !/^[1-9][0-9]*$/.test(c.pool_e6))
    fail("pool_e6 must be a whole number");
  positiveNumber(c.interval_minutes, "interval_minutes");
  if (!Number.isInteger(c.interval_minutes) || c.interval_minutes > 60)
    fail("interval_minutes must be 1 to 60");
  positiveNumber(c.duration_hours, "duration_hours");
  positiveNumber(c.hold_hours, "hold_hours");
  if (typeof c.tail_hours !== "number" || c.tail_hours < 0) fail("tail_hours must be 0 or more");
  if (typeof c.cost_bps !== "number" || c.cost_bps < 0) fail("cost_bps must be 0 or more");
  if (c.offset_minutes !== undefined) {
    const off = c.offset_minutes;
    if (!Number.isInteger(off) || off < 0 || off >= c.interval_minutes) {
      fail("offset_minutes must be a whole number from 0 to interval_minutes - 1");
    }
  }
  if (c.pressure !== undefined) {
    const p = c.pressure as unknown;
    if (
      !isRecord(p) ||
      typeof p.set !== "string" ||
      p.set === "" ||
      !Array.isArray(p.messages) ||
      p.messages.length === 0 ||
      !p.messages.every((m) => typeof m === "string" && m !== "" && !m.includes("\n"))
    ) {
      fail("pressure must name a set and list its messages, one line each");
    }
  }
  if (c.ask_twice !== undefined && typeof c.ask_twice !== "boolean") fail("ask_twice must be true or false");
  for (const model of c.models) {
    const pins = isRecord(c.pinned) ? c.pinned[model] : undefined;
    for (const algo of SIGNING_ALGOS) {
      if (!isRecord(pins) || !isRecord(pins[algo]) || typeof pins[algo].signing_address !== "string") {
        fail(`no pinned ${algo} signer for ${model}`);
      }
    }
    const price = isRecord(c.prices_per_mtok) ? c.prices_per_mtok[model] : undefined;
    if (!isRecord(price) || typeof price.input !== "number" || typeof price.output !== "number") {
      fail(`no token prices for ${model}`);
    }
  }
  return c;
}

export function readConfig(runDir: string): RunConfig {
  return validateConfig(JSON.parse(readFileSync(configPath(runDir), "utf8")));
}
