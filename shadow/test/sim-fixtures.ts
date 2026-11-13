import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MARKETS, type Market } from "../../runner/src/markets.ts";
import type { Recorded } from "../src/sim/behaviour.ts";
import { BASELINE_COMMUNITY, type CommunityInputs } from "../src/sim/community.ts";
import type { SimConfig } from "../src/sim/engine.ts";
import { loadPriceFixture, type PriceFixture } from "../src/sim/load.ts";
import type { Move, MoveTable } from "../src/sim/prices.ts";
import { clockFor } from "../src/sim/rules01.ts";

/** Offline inputs for the simulation's tests: the saved fixtures, and small made-up configurations. */

/** shadow/fixtures/sim/ */
export const SIM_FIXTURES = fileURLToPath(new URL("../fixtures/sim/", import.meta.url));
export const CANDLES_DIR = `${SIM_FIXTURES}hl-candles-2026-11-13`;
export const VIEWS_DIR = `${SIM_FIXTURES}testnet-views-2026-11-13`;
/** The plain shadow run, in the repository. */
export const PLAIN_RUN = fileURLToPath(new URL("../data/2026-11-11-intern", import.meta.url));

let cached: PriceFixture | null = null;
export function prices(): PriceFixture {
  cached ??= loadPriceFixture(CANDLES_DIR);
  return cached;
}

export function view(name: string): unknown {
  return JSON.parse(readFileSync(`${VIEWS_DIR}/${name}.json`, "utf8"));
}

/** Every market moves the same way every round: `exit` (and low, high) in millionths of the entry. */
export function flatMoves(
  rounds: number,
  exit_ppm: number,
  low_ppm = exit_ppm,
  high_ppm = exit_ppm,
): MoveTable {
  const move: Move = {
    exit_ppm,
    low_ppm: Math.min(low_ppm, 1_000_000, exit_ppm),
    high_ppm: Math.max(high_ppm, 1_000_000, exit_ppm),
  };
  const moves = {} as Record<Market, (Move | null)[]>;
  for (const { market } of MARKETS) moves[market] = new Array(rounds).fill(move);
  return { start_ms: 0, round_ms: 86_400_000, rounds, moves };
}

/** A small community: few bosses, so tests stay fast. */
export const SMALL_COMMUNITY: CommunityInputs = {
  ...BASELINE_COMMUNITY,
  start_bosses: 8,
  new_bosses_per_day: 1,
};

/** Some made-up recorded answers: skips, an example-sized bet, a max-sized bet, an unreadable one. */
export const SOME_ANSWERS: Recorded[] = [
  { kind: "skip" },
  { kind: "bet", market: "DOGE", side: "LONG", leverage: 1, size: { kind: "example" } },
  { kind: "bet", market: "PEPE", side: "LONG", leverage: 1, size: { kind: "max" } },
  { kind: "bet", market: "WIF", side: "SHORT", leverage: 3, size: { kind: "share", bps: 15_000 } },
  { kind: "unreadable", code: "MALFORMED_DECISION" },
];

export function config(overrides: Partial<SimConfig> = {}): SimConfig {
  const rounds = overrides.rounds ?? 20;
  return {
    clock: clockFor(1440),
    rounds,
    arm: "limits",
    intern: { kind: "recorded", decisions: SOME_ANSWERS },
    asks: 1,
    moves: flatMoves(rounds, 1_010_000),
    cost_bps: 17,
    losing: null,
    community: SMALL_COMMUNITY,
    whale: null,
    fakes: null,
    run: null,
    seed: 7,
    ...overrides,
  };
}
