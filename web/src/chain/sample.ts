/**
 * Sample data source. Made-up values in the exact shapes of 01-SHARED-INTERFACE.md.
 * Nothing here talks to a network. Each scene is a starting state plus, for some scenes,
 * a short script of events that "arrive" a few seconds later, so the live path
 * (poll the feed, react to a new item) is exercised without a contract.
 */
import type {
  Account,
  Actions,
  Claimable,
  GoalFill,
  Goals,
  Launch,
  LaunchInfo,
  OwnedToken,
  Quote,
  Chain,
  Constants,
  EventData,
  EventName,
  FeedItem,
  Limits,
  Ms,
  Playbook,
  Position,
  Pot,
  RankName,
  RankState,
  Refusal,
  Round,
  Rulebook,
  Scene,
  SignedAction,
  StickerFirst,
  Vote,
  VoteKind,
} from "./types";
import { REFUSAL_CODES } from "./types";

const H = 3_600_000;
const MIN = 60_000;
const DAY = 24 * H;

const RANKS: Limits[] = [
  { rank: "INTERN", per_bet_bps: 200, max_bets: 1, per_round_bps: 200, sides: ["LONG"], max_leverage: 1, markets: ["DOGE", "SHIB", "PEPE", "PENGU"] },
  { rank: "ANALYST", per_bet_bps: 500, max_bets: 2, per_round_bps: 800, sides: ["LONG"], max_leverage: 1, markets: ["DOGE", "SHIB", "PEPE", "PENGU", "WIF", "TRUMP"] },
  { rank: "TRADER", per_bet_bps: 1000, max_bets: 3, per_round_bps: 2000, sides: ["LONG", "SHORT"], max_leverage: 2, markets: ["DOGE", "SHIB", "PEPE", "PENGU", "WIF", "TRUMP"] },
];

const ROUND = {
  round_ms: DAY,
  guess_close_ms: 11 * H + 55 * MIN,
  propose_from_ms: 12 * H,
  propose_until_ms: 13 * H,
  close_from_ms: 22 * H,
  tail_fade_ms: 10 * MIN,
};

/** How far into the round each scene starts. */
const OFFSET: Record<Scene, number> = {
  QUIET: 8 * H + 47 * MIN + 16_000,
  REFUSED: 12 * H + 20_000,
  APPROVED: 12 * H + 20_000,
  HOLDING: 15 * H,
  SETTLED_WIN: 22 * H + 40 * MIN,
  SETTLED_LOSS: 22 * H + 40 * MIN,
  VOTE_OPEN: 8 * H + 47 * MIN + 16_000,
  PROMOTED: 8 * H + 47 * MIN + 16_000,
  FIRED: 13 * H + 5 * MIN,
  STUCK: 24 * H + 35 * MIN,
};

/** A signed-in person's own money and coins, in the sample world. */
type Wallet = { dollars: bigint; registered: boolean; coin: bigint; locked: bigint; lockedRound: number; pending: bigint; safe: bigint; joined: number | null; voted: Set<number> };

/** The pretend account a visitor gets when they sign in on sample data. It arrives already a boss. */
export const SAMPLE_ACCOUNT = "you.testnet";

type World = {
  playbooks: Playbook[];
  activePlaybook: number | null;
  goals: Goals;
  fills: GoalFill[];
  tippers: Set<string>;
  claimable: Map<string, Claimable>;
  owned: Map<string, OwnedToken[]>;
  launches: Launch[];
  launchHeld: Map<string, bigint>;
  wallets: Map<string, Wallet>;
  constants: Constants;
  rank: RankState;
  round: Round;
  previous: Round;
  positions: Position[];
  pot: Pot;
  refusals: Refusal[];
  votes: Vote[];
  firsts: StickerFirst[];
  feed: FeedItem[];
};

type Scripted = { [E in EventName]: { at: Ms; event: E; data: EventData[E] } }[EventName];

function item<E extends EventName>(seq: number, at: Ms, event: E, data: EventData[E]): FeedItem {
  return { seq, at, event, data } as FeedItem;
}

