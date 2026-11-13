import type { Position, SignedAction } from "./contract.ts";
import type { Fill } from "./hl-exchange.ts";
import { isRecord } from "./json.ts";
import { parseScaled } from "./pricing.ts";
import { type BetOnExchange, CLOCK_SLACK_MS } from "./result.ts";

/**
 * Ties the orders the contract signed to the fills Hyperliquid recorded, for fills-check (src/fills-check.ts).
 *
 * The match is approximate. An order the contract signs carries no client order id, so a fill is tied to an order by
 * what both show: the coin, the side and direction, the size (an order's fills add up to at most its size) and the
 * time (between the order's nonce, the time it was signed in ms, and its expiry, with the runner's 10 s of clock
 * slack). Hyperliquid's order id (`oid`) groups the fills of one order. With a client order id on each order the match
 * could be exact: live fill records carry a `cloid` field when the order had one (seen in
 * fixtures/hl/info/2026-11-11T173427Z/userFillsByTime-mainnet-sample.json).
 */

/** One order the contract signed (an OPEN or CLOSE action), as Hyperliquid will show its fills. */
export interface SignedOrder {
  action_id: number;
  position_id: number;
  kind: "OPEN" | "CLOSE";
  /** Hyperliquid's name of the market, from the action's asset index and `get_constants().markets`. */
  coin: string;
  /** The side Hyperliquid writes on this order's fills: "B" for a buy, "A" for a sell. */
  fill_side: "B" | "A";
  /** The `dir` Hyperliquid writes on this order's fills. */
  dir: string;
  sz_e8: bigint;
  sz: string;
  px: string;
  nonce: number;
  expires_after: number;
}

/**
 * Reads one signed order: `action` as `crates/hl-order` builds it, {"type":"order","orders":[{"a","b","p","s","r",
 * "t"}],"grouping":"na"} (01 §8.1: the exact JSON Hyperliquid expects). Throws on any other shape.
 */
export function readSignedOrder(a: SignedAction, coinOf: ReadonlyMap<number, string>): SignedOrder {
  if (a.kind === "LEVERAGE") throw new Error(`get_outbox action ${a.id} sets leverage; it is not an order`);
  const list = a.action.orders;
  const o: unknown = Array.isArray(list) && list.length === 1 ? list[0] : undefined;
  if (
    a.action.type !== "order" ||
    !isRecord(o) ||
    typeof o.a !== "number" ||
    typeof o.b !== "boolean" ||
    typeof o.p !== "string" ||
    typeof o.s !== "string" ||
    typeof o.r !== "boolean"
  ) {
    throw new Error(`get_outbox action ${a.id}: not one order in the shape hl-order builds`);
  }
  const coin = coinOf.get(o.a);
  if (coin === undefined)
    throw new Error(`get_outbox action ${a.id}: asset ${o.a} is not in get_constants().markets`);
  // 01 §9.3: the opening order is not reduce-only; the closing order is, on the other side.
  if (o.r !== (a.kind === "CLOSE"))
    throw new Error(`get_outbox action ${a.id}: ${a.kind} with reduce-only ${o.r}`);
  // Hyperliquid's directions, as in live fills: a buy opens a long or closes a short; a sell the other two.
  const dir = a.kind === "OPEN" ? (o.b ? "Open Long" : "Open Short") : o.b ? "Close Short" : "Close Long";
  return {
    action_id: a.id,
    position_id: a.position_id,
    kind: a.kind,
    coin,
    fill_side: o.b ? "B" : "A",
    dir,
    sz_e8: parseScaled(o.s, 8),
    sz: o.s,
    px: o.p,
    nonce: a.nonce,
    expires_after: a.expires_after,
  };
}

/** The fills of one Hyperliquid order (one `oid`). */
export interface FillGroup {
  oid: number;
  coin: string;
  side: "B" | "A";
  dirs: string[];
  sz_e8: bigint;
  first: number;
  last: number;
  fills: Fill[];
  /** True when its fills disagree on the coin or side: such a group is never matched. */
  mixed: boolean;
}

/** The fills grouped by Hyperliquid order, oldest first. */
export function groupFills(fills: readonly Fill[]): FillGroup[] {
  const byOid = new Map<number, FillGroup>();
  for (const f of fills) {
    const sz = parseScaled(f.sz, 8);
    const g = byOid.get(f.oid);
    if (g === undefined) {
      byOid.set(f.oid, {
        oid: f.oid,
        coin: f.coin,
        side: f.side,
        dirs: [f.dir],
        sz_e8: sz,
        first: f.time,
        last: f.time,
        fills: [f],
        mixed: false,
      });
      continue;
    }
    g.fills.push(f);
    g.sz_e8 += sz;
    g.first = Math.min(g.first, f.time);
    g.last = Math.max(g.last, f.time);
    if (!g.dirs.includes(f.dir)) g.dirs.push(f.dir);
    if (f.coin !== g.coin || f.side !== g.side) g.mixed = true;
  }
  return [...byOid.values()].sort((a, b) => a.first - b.first || a.oid - b.oid);
}

/**
 * Ties each group of fills to at most one signed order, and each order to at most one group (an immediate-or-cancel
 * order is one Hyperliquid order). A group fits an order with the same coin, side and direction, a total size no
 * larger than the order's, and every fill inside the order's window. Of the orders that fit, the one signed last
 * before the fills wins: the runner delivers each order as soon as it is signed, and an earlier immediate-or-cancel
 * order has filled or died by then.
 */
export function matchFills(
  orders: readonly SignedOrder[],
  groups: readonly FillGroup[],
): { byAction: Map<number, FillGroup>; unmatched: FillGroup[] } {
  const byAction = new Map<number, FillGroup>();
  const unmatched: FillGroup[] = [];
  for (const g of groups) {
    const fits = orders.filter(
      (o) =>
        !byAction.has(o.action_id) &&
        !g.mixed &&
        o.coin === g.coin &&
        o.fill_side === g.side &&
        g.dirs.length === 1 &&
        g.dirs[0] === o.dir &&
        g.sz_e8 <= o.sz_e8 &&
        g.first >= o.nonce - CLOCK_SLACK_MS &&
        g.last <= o.expires_after + CLOCK_SLACK_MS,
    );
    const best = fits.sort((a, b) => b.nonce - a.nonce)[0];
    if (best) byAction.set(best.action_id, g);
    else unmatched.push(g);
  }
  return { byAction, unmatched };
}

/** The bet as the runner's rule sees it: built like `Runner.#bet` in src/round.ts (the last OPEN, every CLOSE). */
export function betOnExchange(p: Position, outbox: readonly SignedAction[], coin: string): BetOnExchange {
  const mine = outbox.filter((a) => a.position_id === p.id);
  const win = (a: SignedAction) => ({ from: a.nonce, to: a.expires_after });
  const open = mine.filter((a) => a.kind === "OPEN").at(-1);
  return {
    position_id: p.id,
    coin,
    side: p.side,
    margin_e6: BigInt(p.margin),
    ordered_sz_e8: p.sz_e8 === null ? null : BigInt(p.sz_e8),
    open: open ? win(open) : null,
    close: mine.filter((a) => a.kind === "CLOSE").map(win),
  };
}
