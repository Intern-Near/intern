import type { Recorded } from "./behaviour.ts";
import type { GrieferInputs, SniperInputs, WhaleInputs } from "./community.ts";
import type { Arm, SimConfig } from "./engine.ts";
import type { MoveTable, PriceBook } from "./prices.ts";
import { windowStarts } from "./prices.ts";
import type { Proposals } from "./proposals.ts";
import { hashSeed } from "./rng.ts";
import { type RoundClock, roundsPerDay } from "./rules01.ts";
import type { Scenario } from "./scenarios.ts";

/** How a scenario becomes one run's configuration, shared by the report and the options comparison. Pure. */

/** The window of real prices a seed uses: the same for every scenario, arm and option, so runs compare like for like. */
export function windowOf(starts: readonly number[], seed: number): number {
  return starts[hashSeed(seed, "window") % starts.length] ?? 0;
}

export function windowsFor(book: PriceBook, clock: RoundClock, days: number): number[] {
  return windowStarts(book, clock, days * roundsPerDay(clock));
}

export interface RunOptions {
  clock: RoundClock;
  days: number;
  arm: Arm;
  moves: MoveTable;
  cost_bps: number;
  seed: number;
  /** The recorded answers replayed by a "recorded" Intern. */
  decisions: readonly Recorded[];
  /** Proposals a round when the scenario says "runner": the runner's own setting (runner/src/round.ts). */
  runner_asks: number;
  proposals?: Proposals;
  griefer?: GrieferInputs | null;
  sniper?: SniperInputs | null;
  /** Replaces the scenario's whale (an abuse test's variant). */
  whale?: WhaleInputs | null;
}

export function scenarioConfig(s: Scenario, o: RunOptions): SimConfig {
  const rpd = roundsPerDay(o.clock);
  return {
    clock: o.clock,
    rounds: o.days * rpd,
    arm: o.arm,
    intern: s.intern === "max" ? { kind: "max" } : { kind: "recorded", decisions: o.decisions },
    asks: s.asks === "until-full" ? "until-full" : o.runner_asks,
    moves: o.moves,
    cost_bps: o.cost_bps,
    losing: s.losing
      ? {
          from_round: (s.losing.from_day - 1) * rpd + 1,
          to_round: (s.losing.from_day - 1 + s.losing.days) * rpd,
        }
      : null,
    community: s.community,
    whale: o.whale === undefined ? s.whale : o.whale,
    fakes: s.fakes,
    run: s.run,
    seed: o.seed,
    ...(o.proposals ? { proposals: o.proposals } : {}),
    ...(o.griefer ? { griefer: o.griefer } : {}),
    ...(o.sniper ? { sniper: o.sniper } : {}),
  };
}
