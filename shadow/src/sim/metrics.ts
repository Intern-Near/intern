import type { Arm } from "./engine.ts";
import type { Kind } from "./ledger.ts";
import type { MetricName } from "./scenarios.ts";
import type { DayPoint, Track, World } from "./world.ts";

/** One run's result, ready for JSON (dollars as numbers, rounded to cents only when printed). Pure. */

const dollars = (x: bigint): number => Number(x) / 1e6;

export interface Stat {
  start: number;
  min: number;
  max: number;
  end: number;
  max_drawdown_pct: number;
}

function stat(t: Track): Stat {
  return {
    start: dollars(t.start),
    min: dollars(t.min),
    max: dollars(t.max),
    end: dollars(t.end),
    max_drawdown_pct: t.max_dd_bps / 100,
  };
}

type ByKind = Record<Kind, number>;
const byKind = (): ByKind => ({ boss: 0, whale: 0, fake: 0 });

export interface RunResult {
  scenario: string;
  arm: Arm;
  seed: number;
  window_start: string;
  rounds: number;
  /** The coin price (dollars per coin), the BRAVE pool (dollars) and the coin supply (coins), round by round. */
  price: Stat;
  brave: Stat;
  supply: Stat;
  safe_end: number;
  bosses_end: number;
  bets: {
    asked: number;
    yes: number;
    skip: number;
    refused: Record<string, number>;
    refused_total: number;
    /** Of the refusals, those caused only by money that left between the opening and the proposal. */
    refused_money_left: number;
    /** Bets asked for at exactly the largest margin the Intern was told it may use. */
    asked_max: number;
    not_placeable: number;
    won: number;
    lost: number;
    liquidated: number;
    no_price: number;
  };
  coach_cut: number;
  /** The bets' net result (after trading costs, before the coach cut) and the tips' half credited to BRAVE. */
  bets_result: number;
  income: number;
  worst_round_loss_pct: number;
  worst_loss_vs_limit: number;
  approved_over_limit: number;
  cashouts: { count: number; paid: number; forfeited: number; max_price_drop_e6: string };
  rank: {
    changes: { round: number; from: string; to: string; by: string }[];
    final: string;
    rounds_in: Record<string, number>;
  };
  votes: {
    opened: Record<string, number>;
    passed: Record<string, number>;
    /** The votes that passed (failed ones are only counted: the whale opens one almost every round). */
    passed_list: {
      kind: string;
      opened_round: number;
      state: string;
      effective_round: number | null;
      voters: number;
      opener_share_pct: number;
    }[];
  };
  rewards: {
    interest: number;
    draw_paid: ByKind;
    jackpot_paid: ByKind;
    jackpot_in: number;
    jackpot_left: number;
    draw_pot_left: number;
    guesses: ByKind;
    goldens: ByKind;
    refused_full: ByKind;
    draws_held: number;
    jackpot_wins: number;
    fake_usd_share_pct: number;
  };
  invariant_failures: string[];
  metrics: Record<MetricName, number>;
  daily: DayPoint[];
}

export interface RunMeta {
  scenario: string;
  arm: Arm;
  seed: number;
  window_start: string;
  rounds: number;
}

const share = (part: number, whole: number): number => (whole === 0 ? 0 : (100 * part) / whole);

