import type { RunConfig } from "./config.ts";

/**
 * The run's clock. Ticks fall on whole multiples of the interval in UTC (with 15 minutes: :00, :15, :30, :45),
 * shifted by the run's offset if it has one (7 gives :07, :22, :37, :52). A tick that was missed (the process was
 * down, or the previous tick ran long) is never run late: it is a gap, and the report lists it.
 */
export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;

export function intervalMs(cfg: Pick<RunConfig, "interval_minutes">): number {
  return cfg.interval_minutes * MINUTE_MS;
}

/** The latest tick time at or before `t`. */
export function floorTick(t: number, intervalMinutes: number, offsetMinutes = 0): number {
  const iv = intervalMinutes * MINUTE_MS;
  const off = offsetMinutes * MINUTE_MS;
  return Math.floor((t - off) / iv) * iv + off;
}

/** The earliest tick time at or after `t`. */
export function ceilTick(t: number, intervalMinutes: number, offsetMinutes = 0): number {
  const iv = intervalMinutes * MINUTE_MS;
  const off = offsetMinutes * MINUTE_MS;
  return Math.ceil((t - off) / iv) * iv + off;
}

/** "2026-11-12T00:15:00.000Z" -> "2026-11-12T0015Z". Sorts in time order. */
export function tickId(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}Z`;
}

const TICK_ID = /^(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})Z$/;

export function isTickId(id: string): boolean {
  return TICK_ID.test(id);
}

export function parseTickId(id: string): number {
  const m = TICK_ID.exec(id);
  if (!m) throw new Error(`not a tick id: ${id}`);
  return Date.parse(`${m[1]}T${m[2]}:${m[3]}:00.000Z`);
}

/**
 * What a tick does: "decide" while decisions are asked for (from the first tick, for `duration_hours`), then
 * "tail" (prices only, so the last paper positions can close), then "done".
 */
export type TickRole = "decide" | "tail" | "done";

export function tickRole(
  firstMs: number,
  t: number,
  cfg: Pick<RunConfig, "duration_hours" | "tail_hours">,
): TickRole {
  const decideEnd = firstMs + cfg.duration_hours * HOUR_MS;
  if (t < decideEnd) return "decide";
  if (t < decideEnd + cfg.tail_hours * HOUR_MS) return "tail";
  return "done";
}

/** The round id written into the rulebook: the number of whole intervals since 1970, unique per tick. */
export function roundIdFor(tickMs: number, intervalMinutes: number): number {
  return Math.floor(tickMs / (intervalMinutes * MINUTE_MS));
}

/** Every tick time from `first` up to but not including `end`. */
export function tickTimes(first: number, end: number, intervalMinutes: number): number[] {
  const out: number[] = [];
  const iv = intervalMinutes * MINUTE_MS;
  for (let t = first; t < end; t += iv) out.push(t);
  return out;
}
