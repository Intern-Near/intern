import {
  type Constants,
  type Position,
  type Round,
  readConstants,
  readOutbox,
  readPositions,
  readRound,
  type SignedAction,
} from "./contract.ts";
import {
  betOnExchange,
  type FillGroup,
  groupFills,
  matchFills,
  readSignedOrder,
  type SignedOrder,
} from "./fills-match.ts";
import {
  type Fill,
  type FundingPayment,
  fetchFills,
  fetchFunding,
  HL_TESTNET_INFO,
  type InfoRecord,
} from "./hl-exchange.ts";
import { isRecord } from "./json.ts";
import { formatScaled } from "./pricing.ts";
import { CLOCK_SLACK_MS, type ResultDetail, workOutReturned } from "./result.ts";

/**
 * fills-check: a read-only check of the results the runner reported. For the last N rounds of a coin contract it reads
 * what the contract recorded (01 §8: `get_round_by_id`, `get_positions`, `get_outbox`, `get_feed`), reads what
 * Hyperliquid testnet recorded for the contract's own address (POST /info `userFillsByTime` and `userFunding`), ties
 * each signed order to its fills (src/fills-match.ts, approximate), and works each bet's result out again with the
 * runner's own rule (src/result.ts). Nothing is signed or sent. The text form is src/fills-text.ts.
 */

export const STATUSES = [
  "OK",
  "MISMATCH",
  "NO FILLS",
  "UNMATCHED FILLS",
  "NOT REPORTED",
  "NOT CHECKED",
] as const;
export type Status = (typeof STATUSES)[number];

export const MATCHING_NOTE =
  "Matching is approximate until orders carry a client order id: a fill is tied to a signed order by coin, side, " +
  "size (at most the order's) and time (from the order's nonce to its expiry, 10 s slack).";
export const RULE = "returned = margin + trading result - fees + funding (runner/src/result.ts)";

/** 01 §8: `limit` is capped at 100. */
const PAGE = 100;
/** Most rounds one run reads (two views each). */
export const MAX_ROUNDS = 200;

/** Read-only access to the coin contract's views and to Hyperliquid testnet's /info. */
export interface Sources {
  contract: string;
  view: (method: string, args: Record<string, unknown>) => Promise<unknown>;
  fetchFn: typeof fetch;
  now: () => number;
  /** Receives every /info reply as it came (for --save). */
  keep?: (r: InfoRecord) => void;
}

/** 01 §8.1 `FeedItem`. */
export interface FeedItem {
  seq: number;
  at: number;
  event: string;
  data: Record<string, unknown>;
}

/** Everything one check reads. */
export interface Gathered {
  contract: string;
  checked_at: number;
  constants: Constants;
  current_round: number;
  /** The rounds found, oldest first. */
  rounds: Round[];
  /** Round ids `get_round_by_id` answered null for. */
  missing: number[];
  positions: Position[];
  /** Every signed action the contract still keeps, oldest first. */
  outbox: SignedAction[];
  feed: FeedItem[];
  fills: Fill[];
  funding: FundingPayment[];
  fills_from: number;
  fills_to: number;
}

// ---------------------------------------------------------------- reading

function readFeed(v: unknown): FeedItem[] {
  if (!Array.isArray(v)) throw new Error("get_feed: expected a list");
  return v.map((x: unknown, i: number): FeedItem => {
    if (
      !isRecord(x) ||
      typeof x.seq !== "number" ||
      typeof x.at !== "number" ||
      typeof x.event !== "string" ||
      !isRecord(x.data)
    ) {
      throw new Error(`get_feed[${i}]: expected {seq, at, event, data}`);
    }
    return { seq: x.seq, at: x.at, event: x.event, data: x.data };
  });
}

/** Every signed action still kept, oldest first (as `NearChain.outbox` reads it). */
async function readAllOutbox(src: Sources): Promise<SignedAction[]> {
  const all: SignedAction[] = [];
  for (let afterId: number | undefined; ; ) {
    const args: Record<string, unknown> = { limit: PAGE };
    if (afterId !== undefined) args.after_id = afterId;
    const page = readOutbox(await src.view("get_outbox", args));
    for (const a of page) {
      if (afterId !== undefined && a.id <= afterId) throw new Error("get_outbox: ids do not go up");
      all.push(a);
      afterId = a.id;
    }
    if (page.length < PAGE) return all;
  }
}

