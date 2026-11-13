/**
 * The shapes the program returns, written once.
 * Source of truth: 01-SHARED-INTERFACE.md version 1.3, sections 2, 3, 4, 5, 7, 8.1, 9.3, 10.
 * If this file and that one disagree, that one is right.
 */

export const INTERFACE_VERSION = "1.7" as const;

/** Whole number as a decimal string, e.g. "20000000". Never a JSON number. */
export type U128 = string;
/** Dollars with 6 decimals. "20000000" is $20.00. */
export type Usdc = U128;
/** $INTERN with 6 decimals. */
export type Coin = U128;
/** Like U128 but may start with "-". */
export type Signed = string;
/** Unix time in milliseconds. */
export type Ms = number;
/** Hundredths of a percent. 200 = 2%. */
export type Bps = number;
export type AccountId = string;

export type RankName = "INTERN" | "ANALYST" | "TRADER";
export type Status = "EMPLOYED" | "FIRED";
export type Market = "DOGE" | "SHIB" | "PEPE" | "PENGU" | "WIF" | "TRUMP";
export type Side = "LONG" | "SHORT";
export type Pool = "BRAVE" | "SAFE";
export type Phase = "OPEN" | "PROPOSE" | "HOLD" | "CLOSE";

/**
 * The sixteen codes, in the order the program checks them. Written out here so TypeScript can
 * type them; a test (interface.test.ts) fails if this list ever differs from
 * intern/interface/refusal-codes.json, the file the program is built from.
 */
export const REFUSAL_CODES = [
  "OUTSIDE_WINDOW",
  "FIRED",
  "BAD_MODEL_SIGNATURE",
  "WRONG_RULEBOOK",
  "MALFORMED_DECISION",
  "NOT_ON_LIST",
  "SHORT_NOT_UNLOCKED",
  "ZERO_MARGIN",
  "OVER_LEVERAGE",
  "TOO_MANY_TRADES",
  "OVER_TRADE_LIMIT",
  "OVER_ROUND_LIMIT",
  "BAD_QUOTE_SIGNATURE",
  "STALE_QUOTE",
  "QUOTE_MISMATCH",
  "TOO_EXPENSIVE",
] as const;

export type RefusalCode = (typeof REFUSAL_CODES)[number];

export type Limits = {
  rank: RankName;
  per_bet_bps: Bps;
  max_bets: number;
  per_round_bps: Bps;
  sides: Side[];
  max_leverage: number;
  markets: Market[];
};

export type MarketInfo = {
  market: Market;
  hl_name: string;
  hl_asset: number;
  sz_decimals: number;
};

export type Constants = {
  interface_version: "1.7";
  network: "testnet" | "mainnet";
  usdc_token: AccountId;
  coin_decimals: 6;
  ranks: Limits[];
  markets: MarketInfo[];
  min_notional: Usdc;
  round: {
    genesis_ms: Ms;
    round_ms: number;
    guess_close_ms: number;
    propose_from_ms: number;
    propose_until_ms: number;
    close_from_ms: number;
    tail_fade_ms: number;
  };
  vote: {
    promote_pass_bps: Bps;
    promote_quorum_bps: Bps;
    tighten_pass_bps: Bps;
    vote_ms: number;
    weight_full_rounds: number;
  };
  model: { id: string; signing_algo: "ecdsa" | "ed25519"; signer: string };
  funding: {
    mode: "RECORDED" | "ONECLICK";
    quote_signer: string;
    quote_max_age_ms: number;
    max_funding_cost_bps: Bps;
  };
  result_source: "REPORTED" | "MEASURED";
  /** (1.7) `lender`: the lending contract. */
  lending: { mode: "NONE" | "STANDIN" | "RHEA"; lender?: AccountId | null };
  hl: {
    testnet: boolean;
    address: string;
    signer_contract: AccountId;
    path: string;
    order_expiry_ms: number;
  };
  runner: AccountId;
  min_first_deposit: Usdc;
  refusal_codes: RefusalCode[];
  // (1.3)
  /** Share of a winning round paid to the active playbook's authors. */
  coach_cut_bps: Bps;
  goals: { boss_ladder: number[]; tip_jar_target: Usdc; min_tip: Usdc; hype_window_ms: number; hype_levels: number[] };
  /** The NFT contract for badges and stickers. */
  stickers: AccountId;
  launchpad: AccountId;
};