export function resultOf(w: World, meta: RunMeta): RunResult {
  const c = w.counters;
  const kindOf = (id: string): Kind => w.byId.get(id)?.kind ?? "boss";
  const sumBy = (book: Map<string, bigint | number>): ByKind => {
    const out = byKind();
    for (const [id, x] of book) out[kindOf(id)] += typeof x === "bigint" ? dollars(x) : x;
    return out;
  };
  const rw = w.rewards;
  const drawPaid = sumBy(rw.prizes.draw);
  const jackpotPaid = sumBy(rw.prizes.jackpot);
  const guesses = sumBy(rw.guesses);
  const goldens = byKind();
  for (const [id, p] of rw.players) goldens[kindOf(id)] += p.goldens;
  const refusedFull = byKind();
  for (const id of rw.refused_full) refusedFull[kindOf(id)] += 1;
  const opened: Record<string, number> = {};
  const passed: Record<string, number> = {};
  for (const v of w.votes) {
    opened[v.kind] = (opened[v.kind] ?? 0) + 1;
    if (v.state === "PASSED") passed[v.kind] = (passed[v.kind] ?? 0) + 1;
  }
  const refused: Record<string, number> = {};
  for (const [k, n] of Object.entries(c.verdicts)) {
    if (k !== "YES" && k !== "SKIP" && k !== "NOT_PLACEABLE") refused[k] = n;
  }
  const fakeShares = c.fake_usd_share_at_draws;
  const fakeUsdPct =
    fakeShares.length === 0 ? 0 : fakeShares.reduce((s, x) => s + x, 0) / fakeShares.length / 100;
  const drawTotal = drawPaid.boss + drawPaid.whale + drawPaid.fake;
  const jackpotTotal = jackpotPaid.boss + jackpotPaid.whale + jackpotPaid.fake;
  const guessTotal = guesses.boss + guesses.whale + guesses.fake;
  const jackpotIn = dollars(rw.jackpot_added + rw.jackpot_from_tips);
  const beyond = Math.max(0, drawTotal - dollars(rw.interest_total)) + Math.max(0, jackpotTotal - jackpotIn);
  const metrics: Record<MetricName, number> = {
    price_floor_pct:
      w.track.price.start === 0n ? 0 : (100 * Number(w.track.price.min)) / Number(w.track.price.start),
    worst_loss_vs_limit: c.worst_loss_vs_limit,
    approved_over_limit: c.approved_over_limit,
    cashout_price_drop_e6: Number(c.max_cashout_price_drop),
    rank_changes: c.rank_changes.length,
    tighten_passed: (passed.FIRE ?? 0) + (passed.DEMOTE ?? 0),
    fake_draw_excess_pts: drawTotal === 0 ? 0 : share(drawPaid.fake, drawTotal) - fakeUsdPct,
    honest_refused_full: refusedFull.boss + refusedFull.whale,
    fake_jackpot_excess_pts:
      jackpotTotal === 0 ? 0 : share(jackpotPaid.fake, jackpotTotal) - share(guesses.fake, guessTotal),
    prizes_beyond_sources_e6: Math.round(beyond * 1e6),
    book_failures: c.invariant_failures.length,
  };
  return {
    ...meta,
    price: stat(w.track.price),
    brave: stat(w.track.brave),
    supply: stat(w.track.supply),
    safe_end: dollars(w.pot.safe_total),
    bosses_end: w.accounts.filter((a) => a.coins > 0n).length,
    bets: {
      asked: c.asked,
      yes: c.verdicts.YES ?? 0,
      skip: c.verdicts.SKIP ?? 0,
      refused,
      refused_total: Object.values(refused).reduce((s, n) => s + n, 0),
      refused_money_left: c.refused_money_left,
      asked_max: c.asked_max,
      // Limits switched off: bets the program would have taken but Hyperliquid could not (under its $10 minimum).
      not_placeable: c.verdicts.NOT_PLACEABLE ?? 0,
      won: c.won,
      lost: c.lost,
      liquidated: c.liquidated,
      no_price: c.no_price,
    },
    coach_cut: dollars(c.coach_cut),
    bets_result: dollars(c.bets_result),
    income: dollars(c.income),
    worst_round_loss_pct: c.worst_loss_bps / 100,
    worst_loss_vs_limit: c.worst_loss_vs_limit,
    approved_over_limit: c.approved_over_limit,
    cashouts: {
      count: c.cashouts,
      paid: dollars(c.cashout_paid),
      forfeited: dollars(c.forfeited),
      max_price_drop_e6: String(c.max_cashout_price_drop),
    },
    rank: {
      changes: c.rank_changes,
      final: w.status === "FIRED" ? `FIRED (${w.rank})` : w.rank,
      rounds_in: c.rounds_in,
    },
    votes: {
      opened,
      passed,
      passed_list: w.votes
        .filter((v) => v.state === "PASSED")
        .map((v) => ({
          kind: v.kind,
          opened_round: v.opened_round,
          state: v.state,
          effective_round: v.effective_round,
          voters: v.voters.size,
          opener_share_pct: v.opener_share_bps / 100,
        })),
    },
    rewards: {
      interest: dollars(rw.interest_total),
      draw_paid: drawPaid,
      jackpot_paid: jackpotPaid,
      jackpot_in: jackpotIn,
      jackpot_left: dollars(rw.jackpot),
      draw_pot_left: dollars(rw.draw_pot),
      guesses,
      goldens,
      refused_full: refusedFull,
      draws_held: rw.draws.length,
      jackpot_wins: rw.jackpot_wins.length,
      fake_usd_share_pct: fakeUsdPct,
    },
    invariant_failures: c.invariant_failures,
    metrics,
    daily: w.daily,
  };
}