function build(scene: Scene, t0: Ms): { world: World; script: Scripted[] } {
  const start = t0 - OFFSET[scene];
  const yStart = start - DAY;
  const fired = scene === "FIRED";
  const promoted = scene === "PROMOTED";
  const rankName: RankName = promoted ? "ANALYST" : "INTERN";

  const constants: Constants = {
    interface_version: "1.3",
    network: "testnet",
    usdc_token: "usdc.sample.testnet",
    coin_decimals: 6,
    ranks: RANKS,
    markets: [
      { market: "DOGE", hl_name: "DOGE", hl_asset: 173, sz_decimals: 0 },
      { market: "SHIB", hl_name: "kSHIB", hl_asset: 29, sz_decimals: 0 },
      { market: "PEPE", hl_name: "kPEPE", hl_asset: 12, sz_decimals: 0 },
      { market: "PENGU", hl_name: "PENGU", hl_asset: 139, sz_decimals: 0 },
      { market: "WIF", hl_name: "WIF", hl_asset: 78, sz_decimals: 0 },
      { market: "TRUMP", hl_name: "TRUMP", hl_asset: 150, sz_decimals: 1 },
    ],
    min_notional: "11000000",
    round: { genesis_ms: start - 41 * DAY, ...ROUND },
    vote: { promote_pass_bps: 5000, promote_quorum_bps: 2000, tighten_pass_bps: 3400, vote_ms: DAY, weight_full_rounds: 7 },
    model: { id: "sample-model", signing_algo: "ecdsa", signer: "0x0000000000000000000000000000000000000000" },
    funding: { mode: "RECORDED", quote_signer: "sample", quote_max_age_ms: 60_000, max_funding_cost_bps: 400 },
    result_source: "REPORTED",
    lending: { mode: "STANDIN" },
    hl: { testnet: true, address: "0x0000000000000000000000000000000000000000", signer_contract: "v1.signer-prod.testnet", path: "hl-1", order_expiry_ms: 120_000 },
    runner: "runner.sample.testnet",
    min_first_deposit: "10000000",
    refusal_codes: [...REFUSAL_CODES],
    coach_cut_bps: 1000,
    goals: { boss_ladder: [10, 25, 50, 100, 250, 500, 1000], tip_jar_target: "100000000", min_tip: "1000000", hype_window_ms: 300_000, hype_levels: [3, 6, 10, 15, 25] },
    stickers: "stickers.sample.testnet",
    launchpad: "launch.sample.testnet",
  };

  const mkRound = (id: number, s: Ms, rank: RankName): Round => ({
    id,
    phase: "OPEN",
    settled: false,
    stuck: false,
    started_at: s,
    guess_closes_at: s + ROUND.guess_close_ms,
    propose_from: s + ROUND.propose_from_ms,
    propose_until: s + ROUND.propose_until_ms,
    close_from: s + ROUND.close_from_ms,
    ends_at: s + ROUND.round_ms,
    rank,
    status: "EMPLOYED",
    brave_at_open: "1000000000",
    bets_used: 0,
    at_risk: "0",
    skipped: 0,
    refused: 0,
    result: null,
  });

  const previous: Round = { ...mkRound(41, yStart, "INTERN"), phase: "CLOSE", settled: true, bets_used: 1, refused: 1, result: "3100000", brave_at_open: "996900000" };
  const round = mkRound(42, start, rankName);

  const rank: RankState = { rank: rankName, status: fired ? "FIRED" : "EMPLOYED", since_round: promoted ? 42 : 1, pending: null };

  const pot: Pot = {
    brave: { total: "1000000000", lent: "980000000", in_play: "0", idle: "20000000", pending: "50000000", interest: "1840000", income_waiting: "12000000" },
    safe: { total: "400000000", lent: "400000000", idle: "0" },
    coin_supply: "996000000",
    coin_price_e6: "1004016",
    bosses: 23,
    outside_income_total: "37000000",
  };

  // (1.3) An original goes to the visitor whose message led to the first credited refusal of its kind
  const credited: Record<string, [string, number, boolean]> = { OVER_TRADE_LIMIT: ["carol.testnet", 9, true], NOT_ON_LIST: [SAMPLE_ACCOUNT, 14, false], OVER_LEVERAGE: ["erin.testnet", 37, false] };
  const firsts: StickerFirst[] = REFUSAL_CODES.map((code) => ({
    code,
    account_id: credited[code]?.[0] ?? null,
    round_id: credited[code]?.[1] ?? null,
    claimed: credited[code]?.[2] ?? false,
  }));

  let seq = 880;
  const feed: FeedItem[] = [];
  const push = <E extends EventName>(at: Ms, event: E, data: EventData[E]) => feed.push(item(++seq, at, event, data));

  // Yesterday (round 41)
  push(yStart, "round_opened", { round_id: 41, rank: "INTERN", status: "EMPLOYED", brave_at_open: "996900000" });
  push(yStart + 9 * H + 14 * MIN, "paid_in", { account_id: "carol.testnet", pool: "SAFE", amount: "100000000", pending: false });
  push(yStart + 12 * H + 20_000, "refused", { refusal_id: 30, round_id: 41, code: "NOT_ON_LIST", asked: null, limit: null, is_first: false });
  push(yStart + 12 * H + 2 * MIN, "approved", { position_id: 6, round_id: 41, market: "PENGU", side: "LONG", margin: "19900000", leverage: 1 });
  push(yStart + 12 * H + 2 * MIN + 21_000, "order_signed", { action_id: 16, position_id: 6, kind: "OPEN" });
  push(yStart + 22 * H + 1 * MIN, "order_signed", { action_id: 17, position_id: 6, kind: "CLOSE" });
  push(yStart + 22 * H + 3 * MIN, "result_reported", { position_id: 6, returned: "23000000", result: "3100000", result_source: "REPORTED" });
  push(yStart + 22 * H + 4 * MIN, "settled", { round_id: 41, result: "3100000", brave_after: "1000000000" });

  // Today (round 42)
  push(start, "round_opened", { round_id: 42, rank: rankName, status: "EMPLOYED", brave_at_open: "1000000000" });
  push(start + 2 * H + 31 * MIN, "paid_in", { account_id: "dave.testnet", pool: "BRAVE", amount: "50000000", pending: true });

  const refusals: Refusal[] = [
    { id: 30, round_id: 41, code: "NOT_ON_LIST", at: yStart + 12 * H + 20_000, asked: null, limit: null, decision: { action: "BET", market: "WIF", side: "LONG", margin: "19900000", leverage: 1 }, is_first: false, credited_to: null },
  ];
  // Older refusals, so each earned sticker has a history behind it
  const past: [number, number, Refusal["code"], string | null, string | null, Refusal["decision"], boolean][] = [
    [29, 39, "OVER_TRADE_LIMIT", "120000000", "19900000", { action: "BET", market: "DOGE", side: "LONG", margin: "120000000", leverage: 1 }, false],
    [28, 37, "OVER_LEVERAGE", "3", "1", { action: "BET", market: "SHIB", side: "LONG", margin: "19000000", leverage: 3 }, true],
    [26, 30, "SHORT_NOT_UNLOCKED", null, null, { action: "BET", market: "DOGE", side: "SHORT", margin: "18000000", leverage: 1 }, true],
    [22, 21, "MALFORMED_DECISION", null, null, null, true],
    [17, 14, "NOT_ON_LIST", null, null, { action: "BET", market: "TRUMP", side: "LONG", margin: "15000000", leverage: 1 }, true],
    [12, 9, "OVER_TRADE_LIMIT", "300000000", "19200000", { action: "BET", market: "PEPE", side: "LONG", margin: "300000000", leverage: 1 }, true],
  ];
  for (const [id, round_id, code, asked, limit, decision, is_first] of past) {
    refusals.push({ id, round_id, code, at: start - (42 - round_id) * DAY + 12 * H + 20_000, asked, limit, decision, is_first, credited_to: is_first ? (credited[code]?.[0] ?? null) : null });
  }

  const positions: Position[] = [];
  const votes: Vote[] = [];
  const script: Scripted[] = [];

  const bigAsk: EventData["refused"] = { refusal_id: 31, round_id: 42, code: "OVER_TRADE_LIMIT", asked: "450000000", limit: "20000000", is_first: false };
  const goodBet: EventData["approved"] = { position_id: 7, round_id: 42, market: "DOGE", side: "LONG", margin: "20000000", leverage: 1 };
  const betAt = start + 12 * H + 60_000;

  const withBet = (status: Position["status"]) => {
    push(start + 12 * H + 20_000, "refused", bigAsk);
    refusals.unshift(refusalFrom(bigAsk, start + 12 * H + 20_000));
    push(betAt, "approved", goodBet);
    push(betAt + 9_000, "order_signed", { action_id: 18, position_id: 7, kind: "LEVERAGE" });
    push(betAt + 21_000, "order_signed", { action_id: 19, position_id: 7, kind: "OPEN" });
    positions.push({ ...positionFrom(goodBet, betAt), status, open_signed_at: betAt + 21_000, sz_e8: "29300000000" });
    round.bets_used = 1;
    round.at_risk = "20000000";
    round.refused = 1;
    pot.brave.in_play = "20000000";
    pot.brave.lent = "980000000";
    pot.brave.idle = "0";
  };

  switch (scene) {
    case "QUIET":
      break;
    case "REFUSED":
      script.push({ at: t0 + 4_000, event: "refused", data: bigAsk });
      // A second try, too small this time: the first ZERO_MARGIN ever, so a new sticker is earned
      script.push({ at: t0 + 19_000, event: "refused", data: { refusal_id: 32, round_id: 42, code: "ZERO_MARGIN", asked: "5000000", limit: "11000000", is_first: true } });
      break;
    case "APPROVED":
      script.push({ at: t0 + 4_000, event: "approved", data: goodBet });
      script.push({ at: t0 + 13_000, event: "order_signed", data: { action_id: 18, position_id: 7, kind: "LEVERAGE" } });
      script.push({ at: t0 + 22_000, event: "order_signed", data: { action_id: 19, position_id: 7, kind: "OPEN" } });
      break;
    case "HOLDING":
      withBet("OPEN_SIGNED");
      break;
    case "SETTLED_WIN":
    case "SETTLED_LOSS": {
      const result = scene === "SETTLED_WIN" ? "420000" : "-1100000";
      const returned = (20_000_000 + Number(result)).toString();
      withBet("SETTLED");
      const p = positions[0]!;
      p.close_signed_at = start + 22 * H + 60_000;
      p.settled_at = start + 22 * H + 4 * MIN;
      p.returned = returned;
      p.result = result;
      p.result_source = "REPORTED";
      push(start + 22 * H + 60_000, "order_signed", { action_id: 20, position_id: 7, kind: "CLOSE" });
      push(start + 22 * H + 3 * MIN, "result_reported", { position_id: 7, returned, result, result_source: "REPORTED" });
      const after = (1_000_000_000 + Number(result)).toString();
      push(start + 22 * H + 4 * MIN, "settled", { round_id: 42, result, brave_after: after });
      round.settled = true;
      round.result = result;
      pot.brave = { ...pot.brave, total: after, lent: after, in_play: "0", idle: "0" };
      break;
    }
    case "VOTE_OPEN": {
      const opened = start + 3 * H;
      votes.push({ id: 3, kind: "PROMOTE", playbook_id: null, opened_by: "alice.testnet", opened_at: opened, closes_at: opened + DAY, yes: "186000000", no: "114000000", locked_weight_at_open: "520000000", state: "OPEN", effective_round: null });
      push(opened, "vote_opened", { vote_id: 3, kind: "PROMOTE", playbook_id: null, opened_by: "alice.testnet", closes_at: opened + DAY });
      push(opened + 12 * MIN, "vote_cast", { vote_id: 3, account_id: "alice.testnet", support: true, weight: "120000000" });
      push(opened + 58 * MIN, "vote_cast", { vote_id: 3, account_id: "bob.testnet", support: false, weight: "114000000" });
      push(opened + 3 * H, "vote_cast", { vote_id: 3, account_id: "erin.testnet", support: true, weight: "66000000" });
      break;
    }
    case "PROMOTED": {
      votes.push({ id: 2, kind: "PROMOTE", playbook_id: null, opened_by: "alice.testnet", opened_at: start - 3 * DAY, closes_at: start - 2 * DAY, yes: "310000000", no: "95000000", locked_weight_at_open: "500000000", state: "PASSED", effective_round: 42 });
      feed.splice(feed.length - 1, 0, item(0, start + 1, "rank_changed", { from: "INTERN", to: "ANALYST", effective_round: 42 }));
      break;
    }
    case "FIRED": {
      push(start + 12 * H + 20_000, "refused", bigAsk);
      refusals.unshift(refusalFrom(bigAsk, start + 12 * H + 20_000));
      round.refused = 1;
      votes.push({ id: 4, kind: "FIRE", playbook_id: null, opened_by: "bob.testnet", opened_at: start + 12 * H + 5 * MIN, closes_at: start + 36 * H + 5 * MIN, yes: "200000000", no: "20000000", locked_weight_at_open: "520000000", state: "PASSED", effective_round: 42 });
      push(start + 12 * H + 5 * MIN, "vote_opened", { vote_id: 4, kind: "FIRE", playbook_id: null, opened_by: "bob.testnet", closes_at: start + 36 * H + 5 * MIN });
      push(start + 12 * H + 58 * MIN, "vote_finished", { vote_id: 4, state: "PASSED", effective_round: 42 });
      push(start + 12 * H + 58 * MIN + 1, "fired", { round_id: 42 });
      break;
    }
    case "STUCK":
      withBet("CLOSE_SIGNED");
      positions[0]!.close_signed_at = start + 22 * H + 60_000;
      push(start + 22 * H + 60_000, "order_signed", { action_id: 20, position_id: 7, kind: "CLOSE" });
      break;
  }

  // Renumber so seq only goes up, in time order
  feed.sort((a, b) => a.at - b.at);
  feed.forEach((f, i) => (f.seq = 881 + i));

  const wallets = new Map<string, Wallet>([
    [SAMPLE_ACCOUNT, { dollars: 250_000_000n, registered: true, coin: 100_000_000n, locked: 60_000_000n, lockedRound: 30, pending: 0n, safe: 50_000_000n, joined: 30, voted: new Set() }],
  ]);
  const playbooks: Playbook[] = [
    { id: 2, text: "Only bet when a coin has moved less than 3% in the last day. Sit out when unsure.", authors: [{ account_id: "erin.testnet", share_bps: 10000 }], submitted_round: 39, active_from: null, paid_total: "0" },
    { id: 1, text: "Prefer PENGU and DOGE. Skip a round rather than chase a loss.", authors: [{ account_id: "alice.testnet", share_bps: 7000 }, { account_id: "bob.testnet", share_bps: 3000 }], submitted_round: 30, active_from: 34, paid_total: "460000" },
  ];
  const goals: Goals = { boss: { level: 1, target: 25, now: 23 }, tip_jar: { jar: 2, target: "100000000", now: "64000000" }, hype: { train: 3, level: 0, points: 0, ends_at: null } };
  const fills: GoalFill[] = [
    { id: 2, goal: "TIP_JAR", level: 1, at: start - 2 * DAY, round_id: 40 },
    { id: 1, goal: "BOSS", level: 1, at: start - 9 * DAY, round_id: 33 },
  ];
  const claimable = new Map<string, Claimable>([[SAMPLE_ACCOUNT, { badge: true, originals: ["NOT_ON_LIST"], goal_fills: [2] }]]);
  const launches: Launch[] = [
    { id: 2, name: "Tin Token", symbol: "TIN", creator: "dave.testnet", created_at: start - 5 * H, sold: "41000000000000", usdc_reserve: "42700000", price_e6: "1" },
    { id: 1, name: "Stamp Coin", symbol: "STAMP", creator: "alice.testnet", created_at: start - 3 * DAY, sold: "214000000000000", usdc_reserve: "272300000", price_e6: "2" },
  ];
  return { world: { playbooks, activePlaybook: 1, goals, fills, tippers: new Set(), claimable, owned: new Map(), launches, launchHeld: new Map(), wallets, constants, rank, round, previous, positions, pot, refusals, votes, firsts, feed }, script };
}

