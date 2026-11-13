import type { AtBlock, Block } from "./at-block.ts";
import { isRecord } from "./json.ts";
import { record, six, text, u128, u128Value, ViewShapeError, whole } from "./view-fields.ts";

/**
 * supply-log: every mint and burn of $INTERN coins, rebuilt from the coin's feed (01 §10), and the total compared
 * with `ft_total_supply` now. Read-only; every page of the feed and every view is read at one block.
 *
 * What changes the supply, from the contract's code (crates/coin, read only):
 * - A round's opening turns the dollars waiting in BRAVE into coins, all at once (lib.rs `plan`): first any outside
 *   income joins the pool, then `minted = floor(waiting × supply / pool)` coins are created at the price of that
 *   moment (crates/rules/src/shares.rs `open_round_mint`). The very first conversion creates as many coins as
 *   dollars and locks 1,000 units for ever in the coin contract's own balance. `ft_total_supply` counts them from
 *   that moment. The feed's `round_opened` carries `brave_at_open` but no coin count, so the count is worked out
 *   here with that same rule, from the feed's own figures.
 * - `coins_minted` is not a change of supply: it is the moment one account's share of an opening is written to its
 *   balance, lazily, the next time that account does anything (01 §5). Each one is checked against what the rule
 *   gives that account (`convert`, rounded down; what is left over is dust that belongs to nobody).
 * - `cashed_out` from BRAVE with `coins` burns them (lib.rs `cash_out`); `dial_turned` to SAFE burns `amount` coins
 *   (safe.rs `turn_dial`). A payout that fails puts the coins back and logs neither event, so the two cancel.
 * - Dollars wait for the next opening: `paid_in` to BRAVE, `dial_turned` to BRAVE; `cashed_out` from BRAVE with
 *   `coins: null` takes waiting dollars back.
 * Nothing else in 01 §10 touches the coin's supply (tips, prizes, coach cuts and results move test dollars).
 */

/** 01 §10's event names: the same 45 as crates/coin/wire's `EventName` (1.7). */
export const EVENTS_01: readonly string[] = [
  "round_opened",
  "paid_in",
  "coins_minted",
  "cashed_out",
  "dial_turned",
  "locked",
  "unlocked",
  "skipped",
  "refused",
  "approved",
  "order_signed",
  "result_reported",
  "settled",
  "vote_opened",
  "vote_cast",
  "vote_finished",
  "rank_changed",
  "fired",
  "rehired",
  "outside_income",
  "playbook_submitted",
  "playbook_activated",
  "coach_paid",
  "tipped",
  "goal_filled",
  "hype_level",
  "sticker_claimed",
  "guessed",
  "guess_settled",
  "golden_dropped",
  "jackpot_grew",
  "jackpot_won",
  "draw_held",
  "prize_paid",
  "long_shot_allowed",
  // 1.6
  "league_closed",
  "review_written",
  "review_bar_filled",
  // 1.7
  "strikes_out",
  "brake_on",
  "brake_off",
  "term_lapsed",
  "term_renewed",
  "abandoned",
  "streak_banked",
];

/** crates/rules/src/shares.rs `LOCKED_FOREVER`: coin units locked at the first conversion (01 §9.1). */
export const LOCKED_FOREVER = 1_000n;
/** 01 §8 and crates/coin/src/feed.rs `FEED_KEEP`: the feed keeps the latest 1,000 events. */
export const FEED_KEEP = 1_000;
/** 01 §8: `limit` is capped at 100. */
const PAGE = 100;
const MAX_PAGES = FEED_KEEP / PAGE + 2;

export interface FeedItem {
  seq: number;
  at: number;
  event: string;
  data: Record<string, unknown>;
}