/** Every feed item still kept (01 §8: `after_seq` 0 starts at the oldest kept item), oldest first. */
async function readAllFeed(src: Sources): Promise<FeedItem[]> {
  const all: FeedItem[] = [];
  for (let after = 0; ; ) {
    const page = readFeed(await src.view("get_feed", { after_seq: after, limit: PAGE }));
    for (const item of page) {
      if (item.seq <= after) throw new Error("get_feed: seq does not go up");
      all.push(item);
      after = item.seq;
    }
    if (page.length < PAGE) return all;
  }
}

/** Reads the last `requested` rounds (the current one included) and Hyperliquid's records since the first began. */
export async function gather(src: Sources, requested: number): Promise<Gathered> {
  if (!Number.isInteger(requested) || requested < 1 || requested > MAX_ROUNDS)
    throw new Error(`rounds must be a whole number from 1 to ${MAX_ROUNDS}`);
  const constants = readConstants(await src.view("get_constants", {}));
  if (constants.network !== "testnet" || !constants.hl.testnet)
    throw new Error(
      "the contract is not on testnet with Hyperliquid testnet; fills-check reads testnet only",
    );
  const current = readRound(await src.view("get_round", {}));
  const rounds: Round[] = [];
  const missing: number[] = [];
  const positions: Position[] = [];
  // Round ids go up by one (crates/coin: the next round is the last id + 1), so the last N are these.
  for (let id = Math.max(1, current.id - requested + 1); id <= current.id; id++) {
    const r = await src.view("get_round_by_id", { round_id: id });
    if (r === null) {
      missing.push(id);
      continue;
    }
    rounds.push(readRound(r));
    positions.push(...readPositions(await src.view("get_positions", { round_id: id })));
  }
  // Hyperliquid first, the outbox after: an order is in the outbox before it can fill, so every fill read here has
  // its order in the outbox read next, even while a round is trading.
  const checkedAt = src.now();
  const user = constants.hl.address.toLowerCase();
  const from = (rounds[0]?.started_at ?? checkedAt) - CLOCK_SLACK_MS;
  const fills = await fetchFills(user, from, checkedAt, src.fetchFn, src.keep);
  const funding = await fetchFunding(user, from, checkedAt, src.fetchFn, src.keep);
  const outbox = await readAllOutbox(src);
  const feed = await readAllFeed(src);
  return {
    contract: src.contract,
    checked_at: checkedAt,
    constants,
    current_round: current.id,
    rounds,
    missing,
    positions,
    outbox,
    feed,
    fills,
    funding,
    fills_from: from,
    fills_to: checkedAt,
  };
}

// ---------------------------------------------------------------- the report

export interface OrderReport {
  action_id: number;
  kind: "OPEN" | "CLOSE";
  coin: string;
  side: "B" | "A";
  dir: string;
  sz: string;
  px: string;
  nonce: number;
  expires_after: number;
  /** The Hyperliquid order its fills belong to, or null when no fill was tied to it. */
  matched: { oid: number; fills: number; filled_sz: string; first_fill_at: number; tids: number[] } | null;
}

export interface Amounts {
  returned_e6: string;
  result_e6: string;
}

export interface Recomputed extends Partial<Amounts> {
  kind: "returned" | "waiting" | "needs-person";
  note: string;
  detail: Record<string, string | number[]> | null;
}

export interface BetReport {
  round_id: number;
  position_id: number;
  market: string;
  coin: string;
  side: "LONG" | "SHORT";
  margin_e6: string;
  leverage: number;
  position_status: string;
  /** Opening and closing orders signed; null when the contract no longer keeps them. */
  orders_signed: number | null;
  fills_matched: number;
  orders: OrderReport[];
  /** What `get_positions` says the runner reported; null before a result is reported. */
  reported: Amounts | null;
  /** The same from the feed's `result_reported` event, while the feed still keeps it. */
  feed_reported: (Amounts & { seq: number }) | null;
  recomputed: Recomputed | null;
  status: Status;
  reason: string;
}

export interface RoundReport {
  round_id: number;
  started_at: number;
  phase: string;
  settled: boolean;
  result_e6: string | null;
  bets: number;
  skipped: number;
  refused: number;
  unmatched_fill_groups: number;
}

export interface FillGroupReport {
  oid: number;
  coin: string;
  side: "B" | "A";
  dirs: string[];
  sz: string;
  first_fill_at: number;
  fills: number;
  tids: number[];
  /** The checked round it falls in, by time; null when before the first one. */
  round_id: number | null;
}