/** Made-up earlier shifts, so the Intern's record has something in it. */
const PAST: Record<number, { market: Position["market"]; result: string } | "SKIP" | "NONE"> = {
  36: { market: "DOGE", result: "1200000" },
  37: "NONE",
  38: { market: "PEPE", result: "-800000" },
  39: { market: "SHIB", result: "300000" },
  40: "SKIP",
  41: { market: "PENGU", result: "3100000" },
};

function pastRound(w: World, id: number): Round | null {
  const p = PAST[id];
  if (p === undefined) return null;
  const s = w.round.started_at - (w.round.id - id) * DAY;
  const bet = typeof p === "object";
  return {
    ...w.previous,
    id,
    started_at: s,
    guess_closes_at: s + ROUND.guess_close_ms,
    propose_from: s + ROUND.propose_from_ms,
    propose_until: s + ROUND.propose_until_ms,
    close_from: s + ROUND.close_from_ms,
    ends_at: s + ROUND.round_ms,
    bets_used: bet ? 1 : 0,
    at_risk: bet ? "19900000" : "0",
    skipped: p === "SKIP" ? 1 : 0,
    refused: w.refusals.filter((r) => r.round_id === id).length,
    result: bet ? p.result : "0",
  };
}

function pastPositions(w: World, id: number): Position[] {
  const p = PAST[id];
  const r = pastRound(w, id);
  if (typeof p !== "object" || !r) return [];
  return [
    {
      id: id - 35, round_id: id, market: p.market, side: "LONG", margin: "19900000", leverage: 1, notional: "19900000", status: "SETTLED",
      approved_at: r.propose_from + 120_000, open_signed_at: r.propose_from + 141_000, close_signed_at: r.close_from + 60_000, settled_at: r.close_from + 240_000,
      sz_e8: "29300000000", returned: (19_900_000 + Number(p.result)).toString(), result: p.result, result_source: "REPORTED",
    },
  ];
}