export interface SupplySnapshot {
  coin: string;
  rpc: string;
  block: Block;
  min_first_deposit: bigint;
  /** Every item the feed still keeps, oldest first. */
  feed: FeedItem[];
  ft_total_supply: bigint;
  pot: { coin_supply: bigint; pending: bigint; bosses: number };
  /** `get_round`: the round the views show now, a due opening included even before a transaction writes it. */
  round: { id: number; started_at: number; brave_at_open: bigint };
  /** `ft_balance_of(<the coin contract>)`: the units locked for ever (the contract refuses coins sent to itself). */
  own_balance: bigint;
}

function readItem(v: unknown, i: number): FeedItem {
  const p = `get_feed[${i}]`;
  const o = record(v, p);
  const data = o.data;
  if (!isRecord(data)) throw new ViewShapeError(`${p}.data: expected an object`);
  return { seq: whole(o, "seq", p), at: whole(o, "at", p), event: text(o, "event", p), data };
}

/** Every item the feed keeps, oldest first (01 §8: `after_seq` below the oldest kept item starts there). */
async function readFeed(at: AtBlock, coin: string): Promise<FeedItem[]> {
  const all: FeedItem[] = [];
  let after = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const v = await at.view(coin, "get_feed", { after_seq: after, limit: PAGE });
    if (!Array.isArray(v)) throw new ViewShapeError("get_feed: expected a list");
    const items = v.map((x, i) => readItem(x, all.length + i));
    for (const item of items) {
      if (item.seq <= after)
        throw new ViewShapeError(`get_feed: seq ${item.seq} after ${after} does not go up`);
      all.push(item);
      after = item.seq;
    }
    if (items.length < PAGE) return all;
  }
  throw new Error(`get_feed: more than ${MAX_PAGES} pages, more than the ${FEED_KEEP} items the feed keeps`);
}

export async function readSupply(at: AtBlock, coin: string): Promise<SupplySnapshot> {
  const c = record(await at.view(coin, "get_constants"), "get_constants");
  const network = text(c, "network", "get_constants");
  if (network !== "testnet")
    throw new Error(`get_constants().network is ${network}: supply-log reads testnet only`);
  const feed = await readFeed(at, coin);
  const pot = record(await at.view(coin, "get_pot"), "get_pot");
  const round = record(await at.view(coin, "get_round"), "get_round");
  return {
    coin,
    rpc: at.rpc,
    block: at.block,
    min_first_deposit: u128(c, "min_first_deposit", "get_constants"),
    feed,
    ft_total_supply: u128Value(await at.view(coin, "ft_total_supply"), "ft_total_supply"),
    pot: {
      coin_supply: u128(pot, "coin_supply", "get_pot"),
      pending: u128(record(pot.brave, "get_pot.brave"), "pending", "get_pot.brave"),
      bosses: whole(pot, "bosses", "get_pot"),
    },
    round: {
      id: whole(round, "id", "get_round"),
      started_at: whole(round, "started_at", "get_round"),
      brave_at_open: u128(round, "brave_at_open", "get_round"),
    },
    own_balance: u128Value(await at.view(coin, "ft_balance_of", { account_id: coin }), "ft_balance_of(coin)"),
  };
}

// ---------------------------------------------------------------- the rebuild (pure)

/**
 * MINT: coins created at a round's opening. BURN: coins burned. WRITE: an opening's coins written to one account
 * (no change of supply). WAIT: dollars waiting for the next opening. TAKEN BACK: waiting dollars taken back.
 */
export type Kind = "MINT" | "BURN" | "WRITE" | "WAIT" | "TAKEN BACK";

export interface EventRow {
  /** Null for an opening that is due but not yet written to the chain (no feed event yet). */
  seq: number | null;
  at: number;
  /** The round that was current: the last `round_opened` before it. Null before the first one kept. */
  round_id: number | null;
  event: string;
  kind: Kind;
  account_id: string | null;
  dollars_e6: string | null;
  /** Coins minted, burned or written; null when it cannot be worked out. */
  coins_e6: string | null;
  /** Signed change of the supply ("0" for WRITE and WAIT); null when unknown. */
  supply_change_e6: string | null;
  supply_after_e6: string | null;
  note: string;
}