export interface Report {
  tool: "fills-check";
  checked_at: string;
  checked_at_ms: number;
  contract: string;
  rpc: string | null;
  hl: { info_url: string; address: string };
  result_source: string;
  rounds: { from: number; to: number; current: number; missing: number[] };
  matching: string;
  rule: string;
  sources: {
    outbox_actions: number;
    outbox_first_id: number | null;
    feed_items: number;
    feed_first_seq: number | null;
    fills: number;
    funding_records: number;
    fills_from: number;
    fills_to: number;
  };
  round_rows: RoundReport[];
  bets: BetReport[];
  /** Fills no signed order accounts for. */
  unmatched_fills: FillGroupReport[];
  /** Fills older than the oldest signed order the contract still keeps (it keeps the last 200): not checked. */
  older_fills: FillGroupReport[];
  summary: {
    rounds: number;
    rounds_without_bet: number;
    bets: number;
    by_status: Record<Status, number>;
    unmatched_fill_groups: number;
    older_fill_groups: number;
    /** No MISMATCH, no UNMATCHED FILLS, and no fill on the account that no signed order accounts for. */
    ok: boolean;
  };
}

/** Dollars from 6-decimal units, with all six decimals: "-0.028930". */
export function usd(e6: bigint): string {
  const neg = e6 < 0n;
  const a = neg ? -e6 : e6;
  return `${neg ? "-" : ""}${a / 1_000_000n}.${(a % 1_000_000n).toString().padStart(6, "0")}`;
}

// ---------------------------------------------------------------- judging

function plainDetail(d: ResultDetail): Record<string, string | number[]> {
  return {
    open_sz: formatScaled(BigInt(d.open_sz), 8),
    close_sz: formatScaled(BigInt(d.close_sz), 8),
    open_value_e6: d.open_value_e6.toString(),
    close_value_e6: d.close_value_e6.toString(),
    fees_e6: d.fees_e6.toString(),
    funding_e6: d.funding_e6.toString(),
    closed_pnl_e6: d.closed_pnl_e6.toString(),
    open_oids: d.open_oids,
    close_oids: d.close_oids,
  };
}

function reportedInFeed(feed: readonly FeedItem[]): Map<number, Amounts & { seq: number }> {
  const out = new Map<number, Amounts & { seq: number }>();
  for (const f of feed) {
    if (f.event !== "result_reported") continue;
    const d = f.data;
    if (typeof d.position_id !== "number" || typeof d.returned !== "string" || typeof d.result !== "string")
      throw new Error(`get_feed seq ${f.seq}: result_reported is not {position_id, returned, result, …}`);
    out.set(d.position_id, { returned_e6: d.returned, result_e6: d.result, seq: f.seq });
  }
  return out;
}

const groupLine = (g: FillGroup): string =>
  `oid ${g.oid}: ${g.dirs.join("/")} ${formatScaled(g.sz_e8, 8)} ${g.coin} at ${new Date(g.first).toISOString()}`;

interface Context {
  g: Gathered;
  nameOf: ReadonlyMap<string, string>;
  orders: readonly SignedOrder[];
  byAction: ReadonlyMap<number, FillGroup>;
  /** Groups no kept order accounts for, after the oldest kept order. */
  unmatched: readonly FillGroup[];
  feedReported: ReadonlyMap<number, Amounts & { seq: number }>;
}

function coinOf(ctx: Context, p: Position): string {
  const coin = ctx.nameOf.get(p.market);
  if (coin === undefined)
    throw new Error(`position ${p.id}: market ${p.market} is not in get_constants().markets`);
  return coin;
}

function orderReport(o: SignedOrder, m: FillGroup | undefined): OrderReport {
  return {
    action_id: o.action_id,
    kind: o.kind,
    coin: o.coin,
    side: o.fill_side,
    dir: o.dir,
    sz: o.sz,
    px: o.px,
    nonce: o.nonce,
    expires_after: o.expires_after,
    matched: m
      ? {
          oid: m.oid,
          fills: m.fills.length,
          filled_sz: formatScaled(m.sz_e8, 8),
          first_fill_at: m.first,
          tids: m.fills.map((f) => f.tid),
        }
      : null,
  };
}