export type RankState = {
  rank: RankName;
  status: Status;
  since_round: number;
  pending: { rank: RankName; status: Status; effective_round: number } | null;
};

export type Round = {
  id: number;
  phase: Phase;
  settled: boolean;
  stuck: boolean;
  started_at: Ms;
  guess_closes_at: Ms;
  propose_from: Ms;
  propose_until: Ms;
  close_from: Ms;
  ends_at: Ms;
  rank: RankName;
  status: Status;
  brave_at_open: Usdc;
  bets_used: number;
  at_risk: Usdc;
  skipped: number;
  refused: number;
  result: Signed | null;
};

export type Rulebook = { round_id: number; nonce: string; text: string };

export type PositionStatus = "APPROVED" | "OPEN_SIGNED" | "CLOSE_SIGNED" | "SETTLED";

export type Position = {
  id: number;
  round_id: number;
  market: Market;
  side: Side;
  margin: Usdc;
  leverage: number;
  notional: Usdc;
  status: PositionStatus;
  approved_at: Ms;
  open_signed_at: Ms | null;
  close_signed_at: Ms | null;
  settled_at: Ms | null;
  sz_e8: U128 | null;
  returned: Usdc | null;
  result: Signed | null;
  result_source: "REPORTED" | "MEASURED" | "ABANDONED" | "CORRECTED" | null;
};

export type SignedAction = {
  id: number;
  position_id: number;
  kind: "LEVERAGE" | "OPEN" | "CLOSE";
  action: object;
  nonce: Ms;
  expires_after: Ms;
  signature: { r: string; s: string; v: number };
  created_at: Ms;
};

export type Pot = {
  brave: {
    total: Usdc;
    lent: Usdc;
    in_play: Usdc;
    idle: Usdc;
    pending: Usdc;
    /** (1.3) Lending interest collected into the pool so far. */
    interest: Usdc;
    /** (1.3) Outside income that will be credited when the next round opens. */
    income_waiting: Usdc;
  };
  safe: { total: Usdc; lent: Usdc; idle: Usdc };
  coin_supply: Coin;
  /** Dollars per whole coin, 6 decimals. "1000000" is $1.00. */
  coin_price_e6: U128;
  bosses: number;
  outside_income_total: Usdc;
};

export type Account = {
  account_id: AccountId;
  registered: boolean;
  coin: Coin;
  locked: Coin;
  brave_value: Usdc;
  pending_brave: Usdc;
  safe: Usdc;
  joined_round: number | null;
  vote_weight: U128;
};

/** (1.5) LONG_SHOT: allow one long-shot ticket in the second round after it passes. */
export type VoteKind = "PROMOTE" | "DEMOTE" | "FIRE" | "REHIRE" | "SET_PLAYBOOK" | "LONG_SHOT" | "RENEW" | "CORRECT";

export type Vote = {
  id: number;
  kind: VoteKind;
  playbook_id: number | null;
  opened_by: AccountId;
  opened_at: Ms;
  closes_at: Ms;
  yes: U128;
  no: U128;
  locked_weight_at_open: U128;
  state: "OPEN" | "PASSED" | "FAILED";
  effective_round: number | null;
};

export type Decision =
  | { action: "SKIP" }
  | { action: "BET"; market: Market; side: Side; margin: Usdc; leverage: number };

export type Refusal = {
  id: number;
  round_id: number;
  code: RefusalCode;
  at: Ms;
  asked: string | null;
  limit: string | null;
  decision: Decision | null;
  is_first: boolean;
  /** (1.3) The visitor the runner named for this refusal, if any. The program cannot check it. */
  credited_to: AccountId | null;
};

/** (1.3) Who earned the one original of each code: the visitor credited with its first credited refusal. */
export type StickerFirst = {
  code: RefusalCode;
  account_id: AccountId | null;
  round_id: number | null;
  claimed: boolean;
};

export type Playbook = {
  id: number;
  text: string;
  authors: { account_id: AccountId; share_bps: Bps }[];
  submitted_round: number;
  /** (1.3) The round it became active, if it ever did. */
  active_from: number | null;
  /** (1.3) Coach cut paid to its authors so far. */
  paid_total: Usdc;
};