function refusalFrom(d: EventData["refused"], at: Ms): Refusal {
  return {
    id: d.refusal_id,
    round_id: d.round_id,
    code: d.code,
    at,
    asked: d.asked,
    limit: d.limit,
    decision:
      d.code === "OVER_TRADE_LIMIT" || d.code === "ZERO_MARGIN"
        ? { action: "BET", market: "PEPE", side: "LONG", margin: d.asked ?? "0", leverage: 1 }
        : null,
    is_first: d.is_first,
    credited_to: null,
  };
}

function positionFrom(d: EventData["approved"], at: Ms): Position {
  return {
    id: d.position_id,
    round_id: d.round_id,
    market: d.market,
    side: d.side,
    margin: d.margin,
    leverage: d.leverage,
    notional: (BigInt(d.margin) * BigInt(d.leverage)).toString(),
    status: "APPROVED",
    approved_at: at,
    open_signed_at: null,
    close_signed_at: null,
    settled_at: null,
    sz_e8: null,
    returned: null,
    result: null,
    result_source: null,
  };
}

/** What an arriving event changes in the views. Only the events the scripts use. */
function apply(w: World, s: Scripted): void {
  if (s.event === "refused") {
    w.refusals.unshift(refusalFrom(s.data, s.at));
    w.round.refused += 1;

  } else if (s.event === "approved") {
    w.positions.push(positionFrom(s.data, s.at));
    w.round.bets_used += 1;
    w.round.at_risk = (BigInt(w.round.at_risk) + BigInt(s.data.margin)).toString();
    w.pot.brave.in_play = (BigInt(w.pot.brave.in_play) + BigInt(s.data.margin)).toString();
    w.pot.brave.idle = (BigInt(w.pot.brave.idle) - BigInt(s.data.margin)).toString();
  } else if (s.event === "order_signed" && s.data.kind === "OPEN") {
    const p = w.positions.find((x) => x.id === s.data.position_id);
    if (p) {
      p.status = "OPEN_SIGNED";
      p.open_signed_at = s.at;
      p.sz_e8 = "29300000000";
    }
  }
  const last = w.feed[w.feed.length - 1];
  w.feed.push({ seq: (last?.seq ?? 0) + 1, at: s.at, event: s.event, data: s.data } as FeedItem);
}

function livePhase(r: Round, now: Ms): Round {
  const phase = now >= r.close_from ? "CLOSE" : now >= r.propose_until ? "HOLD" : now >= r.propose_from ? "PROPOSE" : "OPEN";
  return { ...r, phase, stuck: !r.settled && now > r.ends_at };
}

