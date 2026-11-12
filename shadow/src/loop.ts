import { existsSync } from "node:fs";
import { type RunConfig, readConfig } from "./config.ts";
import { ceilTick, HOUR_MS, intervalMs, parseTickId, type TickRole, tickId, tickRole } from "./schedule.ts";
import { listTickIds, tickDir } from "./store.ts";
import { runTick, type TickDeps, type TickSummary } from "./tick.ts";

export interface LoopDeps extends TickDeps {
  sleep: (ms: number) => Promise<void>;
  /** Replaceable for tests; the real one reads prices and asks the models. */
  runTick?: (
    runDir: string,
    cfg: RunConfig,
    tickMs: number,
    role: TickRole,
    deps: TickDeps,
  ) => Promise<TickSummary>;
}

/**
 * Runs the shadow run until it is done. Restart-safe: the first tick is the earliest tick folder on disk (or the
 * next tick time if there is none), and after a restart the loop waits for the next tick time. A tick that was
 * missed is never run late; the report lists it as a gap. Returns when decisions and the price tail are over.
 */
export async function runLoop(runDir: string, deps: LoopDeps): Promise<"finished"> {
  const cfg = readConfig(runDir);
  const iv = intervalMs(cfg);
  const existing = listTickIds(runDir);
  const [earliest] = existing;
  const firstMs =
    earliest === undefined
      ? ceilTick(deps.now(), cfg.interval_minutes, cfg.offset_minutes ?? 0)
      : parseTickId(earliest);
  const decideEnd = firstMs + cfg.duration_hours * HOUR_MS;
  deps.log({
    step: earliest === undefined ? "run start" : "run resume",
    first_tick: tickId(firstMs),
    decisions_until: new Date(decideEnd).toISOString(),
    prices_until: new Date(decideEnd + cfg.tail_hours * HOUR_MS).toISOString(),
    ticks_on_disk: existing.length,
  });
  const tick = deps.runTick ?? runTick;

  for (;;) {
    let next = ceilTick(deps.now(), cfg.interval_minutes, cfg.offset_minutes ?? 0);
    if (existsSync(tickDir(runDir, tickId(next)))) next += iv; // this tick already started before a restart
    const role = tickRole(firstMs, next, cfg);
    if (role === "done") {
      deps.log({ step: "run finished", last_tick: tickId(next - iv) });
      return "finished";
    }
    const wait = next - deps.now();
    if (wait > 0) await deps.sleep(wait);
    await tick(runDir, cfg, next, role, deps);
  }
}