/** (1.3) The three bars the audience fills together. */
export type Goals = {
  boss: { level: number; target: number | null; now: number };
  tip_jar: { jar: number; target: Usdc; now: Usdc };
  hype: { train: number; level: number; points: number; ends_at: Ms | null };
};
export type GoalKind = "BOSS" | "TIP_JAR" | "HYPE";
export type GoalFill = { id: number; goal: GoalKind; level: number; at: Ms; round_id: number };
export type Claimable = { badge: boolean; originals: RefusalCode[]; goal_fills: number[] };

/** A badge or sticker someone owns (NEP-171 token on the stickers contract). */
export type OwnedToken = { token_id: string; owner_id: AccountId; metadata: { title: string | null; description: string | null; extra: string | null } };

/** The launchpad's shapes, as its contract returns them. */
export type Launch = { id: number; name: string; symbol: string; creator: AccountId; created_at: Ms; sold: U128; usdc_reserve: Usdc; price_e6: U128 };
export type LaunchInfo = { usdc: AccountId; coin: AccountId; fee_bps: Bps; virtual_usdc: Usdc; supply: U128; fees_sent: Usdc; fees_kept: Usdc; launches: number };
export type Quote = { out: U128; fee: Usdc };

export type Verdict =
  | { verdict: "YES"; position_id: number }
  | { verdict: "SKIP" }
  | {
      verdict: "NOPE";
      refusal_id: number;
      code: RefusalCode;
      asked: string | null;
      limit: string | null;
    };

/** Every event the program announces, with its data. Section 10. */
export type EventData = {
  round_opened: { round_id: number; rank: RankName; status: Status; brave_at_open: Usdc };
  paid_in: { account_id: AccountId; pool: Pool; amount: Usdc; pending: boolean };
  coins_minted: { account_id: AccountId; coins: Coin; round_id: number };
  cashed_out: { account_id: AccountId; pool: Pool; coins: Coin | null; paid: Usdc };
  dial_turned: { account_id: AccountId; to: Pool; amount: U128 };
  locked: { account_id: AccountId; amount: Coin };
  unlocked: { account_id: AccountId; amount: Coin };
  skipped: { round_id: number };
  refused: {
    refusal_id: number;
    round_id: number;
    code: RefusalCode;
    asked: string | null;
    limit: string | null;
    is_first: boolean;
  };
  approved: {
    position_id: number;
    round_id: number;
    market: Market;
    side: Side;
    margin: Usdc;
    leverage: number;
    /** (1.5) True when this bet is the long-shot ticket. */
    long_shot?: boolean;
  };
  order_signed: { action_id: number; position_id: number; kind: SignedAction["kind"] };
  result_reported: {
    position_id: number;
    returned: Usdc;
    result: Signed;
    result_source: "REPORTED" | "MEASURED" | "ABANDONED" | "CORRECTED";
  };
  settled: { round_id: number; result: Signed; brave_after: Usdc };
  vote_opened: {
    vote_id: number;
    kind: VoteKind;
    playbook_id: number | null;
    opened_by: AccountId;
    closes_at: Ms;
  };
  vote_cast: { vote_id: number; account_id: AccountId; support: boolean; weight: U128 };
  vote_finished: { vote_id: number; state: Vote["state"]; effective_round: number | null };
  rank_changed: { from: RankName; to: RankName; effective_round: number };
  fired: { round_id: number };
  rehired: { effective_round: number };
  outside_income: { source: string; amount: Usdc };
  // (1.3)
  playbook_submitted: { playbook_id: number; authors: { account_id: AccountId; share_bps: Bps }[]; submitted_round: number };
  playbook_activated: { playbook_id: number; effective_round: number };
  coach_paid: { round_id: number; playbook_id: number; amount: Usdc; paid: { account_id: AccountId; amount: Usdc }[] };
  tipped: { account_id: AccountId; amount: Usdc };
  goal_filled: { fill_id: number; goal: GoalKind; level: number; round_id: number };
  hype_level: { train: number; level: number; points: number };
  sticker_claimed: { account_id: AccountId; token_id: string };
  // (1.4) the reward ladder
  guessed: { round_id: number; account_id: AccountId };
  guess_settled: { round_id: number; verdict: Verdict3; right: number; wrong: number };
  golden_dropped: { account_id: AccountId; code: RefusalCode; serial: number };
  jackpot_grew: { amount: Usdc; source: "tips" | "added"; by?: AccountId; jackpot: Usdc };
  jackpot_won: { round_id: number; winners: AccountId[]; each: Usdc };
  draw_held: { period: number; winner: AccountId | null; prize: Usdc; runners_up: number | [AccountId, Usdc][]; each: Usdc; tickets_total: U128; rolled_over?: boolean; randomness?: DrawLuck; drand_round?: number };
  prize_paid: { account_id: AccountId; amount: Usdc };
  // (1.5)
  long_shot_allowed: { round_id: number };
  // (1.6)
  league_closed: { week: number; players: number; groups: number; winners: { group: number; account_id: AccountId; points: number }[] };
  review_written: { week: number; bets: number; refused: number; skipped: number; result: Signed; rank_end: RankName };
  review_bar_filled: { week: number; stamps: number };
  // (1.7)
  strikes_out: { round_id: number; strikes: number; action: "DEMOTE" | "FIRE"; to?: RankName };
  brake_on: { round_id: number; result: Signed; base: Usdc; until_round: number };
  brake_off: { round_id: number };
  term_lapsed: { round_id: number; term_ended_at: Ms };
  term_renewed: { term_ends_at: Ms };
  abandoned: { round_id: number; bets_booked_lost: number };
  streak_banked: { account_id: AccountId; streak: number; points: number };
  trick_paid: { id: string; account_id: AccountId; amount: Usdc; to_bounty: Usdc };
  bounty_grew: { amount: Usdc; by: AccountId; pot: Usdc };
  bounty_paid: { account_id: AccountId; amount: Usdc; refusal_id: number; code: RefusalCode };
  rescue_grew: { amount: Usdc; by: AccountId; fund: Usdc; target: Usdc };
  rescued: { round_id: number; effective_round: number; fund: Usdc; rescuers: number };
  rescue_paid: { round_id: number; amount: Usdc };
  nft_earnings_claimed: { token_id: string; account_id: AccountId; amount: Usdc };
  stake_grew: { round_id: number; coins: Coin; fee: Usdc };
  stake_burned: { round_id: number; coins: Coin; covered: Usdc };
  result_challenged: { vote_id: number; position_id: number; challenger: AccountId; reported: Usdc; claimed: Usdc; bond: Usdc };
  result_corrected: { vote_id: number; position_id: number; from: Usdc; to: Usdc; delta: Signed; brave_after: Usdc };
  sticker_hl_signed: { code: RefusalCode; kind: string; account_id: AccountId; signer: string };
  draw_pending: { period: number; drand_round: number };
  drand_submitted: { round: number; randomness: string };
};