export interface RoundRow {
  round_id: number;
  opened_at: number;
  /** The `round_opened` event; null when the opening is due and not yet written. */
  seq: number | null;
  brave_at_open_e6: string;
  /** Dollars that became coins at this opening; null when not known (the feed starts later). */
  converted_e6: string | null;
  minted_e6: string | null;
  locked_e6: string;
  /** The opening's price, dollars per coin (pool / supply of its rate); null without a conversion. */
  dollars_per_coin_e6: string | null;
  /** Coins of this opening written to accounts so far (`coins_minted` with this round_id). */
  written_e6: string;
  not_written_e6: string | null;
  dust_e6: string | null;
  /** Coins burned while this round was the current one. */
  burned_e6: string;
  supply_end_e6: string | null;
}

export interface NotWritten {
  round_id: number;
  account_id: string;
  dollars_e6: string;
  coins_e6: string;
}

export interface SupplyCheck {
  /** Null when it could not be made. */
  ok: boolean | null;
  rule: string;
  detail: string;
}

export interface SupplyReport {
  tool: "supply-log";
  coin: string;
  rpc: string;
  block: { height: number; hash: string; at: string; at_ms: number };
  feed: {
    first_seq: number | null;
    last_seq: number | null;
    items: number;
    keeps: number;
    /** True when the feed still starts at seq 1, so every event since the contract began is here. */
    complete: boolean;
    unknown_events: { event: string; seqs: number[] }[];
  };
  events: EventRow[];
  rounds: RoundRow[];
  totals: {
    minted_e6: string | null;
    locked_e6: string | null;
    written_e6: string;
    not_written_e6: string | null;
    dust_e6: string | null;
    burned_cash_out_e6: string;
    burned_dial_e6: string;
    rebuilt_e6: string | null;
    /** What NEP-141 `ft_mint` / `ft_burn` logs add up to: coins written to balances, locked units included. */
    written_balances_e6: string | null;
  };
  now: {
    ft_total_supply_e6: string;
    pot_coin_supply_e6: string;
    own_balance_e6: string;
    pending_e6: string;
    bosses: number;
    round_id: number;
  };
  difference_e6: string | null;
  checks: SupplyCheck[];
  not_written: NotWritten[];
  /** What the feed cannot account for. Empty when it accounts for every coin. */
  gaps: string[];
  /** Points for the contract's owner. */
  findings: string[];
  ok: boolean;
}

interface Conversion {
  round_id: number;
  dollars: bigint;
  minted: bigint;
  locked: bigint;
  pool: bigint;
  supply: bigint;
  /** Each account's waiting dollars and the coins the rule gives them. */
  by: Map<string, { dollars: bigint; coins: bigint }>;
}

/** floor(a × b / c), as crates/rules/src/math.rs `mul_div_floor` (u128 there; bigint here, never overflows). */
function mulDiv(a: bigint, b: bigint, c: bigint): bigint {
  return (a * b) / c;
}

const add = (m: Map<string, bigint>, k: string, v: bigint) => m.set(k, (m.get(k) ?? 0n) + v);
const str = (v: bigint | null): string | null => (v === null ? null : v.toString());

function nullableU128(o: Record<string, unknown>, k: string, path: string): bigint | null {
  return o[k] === null ? null : u128(o, k, path);
}