/** The runner's rule for one bet. A bet whose opening order was never signed gets its margin back, fills unread. */
function recompute(p: Position, ctx: Context, coin: string): { returned: bigint | null; r: Recomputed } {
  const { g } = ctx;
  const margin = BigInt(p.margin);
  if (!g.outbox.some((a) => a.position_id === p.id && a.kind === "OPEN")) {
    const note = "no opening order was signed: the margin is reported back in full";
    return {
      returned: margin,
      r: { kind: "returned", returned_e6: p.margin, result_e6: "0", note, detail: null },
    };
  }
  const others = g.positions
    .filter((o) => o.round_id === p.round_id && o.id !== p.id)
    .map((o) => betOnExchange(o, g.outbox, coinOf(ctx, o)));
  const outcome = workOutReturned(betOnExchange(p, g.outbox, coin), g.fills, g.funding, others);
  if (outcome.kind === "returned") {
    const returned = outcome.returned_e6;
    return {
      returned,
      r: {
        kind: "returned",
        returned_e6: returned.toString(),
        result_e6: (returned - margin).toString(),
        note: outcome.note,
        detail: plainDetail(outcome.detail),
      },
    };
  }
  const detail = outcome.kind === "waiting" ? plainDetail(outcome.detail) : null;
  return { returned: null, r: { kind: outcome.kind, note: outcome.reason, detail } };
}

function judgeBet(p: Position, ctx: Context): BetReport {
  const { g } = ctx;
  const coin = coinOf(ctx, p);
  const mine = g.outbox.filter((a) => a.position_id === p.id);
  const myOrders = ctx.orders.filter((o) => o.position_id === p.id);
  const orders = myOrders.map((o) => orderReport(o, ctx.byAction.get(o.action_id)));
  const fillsMatched = orders.reduce((n, o) => n + (o.matched?.fills ?? 0), 0);
  const reported: Amounts | null =
    p.returned === null
      ? null
      : {
          returned_e6: p.returned,
          result_e6: p.result ?? (BigInt(p.returned) - BigInt(p.margin)).toString(),
        };
  const base = {
    round_id: p.round_id,
    position_id: p.id,
    market: p.market,
    coin,
    side: p.side,
    margin_e6: p.margin,
    leverage: p.leverage,
    position_status: p.status,
    orders_signed: myOrders.length,
    fills_matched: fillsMatched,
    orders,
    reported,
    feed_reported: ctx.feedReported.get(p.id) ?? null,
  };

  // The contract keeps only its last 200 signed actions (crates/coin/src/sign.rs, OUTBOX_KEEP); 01 §8 does not say
  // so. An older bet's orders cannot be read back, and nothing here guesses them.
  const gone =
    (p.open_signed_at !== null && !mine.some((a) => a.kind === "OPEN")) ||
    (p.close_signed_at !== null && !mine.some((a) => a.kind === "CLOSE"));
  if (gone) {
    const oldest = g.outbox[0]?.id ?? "none";
    return {
      ...base,
      orders_signed: null,
      recomputed: null,
      status: "NOT CHECKED",
      reason: `its signed orders are no longer in get_outbox (the contract keeps its last 200 signed actions; the oldest kept is ${oldest})`,
    };
  }

  const { returned, r: recomputed } = recompute(p, ctx, coin);
  const said =
    returned === null
      ? `the runner's rule says ${recomputed.kind}: ${recomputed.note}`
      : `the fills give ${usd(returned)} back`;
  const judged = (status: Status, reason: string): BetReport => ({ ...base, recomputed, status, reason });
  if (reported === null) return judged("NOT REPORTED", `no result yet; ${said}`);

  const feed = base.feed_reported;
  if (feed !== null && feed.returned_e6 !== reported.returned_e6)
    return judged(
      "MISMATCH",
      `get_positions says ${reported.returned_e6} came back, the feed's result_reported (seq ${feed.seq}) says ${feed.returned_e6}`,
    );
  // Fills on this coin, inside the time of this bet's orders, that no signed order accounts for.
  const inSpan = (u: FillGroup): boolean =>
    u.last >= Math.min(...myOrders.map((o) => o.nonce)) - CLOCK_SLACK_MS &&
    u.first <= Math.max(...myOrders.map((o) => o.expires_after)) + CLOCK_SLACK_MS;
  const strays = myOrders.length === 0 ? [] : ctx.unmatched.filter((u) => u.coin === coin && inSpan(u));
  if (strays.length > 0)
    return judged(
      "UNMATCHED FILLS",
      `fills inside this bet's order windows that match none of its signed orders: ${strays.map(groupLine).join("; ")}`,
    );
  const back = BigInt(reported.returned_e6);
  if (returned === null) return judged("MISMATCH", `${usd(back)} was reported, but ${said}`);
  if (returned !== back)
    return judged(
      "MISMATCH",
      `the fills give ${usd(returned)} back, the runner reported ${usd(back)} (off by ${usd(back - returned)})`,
    );
  if (fillsMatched === 0) return judged("NO FILLS", recomputed.note);
  return judged("OK", recomputed.note);
}

