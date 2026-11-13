import { isRecord } from "../../../runner/src/json.ts";
import { MARKETS, type Market } from "../../../runner/src/markets.ts";
import { parseScaled } from "../../../runner/src/pricing.ts";
import { DAY_MS, PPM, type RoundClock } from "./rules01.ts";

/**
 * Real Hyperliquid prices for the simulation: 30-minute candles of the six markets of 01 §4, fetched once with the
 * read-only `POST https://api.hyperliquid.xyz/info {"type":"candleSnapshot"}` (src/sim/fetch.ts) and kept as a dated
 * fixture.
 *
 * From Hyperliquid's info-endpoint docs (read 2026-11-13): the request is
 * {"type":"candleSnapshot","req":{"coin","interval","startTime","endTime"}}; for perps `coin` is the name in `meta`
 * (kSHIB, kPEPE: runner/src/markets.ts); "30m" is a supported interval; only the most recent 5000 candles are
 * available. The docs show the fields t, T, s, i, o, c, h, l, v, n without defining them. Reading t as the open time
 * and o, h, l, c as open, high, low, close is UNVERIFIED in the docs; it fits the data, which parseCandles checks
 * (t on the 30-minute grid, low and high bounding open and close).
 *
 * Pure: no node: imports. The fixture is read from disk by src/sim/load.ts.
 */
export const CANDLE_INTERVAL = "30m";
export const CANDLE_MS = 1_800_000;

export interface Candle {
  /** Open time, Unix milliseconds. */
  t: number;
  /** Prices × 10^8, read exactly from Hyperliquid's decimal strings. */
  o: bigint;
  h: bigint;
  l: bigint;
  c: bigint;
}

/** The request body for one market's candles. */
export function candleRequest(coin: string, startTime: number, endTime: number): string {
  return JSON.stringify({
    type: "candleSnapshot",
    req: { coin, interval: CANDLE_INTERVAL, startTime, endTime },
  });
}