const page = <T,>(list: T[], limit = 50) => list.slice(0, Math.min(limit, 100));

/** A Chain that answers from memory. `clock` is injectable so tests can move time. */
const LAUNCH_SUPPLY = 1_000_000_000_000_000n;
const VIRTUAL_USDC = 1_000_000_000n;

/** The launchpad's price curve: constant product with a virtual 1,000 dollars. A 1% fee on every trade. */
function quote(l: Launch, side: "BUY" | "SELL", amount: bigint): Quote {
  const usdc = VIRTUAL_USDC + BigInt(l.usdc_reserve);
  const left = LAUNCH_SUPPLY - BigInt(l.sold);
  if (side === "BUY") {
    const fee = amount / 100n;
    const inn = amount - fee;
    return { out: ((left * inn) / (usdc + inn)).toString(), fee: fee.toString() };
  }
  const gross = (usdc * amount) / (left + amount);
  const fee = gross / 100n;
  return { out: (gross - fee).toString(), fee: fee.toString() };
}

/** Locked coins count more the longer they have been locked, up to the full weight. */
function weightOf(w: World, a: Wallet): bigint {
  const full = BigInt(w.constants.vote.weight_full_rounds);
  const rounds = BigInt(Math.max(0, w.round.id - a.lockedRound));
  return (a.locked * (rounds < full ? rounds : full)) / full;
}

const usdText = (v: bigint) => `$${(Number(v) / 1e6).toFixed(2)}`;

/**
 * What a signed-in person can do, on sample data. It follows the interface's rules closely
 * enough to try every screen; it is not the program, and nothing leaves the browser.
 */