/** (1.7) Where a payday draw's luck came from: the public drand beacon, NEAR's block seed (fallback), or none needed. */
export type DrawLuck = "drand" | "block" | "none";

/** (1.7) Section 9.9: what the program does to the Intern by itself, with no vote and no runner. */
export type AutoView = {
  strikes: number;
  strikes_out: number;
  brake_on: boolean;
  brake_until: number | null;
  brake_rounds: number;
  brake_loss_bps: number;
  loss_window_result: Signed;
  loss_window_base: Usdc;
  term_ends_at: Ms;
  term_ms: number;
  dead_man_rounds: number;
  /** When the current round could be abandoned, if it has an open bet. */
  abandon_from: Ms | null;
};
/** (1.7) Section 9.10 */
export type Bounty = { pot: Usdc; paid_total: Usdc; added_total: Usdc; from_tricks_total: Usdc; tricks_paid: number; trick_price: Usdc; bounty_bps: Bps };
/** (1.7) Section 9.12 */
export type NftEarnings = { owed_total: Usdc; paid_total: Usdc; tokens: { token_id: string; owed: Usdc }[]; careers_minted: number };
export type Career = { rank: RankName; status: Status; level: number; rounds: number; bets: number; refusals: number; result: Signed; svg: string };
/** (1.7) Section 9.14 */
export type ChallengeState = "OPEN" | "PASSED" | "APPLYING" | "APPLIED" | "FAILED";
export type Challenge = { vote_id: number; position_id: number; challenger: AccountId; bond: Usdc; reported: Usdc; claimed: Usdc; reason: string; state: ChallengeState };
export type Challenges = { bonds_held: Usdc; bond: Usdc; window_rounds: number; challenges: Challenge[] };
/** (1.7) Section 9.17: an original's Hyperliquid account and what the coin has signed for it. */
export type StickerHlSigned = { code: RefusalCode; kind: string; action: object; nonce: Ms; r: string; s: string; v: number; signer: string; for_account: AccountId; at: Ms };
export type StickerHl = { code: RefusalCode; token_id: string; path: string; signed: StickerHlSigned[] };
/** (1.7) Section 9.18 */
export type Drand = {
  period: number;
  state: "OPEN" | "WAITING" | "HELD";
  drand_round: number | null;
  source: DrawLuck | null;
  /** Hex. */
  randomness: string | null;
  /** The frozen tickets, in order: kept while waiting and for the last 4 periods. */
  tickets: [AccountId, U128][] | null;
  chain: string;
  chain_hash: string;
  wait_rounds: number;
};
/** (1.7) Section 9.13 */
export type Stake = { coins: Coin; value: Usdc; fee_bps: Bps; grew_total: Coin; burned_total: Coin };
/** (1.7) Section 9.11 */
export type Rescue = { fund: Usdc; target: Usdc; contributors: number; rescuers: [AccountId, Usdc][]; from_round: number; until_round: number; cut_bps: Bps; paid_total: Usdc; rescues: number };
/** (1.7) Section 9.16: a listing on the tickets contract's market. */
export type Listing = { id: number; seller: AccountId; token_id: string; amount: U128; price_each: Usdc };