/** Reads one candleSnapshot reply for `coin`. Throws on any unexpected shape. Sorted by time, duplicates dropped. */
export function parseCandles(body: string, coin: string): Candle[] {
  const data: unknown = JSON.parse(body);
  if (!Array.isArray(data)) throw new Error(`candleSnapshot ${coin}: expected a list`);
  const byTime = new Map<number, Candle>();
  data.forEach((item: unknown, i) => {
    const where = `candleSnapshot ${coin}[${i}]`;
    if (!isRecord(item)) throw new Error(`${where}: not an object`);
    if (item.s !== coin) throw new Error(`${where}: coin ${String(item.s)}, expected ${coin}`);
    if (item.i !== CANDLE_INTERVAL) throw new Error(`${where}: interval ${String(item.i)}`);
    const t = item.t;
    if (typeof t !== "number" || !Number.isSafeInteger(t) || t % CANDLE_MS !== 0) {
      throw new Error(`${where}: open time is not on the 30-minute grid`);
    }
    const px = (key: "o" | "h" | "l" | "c"): bigint => {
      const v = item[key];
      if (typeof v !== "string") throw new Error(`${where}: ${key} is not a decimal string`);
      return parseScaled(v, 8);
    };
    const c: Candle = { t, o: px("o"), h: px("h"), l: px("l"), c: px("c") };
    if (c.l <= 0n || c.l > c.o || c.l > c.c || c.h < c.o || c.h < c.c) {
      throw new Error(`${where}: low and high do not bound open and close`);
    }
    byTime.set(t, c);
  });
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

/** All six markets' candles over the range every one of them covers, indexed by 30-minute step. */
export interface PriceBook {
  /** Open time of the first candle. */
  first_t: number;
  /** Candles per market, 30 minutes apart from `first_t`. */
  count: number;
  /** Null where a market has no candle (a gap in the data). */
  candles: Record<Market, (Candle | null)[]>;
}

/**
 * Builds the book from each market's candles, keeping only candles that had closed when they were fetched
 * (`completeBefore`), over the range all six markets cover.
 */
export function buildBook(byMarket: Record<Market, readonly Candle[]>, completeBefore: number): PriceBook {
  let first = Number.NEGATIVE_INFINITY;
  let last = Number.POSITIVE_INFINITY;
  const closed = {} as Record<Market, Candle[]>;
  for (const { market } of MARKETS) {
    const list = byMarket[market].filter((c) => c.t + CANDLE_MS <= completeBefore);
    const head = list[0];
    const tail = list[list.length - 1];
    if (head === undefined || tail === undefined) throw new Error(`no closed candles for ${market}`);
    first = Math.max(first, head.t);
    last = Math.min(last, tail.t);
    closed[market] = list;
  }
  if (last < first) throw new Error("the six markets' candles do not overlap");
  const count = (last - first) / CANDLE_MS + 1;
  const candles = {} as Record<Market, (Candle | null)[]>;
  for (const { market } of MARKETS) {
    const row: (Candle | null)[] = new Array(count).fill(null);
    for (const c of closed[market]) if (c.t >= first && c.t <= last) row[(c.t - first) / CANDLE_MS] = c;
    candles[market] = row;
  }
  return { first_t: first, count, candles };
}

/** A bet's price path over its hold, relative to the entry price, in millionths: the exit, the low and the high. */
export interface Move {
  exit_ppm: number;
  low_ppm: number;
  high_ppm: number;
}

/**
 * The move of `market` over [fromMs, toMs): entry at the open of the candle holding `fromMs`, exit at the close of the
 * candle holding the last moment before `toMs`, and the lowest low and highest high in between. Null over a gap.
 *
 * With 24-hour rounds that is exactly 12:00 to 22:00 UTC, the proposal window's start to closing time (01 §5). With
 * 30-minute rounds the demo's hold (minute 15 to minute 25) lies inside one candle, so the bet is held for that whole
 * candle: three times longer than the demo holds it, so the swings are larger than the demo's would be. A stand-in,
 * on the cautious side.
 */
export function moveOver(book: PriceBook, market: Market, fromMs: number, toMs: number): Move | null {
  const i0 = Math.floor((fromMs - book.first_t) / CANDLE_MS);
  const i1 = Math.floor((toMs - 1 - book.first_t) / CANDLE_MS);
  if (i0 < 0 || i1 >= book.count || i1 < i0) return null;
  const row = book.candles[market];
  const entry = row[i0];
  const exit = row[i1];
  if (!entry || !exit) return null;
  let low = entry.l;
  let high = entry.h;
  for (let i = i0; i <= i1; i++) {
    const c = row[i];
    if (!c) return null;
    if (c.l < low) low = c.l;
    if (c.h > high) high = c.h;
  }
  const ppm = (x: bigint): number => Number((x * BigInt(PPM)) / entry.o);
  return { exit_ppm: ppm(exit.c), low_ppm: ppm(low), high_ppm: ppm(high) };
}

/** For each round of a simulated window and each market, the move a bet placed that round would see. */
export interface MoveTable {
  /** When round 1 starts. */
  start_ms: number;
  round_ms: number;
  rounds: number;
  moves: Record<Market, (Move | null)[]>;
}

export function moveTable(book: PriceBook, clock: RoundClock, startMs: number, rounds: number): MoveTable {
  const moves = {} as Record<Market, (Move | null)[]>;
  for (const { market } of MARKETS) {
    const row: (Move | null)[] = [];
    for (let k = 0; k < rounds; k++) {
      const roundStart = startMs + k * clock.round_ms;
      row.push(moveOver(book, market, roundStart + clock.propose_from_ms, roundStart + clock.close_from_ms));
    }
    moves[market] = row;
  }
  return { start_ms: startMs, round_ms: clock.round_ms, rounds, moves };
}

/**
 * Every UTC midnight at which a window of `rounds` rounds fits inside the book: each round's hold, from its
 * proposal window to its closing time, has candles. Windows start at midnight so that day d is a calendar day for
 * both round lengths.
 */
export function windowStarts(book: PriceBook, clock: RoundClock, rounds: number): number[] {
  const endT = book.first_t + book.count * CANDLE_MS;
  const lowest = Math.ceil((book.first_t - clock.propose_from_ms) / DAY_MS) * DAY_MS;
  const out: number[] = [];
  for (let s = lowest; s + (rounds - 1) * clock.round_ms + clock.close_from_ms <= endT; s += DAY_MS)
    out.push(s);
  return out;
}