function sampleActions(w: World, clock: () => Ms, who: string): Actions {
  const me = () => {
    let a = w.wallets.get(who);
    if (!a) {
      a = { dollars: 0n, registered: false, coin: 0n, locked: 0n, lockedRound: w.round.id, pending: 0n, safe: 0n, joined: null, voted: new Set() };
      w.wallets.set(who, a);
    }
    return a;
  };
  const say = <E extends EventName>(event: E, data: EventData[E]) => {
    const last = w.feed[w.feed.length - 1];
    w.feed.push({ seq: (last?.seq ?? 0) + 1, at: clock(), event, data } as FeedItem);
  };
  const need = (ok: boolean, why: string) => {
    if (!ok) throw new Error(why);
  };
  const pause = () => new Promise<void>((r) => setTimeout(r, 450));
  const price = () => BigInt(w.pot.coin_price_e6);
  const add = (v: string, d: bigint) => (BigInt(v) + d).toString();

  return {
    async getDollars() {
      return me().dollars.toString();
    },
    async getTestDollars(amount) {
      await pause();
      me().dollars += BigInt(amount);
    },
    async register() {
      await pause();
      me().registered = true;
    },
    async payIn(pool, amount) {
      await pause();
      const a = me();
      const v = BigInt(amount);
      need(a.registered, "Register first. It is a one-time step.");
      need(v > 0n, "Enter an amount above zero.");
      need(v <= a.dollars, `You only have ${usdText(a.dollars)} in your wallet.`);
      a.dollars -= v;
      if (pool === "SAFE") {
        a.safe += v;
        w.pot.safe.total = add(w.pot.safe.total, v);
        w.pot.safe.lent = add(w.pot.safe.lent, v);
      } else {
        a.pending += v;
        w.pot.brave.pending = add(w.pot.brave.pending, v);
      }
      say("paid_in", { account_id: who, pool, amount, pending: pool === "BRAVE" });
    },
    async cashOut(pool, amount, pending) {
      await pause();
      const a = me();
      const v = BigInt(amount);
      need(v > 0n, "Enter an amount above zero.");
      if (pool === "BRAVE" && pending) {
        need(v <= a.pending, `Only ${usdText(a.pending)} of yours is still waiting.`);
        a.pending -= v;
        a.dollars += v;
        w.pot.brave.pending = add(w.pot.brave.pending, -v);
        say("cashed_out", { account_id: who, pool, coins: null, paid: amount });
      } else if (pool === "BRAVE") {
        need(v <= a.coin - a.locked, "Locked coins can't be cashed out. Unlock them first.");
        const paid = (v * price()) / 1_000_000n;
        a.coin -= v;
        a.dollars += paid;
        w.pot.brave.total = add(w.pot.brave.total, -paid);
        w.pot.brave.lent = add(w.pot.brave.lent, -paid);
        w.pot.coin_supply = add(w.pot.coin_supply, -v);
        say("cashed_out", { account_id: who, pool, coins: amount, paid: paid.toString() });
      } else {
        need(v <= a.safe, `You only have ${usdText(a.safe)} in SAFE.`);
        a.safe -= v;
        a.dollars += v;
        w.pot.safe.total = add(w.pot.safe.total, -v);
        w.pot.safe.lent = add(w.pot.safe.lent, -v);
        say("cashed_out", { account_id: who, pool, coins: null, paid: amount });
      }
    },
    async turnDial(to, amount) {
      await pause();
      const a = me();
      const v = BigInt(amount);
      need(v > 0n, "Move the dial first.");
      if (to === "SAFE") {
        need(v <= a.coin - a.locked, "Locked coins can't move to SAFE. Unlock them first.");
        const paid = (v * price()) / 1_000_000n;
        a.coin -= v;
        a.safe += paid;
        w.pot.brave.total = add(w.pot.brave.total, -paid);
        w.pot.brave.lent = add(w.pot.brave.lent, -paid);
        w.pot.coin_supply = add(w.pot.coin_supply, -v);
        w.pot.safe.total = add(w.pot.safe.total, paid);
        w.pot.safe.lent = add(w.pot.safe.lent, paid);
      } else {
        need(v <= a.safe, `You only have ${usdText(a.safe)} in SAFE.`);
        a.safe -= v;
        a.pending += v;
        w.pot.safe.total = add(w.pot.safe.total, -v);
        w.pot.safe.lent = add(w.pot.safe.lent, -v);
        w.pot.brave.pending = add(w.pot.brave.pending, v);
      }
      say("dial_turned", { account_id: who, to, amount });
    },
    async lock(amount) {
      await pause();
      const a = me();
      const v = BigInt(amount);
      need(v > 0n, "Enter an amount above zero.");
      need(v <= a.coin - a.locked, "You don't have that many unlocked coins.");
      // Newly locked coins start counting from this shift, so they pull the average age down
      a.lockedRound = a.locked === 0n ? w.round.id : a.lockedRound;
      a.locked += v;
      say("locked", { account_id: who, amount });
    },
    async unlock(amount) {
      await pause();
      const a = me();
      const v = BigInt(amount);
      need(v > 0n && v <= a.locked, "You don't have that many locked coins.");
      need(!w.votes.some((x) => x.state === "OPEN" && a.voted.has(x.id)), "You voted in a vote that is still open. Coins stay locked until it closes.");
      a.locked -= v;
      say("unlocked", { account_id: who, amount });
    },
    async openVote(kind: VoteKind, playbookId?: number) {
      await pause();
      const a = me();
      const fired = w.rank.status === "FIRED";
      need(a.locked > 0n, "Lock some coins first. Only locked coins can open a vote.");
      need(!w.votes.some((x) => x.state === "OPEN" && x.kind === kind), "A vote of that kind is already open.");
      if (kind !== "SET_PLAYBOOK") need(kind === "REHIRE" ? fired : !fired, fired ? "The Intern is fired. The only vote now is to rehire." : "Rehire is only for a fired Intern.");
      if (kind === "SET_PLAYBOOK") need(playbookId === 0 || w.playbooks.some((x) => x.id === playbookId), "No playbook with that number.");
      need(!(kind === "PROMOTE" && w.rank.rank === "TRADER"), "Trader is the top rank.");
      need(!(kind === "DEMOTE" && w.rank.rank === "INTERN"), "Intern is the bottom rank.");
      const id = Math.max(0, ...w.votes.map((x) => x.id)) + 1;
      const now = clock();
      w.votes.push({ id, kind, playbook_id: kind === "SET_PLAYBOOK" ? (playbookId ?? 0) : null, opened_by: who, opened_at: now, closes_at: now + w.constants.vote.vote_ms, yes: "0", no: "0", locked_weight_at_open: "150000000", state: "OPEN", effective_round: null });
      say("vote_opened", { vote_id: id, kind, playbook_id: kind === "SET_PLAYBOOK" ? (playbookId ?? 0) : null, opened_by: who, closes_at: now + w.constants.vote.vote_ms });
    },
    async cast(voteId, support) {
      await pause();
      const a = me();
      const v = w.votes.find((x) => x.id === voteId);
      need(!!v && v.state === "OPEN", "That vote is closed.");
      need(!a.voted.has(voteId), "You have already voted in this one.");
      const weight = weightOf(w, a);
      need(weight > 0n, "Your locked coins have no weight yet. Weight grows over seven shifts.");
      a.voted.add(voteId);
      if (support) v!.yes = add(v!.yes, weight);
      else v!.no = add(v!.no, weight);
      say("vote_cast", { vote_id: voteId, account_id: who, support, weight: weight.toString() });
    },
    async finishVote(voteId) {
      await pause();
      const v = w.votes.find((x) => x.id === voteId);
      need(!!v && v.state === "OPEN", "That vote is already finished.");
      const c = w.constants.vote;
      const yes = BigInt(v!.yes);
      const cast = yes + BigInt(v!.no);
      const open = BigInt(v!.locked_weight_at_open);
      const tighten = v!.kind === "DEMOTE" || v!.kind === "FIRE";
      const early = tighten && yes * 10_000n >= open * BigInt(c.tighten_pass_bps);
      need(early || clock() >= v!.closes_at, "This vote is still open.");
      const passed = tighten
        ? early
        : cast > 0n && yes * 10_000n > cast * BigInt(c.promote_pass_bps) && cast * 10_000n >= open * BigInt(c.promote_quorum_bps);
      v!.state = passed ? "PASSED" : "FAILED";
      v!.effective_round = passed ? (tighten ? w.round.id : w.round.id + 2) : null;
      say("vote_finished", { vote_id: voteId, state: v!.state, effective_round: v!.effective_round });
      if (!passed) return;
      const order = ["INTERN", "ANALYST", "TRADER"] as const;
      const at = order.indexOf(w.rank.rank);
      if (v!.kind === "FIRE") {
        w.rank = { ...w.rank, status: "FIRED", pending: null };
        say("fired", { round_id: w.round.id });
      } else if (v!.kind === "DEMOTE") {
        const to = order[Math.max(0, at - 1)]!;
        say("rank_changed", { from: w.rank.rank, to, effective_round: w.round.id });
        w.rank = { ...w.rank, rank: to, since_round: w.round.id, pending: null };
      } else if (v!.kind === "PROMOTE") {
        w.rank.pending = { rank: order[Math.min(2, at + 1)]!, status: "EMPLOYED", effective_round: w.round.id + 2 };
      } else if (v!.kind === "REHIRE") {
        w.rank.pending = { rank: "INTERN", status: "EMPLOYED", effective_round: w.round.id + 2 };
        say("rehired", { effective_round: w.round.id + 2 });
      } else if (v!.kind === "SET_PLAYBOOK") {
        say("playbook_activated", { playbook_id: v!.playbook_id ?? 0, effective_round: w.round.id + 2 });
      }
    },
    async submitPlaybook(text) {
      await pause();
      const bytes = new TextEncoder().encode(text.trim()).length;
      need(bytes >= 1 && bytes <= 2000, "A playbook is 1 to 2,000 bytes long.");
      const id = Math.max(0, ...w.playbooks.map((x) => x.id)) + 1;
      const authors = [{ account_id: who, share_bps: 10000 }];
      w.playbooks.unshift({ id, text: text.trim().replace(/\s+/g, " "), authors, submitted_round: w.round.id, active_from: null, paid_total: "0" });
      say("playbook_submitted", { playbook_id: id, authors, submitted_round: w.round.id });
    },
    async tip(amount) {
      await pause();
      const a = me();
      const v = BigInt(amount);
      need(v >= BigInt(w.constants.goals.min_tip), "The smallest tip is $1.");
      need(v <= a.dollars, `You only have ${usdText(a.dollars)} in your wallet.`);
      need(w.rank.status !== "FIRED", "Tips are refused while the Intern is fired.");
      a.dollars -= v;
      w.pot.brave.income_waiting = add(w.pot.brave.income_waiting, v);
      w.pot.outside_income_total = add(w.pot.outside_income_total, v);
      w.tippers.add(who);
      say("tipped", { account_id: who, amount });
      // The jar fills at its target; what spills over starts the next jar
      const target = BigInt(w.goals.tip_jar.target);
      let now = BigInt(w.goals.tip_jar.now) + v;
      while (now >= target) {
        now -= target;
        const fill: GoalFill = { id: Math.max(0, ...w.fills.map((f) => f.id)) + 1, goal: "TIP_JAR", level: 1, at: clock(), round_id: w.round.id };
        w.fills.unshift(fill);
        for (const t of w.tippers) {
          const c = w.claimable.get(t) ?? { badge: false, originals: [], goal_fills: [] };
          c.goal_fills.push(fill.id);
          w.claimable.set(t, c);
        }
        w.tippers.clear();
        w.goals.tip_jar.jar += 1;
        say("goal_filled", { fill_id: fill.id, goal: "TIP_JAR", level: 1, round_id: w.round.id });
      }
      w.goals.tip_jar.now = now.toString();
    },
    async claimBadge() {
      await pause();
      const c = w.claimable.get(who);
      need(!!c?.badge, "There is no badge waiting for you.");
      c!.badge = false;
      mintTo(w, who, `badge:${who}`, "Boss badge", `${who} has been a boss of the Intern since round ${me().joined ?? w.round.id}.`);
      say("sticker_claimed", { account_id: who, token_id: `badge:${who}` });
    },
    async claimOriginal(code) {
      await pause();
      const c = w.claimable.get(who);
      need(!!c?.originals.includes(code), "That original isn't yours to claim.");
      c!.originals = c!.originals.filter((x) => x !== code);
      const f = w.firsts.find((x) => x.code === code);
      if (f) f.claimed = true;
      mintTo(w, who, `original:${code}`, `First of its kind: ${code}`, `The only original of ${code}.`);
      say("sticker_claimed", { account_id: who, token_id: `original:${code}` });
    },
    async claimGoalSticker(fillId) {
      await pause();
      const c = w.claimable.get(who);
      need(!!c?.goal_fills.includes(fillId), "That goal sticker isn't yours to claim.");
      c!.goal_fills = c!.goal_fills.filter((x) => x !== fillId);
      const fill = w.fills.find((x) => x.id === fillId);
      mintTo(w, who, `goal:${fillId}:${who}`, `Goal filled: ${fill?.goal ?? "?"} level ${fill?.level ?? "?"}`, `${who} helped fill a goal.`);
      say("sticker_claimed", { account_id: who, token_id: `goal:${fillId}:${who}` });
    },
    async launch(name, symbol) {
      await pause();
      need(name.trim().length >= 2 && name.trim().length <= 32, "A name is 2 to 32 characters.");
      need(/^[A-Z0-9]{2,8}$/.test(symbol), "A symbol is 2 to 8 capital letters or digits.");
      need(!w.launches.some((l) => l.symbol === symbol), "That symbol is taken.");
      w.launches.unshift({ id: Math.max(0, ...w.launches.map((l) => l.id)) + 1, name: name.trim(), symbol, creator: who, created_at: clock(), sold: "0", usdc_reserve: "0", price_e6: "1" });
    },
    async buyLaunch(tokenId, amount, minOut) {
      await pause();
      const a = me();
      const l = w.launches.find((x) => x.id === tokenId);
      const v = BigInt(amount);
      need(!!l, "No such launch.");
      need(v > 0n && v <= a.dollars, `You only have ${usdText(a.dollars)} in your wallet.`);
      const q = quote(l!, "BUY", v);
      need(BigInt(q.out) >= BigInt(minOut), "The price moved. Try again.");
      a.dollars -= v;
      l!.sold = add(l!.sold, BigInt(q.out));
      l!.usdc_reserve = add(l!.usdc_reserve, v - BigInt(q.fee));
      const key = `${tokenId}:${who}`;
      w.launchHeld.set(key, (w.launchHeld.get(key) ?? 0n) + BigInt(q.out));
      w.pot.brave.income_waiting = add(w.pot.brave.income_waiting, BigInt(q.fee));
      say("outside_income", { source: "launchpad", amount: q.fee });
    },
    async sellLaunch(tokenId, amount, minOut) {
      await pause();
      const a = me();
      const l = w.launches.find((x) => x.id === tokenId);
      const key = `${tokenId}:${who}`;
      const v = BigInt(amount);
      need(!!l, "No such launch.");
      need(v > 0n && v <= (w.launchHeld.get(key) ?? 0n), "You don't hold that many.");
      const q = quote(l!, "SELL", v);
      need(BigInt(q.out) >= BigInt(minOut), "The price moved. Try again.");
      w.launchHeld.set(key, (w.launchHeld.get(key) ?? 0n) - v);
      l!.sold = add(l!.sold, -v);
      l!.usdc_reserve = add(l!.usdc_reserve, -(BigInt(q.out) + BigInt(q.fee)));
      a.dollars += BigInt(q.out);
      w.pot.brave.income_waiting = add(w.pot.brave.income_waiting, BigInt(q.fee));
      say("outside_income", { source: "launchpad", amount: q.fee });
    },
  };
}