/** (1.6) Section 9.8: the week (7 rounds), its league and its review. Leagues are points only: there is no prize. */
export type WeekView = {
  round_id: number;
  week: number;
  first_round: number;
  last_round: number;
  rounds_per_week: number;
  league_players: number;
  league_groups: number;
  group_size: number;
  max_groups: number;
  /** Last week's review, once written: the one people can stamp now. */
  review_to_stamp: number | null;
  review_bar: number;
  max_stamps: number;
};
/** `waiting`: guesses whose round has no ruling yet. */
export type Standing = { place: number; account_id: AccountId; points: number; wrong: number; best_run: number; waiting: number };
export type LeagueView = {
  week: number;
  first_round: number;
  last_round: number;
  players: number;
  groups: number;
  /** With an account: that account's group, or null if it has not guessed this week. Otherwise the group asked for. */
  group: number | null;
  closed: boolean;
  /** The whole group while the week runs; its top three once closed. */
  standings: Standing[];
  group_size: number;
  max_groups: number;
};
export type GroupResult = { group: number; top: Standing[] };
export type BetLine = { position_id: number; round_id: number; market: Market; side: Side; margin: Usdc; leverage: number; result: Signed };
export type ReviewView = {
  week: number;
  first_round: number;
  last_round: number;
  written_at: Ms;
  /** Written after the fact, for a week that ended before reviews existed. */
  backfilled: boolean;
  rounds: number;
  settled: number;
  bets: number;
  refused: number;
  skipped: number;
  result: Signed;
  best_bet: BetLine | null;
  worst_bet: BetLine | null;
  refusals: { code: RefusalCode; count: number }[];
  rank_start: RankName;
  rank_end: RankName;
  status_end: Status;
  pool_start: Usdc;
  pool_end: Usdc;
  long_shot: boolean;
  league_players: number;
  stamps: number;
  bar: number;
  bar_filled: boolean;
  stamping_open: boolean;
};

/** (1.4) Section 9.7: the reward ladder. Every prize comes from a named source; none changes what the Intern may bet. */
export type Verdict3 = "YES" | "NOPE" | "SKIP";
export type PlayerView = {
  account_id: AccountId;
  points: number;
  right: number;
  wrong: number;
  streak: number;
  best: number;
  /** This round's guess, or one still waiting for its ruling. */
  guess: { round_id: number; verdict: Verdict3; wager?: number } | null;
  jackpot_eligible: boolean;
  prize_owed: Usdc;
  /** Won, not yet claimed. */
  goldens: { code: RefusalCode; serial: number }[];
  draw: { since_round: number; base_usd: Usdc; usd_now: Usdc; tickets: U128 } | null;
};
export type Rewards = {
  round_id: number;
  guess_closes_at: Ms;
  /** YES, NOPE, SKIP */
  guesses_this_round: [number, number, number];
  /** (1.7) Points wagered this round on YES, NOPE, SKIP. */
  wagers_this_round?: [string, string, string];
  jackpot: Usdc;
  jackpot_added_total: Usdc;
  jackpot_from_tips_total: Usdc;
  jackpot_last_won_round: number | null;
  draw_pot: Usdc;
  draw_period: number;
  draw_from_round: number;
  entrants: number;
  prizes_owed: Usdc;
  /** Sixteen, in the order of the refusal codes. */
  golden_minted: number[];
  /** (1.5) The long shot. `margin` is set only in the ticket's round while it is unused. */
  long_shot: { ticket_round: number | null; used: boolean; margin: Usdc | null; max_leverage: number; vote_from_round: number };
  constants: {
    golden_odds: number;
    golden_cap: number;
    jackpot_streak: number;
    min_boss_usd: Usdc;
    min_boss_rounds: number;
    tip_to_jackpot_bps: number;
    draw_rounds: number;
    draw_top_bps: number;
    draw_runners: number;
    max_entrants: number;
  };
};
export type DrawResult = { period: number; held_at: Ms; held_in_round: number; prize: Usdc; winner: AccountId | null; winner_prize: Usdc; runners_up: [AccountId, Usdc][]; tickets_total: U128 };
export type JackpotWin = { round_id: number; winners: AccountId[]; each: Usdc };