/** Works the check out from what `gather` read. Pure: no network. */
export function analyze(g: Gathered, rpc: string | null = null): Report {
  const coinByAsset = new Map(g.constants.markets.map((m) => [m.hl_asset, m.hl_name] as const));
  const nameOf = new Map<string, string>(g.constants.markets.map((m) => [m.market, m.hl_name] as const));
  // Every order the contract still keeps, of any round, so a fill of an older bet is not taken for a stray.
  const orders = g.outbox.filter((a) => a.kind !== "LEVERAGE").map((a) => readSignedOrder(a, coinByAsset));
  const { byAction, unmatched } = matchFills(orders, groupFills(g.fills));
  // When the contract has dropped old signed actions (ids no longer start at 1), fills older than the oldest order
  // it keeps cannot be tied to anything: they are set apart as not checked, not called unmatched.
  const oldest = g.outbox[0];
  const keptFrom = oldest !== undefined && oldest.id > 1 ? oldest.nonce - CLOCK_SLACK_MS : null;
  const isOlder = (u: FillGroup) => keptFrom !== null && u.last < keptFrom;
  const stray = unmatched.filter((u) => !isOlder(u));
  const ctx: Context = {
    g,
    nameOf,
    orders,
    byAction,
    unmatched: stray,
    feedReported: reportedInFeed(g.feed),
  };
  const bets = g.positions.map((p) => judgeBet(p, ctx));

  const roundAt = (t: number): number | null => {
    let id: number | null = null;
    for (const r of g.rounds) if (r.started_at <= t) id = r.id;
    return id;
  };
  const groupReport = (u: FillGroup): FillGroupReport => ({
    oid: u.oid,
    coin: u.coin,
    side: u.side,
    dirs: u.dirs,
    sz: formatScaled(u.sz_e8, 8),
    first_fill_at: u.first,
    fills: u.fills.length,
    tids: u.fills.map((f) => f.tid),
    round_id: roundAt(u.first),
  });
  const unmatchedFills = stray.map(groupReport);
  const olderFills = unmatched.filter(isOlder).map(groupReport);
  const roundRows: RoundReport[] = g.rounds.map((r) => ({
    round_id: r.id,
    started_at: r.started_at,
    phase: r.phase,
    settled: r.settled,
    result_e6: r.result,
    bets: g.positions.filter((p) => p.round_id === r.id).length,
    skipped: r.skipped,
    refused: r.refused,
    unmatched_fill_groups: unmatchedFills.filter((u) => u.round_id === r.id).length,
  }));
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
  for (const b of bets) byStatus[b.status]++;
  return {
    tool: "fills-check",
    checked_at: new Date(g.checked_at).toISOString(),
    checked_at_ms: g.checked_at,
    contract: g.contract,
    rpc,
    hl: { info_url: HL_TESTNET_INFO, address: g.constants.hl.address.toLowerCase() },
    result_source: g.constants.result_source,
    rounds: {
      from: g.rounds[0]?.id ?? g.current_round,
      to: g.current_round,
      current: g.current_round,
      missing: g.missing,
    },
    matching: MATCHING_NOTE,
    rule: RULE,
    sources: {
      outbox_actions: g.outbox.length,
      outbox_first_id: g.outbox[0]?.id ?? null,
      feed_items: g.feed.length,
      feed_first_seq: g.feed[0]?.seq ?? null,
      fills: g.fills.length,
      funding_records: g.funding.length,
      fills_from: g.fills_from,
      fills_to: g.fills_to,
    },
    round_rows: roundRows,
    bets,
    unmatched_fills: unmatchedFills,
    older_fills: olderFills,
    summary: {
      rounds: g.rounds.length,
      rounds_without_bet: roundRows.filter((r) => r.bets === 0).length,
      bets: bets.length,
      by_status: byStatus,
      unmatched_fill_groups: unmatchedFills.length,
      older_fill_groups: olderFills.length,
      ok: byStatus.MISMATCH === 0 && byStatus["UNMATCHED FILLS"] === 0 && unmatchedFills.length === 0,
    },
  };
}