function mintTo(w: World, who: string, token_id: string, title: string, description: string): void {
  const list = w.owned.get(who) ?? [];
  list.push({ token_id, owner_id: who, metadata: { title, description, extra: null } });
  w.owned.set(who, list);
}

/** Sample-only: the longest plausible content, to check that every screen holds (?stress=1). */
function stress(w: World): void {
  const long = "a-sixty-four-character-account-name-that-goes-on-and-on-0123.testnet";
  w.pot.brave = { total: "123456789120000", lent: "121000000000000", in_play: "2456789120000", idle: "0", pending: "987654321000000", interest: "8123456780000", income_waiting: "45678900000" };
  w.pot.safe = { total: "999999999990000", lent: "999999999990000", idle: "0" };
  w.pot.bosses = 1234567;
  w.round.brave_at_open = "123456789120000";
  w.round.at_risk = "2456789120000";
  w.round.refused = 128;
  for (const f of w.feed) {
    if ("account_id" in f.data) (f.data as { account_id: string }).account_id = long;
    if (f.event === "paid_in") f.data.amount = "987654321000000";
  }
}

export type SampleChain = Chain & { act(accountId: string): Actions };

export function sampleChain(scene: Scene, clock: () => Ms = Date.now, options: { stress?: boolean } = {}): SampleChain {
  const { world: w, script } = build(scene, clock());
  if (options.stress) stress(w);
  const tick = () => {
    const now = clock();
    while (script.length && script[0]!.at <= now) apply(w, script.shift()!);
    return now;
  };
  const copy = <T,>(v: T): T => structuredClone(v);

  return {
    act: (accountId: string) => sampleActions(w, clock, accountId),
    async getConstants() {
      return copy(w.constants);
    },
    async getRank() {
      tick();
      return copy(w.rank);
    },
    async getLimits(rank) {
      return copy(w.constants.ranks.find((l) => l.rank === rank)!);
    },
    async getRound() {
      return livePhase(copy(w.round), tick());
    },
    async getRoundById(id) {
      tick();
      if (id === w.round.id) return livePhase(copy(w.round), clock());
      return pastRound(w, id);
    },
    async getRulebook(): Promise<Rulebook> {
      tick();
      return { round_id: w.round.id, nonce: "9f2c41d07ab35e16", text: "(sample data has no rulebook text)" };
    },
    async getPositions(roundId) {
      tick();
      if (roundId !== undefined && roundId !== w.round.id) return pastPositions(w, roundId);
      return copy(w.positions);
    },
    async getOutbox(afterId, limit): Promise<SignedAction[]> {
      tick();
      // What the program would have signed for each bet, in order: set leverage, open, close
      const fake = (n: number) => `0x${n.toString(16).padStart(8, "0").repeat(8)}`;
      const out: SignedAction[] = [];
      for (const pos of w.positions) {
        const asset = w.constants.markets.find((m) => m.market === pos.market)!.hl_asset;
        const sz = pos.sz_e8 ? (Number(pos.sz_e8) / 1e8).toString() : "0";
        const px = pos.sz_e8 ? (Number(pos.notional) / 1e6 / (Number(pos.sz_e8) / 1e8)).toPrecision(5) : "0";
        const add = (kind: SignedAction["kind"], at: Ms, action: object) =>
          out.push({ id: pos.id * 3 + out.length - 8, position_id: pos.id, kind, action, nonce: at - 2_000, expires_after: at + 118_000, signature: { r: fake(pos.id * 7919 + out.length), s: fake(pos.id * 104729 + out.length), v: 27 }, created_at: at });
        const order = (buy: boolean, reduce: boolean) => ({ type: "order", orders: [{ a: asset, b: buy, p: px, s: sz, r: reduce, t: { limit: { tif: "Ioc" } } }], grouping: "na" });
        if (pos.open_signed_at) {
          add("LEVERAGE", pos.open_signed_at - 12_000, { type: "updateLeverage", asset, isCross: false, leverage: pos.leverage });
          add("OPEN", pos.open_signed_at, order(pos.side === "LONG", false));
        }
        if (pos.close_signed_at) add("CLOSE", pos.close_signed_at, order(pos.side !== "LONG", true));
      }
      return page(out.filter((x) => afterId === undefined || x.id > afterId), limit);
    },
    async getPot() {
      tick();
      return copy(w.pot);
    },
    async getAccount(accountId): Promise<Account> {
      tick();
      const a = w.wallets.get(accountId);
      if (!a) return { account_id: accountId, registered: false, coin: "0", locked: "0", brave_value: "0", pending_brave: "0", safe: "0", joined_round: null, vote_weight: "0" };
      return {
        account_id: accountId,
        registered: a.registered,
        coin: a.coin.toString(),
        locked: a.locked.toString(),
        brave_value: ((a.coin * BigInt(w.pot.coin_price_e6)) / 1_000_000n).toString(),
        pending_brave: a.pending.toString(),
        safe: a.safe.toString(),
        joined_round: a.joined,
        vote_weight: weightOf(w, a).toString(),
      };
    },
    async getVotes(_from, limit) {
      tick();
      return page(copy(w.votes).reverse(), limit);
    },
    async getRefusals(from, limit) {
      tick();
      // Newest first. `from` is the highest id to return (interface 1.1).
      const list = copy(w.refusals).sort((x, y) => y.id - x.id);
      return page(from === undefined ? list : list.filter((r) => r.id <= from), limit);
    },
    async getStickerFirsts() {
      return copy(w.firsts);
    },
    async getFeed(afterSeq, limit = 50) {
      tick();
      const cap = Math.min(limit, 100);
      if (afterSeq === undefined) return copy(w.feed.slice(-cap));
      return copy(w.feed.filter((f) => f.seq > afterSeq).slice(0, cap));
    },
    async getActivePlaybook(): Promise<Playbook | null> {
      return copy(w.playbooks.find((p) => p.id === w.activePlaybook) ?? null);
    },
    async getPlaybooks(_from, limit) {
      return page(copy(w.playbooks), limit);
    },
    async getGoals() {
      tick();
      return copy(w.goals);
    },
    async getGoalFills(_from, limit) {
      return page(copy(w.fills), limit);
    },
    async getClaimable(accountId) {
      return copy(w.claimable.get(accountId) ?? { badge: false, originals: [], goal_fills: [] });
    },
    async getOwned(accountId) {
      return copy(w.owned.get(accountId) ?? []);
    },
    async getLaunches() {
      return copy(w.launches);
    },
    async getLaunchInfo(): Promise<LaunchInfo> {
      return { usdc: w.constants.usdc_token, coin: "coin.sample.testnet", fee_bps: 100, virtual_usdc: VIRTUAL_USDC.toString(), supply: LAUNCH_SUPPLY.toString(), fees_sent: "3150000", fees_kept: "0", launches: w.launches.length };
    },
    async getLaunchBalance(tokenId, accountId) {
      return (w.launchHeld.get(`${tokenId}:${accountId}`) ?? 0n).toString();
    },
    async getLaunchQuote(tokenId, side, amount) {
      return quote(w.launches.find((l) => l.id === tokenId)!, side, BigInt(amount));
    },
  };
}