export type EventName = keyof EventData;

export type FeedItem = {
  [E in EventName]: { seq: number; at: Ms; event: E; data: EventData[E] };
}[EventName];

/** The ten named scenes shared by the sample data and Engine 1's stub. */
export const SCENES = [
  "QUIET",
  "REFUSED",
  "APPROVED",
  "HOLDING",
  "SETTLED_WIN",
  "SETTLED_LOSS",
  "VOTE_OPEN",
  "PROMOTED",
  "FIRED",
  "STUCK",
] as const;

export type Scene = (typeof SCENES)[number];

/** Every question the site may ask the program. Section 8. */
export interface Chain {
  getConstants(): Promise<Constants>;
  getRank(): Promise<RankState>;
  getLimits(rank: RankName): Promise<Limits>;
  getRound(): Promise<Round>;
  getRoundById(roundId: number): Promise<Round | null>;
  getRulebook(): Promise<Rulebook>;
  getPositions(roundId?: number): Promise<Position[]>;
  getOutbox(afterId?: number, limit?: number): Promise<SignedAction[]>;
  getPot(): Promise<Pot>;
  getAccount(accountId: AccountId): Promise<Account>;
  getVotes(from?: number, limit?: number): Promise<Vote[]>;
  getRefusals(from?: number, limit?: number): Promise<Refusal[]>;
  getStickerFirsts(): Promise<StickerFirst[]>;
  getFeed(afterSeq?: number, limit?: number): Promise<FeedItem[]>;
  getActivePlaybook(): Promise<Playbook | null>;
  // (1.3)
  getPlaybooks(from?: number, limit?: number): Promise<Playbook[]>;
  getGoals(): Promise<Goals>;
  getGoalFills(from?: number, limit?: number): Promise<GoalFill[]>;
  getClaimable(accountId: AccountId): Promise<Claimable>;
  /** Badges and stickers an account owns, read from the stickers contract. */
  getOwned(accountId: AccountId): Promise<OwnedToken[]>;
  getLaunches(): Promise<Launch[]>;
  getLaunchInfo(): Promise<LaunchInfo>;
  getLaunchBalance(tokenId: number, accountId: AccountId): Promise<U128>;
  getLaunchQuote(tokenId: number, side: "BUY" | "SELL", amount: U128): Promise<Quote>;
  // (1.4)
  getRewards(): Promise<Rewards>;
  getPlayer(accountId: AccountId): Promise<PlayerView>;
  getDrawResults(from?: number, limit?: number): Promise<DrawResult[]>;
  getJackpotWins(limit?: number): Promise<JackpotWin[]>;
  // (1.6)
  getWeek(): Promise<WeekView>;
  getLeague(args?: { week?: number; group?: number; accountId?: AccountId }): Promise<LeagueView>;
  getLeagueResults(week: number): Promise<GroupResult[]>;
  getReviews(from?: number, limit?: number): Promise<ReviewView[]>;
  // (1.7)
  getAuto(): Promise<AutoView>;
  getBounty(): Promise<Bounty>;
  getNftEarnings(): Promise<NftEarnings>;
  getCareer(): Promise<Career>;
  getChallenges(): Promise<Challenges>;
  getStickerHl(code: RefusalCode): Promise<StickerHl>;
  getDrand(period?: number): Promise<Drand>;
  getStake(): Promise<Stake>;
  getRescue(): Promise<Rescue>;
  /** The market on the tickets contract. */
  getListings(): Promise<Listing[]>;
  /** How many tradable golden units of each code an account holds on the tickets contract: sixteen, in the order of the codes. */
  getGoldenUnits(accountId: AccountId): Promise<U128[]>;
  /** Who holds a token on the sticker contract, or null if it was never minted. */
  getTokenOwner(tokenId: string): Promise<AccountId | null>;
}

