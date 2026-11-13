import { MARKETS, type Market } from "../../../runner/src/markets.ts";
import type { RankName } from "../../../runner/src/ranks.ts";
import type { Status } from "../../../runner/src/rules.ts";
import type { Recorded } from "./behaviour.ts";
import { BASELINE_COMMUNITY, type CommunityInputs } from "./community.ts";
import { type InternPolicy, runSim, type SimConfig } from "./engine.ts";
import { coinPriceE6 } from "./ledger.ts";
import type { Move, MoveTable } from "./prices.ts";
import { Rng } from "./rng.ts";
import { clockFor, roundsPerDay } from "./rules01.ts";
import { addAccount, bosses, type DayPoint, newWorld } from "./world.ts";

/**
 * PROJECTION. `fastForward` takes the coin's public state (the `get_pot` and `get_rank` views of 01 §8.1) and a number
 * of days, and returns where the simulation takes it. It is a projection from assumed community behaviour, past
 * prices and the AI's past answers: not a forecast, not advice, not a promise. Every result carries that label.
 *
 * Pure and deterministic: no I/O, no clock; the same input gives the same output, and the input is not changed. It
 * runs the same engine as the scenarios, with the rank limits on. What the public views do not say is filled in and
 * stated: each boss is given an equal share of the coins, the SAFE money and the pending money, and none has coins
 * locked yet; a bet open at the start is taken to come back flat.
 */

export const PROJECTION_NOTE =
  "A projection from the $INTERN simulation: assumed community behaviour on past prices and the AI's recorded answers. Not a forecast, not advice, not a promise.";

/** The parts of `get_pot` (01 §8.1) the projection reads, as the view returns them. */
export interface PotView {
  brave: { total: string; in_play: string; pending: string; income_waiting?: string };
  safe: { total: string };
  coin_supply: string;
  bosses: number;
}

export interface ProjectionInput {
  pot: PotView;
  /** `get_rank` (01 §8.1). */
  rank: { rank: RankName; status: Status };
  /** 1440 (the product) or 30 (the demo); 01 §5 has no other phase offsets. */
  round_minutes: number;
  /** The model's recorded answers (a profile's `decisions`), replayed as in the scenarios. */
  decisions: readonly Recorded[];
  /** Price moves per round; repeated from the start if the projection is longer. */
  moves: MoveTable;
  cost_bps: number;
  community?: CommunityInputs;
  seed?: number;
  /** Proposals a round: the runner's default is one (runner/src/round.ts; test/sim-projection.test.ts checks). */
  asks?: number;
}

export interface Projection {
  label: "PROJECTION";
  note: string;
  days: number;
  seed: number;
  start: {
    price_e6: string;
    brave_e6: string;
    supply_e6: string;
    bosses: number;
    rank: RankName;
    status: Status;
  };
  end: {
    price_e6: string;
    brave_e6: string;
    supply_e6: string;
    bosses: number;
    rank: RankName;
    status: Status;
  };
  /** One point a day, at the end of the day. */
  daily: DayPoint[];
  rank_changes: { round: number; from: string; to: string; by: string }[];
}

/** The moves table repeated to `rounds` rounds. */
function cycled(moves: MoveTable, rounds: number): MoveTable {
  if (moves.rounds === 0) throw new Error("the projection needs at least one round of price moves");
  const out = {} as Record<Market, (Move | null)[]>;
  for (const { market } of MARKETS) {
    const row = moves.moves[market];
    out[market] = Array.from({ length: rounds }, (_, k) => row[k % moves.rounds] ?? null);
  }
  return { start_ms: moves.start_ms, round_ms: moves.round_ms, rounds, moves: out };
}

export function fastForward(input: ProjectionInput, days: number): Projection {
  const clock = clockFor(input.round_minutes);
  const rounds = Math.max(0, Math.round(days * roundsPerDay(clock)));
  const seed = input.seed ?? 1;
  const community = input.community ?? BASELINE_COMMUNITY;
  const w = newWorld();
  // The public state, spread over `bosses` equal holders.
  const n = Math.max(1, input.pot.bosses);
  const supply = BigInt(input.pot.coin_supply);
  const safe = BigInt(input.pot.safe.total);
  const pending = BigInt(input.pot.brave.pending);
  const rng = new Rng(seed);
  for (let i = 0; i < n; i++) {
    const a = addAccount(w, "boss", {
      locks: rng.chance(community.lock_share),
      joins_draw: rng.chance(community.draw_join_share),
    });
    a.coins = supply / BigInt(n);
    a.safe = safe / BigInt(n);
    a.pending = pending / BigInt(n);
    a.joined_round = a.coins > 0n ? 0 : null;
  }
  w.pot.brave_total = BigInt(input.pot.brave.total);
  w.pot.supply = supply;
  w.pot.nobodys = supply - w.accounts.reduce((s, a) => s + a.coins, 0n);
  w.pot.safe_total = w.accounts.reduce((s, a) => s + a.safe, 0n);
  w.pot.pending = w.accounts.reduce((s, a) => s + a.pending, 0n);
  w.pot.income_waiting = BigInt(input.pot.brave.income_waiting ?? "0");
  w.rank = input.rank.rank;
  w.status = input.rank.status;
  const startPoint = {
    price_e6: String(coinPriceE6(w.pot)),
    brave_e6: String(w.pot.brave_total),
    supply_e6: String(w.pot.supply),
    bosses: bosses(w),
    rank: w.rank,
    status: w.status,
  };
  const intern: InternPolicy = { kind: "recorded", decisions: input.decisions };
  const cfg: SimConfig = {
    clock,
    rounds,
    arm: "limits",
    intern,
    asks: input.asks ?? 1,
    moves: cycled(input.moves, Math.max(1, rounds)),
    cost_bps: input.cost_bps,
    losing: null,
    community: { ...community, start_bosses: 0, jackpot_seed_usd: 0 },
    whale: null,
    fakes: null,
    run: null,
    seed,
  };
  runSim(cfg, w);
  return {
    label: "PROJECTION",
    note: PROJECTION_NOTE,
    days,
    seed,
    start: startPoint,
    end: {
      price_e6: String(coinPriceE6(w.pot)),
      brave_e6: String(w.pot.brave_total),
      supply_e6: String(w.pot.supply),
      bosses: bosses(w),
      rank: w.rank,
      status: w.status,
    },
    daily: w.daily,
    rank_changes: w.counters.rank_changes,
  };
}