export function rebuild(s: SupplySnapshot): SupplyReport {
  const feed = s.feed;
  const first = feed[0]?.seq ?? null;
  const last = feed.at(-1)?.seq ?? null;
  // The contract numbers its events from 1 and drops the oldest past 1,000 (crates/coin/src/feed.rs).
  const complete = first === null || first === 1;
  let supply: bigint | null = complete ? 0n : null;
  let waiting: bigint | null = complete ? 0n : null;
  const waitingBy = new Map<string, bigint>();
  let current: number | null = null;
  const rows = new Map<number, RoundRow>();
  const conversions = new Map<number, Conversion>();
  const written = new Map<number, Map<string, bigint>>();
  const events: EventRow[] = [];
  const problems: string[] = [];
  const unknown = new Map<string, number[]>();
  let burnedCashOut = 0n;
  let burnedDial = 0n;
  let writtenTotal = 0n;
  let checkedWrites = 0;
  let writeProblems = 0;

  const row = (
    seq: number | null,
    at: number,
    event: string,
    kind: Kind,
    account: string | null,
    dollars: bigint | null,
    coins: bigint | null,
    change: bigint | null,
    note: string,
  ): void => {
    events.push({
      seq,
      at,
      round_id: current,
      event,
      kind,
      account_id: account,
      dollars_e6: str(dollars),
      coins_e6: str(coins),
      supply_change_e6: str(change),
      supply_after_e6: str(supply),
      note,
    });
  };

  const burn = (
    f: FeedItem,
    account: string,
    coins: bigint,
    paid: bigint | null,
    how: "cash-out" | "dial",
  ): void => {
    if (supply !== null) {
      if (coins > supply)
        problems.push(`seq ${f.seq}: ${six(coins)} coins burned, more than the ${six(supply)} rebuilt`);
      supply -= coins;
    }
    if (how === "cash-out") burnedCashOut += coins;
    else burnedDial += coins;
    const r = current === null ? undefined : rows.get(current);
    if (r) r.burned_e6 = (BigInt(r.burned_e6) + coins).toString();
    const note = how === "cash-out" ? `cashed out for $${six(paid ?? 0n)}` : "turned the dial to SAFE";
    row(f.seq, f.at, f.event, "BURN", account, paid, coins, -coins, note);
  };

  const wait = (f: FeedItem, account: string, dollars: bigint, how: string): void => {
    if (waiting !== null) {
      waiting += dollars;
      add(waitingBy, account, dollars);
    }
    row(
      f.seq,
      f.at,
      f.event,
      "WAIT",
      account,
      dollars,
      null,
      0n,
      `${how}; becomes coins at the next opening`,
    );
  };

  const takeBack = (f: FeedItem, account: string, dollars: bigint): void => {
    if (waiting !== null) {
      const had = waitingBy.get(account) ?? 0n;
      if (dollars > had)
        problems.push(
          `seq ${f.seq}: ${account} took back $${six(dollars)} but only $${six(had)} was waiting`,
        );
      waiting -= dollars;
      waitingBy.set(account, had - dollars);
    }
    row(f.seq, f.at, f.event, "TAKEN BACK", account, dollars, null, 0n, "waiting dollars paid back");
  };

  /** One opening: the rule of crates/rules/src/shares.rs `open_round_mint`, from the feed's own figures. */
  const open = (id: number, at: number, bao: bigint, seq: number | null): void => {
    const prev = current === null ? undefined : rows.get(current);
    if (prev) prev.supply_end_e6 = str(supply);
    current = id;
    const r: RoundRow = {
      round_id: id,
      opened_at: at,
      seq,
      brave_at_open_e6: bao.toString(),
      converted_e6: str(waiting),
      minted_e6: supply === null ? null : "0",
      locked_e6: "0",
      dollars_per_coin_e6: null,
      written_e6: "0",
      not_written_e6: supply === null ? null : "0",
      dust_e6: supply === null ? null : "0",
      burned_e6: "0",
      supply_end_e6: null,
    };
    rows.set(id, r);
    const event = seq === null ? "round_opened (due)" : "round_opened";
    const due =
      seq === null ? " The opening is due but not yet written to the chain: the views count it already." : "";
    if (supply === null || waiting === null || waiting === 0n) {
      if (supply === null) r.converted_e6 = null;
      return;
    }
    let minted: bigint;
    let locked = 0n;
    let pool: bigint;
    let rateSupply: bigint;
    if (supply === 0n) {
      // The first conversion ever: as many coins as dollars, 1,000 units of them locked for ever.
      if (waiting < s.min_first_deposit || waiting <= LOCKED_FOREVER) {
        r.converted_e6 = "0";
        row(
          seq,
          at,
          event,
          "MINT",
          null,
          waiting,
          0n,
          0n,
          `under min_first_deposit $${six(s.min_first_deposit)}: the money keeps waiting.${due}`,
        );
        return;
      }
      minted = waiting;
      locked = LOCKED_FOREVER;
      pool = waiting;
      rateSupply = waiting - LOCKED_FOREVER;
    } else {
      // brave_at_open is the pool after the opening: the pool before (outside income included) plus the dollars.
      // (When the rule keeps the money waiting instead, brave_at_open leaves it out. The two readings could both fit
      // only for a pay-in of about one coin unit; the comparison with ft_total_supply would show a wrong one.)
      pool = bao - waiting;
      if (pool <= 0n) {
        r.converted_e6 = "0";
        if (bao === 0n) {
          row(
            seq,
            at,
            event,
            "MINT",
            null,
            waiting,
            0n,
            0n,
            `the pool is empty, so the rule cannot price coins: the money keeps waiting.${due}`,
          );
        } else {
          problems.push(`round ${id}: brave_at_open $${six(bao)} is not above the $${six(waiting)} waiting`);
          row(
            seq,
            at,
            event,
            "MINT",
            null,
            waiting,
            null,
            null,
            "the feed's brave_at_open does not fit the dollars waiting",
          );
          supply = null;
        }
        return;
      }
      rateSupply = supply;
      minted = mulDiv(waiting, supply, pool);
      if (minted === 0n) {
        // Under one coin unit: the rule keeps the money waiting (brave_at_open is then the pool without it, which
        // gives no coin either).
        r.converted_e6 = "0";
        row(
          seq,
          at,
          event,
          "MINT",
          null,
          waiting,
          0n,
          0n,
          `under one coin unit at this price: the money keeps waiting.${due}`,
        );
        return;
      }
    }
    const by = new Map<string, { dollars: bigint; coins: bigint }>();
    let shared = 0n;
    for (const [account, dollars] of waitingBy) {
      if (dollars === 0n) continue;
      const coins = mulDiv(dollars, rateSupply, pool);
      by.set(account, { dollars, coins });
      shared += coins;
    }
    conversions.set(id, { round_id: id, dollars: waiting, minted, locked, pool, supply: rateSupply, by });
    r.converted_e6 = waiting.toString();
    r.minted_e6 = minted.toString();
    r.locked_e6 = locked.toString();
    r.dollars_per_coin_e6 = mulDiv(pool, 1_000_000n, rateSupply).toString();
    r.dust_e6 = (minted - locked - shared).toString();
    const dollars = waiting;
    supply += minted;
    waiting = 0n;
    waitingBy.clear();
    const price = `$${six(mulDiv(pool, 1_000_000n, rateSupply))} a coin`;
    const what =
      locked > 0n
        ? `: ${six(minted - locked)} for those who paid in (${price}) and ${six(locked)} locked for ever in the coin contract's own balance`
        : ` at ${price}`;
    row(
      seq,
      at,
      event,
      "MINT",
      null,
      dollars,
      minted,
      minted,
      `round ${id} opened: $${six(dollars)} became ${six(minted)} coins${what}.${due}`,
    );
  };

  for (const f of feed) {
    const d = f.data;
    const p = `get_feed seq ${f.seq} ${f.event}`;
    switch (f.event) {
      case "round_opened":
        open(whole(d, "round_id", p), f.at, u128(d, "brave_at_open", p), f.seq);
        break;
      case "paid_in":
        if (text(d, "pool", p) === "BRAVE")
          wait(f, text(d, "account_id", p), u128(d, "amount", p), "paid in to BRAVE");
        break;
      case "dial_turned": {
        const to = text(d, "to", p);
        const account = text(d, "account_id", p);
        if (to === "SAFE") burn(f, account, u128(d, "amount", p), null, "dial");
        else if (to === "BRAVE") wait(f, account, u128(d, "amount", p), "dollars from SAFE to BRAVE");
        else throw new ViewShapeError(`${p}.to: expected BRAVE or SAFE`);
        break;
      }
      case "cashed_out": {
        if (text(d, "pool", p) !== "BRAVE") break;
        const account = text(d, "account_id", p);
        const coins = nullableU128(d, "coins", p);
        const paid = u128(d, "paid", p);
        if (coins === null) takeBack(f, account, paid);
        else burn(f, account, coins, paid, "cash-out");
        break;
      }
      case "coins_minted": {
        const account = text(d, "account_id", p);
        const coins = u128(d, "coins", p);
        const rid = whole(d, "round_id", p);
        const mine = written.get(rid) ?? new Map<string, bigint>();
        written.set(rid, mine);
        const writeProblem = (what: string): void => {
          problems.push(what);
          writeProblems++;
        };
        if (mine.has(account))
          writeProblem(`seq ${f.seq}: ${account} was written a second time for round ${rid}`);
        add(mine, account, coins);
        writtenTotal += coins;
        const conv = conversions.get(rid);
        let note = `round ${rid}'s coins written to the account`;
        if (conv !== undefined) {
          checkedWrites++;
          const expected = conv.by.get(account)?.coins;
          if (expected === undefined)
            writeProblem(
              `seq ${f.seq}: ${account} got coins of round ${rid}, but had nothing waiting at its opening`,
            );
          else if (expected !== coins)
            writeProblem(
              `seq ${f.seq}: ${account} got ${six(coins)} coins of round ${rid}; the rule gives ${six(expected)}`,
            );
          else note += "; the rule gives the same";
        } else if (complete) {
          writeProblem(
            `seq ${f.seq}: coins_minted for round ${rid}, whose opening converted nothing in this feed`,
          );
        }
        const r = rows.get(rid);
        if (r) r.written_e6 = (BigInt(r.written_e6) + coins).toString();
        row(f.seq, f.at, f.event, "WRITE", account, null, coins, 0n, note);
        break;
      }
      default:
        if (!EVENTS_01.includes(f.event)) unknown.set(f.event, [...(unknown.get(f.event) ?? []), f.seq]);
    }
  }

  // The views count an opening that is due as soon as it is due; the feed shows it once a transaction writes it.
  if (current !== null && s.round.id === current + 1)
    open(s.round.id, s.round.started_at, s.round.brave_at_open, null);
  else if (current !== null && s.round.id !== current)
    problems.push(`get_round says round ${s.round.id}, the feed's last opening is round ${current}`);
  const lastRow = current === null ? undefined : rows.get(current);
  if (lastRow) lastRow.supply_end_e6 = str(supply);

  // Coins of each opening not yet written to their account, and the dust.
  const notWritten: NotWritten[] = [];
  for (const conv of conversions.values()) {
    const mine = written.get(conv.round_id) ?? new Map<string, bigint>();
    let missing = 0n;
    for (const [account, v] of conv.by) {
      if (v.coins === 0n || mine.has(account)) continue;
      notWritten.push({
        round_id: conv.round_id,
        account_id: account,
        dollars_e6: v.dollars.toString(),
        coins_e6: v.coins.toString(),
      });
      missing += v.coins;
    }
    const r = rows.get(conv.round_id);
    if (r) r.not_written_e6 = missing.toString();
  }
  const sum = (f: (c: Conversion) => bigint): bigint | null =>
    complete ? [...conversions.values()].reduce((a, c) => a + f(c), 0n) : null;
  const minted = sum((c) => c.minted);
  const locked = sum((c) => c.locked);
  const dust = complete ? [...rows.values()].reduce((a, r) => a + BigInt(r.dust_e6 ?? "0"), 0n) : null;
  const notWrittenTotal = complete ? notWritten.reduce((a, n) => a + BigInt(n.coins_e6), 0n) : null;
  const burned = burnedCashOut + burnedDial;

  const checks: SupplyCheck[] = [];
  const difference = supply === null ? null : s.ft_total_supply - supply;
  checks.push({
    ok: difference === null ? null : difference === 0n,
    rule: "the supply rebuilt from the feed = ft_total_supply now",
    detail:
      supply === null
        ? "not possible: the feed does not start at seq 1 (below)"
        : `rebuilt ${six(supply)}, ft_total_supply ${six(s.ft_total_supply)}`,
  });
  checks.push({
    ok: s.ft_total_supply === s.pot.coin_supply,
    rule: "ft_total_supply = get_pot.coin_supply",
    detail: `${six(s.ft_total_supply)} and ${six(s.pot.coin_supply)}`,
  });
  checks.push({
    ok: locked === null ? null : locked === s.own_balance,
    rule: "the units locked for ever at the first conversion = ft_balance_of(the coin contract)",
    detail: `rebuilt ${locked === null ? "unknown" : six(locked)}, the contract holds ${six(s.own_balance)}`,
  });
  checks.push({
    ok: waiting === null ? null : waiting === s.pot.pending,
    rule: "dollars still waiting for an opening, rebuilt = get_pot.brave.pending",
    detail: `rebuilt ${waiting === null ? "unknown" : six(waiting)}, get_pot ${six(s.pot.pending)}`,
  });
  const writes = events.filter((e) => e.kind === "WRITE").length;
  checks.push({
    // Writes of openings older than the kept feed cannot be checked: then "not made", unless one checked is wrong.
    ok: writeProblems > 0 ? false : writes > 0 && checkedWrites === 0 ? null : true,
    rule: "every coins_minted event gives its account what the rule gives it, once",
    detail: `${checkedWrites} of ${writes} checked against the rule, ${writeProblems} wrong`,
  });

  const gaps: string[] = [];
  if (!complete && first !== null) {
    const openings = [...rows.values()].filter((r) => r.seq !== null).length;
    gaps.push(
      `The feed keeps the latest ${FEED_KEEP} events (01 §8; crates/coin/src/feed.rs FEED_KEEP) and now starts at seq ${first}: ` +
        `events 1 to ${first - 1} are gone, with every pay-in, opening and burn among them. So the supply before seq ${first} ` +
        "and the dollars waiting then are not in the feed: the coins minted at the " +
        `${openings} opening(s) kept here cannot be worked out, and the total cannot be compared with ft_total_supply. ` +
        `What the kept events do show: ${six(burned)} coins burned (${six(burnedCashOut)} at cash-out, ` +
        `${six(burnedDial)} by the dial) and ${six(writtenTotal)} coins written to accounts.`,
    );
  }
  for (const [event, seqs] of unknown)
    gaps.push(
      `${seqs.length} event(s) "${event}" (seq ${seqs.slice(0, 10).join(", ")}${seqs.length > 10 ? ", …" : ""}): ` +
        "not an event 01 §10 lists, so what it does to the supply is unknown.",
    );
  for (const p of problems) gaps.push(`The feed disagrees with the rule: ${p}.`);
  if (difference !== null && difference < 0n)
    gaps.push(
      `ft_total_supply is ${six(s.ft_total_supply)}, the feed accounts for ${six(supply ?? 0n)}: ${six(-difference)} ` +
        "coins fewer exist than the feed shows. A cash-out or dial turn in flight at this block burns its coins " +
        "before the feed logs it (the event comes when the payment lands): run it again. If it stays, the feed does " +
        "not account for every coin.",
    );
  if (difference !== null && difference > 0n)
    gaps.push(
      `ft_total_supply is ${six(s.ft_total_supply)}, the feed accounts for ${six(supply ?? 0n)}: ${six(difference)} ` +
        "coins more exist than the feed shows: coins made with no event in the feed, or an opening's coins worked " +
        "out wrong here. The feed does not account for every coin.",
    );

  const findings: string[] = [];
  const noCount =
    "round_opened carries no coin count (01 §10: round_id, rank, status, brave_at_open), and the 1,000 units " +
    "locked at the first conversion have no event at all.";
  if (conversions.size > 0)
    findings.push(
      `${noCount} This log works each opening's coins out with the contract's rule (crates/rules/src/shares.rs ` +
        "open_round_mint) from the feed's figures; the comparison with ft_total_supply is what shows the rule and " +
        "the feed agree. A `minted` and `locked` field on round_opened would make the feed state it (an interface " +
        "change: the owner's).",
    );
  else if (!complete)
    findings.push(
      `${noCount} Once the feed drops its oldest events, the supply can no longer be rebuilt from it: a \`minted\` ` +
        "and a `supply_after` field on round_opened, or a view of the supply at each opening, would keep the log " +
        "whole (an interface change: the owner's).",
    );
  const writtenBalances = locked === null ? null : locked + writtenTotal - burned;
  if (notWrittenTotal !== null && notWrittenTotal > 0n && writtenBalances !== null) {
    const pct = s.ft_total_supply > 0n ? Number((notWrittenTotal * 10_000n) / s.ft_total_supply) / 100 : 0;
    const rounds = [...new Set(notWritten.map((n) => n.round_id))].join(", ");
    findings.push(
      `${six(notWrittenTotal)} coins (${pct}% of the supply) from the opening(s) of round ${rounds} are in ` +
        "ft_total_supply but have no coins_minted event yet: their owners have not acted since (01 §5, by design). " +
        "The contract emits the NEP-141 ft_mint log for them at that same later moment, so a tool that adds up " +
        `ft_mint and ft_burn logs sees ${six(writtenBalances)} today, not ft_total_supply (from the code: ` +
        "crates/coin/src/lib.rs materialize, tick and ft_total_supply; how any explorer counts is UNVERIFIED).",
    );
  }
  if (complete && last !== null) {
    const opened = [...rows.values()].filter((r) => r.seq !== null).length;
    const left = FEED_KEEP - last;
    const perRound = opened > 0 ? last / opened : null;
    findings.push(
      `The feed has used ${last} of its ${FEED_KEEP} places. ` +
        (perRound === null
          ? ""
          : `At the rate so far (${last} events in ${opened} rounds, about ${perRound.toFixed(1)} a round), ` +
            `seq 1 drops out after about ${Math.floor(left / perRound)} more rounds. `) +
        "After that this log can no longer be rebuilt from the feed alone: a view of the supply at each opening " +
        "(or the fields above plus a longer feed) would keep it whole.",
    );
  }

  const ok =
    complete &&
    unknown.size === 0 &&
    problems.length === 0 &&
    difference === 0n &&
    checks.every((c) => c.ok === true || c.ok === null);
  return {
    tool: "supply-log",
    coin: s.coin,
    rpc: s.rpc,
    block: {
      height: s.block.height,
      hash: s.block.hash,
      at: new Date(s.block.at_ms).toISOString(),
      at_ms: s.block.at_ms,
    },
    feed: {
      first_seq: first,
      last_seq: last,
      items: feed.length,
      keeps: FEED_KEEP,
      complete,
      unknown_events: [...unknown].map(([event, seqs]) => ({ event, seqs })),
    },
    events,
    rounds: [...rows.values()],
    totals: {
      minted_e6: str(minted),
      locked_e6: str(locked),
      written_e6: writtenTotal.toString(),
      not_written_e6: str(notWrittenTotal),
      dust_e6: str(dust),
      burned_cash_out_e6: burnedCashOut.toString(),
      burned_dial_e6: burnedDial.toString(),
      rebuilt_e6: str(supply),
      written_balances_e6: str(writtenBalances),
    },
    now: {
      ft_total_supply_e6: s.ft_total_supply.toString(),
      pot_coin_supply_e6: s.pot.coin_supply.toString(),
      own_balance_e6: s.own_balance.toString(),
      pending_e6: s.pot.pending.toString(),
      bosses: s.pot.bosses,
      round_id: s.round.id,
    },
    difference_e6: str(difference),
    checks,
    not_written: notWritten,
    gaps,
    findings,
    ok,
  };
}