/**
 * Everything a signed-in person can do. Section 9 of the interface.
 * Each call resolves when the program has accepted it, and rejects with a plain sentence if not.
 */
export interface Actions {
  /** Dollars in the person's own wallet (the dollar token's balance), not yet paid in. */
  getDollars(): Promise<Usdc>;
  /** Test network only: the stand-in dollar's free tap. */
  getTestDollars(amount: Usdc): Promise<void>;
  /** One-time registration, needed before holding the coin or a SAFE balance. */
  register(): Promise<void>;
  payIn(pool: Pool, amount: Usdc): Promise<void>;
  /** BRAVE: amount is coins. SAFE: amount is dollars. With `pending`, dollars still waiting for the next shift. */
  cashOut(pool: Pool, amount: U128, pending?: boolean): Promise<void>;
  /** To SAFE: amount is coins. To BRAVE: amount is dollars. */
  turnDial(to: Pool, amount: U128): Promise<void>;
  lock(amount: Coin): Promise<void>;
  unlock(amount: Coin): Promise<void>;
  openVote(kind: VoteKind, playbookId?: number): Promise<void>;
  cast(voteId: number, support: boolean): Promise<void>;
  finishVote(voteId: number): Promise<void>;
  // (1.3)
  submitPlaybook(text: string): Promise<void>;
  tip(amount: Usdc): Promise<void>;
  claimBadge(): Promise<void>;
  claimOriginal(code: RefusalCode): Promise<void>;
  claimGoalSticker(fillId: number): Promise<void>;
  launch(name: string, symbol: string): Promise<void>;
  buyLaunch(tokenId: number, amount: Usdc, minOut: U128): Promise<void>;
  sellLaunch(tokenId: number, amount: U128, minOut: Usdc): Promise<void>;
  // (1.4)
  /** Free, once a round, before the guessing closes. */
  guess(verdict: Verdict3): Promise<void>;
  claimGolden(code: RefusalCode, serial: number): Promise<void>;
  enterDraw(): Promise<void>;
  leaveDraw(): Promise<void>;
  /** A gift to the streak jackpot, at least 1 dollar. */
  addToJackpot(amount: Usdc): Promise<void>;
  /** Pays every prize owed to the caller. */
  claimPrizes(): Promise<void>;
  // (1.6)
  /** One free stamp on last week's review. */
  stampReview(week: number): Promise<void>;
  // (1.7)
  /** A guess with points wagered on it (at most the points held). */
  guessWager(verdict: Verdict3, wager: number): Promise<void>;
  /** Turns the current streak into streak x streak points. */
  bankStreak(): Promise<void>;
  /** Books a round's bets as lost once they have had no result for three round lengths. Anyone may call it. */
  abandon(roundId: number): Promise<void>;
  /** Pays the trick price for the payment id the trick page made up. */
  payTrick(id: string, amount: Usdc): Promise<void>;
  addToBounty(amount: Usdc): Promise<void>;
  chipInRescue(amount: Usdc): Promise<void>;
  /** Opens a CORRECT vote on a reported result, with the bond. `returned` is dollars back, 6 decimals. */
  challenge(positionId: number, returned: Usdc, reason: string, bond: Usdc): Promise<void>;
  applyCorrection(voteId: number): Promise<void>;
  claimNftEarnings(tokenId: string): Promise<void>;
  claimPlaybookNft(playbookId: number): Promise<void>;
  mintCareerCard(): Promise<void>;
  refreshCareerCard(n: number): Promise<void>;
  /** The coin signs an approveAgent for an original's Hyperliquid account. Holder only. */
  stickerHlApprove(code: RefusalCode, agent: string): Promise<void>;
  stickerHlWithdraw(code: RefusalCode, destination: string, amount: string): Promise<void>;
  /** A won golden sticker as one tradable unit on the tickets contract. */
  claimGoldenMt(code: RefusalCode, serial: number): Promise<void>;
  listGolden(tokenId: string, amount: U128, priceEach: Usdc): Promise<void>;
  unlistGolden(listingId: number): Promise<void>;
  buyGolden(listingId: number, amount: U128, total: Usdc): Promise<void>;
}
