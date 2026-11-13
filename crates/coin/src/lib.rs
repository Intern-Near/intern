//! The $INTERN coin contract, following `01-SHARED-INTERFACE.md` version 1.1.
//!
//! Step 3: the coin (NEP-141/145/148), the BRAVE pool, money waiting as pending, rounds on the
//! clock (opened lazily; a round with no bet settles itself when the next one opens), cash-out, the
//! feed. Step 4 (`round.rs`): the rank, the nonce and rulebook, `propose` with all sixteen checks in
//! order, positions, refusals, `report_result` and `settle`. The vote is step 5; SAFE step 6;
//! signing orders step 7. Step 5 (`vote.rs`): locks, votes and rank changes. Step 6 (`safe.rs`):
//! the SAFE side and the dial. Step 7 (`sign.rs`): the real AI check (Engine 2's `ai-check`) and real
//! order signing (Engine 2's `hl-order` and NEAR's signing network).
//!
//! Rules this contract keeps everywhere:
//! - Whole numbers only; every rounding favours the pool (the maths is in the `rules` crate).
//! - Opening a round never loops over depositors (1.1): it records one rate; each account's coins
//!   are written the next time that account does anything, and every view shows them at once.
//! - State first, then the outgoing call; a failed payout is put back by its callback.
//! - Tokens other than the pinned USDC, bad messages and unregistered senders are refunded in full.

#![forbid(unsafe_code)]

pub mod ai;
mod claims;
pub mod feed;
pub mod goals;
pub mod host;
pub mod lending;
pub mod playbook;
pub mod rewards;
mod round;
mod safe;
pub mod sign;
pub mod auto;
pub mod challenge;
pub mod earn;
pub mod rescue;
pub mod stake;
pub mod tricks;
pub mod vote;
pub mod weekly;

use feed::Feed;
use goals::GoalFillRec;
use near_contract_standards::fungible_token::core::ext_ft_core;
use near_contract_standards::fungible_token::events::{FtBurn, FtMint};
use near_contract_standards::fungible_token::{FungibleToken, FungibleTokenCore};
use near_sdk::json_types::U128;
use near_sdk::serde::Deserialize;
use near_sdk::serde_json::{self, json};
use near_sdk::store::LookupMap;
use near_sdk::store::LookupSet;
use near_sdk::{
    assert_one_yocto, env, near, require, AccountId, BorshStorageKey, Gas, NearToken,
    PanicOnDefault, Promise, PromiseError, PromiseOrValue,
};
use playbook::PlaybookRec;
use rules::clock::{self, Offsets};
use rules::shares::{self, OpenMint, Rate};
use shared::{Rank, Refusal, Status};
use sign::{ActionRec, Pins, PinsInit};
use vote::{LockRec, VoteRec};
use wire::{EventName, Pool};

/// Gas for the USDC transfer of a payout, and for the callback that checks it.
const GAS_PAYOUT: Gas = Gas::from_tgas(15);
const GAS_ON_PAYOUT: Gas = Gas::from_tgas(20);
/// A cash-out must carry enough gas for both, or the callback could not put a failed payout back.
pub const GAS_CASH_OUT_MIN: Gas = Gas::from_tgas(60);

/// Storage one boss's records may use, paid by their NEP-145 registration: the coin balance, the
/// pending entry, and room for SAFE (step 6) and vote locks (step 5). Measured in the tests.
/// 1.4: 640 bytes for the boss's own records (the coin balance, pending money, SAFE, vote locks; 596 measured)
/// plus `REWARDS_ACCOUNT_BYTES` for the reward ladder's. Accounts registered before 1.4 paid for 640; the contract
/// covers their reward records from its own balance.
pub const ACCOUNT_STORAGE_BYTES: u64 = 640 + REWARDS_ACCOUNT_BYTES;

/// 1.4: what one account's reward records may add: the guessing record with four unclaimed golden stickers, a
/// draw entry and its place among the entrants, a prize owed (597 bytes measured for a 64-character account).
pub const REWARDS_ACCOUNT_BYTES: u64 = 640;

/// (step 10) Any single payment above this ($1 trillion) is refunded: every total stays far from
/// the top of u128 (about 3.4·10³⁸).
pub const MAX_PAYMENT: u128 = 1_000_000_000_000_000_000;

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Token,
    Extras,
    Rates,
    Rounds,
    Feed,
    Positions,
    RoundPositions,
    Refusals,
    Locks,
    LockedByRound,
    Votes,
    Safe,
    Outbox,
    SignStage,
    Playbooks,
    RoundPlaybook,
    VotePlaybook,
    RefusalCredit,
    Badges,
    GoalFills,
    GoalClaims,
    JarTippers,
    HypeRiders,
    // 1.4: the reward ladder (appended: the keys above keep their places)
    RwRoundVerdict,
    RwRoundCounts,
    RwPlayers,
    RwCandidates,
    RwPrizes,
    RwEntries,
    RwEntrants,
    RwDraws,
    RwJackpotWins,
}

// ----- configuration ----------------------------------------------------------------------------------

/// `new()` arguments (JSON).
#[derive(Deserialize, near_sdk::serde::Serialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub struct InitConfig {
    /// The pinned USDC token (`mock-usdc` on testnet).
    pub usdc_token: AccountId,
    /// The runner's account (proposals from step 4).
    pub runner: AccountId,
    /// The round clock of section 5, `genesis_ms` included. `genesis_ms` must not be in the future.
    pub round: wire::RoundConstants,
    /// The first conversion into coins must be at least this many dollars (6 decimals).
    pub min_first_deposit: U128,
    /// The pinned model and the Hyperliquid signing settings (step 7). Left out: nothing pinned yet.
    #[serde(default)]
    pub pins: Option<PinsInit>,
    /// (1.3) The sticker (NEP-171) and launchpad contracts. Left out: not deployed yet.
    #[serde(default)]
    pub stickers: Option<AccountId>,
    #[serde(default)]
    pub launchpad: Option<AccountId>,
    /// (1.3, step 8) The lender (STAND-IN on testnet). Left out: lending.mode NONE.
    #[serde(default)]
    pub lender: Option<AccountId>,
}

/// Steps 8 and 9's small state (01 1.3: lending and outside income; section 9.5).
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Step9 {
    /// The sticker and launchpad contracts (this contract's own account when not deployed yet).
    pub stickers: AccountId,
    pub launchpad: AccountId,
    pub next_playbook_id: u64,
    pub active_playbook: Option<u64>,
    /// (playbook id, 0 to clear; effective round)
    pub pending_playbook: Option<(u64, u64)>,
    /// For each refusal code, in check order: (credited account, round, claimed) of the first credited refusal.
    pub sticker_firsts: Vec<Option<(AccountId, u64, bool)>>,
    pub outside_income_total: u128,
    pub next_fill_id: u64,
    pub boss_level: u32,
    pub jar: u64,
    pub jar_now: u128,
    pub train: u64,
    pub train_level: u32,
    pub train_points: u32,
    pub train_last: u64,
    // step 8
    /// The lender (STAND-IN on testnet); None: lending.mode NONE.
    pub lender: Option<AccountId>,
    /// BRAVE dollars lent out, and on their way there.
    pub lent: u128,
    pub lend_in_flight: u128,
    pub withdraw_in_flight: bool,
    pub interest_total: u128,
    /// Outside income credited at the next round's opening.
    pub income_waiting: u128,
}

impl Step9 {
    fn new(stickers: AccountId, launchpad: AccountId, lender: Option<AccountId>) -> Self {
        Step9 {
            lender,
            lent: 0,
            lend_in_flight: 0,
            withdraw_in_flight: false,
            interest_total: 0,
            income_waiting: 0,
            stickers,
            launchpad,
            next_playbook_id: 1,
            active_playbook: None,
            pending_playbook: None,
            sticker_firsts: vec![None; 16],
            outside_income_total: 0,
            next_fill_id: 1,
            boss_level: 0,
            jar: 1,
            jar_now: 0,
            train: 0,
            train_level: 0,
            train_points: 0,
            train_last: 0,
        }
    }
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Cfg {
    usdc_token: AccountId,
    runner: AccountId,
    genesis_ms: u64,
    round_ms: u64,
    guess_close_ms: u64,
    propose_from_ms: u64,
    propose_until_ms: u64,
    close_from_ms: u64,
    tail_fade_ms: u64,
    min_first_deposit: u128,
}

impl Cfg {
    fn offsets(&self) -> Offsets {
        Offsets {
            round_ms: self.round_ms,
            guess_close_ms: self.guess_close_ms,
            propose_from_ms: self.propose_from_ms,
            propose_until_ms: self.propose_until_ms,
            close_from_ms: self.close_from_ms,
            tail_fade_ms: self.tail_fade_ms,
        }
    }
}

// ----- state ----------------------------------------------------------------------------------------

/// The BRAVE pool's books. No lending yet (`lending.mode` NONE): everything not in play is idle.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PoolBooks {
    /// BRAVE dollars: idle + in play. Pending money is not in it.
    pub brave_total: u128,
    /// Margin out on open bets (step 4 on).
    pub in_play: u128,
    /// Dollars waiting to become coins.
    pub pending_total: u128,
    /// Coins minted for depositors but not yet written to their balances, plus rounding dust that
    /// belongs to nobody. Part of the coin supply.
    pub unclaimed: u128,
    /// The epoch of the next conversion. An epoch is one round opening that turned pending money
    /// into coins; openings that convert nothing do not count.
    pub next_epoch: u64,
    /// Accounts (not this contract) with coins written to their balance.
    pub holders: u32,
    /// Accounts with no coins whose pending money waits for the next conversion.
    pub newcomers_next: u32,
    /// Accounts with no coins written yet whose money has been converted.
    pub newcomers_converted: u32,
}

/// One round, as stored.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RoundRec {
    pub id: u64,
    /// The grid slot it runs in (section 5).
    pub slot: u64,
    pub started_at: u64,
    pub settled: bool,
    pub rank: u8,
    pub status: u8,
    pub brave_at_open: u128,
    pub bets_used: u32,
    pub at_risk: u128,
    pub skipped: u32,
    pub refused: u32,
    /// Dollars back minus dollars out, once settled.
    pub result: i128,
}

/// What a boss has besides the coin balance. Kept within `ACCOUNT_STORAGE_BYTES`.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Extra {
    /// Dollars waiting to become coins.
    pub pending: u128,
    /// The epoch they convert in. Converted once `pending_epoch < books.next_epoch`.
    pub pending_epoch: u64,
    /// Had no coins when the money was paid in (for the `bosses` count).
    pub newcomer: bool,
    /// The first round in which this account held coins.
    pub joined_round: Option<u64>,
    /// Payouts or coin transfers still in flight; the account cannot unregister until they land.
    pub in_flight: u32,
}

/// Where the round opening that is due would leave things. Computed without writing, so views
/// can show it at once; the next transaction writes the same thing.
#[derive(Clone, Copy, Debug)]
struct Opening {
    /// The previous round, settled because it had no bet.
    closed: Option<RoundRec>,
    round: RoundRec,
    books: PoolBooks,
    mint: Option<Mint>,
}

#[derive(Clone, Copy, Debug)]
struct Mint {
    epoch: u64,
    rate: Rate,
    locked: u128,
}

/// The Intern's rank (`get_rank`). Codes: rank 0 INTERN 1 ANALYST 2 TRADER; status 0 EMPLOYED 1 FIRED.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RankRec {
    pub rank: u8,
    pub status: u8,
    pub since_round: u64,
    /// (rank, status, effective_round) of a passed promotion or rehire still waiting (step 5).
    pub pending: Option<(u8, u8, u64)>,
}

/// One bet (`get_positions`). Status codes: 0 APPROVED 1 OPEN_SIGNED 2 CLOSE_SIGNED 3 SETTLED.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PositionRec {
    pub id: u64,
    pub round_id: u64,
    pub market: u8,
    pub side: u8,
    pub margin: u128,
    pub leverage: u32,
    pub notional: u128,
    pub status: u8,
    pub approved_at: u64,
    pub open_signed_at: Option<u64>,
    pub close_signed_at: Option<u64>,
    pub settled_at: Option<u64>,
    pub sz_e8: Option<u128>,
    pub returned: Option<u128>,
    /// 0 REPORTED, 1 MEASURED
    pub result_source: Option<u8>,
}

/// One NOPE (`get_refusals`). `decision` is (market, side, margin, leverage) for checks 6-16.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RefusalRec {
    pub id: u64,
    pub round_id: u64,
    pub code: u8,
    pub at: u64,
    pub asked: Option<u128>,
    pub limit: Option<u128>,
    pub decision: Option<(u8, u8, u128, u32)>,
    pub is_first: bool,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Coin {
    cfg: Cfg,
    token: FungibleToken,
    extras: LookupMap<AccountId, Extra>,
    /// epoch -> (rate.pool, rate.supply, round id of that opening)
    rates: LookupMap<u64, (u128, u128, u64)>,
    rounds: LookupMap<u64, RoundRec>,
    current: Option<RoundRec>,
    books: PoolBooks,
    feed: Feed,
    // ----- step 4
    rank: RankRec,
    /// Moves after every ruling; with the round id it makes the nonce (section 6.1).
    nonce_counter: u64,
    positions: LookupMap<u64, PositionRec>,
    /// round id -> its position ids (at most `max_bets`, 3)
    round_positions: LookupMap<u64, Vec<u64>>,
    next_position_id: u64,
    refusals: LookupMap<u64, RefusalRec>,
    next_refusal_id: u64,
    /// For each of the sixteen codes, in check order: the round of its first refusal ever.
    firsts: Vec<Option<u64>>,
    /// A round whose settlement is waiting for the test dollars to be minted or burned.
    settling: Option<u64>,
    // ----- step 5
    locks: LookupMap<AccountId, LockRec>,
    locked_total: u128,
    /// round -> coins locked in that round and still locked (for the weight of all locked coins)
    locked_by_round: LookupMap<u64, u128>,
    votes: LookupMap<u64, VoteRec>,
    next_vote_id: u64,
    /// The open vote of each kind, in `rules::vote::VoteKind::ALL` order.
    open_by_kind: Vec<Option<u64>>,
    // ----- step 6
    /// Each boss's SAFE dollars.
    safe: LookupMap<AccountId, u128>,
    /// All SAFE dollars. Not lent yet (step 8): all idle.
    books_safe: u128,
    // ----- step 7
    pins: Pins,
    /// Signed actions, the last `sign::OUTBOX_KEEP`: ids outbox_first..outbox_next.
    outbox: LookupMap<u64, ActionRec>,
    outbox_first: u64,
    outbox_next: u64,
    /// position -> how far its signing has got (sign.rs)
    sign_stage: LookupMap<u64, u8>,
    last_hl_nonce: u64,
    // ----- step 9 (1.3)
    s9: Step9,
    playbooks: LookupMap<u64, PlaybookRec>,
    /// round -> the playbook active in it (for the coach cut)
    round_playbook: LookupMap<u64, u64>,
    /// SET_PLAYBOOK vote -> its playbook (0: clear)
    vote_playbook: LookupMap<u64, u64>,
    /// refusal -> the visitor the runner credited it to
    refusal_credit: LookupMap<u64, AccountId>,
    /// accounts whose badge is minted (or being minted)
    badges: LookupSet<AccountId>,
    goal_fills: LookupMap<u64, GoalFillRec>,
    goal_claims: LookupSet<(u64, AccountId)>,
    jar_tippers: LookupSet<(u64, AccountId)>,
    hype_riders: LookupSet<(u64, AccountId)>,
    // ----- 1.4: the reward ladder
    rw: rewards::Rewards,
    // ----- 1.5: the long shot (R6)
    ls: rewards::LongShot,
}

/// The 1.4 layout, read once by `migrate_long_shot`.
#[near(serializers = [borsh])]
pub struct CoinV9 {
    cfg: Cfg,
    token: FungibleToken,
    extras: LookupMap<AccountId, Extra>,
    /// epoch -> (rate.pool, rate.supply, round id of that opening)
    rates: LookupMap<u64, (u128, u128, u64)>,
    rounds: LookupMap<u64, RoundRec>,
    current: Option<RoundRec>,
    books: PoolBooks,
    feed: Feed,
    // ----- step 4
    rank: RankRec,
    /// Moves after every ruling; with the round id it makes the nonce (section 6.1).
    nonce_counter: u64,
    positions: LookupMap<u64, PositionRec>,
    /// round id -> its position ids (at most `max_bets`, 3)
    round_positions: LookupMap<u64, Vec<u64>>,
    next_position_id: u64,
    refusals: LookupMap<u64, RefusalRec>,
    next_refusal_id: u64,
    /// For each of the sixteen codes, in check order: the round of its first refusal ever.
    firsts: Vec<Option<u64>>,
    /// A round whose settlement is waiting for the test dollars to be minted or burned.
    settling: Option<u64>,
    // ----- step 5
    locks: LookupMap<AccountId, LockRec>,
    locked_total: u128,
    /// round -> coins locked in that round and still locked (for the weight of all locked coins)
    locked_by_round: LookupMap<u64, u128>,
    votes: LookupMap<u64, VoteRec>,
    next_vote_id: u64,
    /// The open vote of each kind, in `rules::vote::VoteKind::ALL` order.
    open_by_kind: Vec<Option<u64>>,
    // ----- step 6
    /// Each boss's SAFE dollars.
    safe: LookupMap<AccountId, u128>,
    /// All SAFE dollars. Not lent yet (step 8): all idle.
    books_safe: u128,
    // ----- step 7
    pins: Pins,
    /// Signed actions, the last `sign::OUTBOX_KEEP`: ids outbox_first..outbox_next.
    outbox: LookupMap<u64, ActionRec>,
    outbox_first: u64,
    outbox_next: u64,
    /// position -> how far its signing has got (sign.rs)
    sign_stage: LookupMap<u64, u8>,
    last_hl_nonce: u64,
    // ----- step 9 (1.3)
    s9: Step9,
    playbooks: LookupMap<u64, PlaybookRec>,
    /// round -> the playbook active in it (for the coach cut)
    round_playbook: LookupMap<u64, u64>,
    /// SET_PLAYBOOK vote -> its playbook (0: clear)
    vote_playbook: LookupMap<u64, u64>,
    /// refusal -> the visitor the runner credited it to
    refusal_credit: LookupMap<u64, AccountId>,
    /// accounts whose badge is minted (or being minted)
    badges: LookupSet<AccountId>,
    goal_fills: LookupMap<u64, GoalFillRec>,
    goal_claims: LookupSet<(u64, AccountId)>,
    jar_tippers: LookupSet<(u64, AccountId)>,
    hype_riders: LookupSet<(u64, AccountId)>,
    // ----- 1.4: the reward ladder
    rw: rewards::Rewards,
}

/// The layout before 1.4 (steps 8 and 9), read once by `migrate_rewards`.
#[near(serializers = [borsh])]
pub struct CoinV8 {
    cfg: Cfg,
    token: FungibleToken,
    extras: LookupMap<AccountId, Extra>,
    /// epoch -> (rate.pool, rate.supply, round id of that opening)
    rates: LookupMap<u64, (u128, u128, u64)>,
    rounds: LookupMap<u64, RoundRec>,
    current: Option<RoundRec>,
    books: PoolBooks,
    feed: Feed,
    // ----- step 4
    rank: RankRec,
    /// Moves after every ruling; with the round id it makes the nonce (section 6.1).
    nonce_counter: u64,
    positions: LookupMap<u64, PositionRec>,
    /// round id -> its position ids (at most `max_bets`, 3)
    round_positions: LookupMap<u64, Vec<u64>>,
    next_position_id: u64,
    refusals: LookupMap<u64, RefusalRec>,
    next_refusal_id: u64,
    /// For each of the sixteen codes, in check order: the round of its first refusal ever.
    firsts: Vec<Option<u64>>,
    /// A round whose settlement is waiting for the test dollars to be minted or burned.
    settling: Option<u64>,
    // ----- step 5
    locks: LookupMap<AccountId, LockRec>,
    locked_total: u128,
    /// round -> coins locked in that round and still locked (for the weight of all locked coins)
    locked_by_round: LookupMap<u64, u128>,
    votes: LookupMap<u64, VoteRec>,
    next_vote_id: u64,
    /// The open vote of each kind, in `rules::vote::VoteKind::ALL` order.
    open_by_kind: Vec<Option<u64>>,
    // ----- step 6
    /// Each boss's SAFE dollars.
    safe: LookupMap<AccountId, u128>,
    /// All SAFE dollars. Not lent yet (step 8): all idle.
    books_safe: u128,
    // ----- step 7
    pins: Pins,
    /// Signed actions, the last `sign::OUTBOX_KEEP`: ids outbox_first..outbox_next.
    outbox: LookupMap<u64, ActionRec>,
    outbox_first: u64,
    outbox_next: u64,
    /// position -> how far its signing has got (sign.rs)
    sign_stage: LookupMap<u64, u8>,
    last_hl_nonce: u64,
    // ----- step 9 (1.3)
    s9: Step9,
    playbooks: LookupMap<u64, PlaybookRec>,
    /// round -> the playbook active in it (for the coach cut)
    round_playbook: LookupMap<u64, u64>,
    /// SET_PLAYBOOK vote -> its playbook (0: clear)
    vote_playbook: LookupMap<u64, u64>,
    /// refusal -> the visitor the runner credited it to
    refusal_credit: LookupMap<u64, AccountId>,
    /// accounts whose badge is minted (or being minted)
    badges: LookupSet<AccountId>,
    goal_fills: LookupMap<u64, GoalFillRec>,
    goal_claims: LookupSet<(u64, AccountId)>,
    jar_tippers: LookupSet<(u64, AccountId)>,
    hype_riders: LookupSet<(u64, AccountId)>,
}

/// The step 7 layout, read once by `migrate`.
#[near(serializers = [borsh])]
pub struct CoinV7 {
    cfg: Cfg,
    token: FungibleToken,
    extras: LookupMap<AccountId, Extra>,
    rates: LookupMap<u64, (u128, u128, u64)>,
    rounds: LookupMap<u64, RoundRec>,
    current: Option<RoundRec>,
    books: PoolBooks,
    feed: Feed,
    rank: RankRec,
    nonce_counter: u64,
    positions: LookupMap<u64, PositionRec>,
    round_positions: LookupMap<u64, Vec<u64>>,
    next_position_id: u64,
    refusals: LookupMap<u64, RefusalRec>,
    next_refusal_id: u64,
    firsts: Vec<Option<u64>>,
    settling: Option<u64>,
    locks: LookupMap<AccountId, LockRec>,
    locked_total: u128,
    locked_by_round: LookupMap<u64, u128>,
    votes: LookupMap<u64, VoteRec>,
    next_vote_id: u64,
    open_by_kind: Vec<Option<u64>>,
    safe: LookupMap<AccountId, u128>,
    books_safe: u128,
    pins: Pins,
    outbox: LookupMap<u64, ActionRec>,
    outbox_first: u64,
    outbox_next: u64,
    sign_stage: LookupMap<u64, u8>,
    last_hl_nonce: u64,
}

/// The step 6 layout, read once by `migrate`.
#[near(serializers = [borsh])]
pub struct CoinV6 {
    cfg: Cfg,
    token: FungibleToken,
    extras: LookupMap<AccountId, Extra>,
    rates: LookupMap<u64, (u128, u128, u64)>,
    rounds: LookupMap<u64, RoundRec>,
    current: Option<RoundRec>,
    books: PoolBooks,
    feed: Feed,
    rank: RankRec,
    nonce_counter: u64,
    positions: LookupMap<u64, PositionRec>,
    round_positions: LookupMap<u64, Vec<u64>>,
    next_position_id: u64,
    refusals: LookupMap<u64, RefusalRec>,
    next_refusal_id: u64,
    firsts: Vec<Option<u64>>,
    settling: Option<u64>,
    locks: LookupMap<AccountId, LockRec>,
    locked_total: u128,
    locked_by_round: LookupMap<u64, u128>,
    votes: LookupMap<u64, VoteRec>,
    next_vote_id: u64,
    open_by_kind: Vec<Option<u64>>,
    safe: LookupMap<AccountId, u128>,
    books_safe: u128,
}

impl RankRec {
    fn start() -> Self {
        RankRec {
            rank: rank_code(Rank::Intern),
            status: status_code(Status::Employed),
            since_round: 1,
            pending: None,
        }
    }
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct PayInMsg {
    pool: Pool,
}

/// 1.3: `{"tip":{}}`
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct TipMsg {
    #[allow(dead_code)]
    tip: TipBody,
}
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub(crate) struct TipBody {}
/// 1.4: `{"jackpot":{}}`, a direct addition to the streak jackpot (the team's seed, a gift).
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct JackpotMsg {
    #[allow(dead_code)]
    jackpot: TipBody,
}

fn rank_code(r: Rank) -> u8 {
    r as u8
}
fn rank_of(c: u8) -> Rank {
    Rank::ALL[c as usize % 3]
}
fn status_code(s: Status) -> u8 {
    s as u8
}
fn status_of(c: u8) -> Status {
    Status::ALL[c as usize % 2]
}

// ----- internal -------------------------------------------------------------------------------------

impl Coin {
    fn me() -> AccountId {
        env::current_account_id()
    }

    fn now() -> u64 {
        // TEST ONLY: the sandbox build may fix the clock (round.rs, `test_set`).
        #[cfg(feature = "test-hooks")]
        if let Some(b) = env::storage_read(b"TEST_NOW") {
            return u64::from_le_bytes(b.try_into().expect("8 bytes"));
        }
        env::block_timestamp_ms()
    }

    fn bal(&self, who: &AccountId) -> u128 {
        self.token.accounts.get(who).unwrap_or(0)
    }

    fn registered(&self, who: &AccountId) -> bool {
        self.token.accounts.contains_key(who)
    }

    /// Coins in existence: written balances (including the locked units) plus unclaimed.
    fn supply(&self) -> u128 {
        self.token.total_supply + self.books.unclaimed
    }

    fn extra(&self, who: &AccountId) -> Extra {
        self.extras.get(who).cloned().unwrap_or_default()
    }

    fn save_extra(&mut self, who: &AccountId, x: Extra) {
        if x == Extra::default() {
            self.extras.remove(who);
        } else {
            self.extras.insert(who.clone(), x);
        }
    }

    /// Keeps `holders` right around a balance change.
    fn note_holder(&mut self, who: &AccountId, before: u128, after: u128) {
        if *who == Self::me() {
            return;
        }
        if before == 0 && after > 0 {
            self.books.holders += 1;
            self.check_boss_goal();
        } else if before > 0 && after == 0 {
            self.books.holders = self.books.holders.saturating_sub(1);
        }
    }

    /// The round opening that is due at `now`, if any (section 5). Pure: writes nothing.
    fn plan(&self, now: u64) -> Option<Opening> {
        let c = &self.cfg;
        let (slot, settled, closed) = match self.current {
            None => (None, true, None),
            Some(r) if r.settled => (Some(r.slot), true, None),
            // A round with no bet settles itself when the next one opens. (1.6: "no bet" means nothing at risk: a
            // round whose only bet is a long-shot ticket uses none of the rank's bets but must settle like any other.)
            Some(r) if r.bets_used == 0 && r.at_risk == 0 => (
                Some(r.slot),
                true,
                Some(RoundRec {
                    settled: true,
                    result: 0,
                    ..r
                }),
            ),
            Some(r) => (Some(r.slot), false, None),
        };
        let next = clock::next_slot(c.genesis_ms, c.round_ms, slot, settled, now)?;
        let mut books = self.books;
        // Step 8: outside income waiting since the last opening counts from this one, before pending
        // money converts (so the new money pays a price that includes it).
        books.brave_total += self.s9.income_waiting;
        let mint = match shares::open_round_mint(
            books.brave_total,
            self.supply(),
            books.pending_total,
            c.min_first_deposit,
        ) {
            Ok(OpenMint::Mint {
                rate,
                minted,
                locked,
            }) => {
                books.brave_total += books.pending_total;
                books.pending_total = 0;
                books.unclaimed += minted - locked;
                books.newcomers_converted += books.newcomers_next;
                books.newcomers_next = 0;
                let epoch = books.next_epoch;
                books.next_epoch += 1;
                Some(Mint {
                    epoch,
                    rate,
                    locked,
                })
            }
            // Nothing waiting, under the first minimum, or a pool that cannot price coins: the
            // money keeps waiting and can be taken back.
            _ => None,
        };
        // As they are when the round opens (section 8.1), a waiting promotion or rehire included.
        let (rank, status) = self.rank_codes_at(self.current.map_or(1, |r| r.id + 1));
        let round = RoundRec {
            id: self.current.map_or(1, |r| r.id + 1),
            slot: next.index,
            started_at: next.started_at,
            settled: false,
            rank,
            status,
            brave_at_open: books.brave_total,
            bets_used: 0,
            at_risk: 0,
            skipped: 0,
            refused: 0,
            result: 0,
        };
        Some(Opening {
            closed,
            round,
            books,
            mint,
        })
    }

    /// Opens the round that is due, if any. Called first by every call that changes something.
    fn tick(&mut self) {
        let Some(o) = self.plan(Self::now()) else {
            return;
        };
        let supply_before = self.supply(); // 1.7: for `round_opened`'s `minted`
        let locked_now = o.mint.as_ref().map_or(0, |m| m.locked);
        if let Some(prev) = o.closed {
            self.rounds.insert(prev.id, prev);
            self.feed.push(
                EventName::Settled,
                json!({"round_id": prev.id, "result": wire::I128(0), "brave_after": U128(self.books.brave_total)}),
            );
        }
        if let Some(m) = o.mint {
            self.rates
                .insert(m.epoch, (m.rate.pool, m.rate.supply, o.round.id));
            if m.locked > 0 {
                let me = Self::me();
                self.token.internal_deposit(&me, m.locked);
                FtMint {
                    owner_id: &me,
                    amount: U128(m.locked),
                    memo: Some("locked for ever"),
                }
                .emit();
            }
        }
        self.books = o.books;
        self.s9.income_waiting = 0; // in o.books now
        self.current = Some(o.round);
        self.rounds.insert(o.round.id, o.round);
        self.apply_due_rank(o.round.id);
        self.open_round_playbook(o.round.id);
        self.check_boss_goal();
        // 1.7 (Engine 2's finding): the coin supply after the opening and the coins it created (pending money
        // converted; at the very first conversion, `locked` of them locked for ever in the contract's own account),
        // so the supply can be followed from any event on, after older ones drop out of the 1,000 kept.
        let supply_after = self.supply();
        self.feed.push(
            EventName::RoundOpened,
            json!({"round_id": o.round.id, "rank": rank_of(o.round.rank), "status": status_of(o.round.status),
                   "brave_at_open": U128(o.round.brave_at_open), "coin_supply": U128(supply_after),
                   "minted": U128(supply_after.saturating_sub(supply_before)), "locked": U128(locked_now)}),
        );
        self.auto_on_open(o.round.id); // 1.7: the brake and the term, after the round's own event
    }

    /// Writes an account's converted pending money into its coin balance (1.1: lazily, per account).
    fn materialize(&mut self, who: &AccountId) {
        let mut x = self.extra(who);
        if x.pending == 0 || x.pending_epoch >= self.books.next_epoch {
            return;
        }
        let (pool, supply, round_id) = *self
            .rates
            .get(&x.pending_epoch)
            .expect("every converted epoch has a rate");
        let coins = shares::convert(x.pending, Rate { pool, supply });
        self.books.unclaimed = self
            .books
            .unclaimed
            .checked_sub(coins)
            .expect("never more than was minted");
        if x.newcomer {
            self.books.newcomers_converted = self.books.newcomers_converted.saturating_sub(1);
            x.newcomer = false;
        }
        x.pending = 0;
        if coins > 0 {
            let before = self.bal(who);
            self.token.internal_deposit(who, coins);
            self.note_holder(who, before, before + coins);
            x.joined_round.get_or_insert(round_id);
            FtMint {
                owner_id: who,
                amount: U128(coins),
                memo: None,
            }
            .emit();
            self.feed.push(
                EventName::CoinsMinted,
                json!({"account_id": who, "coins": U128(coins), "round_id": round_id}),
            );
        }
        self.save_extra(who, x);
    }

    /// Adds dollars to an account's BRAVE money waiting for the next round. The caller has written
    /// any earlier conversion (`materialize`) first.
    pub(crate) fn add_pending(&mut self, who: &AccountId, amount: u128) {
        let mut x = self.extra(who);
        if x.pending == 0 {
            x.pending_epoch = self.books.next_epoch;
            if self.bal(who) == 0 {
                x.newcomer = true;
                self.books.newcomers_next += 1;
            }
        }
        x.pending += amount;
        self.books.pending_total += amount;
        self.save_extra(who, x);
    }

    /// Sends `amount` USDC to `who`, then checks it in `on_payout`.
    fn payout(&self, who: &AccountId, amount: u128, pool: Pool, coins: Option<U128>) -> Promise {
        ext_ft_core::ext(self.cfg.usdc_token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_PAYOUT)
            .ft_transfer(
                who.clone(),
                U128(amount),
                Some("$INTERN cash-out".to_string()),
            )
            .then(
                Self::ext(Self::me())
                    .with_static_gas(GAS_ON_PAYOUT)
                    .on_payout(who.clone(), pool, coins, U128(amount)),
            )
    }

    // ----- what the views show: the state with any due opening applied, written or not

    fn projected(&self) -> (RoundRec, PoolBooks, Option<Mint>, u128) {
        match self.plan(Self::now()) {
            Some(o) => {
                let supply =
                    self.token.total_supply + o.mint.map_or(0, |m| m.locked) + o.books.unclaimed;
                (o.round, o.books, o.mint, supply)
            }
            None => (
                self.current.expect("a round is always open after init"),
                self.books,
                None,
                self.supply(),
            ),
        }
    }

    /// (coins, still pending, joined_round) for an account, as the views show it.
    fn projected_account(&self, who: &AccountId) -> (u128, u128, Option<u64>) {
        let (round, _, mint, _) = self.projected();
        let x = self.extra(who);
        let mut coins = self.bal(who);
        let mut joined = x.joined_round;
        let mut pending = 0;
        if x.pending > 0 {
            if x.pending_epoch < self.books.next_epoch {
                let (p, s, rid) = *self.rates.get(&x.pending_epoch).expect("rate");
                let c = shares::convert(x.pending, Rate { pool: p, supply: s });
                coins += c;
                if c > 0 {
                    joined.get_or_insert(rid);
                }
            } else if let Some(m) = mint.filter(|m| m.epoch == x.pending_epoch) {
                let c = shares::convert(x.pending, m.rate);
                coins += c;
                if c > 0 {
                    joined.get_or_insert(round.id);
                }
            } else {
                pending = x.pending;
            }
        }
        (coins, pending, joined)
    }

    fn round_view(&self, r: &RoundRec) -> wire::Round {
        let c = self.cfg.offsets();
        let t = clock::times(&c, r.started_at).expect("times fit");
        let now = Self::now();
        let phase = match clock::phase_at(&c, now.saturating_sub(r.started_at)) {
            clock::Phase::Open => wire::Phase::Open,
            clock::Phase::Propose => wire::Phase::Propose,
            clock::Phase::Hold => wire::Phase::Hold,
            clock::Phase::Close => wire::Phase::Close,
        };
        wire::Round {
            id: r.id,
            phase,
            settled: r.settled,
            stuck: clock::is_stuck(r.settled, now, t.ends_at),
            started_at: t.started_at,
            guess_closes_at: t.guess_closes_at,
            propose_from: t.propose_from,
            propose_until: t.propose_until,
            close_from: t.close_from,
            ends_at: t.ends_at,
            rank: rank_of(r.rank),
            status: status_of(r.status),
            brave_at_open: U128(r.brave_at_open),
            bets_used: r.bets_used,
            at_risk: U128(r.at_risk),
            skipped: r.skipped,
            refused: r.refused,
            result: r.settled.then_some(wire::I128(r.result)),
        }
    }

    fn storage_min() -> NearToken {
        env::storage_byte_cost().saturating_mul(ACCOUNT_STORAGE_BYTES as u128)
    }
}

// ----- the contract -----------------------------------------------------------------------------------

#[near]
impl Coin {
    #[init]
    pub fn new(config: InitConfig) -> Self {
        let r = &config.round;
        let cfg = Cfg {
            usdc_token: config.usdc_token,
            runner: config.runner,
            genesis_ms: r.genesis_ms,
            round_ms: r.round_ms,
            guess_close_ms: r.guess_close_ms,
            propose_from_ms: r.propose_from_ms,
            propose_until_ms: r.propose_until_ms,
            close_from_ms: r.close_from_ms,
            tail_fade_ms: r.tail_fade_ms,
            min_first_deposit: config.min_first_deposit.0,
        };
        require!(cfg.offsets().is_valid(), "round offsets out of order");
        require!(cfg.genesis_ms <= Self::now(), "genesis_ms is in the future");
        require!(
            cfg.min_first_deposit > shares::LOCKED_FOREVER,
            "min_first_deposit must exceed the 1,000 locked units"
        );
        require!(
            cfg.usdc_token != Self::me(),
            "the coin cannot be its own dollar"
        );
        let stickers = config.stickers.clone().unwrap_or_else(Self::me);
        let launchpad = config.launchpad.clone().unwrap_or_else(Self::me);
        let lender = config.lender.clone();
        let mut token = FungibleToken::new(Key::Token);
        token.internal_register_account(&Self::me()); // holds the locked units
        let mut c = Coin {
            cfg,
            token,
            extras: LookupMap::new(Key::Extras),
            rates: LookupMap::new(Key::Rates),
            rounds: LookupMap::new(Key::Rounds),
            current: None,
            books: PoolBooks::default(),
            feed: Feed::new(Key::Feed),
            rank: RankRec::start(),
            nonce_counter: 0,
            positions: LookupMap::new(Key::Positions),
            round_positions: LookupMap::new(Key::RoundPositions),
            next_position_id: 1,
            refusals: LookupMap::new(Key::Refusals),
            next_refusal_id: 1,
            firsts: vec![None; 16],
            settling: None,
            locks: LookupMap::new(Key::Locks),
            locked_total: 0,
            locked_by_round: LookupMap::new(Key::LockedByRound),
            votes: LookupMap::new(Key::Votes),
            next_vote_id: 1,
            open_by_kind: vec![None; rules::vote::VoteKind::ALL.len()],
            safe: LookupMap::new(Key::Safe),
            books_safe: 0,
            pins: config.pins.map_or_else(Pins::unset, Pins::from_init),
            outbox: LookupMap::new(Key::Outbox),
            outbox_first: 1,
            outbox_next: 1,
            sign_stage: LookupMap::new(Key::SignStage),
            last_hl_nonce: 0,
            s9: Step9::new(stickers, launchpad, lender),
            playbooks: LookupMap::new(Key::Playbooks),
            round_playbook: LookupMap::new(Key::RoundPlaybook),
            vote_playbook: LookupMap::new(Key::VotePlaybook),
            refusal_credit: LookupMap::new(Key::RefusalCredit),
            badges: LookupSet::new(Key::Badges),
            goal_fills: LookupMap::new(Key::GoalFills),
            goal_claims: LookupSet::new(Key::GoalClaims),
            jar_tippers: LookupSet::new(Key::JarTippers),
            hype_riders: LookupSet::new(Key::HypeRiders),
            rw: rewards::Rewards::new(0),
            ls: rewards::LongShot::default(),
        };
        c.tick(); // round 1
        c
    }

    /// Upgrades a step 7 contract in place (testnet), keeping everything. Adds steps 8 and 9 (1.3):
    /// lending and outside income; playbooks, credited refusals, claims, goals and tips, with the
    /// sticker, launchpad and lender contracts. Only the contract account itself may call it.
    #[private]
    #[init(ignore_state)]
    pub fn migrate(stickers: AccountId, launchpad: AccountId, lender: Option<AccountId>) -> Self {
        let o: CoinV7 =
            env::state_read().unwrap_or_else(|| env::panic_str("no step 7 state to migrate"));
        Coin {
            cfg: o.cfg,
            token: o.token,
            extras: o.extras,
            rates: o.rates,
            rounds: o.rounds,
            current: o.current,
            books: o.books,
            feed: o.feed,
            rank: o.rank,
            nonce_counter: o.nonce_counter,
            positions: o.positions,
            round_positions: o.round_positions,
            next_position_id: o.next_position_id,
            refusals: o.refusals,
            next_refusal_id: o.next_refusal_id,
            firsts: o.firsts,
            settling: o.settling,
            locks: o.locks,
            locked_total: o.locked_total,
            locked_by_round: o.locked_by_round,
            votes: o.votes,
            next_vote_id: o.next_vote_id,
            open_by_kind: o.open_by_kind,
            safe: o.safe,
            books_safe: o.books_safe,
            pins: o.pins,
            outbox: o.outbox,
            outbox_first: o.outbox_first,
            outbox_next: o.outbox_next,
            sign_stage: o.sign_stage,
            last_hl_nonce: o.last_hl_nonce,
            s9: Step9::new(stickers, launchpad, lender),
            playbooks: LookupMap::new(Key::Playbooks),
            round_playbook: LookupMap::new(Key::RoundPlaybook),
            vote_playbook: LookupMap::new(Key::VotePlaybook),
            refusal_credit: LookupMap::new(Key::RefusalCredit),
            badges: LookupSet::new(Key::Badges),
            goal_fills: LookupMap::new(Key::GoalFills),
            goal_claims: LookupSet::new(Key::GoalClaims),
            jar_tippers: LookupSet::new(Key::JarTippers),
            hype_riders: LookupSet::new(Key::HypeRiders),
            rw: rewards::Rewards::new(o.current.map_or(0, |r| r.id)),
            ls: rewards::LongShot::default(),
        }
    }

    /// Upgrades a 1.3 contract in place (testnet), keeping everything, and adds the reward ladder (1.4): the
    /// free guess, golden stickers, the streak jackpot and the payday draw. Only the contract account may call it.
    #[private]
    #[init(ignore_state)]
    pub fn migrate_rewards() -> Self {
        let o: CoinV8 =
            env::state_read().unwrap_or_else(|| env::panic_str("no 1.3 state to migrate"));
        let start = o.current.map_or(0, |r| r.id);
        Coin {
            cfg: o.cfg,
            token: o.token,
            extras: o.extras,
            rates: o.rates,
            rounds: o.rounds,
            current: o.current,
            books: o.books,
            feed: o.feed,
            rank: o.rank,
            nonce_counter: o.nonce_counter,
            positions: o.positions,
            round_positions: o.round_positions,
            next_position_id: o.next_position_id,
            refusals: o.refusals,
            next_refusal_id: o.next_refusal_id,
            firsts: o.firsts,
            settling: o.settling,
            locks: o.locks,
            locked_total: o.locked_total,
            locked_by_round: o.locked_by_round,
            votes: o.votes,
            next_vote_id: o.next_vote_id,
            open_by_kind: o.open_by_kind,
            safe: o.safe,
            books_safe: o.books_safe,
            pins: o.pins,
            outbox: o.outbox,
            outbox_first: o.outbox_first,
            outbox_next: o.outbox_next,
            sign_stage: o.sign_stage,
            last_hl_nonce: o.last_hl_nonce,
            s9: o.s9,
            playbooks: o.playbooks,
            round_playbook: o.round_playbook,
            vote_playbook: o.vote_playbook,
            refusal_credit: o.refusal_credit,
            badges: o.badges,
            goal_fills: o.goal_fills,
            goal_claims: o.goal_claims,
            jar_tippers: o.jar_tippers,
            hype_riders: o.hype_riders,
            rw: rewards::Rewards::new(start),
            ls: rewards::LongShot::default(),
        }
    }

    /// Upgrades a 1.4 contract in place (testnet), keeping everything, and adds the long shot (1.5, R6): the
    /// LONG_SHOT vote and its one ticket. Only the contract account may call it.
    #[private]
    #[init(ignore_state)]
    pub fn migrate_long_shot() -> Self {
        let mut o: CoinV9 =
            env::state_read().unwrap_or_else(|| env::panic_str("no 1.4 state to migrate"));
        while o.open_by_kind.len() < rules::vote::VoteKind::ALL.len() {
            o.open_by_kind.push(None);
        }
        Coin {
            cfg: o.cfg,
            token: o.token,
            extras: o.extras,
            rates: o.rates,
            rounds: o.rounds,
            current: o.current,
            books: o.books,
            feed: o.feed,
            rank: o.rank,
            nonce_counter: o.nonce_counter,
            positions: o.positions,
            round_positions: o.round_positions,
            next_position_id: o.next_position_id,
            refusals: o.refusals,
            next_refusal_id: o.next_refusal_id,
            firsts: o.firsts,
            settling: o.settling,
            locks: o.locks,
            locked_total: o.locked_total,
            locked_by_round: o.locked_by_round,
            votes: o.votes,
            next_vote_id: o.next_vote_id,
            open_by_kind: o.open_by_kind,
            safe: o.safe,
            books_safe: o.books_safe,
            pins: o.pins,
            outbox: o.outbox,
            outbox_first: o.outbox_first,
            outbox_next: o.outbox_next,
            sign_stage: o.sign_stage,
            last_hl_nonce: o.last_hl_nonce,
            s9: o.s9,
            playbooks: o.playbooks,
            round_playbook: o.round_playbook,
            vote_playbook: o.vote_playbook,
            refusal_credit: o.refusal_credit,
            badges: o.badges,
            goal_fills: o.goal_fills,
            goal_claims: o.goal_claims,
            jar_tippers: o.jar_tippers,
            hype_riders: o.hype_riders,
            rw: o.rw,
            ls: rewards::LongShot::default(),
        }
    }

    // ===== section 9.1: money ========================================================================

    /// Pay in, called by the USDC token after `ft_transfer_call(coin, amount, '{"pool":"BRAVE"}')`.
    /// Returns the amount *not* used: the whole amount (a full refund) for any other token, an
    /// unregistered sender, a bad message, or a first deposit under the minimum.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let refund = PromiseOrValue::Value(amount);
        // Any single payment above $1 trillion is refunded, so no total can ever overflow.
        if env::predecessor_account_id() != self.cfg.usdc_token || amount.0 == 0 || amount.0 > MAX_PAYMENT {
            return refund;
        }
        if let Ok(lending::IncomeMsg { income }) = serde_json::from_str(&msg) {
            // (Income may come from a contract that holds no coins, like the launchpad: no registration needed.)
            // Step 8: outside income, only while the Intern is EMPLOYED.
            self.tick();
            if !lending::valid_source(&income.source) || self.rank_now().1 != Status::Employed {
                env::log_str("outside income is taken only while the Intern is EMPLOYED, with a source of 1-32 [a-z0-9_-]: refunded");
                return refund;
            }
            self.take_income(&income.source, amount.0);
            return PromiseOrValue::Value(U128(0));
        }
        // 1.7: a paid trick (half to the bounty, half to the pool), and additions to the trick bounty.
        if let Ok(tricks::TrickMsg { trick }) = serde_json::from_str(&msg) {
            return PromiseOrValue::Value(U128(self.take_trick_payment(&sender_id, &trick.id, amount.0)));
        }
        if let Ok(challenge::ChallengeMsg { challenge }) = serde_json::from_str(&msg) {
            return PromiseOrValue::Value(U128(self.take_challenge(&sender_id, challenge, amount.0)));
        }
        if serde_json::from_str::<rescue::RescueMsg>(&msg).is_ok() {
            return PromiseOrValue::Value(U128(self.take_rescue(&sender_id, amount.0)));
        }
        if serde_json::from_str::<tricks::BountyMsg>(&msg).is_ok() {
            if amount.0 < goals::MIN_TIP {
                env::log_str("an addition to the bounty is at least 1 USDC: refunded");
                return refund;
            }
            self.tick();
            self.add_bounty(&sender_id, amount.0);
            return PromiseOrValue::Value(U128(0));
        }
        if serde_json::from_str::<JackpotMsg>(&msg).is_ok() {
            // 1.4: anyone may add to the jackpot (it stores nothing per account), at least 1 USDC.
            if amount.0 < goals::MIN_TIP {
                env::log_str("an addition to the jackpot is at least 1 USDC: refunded");
                return refund;
            }
            self.tick();
            self.rw_add(&sender_id, amount.0);
            return PromiseOrValue::Value(U128(0));
        }
        if !self.registered(&sender_id) {
            return refund;
        }
        if serde_json::from_str::<TipMsg>(&msg).is_ok() {
            // 1.3: a tip, a gift to the BRAVE pool.
            if amount.0 < goals::MIN_TIP {
                env::log_str("a tip is at least 1 USDC: refunded");
                return refund;
            }
            self.tick();
            self.take_tip(&sender_id, amount.0);
            return PromiseOrValue::Value(U128(0));
        }
        let Ok(PayInMsg { pool }) = serde_json::from_str::<PayInMsg>(&msg) else {
            return refund;
        };
        self.tick();
        if pool == Pool::Safe {
            // Credited at once. No coin, no vote, never in brave_at_open.
            if self.books_safe.checked_add(amount.0).is_none() {
                return refund;
            }
            self.credit_safe(&sender_id, amount.0);
            self.feed.push(EventName::PaidIn, json!({"account_id": sender_id, "pool": Pool::Safe, "amount": amount, "pending": false}));
            return PromiseOrValue::Value(U128(0));
        }
        self.materialize(&sender_id);
        // Section 9.1: the first deposit ever into BRAVE must be at least min_first_deposit.
        if self.supply() == 0
            && self.books.pending_total == 0
            && amount.0 < self.cfg.min_first_deposit
        {
            env::log_str("first deposit under min_first_deposit: refunded");
            return refund;
        }
        if self.books.pending_total.checked_add(amount.0).is_none() {
            return refund;
        }
        self.add_pending(&sender_id, amount.0);
        self.feed.push(EventName::PaidIn, json!({"account_id": sender_id, "pool": Pool::Brave, "amount": amount, "pending": true}));
        if amount.0 >= rules::limits::MIN_NOTIONAL {
            self.hype_point(&sender_id); // 1.3
        }
        PromiseOrValue::Value(U128(0))
    }

    /// Cash out, 1 yocto, at least 60 TGas. BRAVE: burns `amount` coins and pays their share of what
    /// the pool holds outside open bets (1.1). With `pending: true`, `amount` is dollars taken back
    /// from money still waiting. SAFE: `amount` is dollars, paid at once. Never blocked by the round's phase.
    #[payable]
    pub fn cash_out(&mut self, pool: Pool, amount: U128, pending: Option<bool>) -> Promise {
        assert_one_yocto();
        require!(
            env::prepaid_gas() >= GAS_CASH_OUT_MIN,
            "attach at least 60 TGas so a failed payout can be put back"
        );
        require!(amount.0 > 0, "amount must be above 0");
        let who = env::predecessor_account_id();
        require!(self.registered(&who), "not registered");
        self.tick();
        if pool == Pool::Safe {
            require!(!pending.unwrap_or(false), "pending is for BRAVE only");
            self.debit_safe(&who, amount.0);
            let mut x = self.extra(&who);
            x.in_flight += 1;
            self.save_extra(&who, x);
            return self.payout(&who, amount.0, Pool::Safe, None);
        }
        self.materialize(&who);
        let mut x = self.extra(&who);
        if pending.unwrap_or(false) {
            require!(
                x.pending_epoch == self.books.next_epoch && x.pending >= amount.0,
                "not that much is waiting"
            );
            x.pending -= amount.0;
            self.books.pending_total -= amount.0;
            if x.pending == 0 && x.newcomer {
                x.newcomer = false;
                self.books.newcomers_next = self.books.newcomers_next.saturating_sub(1);
            }
            x.in_flight += 1;
            self.save_extra(&who, x);
            return self.payout(&who, amount.0, Pool::Brave, None);
        }
        let coins = amount.0;
        let before = self.bal(&who);
        require!(coins <= before, "not that many coins");
        require!(
            coins <= before - self.locked_of(&who),
            "locked coins cannot be cashed out: unlock them first"
        );
        let held = shares::held(self.books.brave_total, self.books.in_play);
        let paid = shares::redeem(coins, held, self.supply())
            .unwrap_or_else(|_| env::panic_str("cannot price these coins"));
        require!(paid > 0, "too few coins to pay out anything");
        let idle = self.idle(); // step 8: what is not lent and not in play
                                // State first.
        self.token.internal_withdraw(&who, coins);
        self.note_holder(&who, before, before - coins);
        FtBurn {
            owner_id: &who,
            amount,
            memo: Some("cash-out"),
        }
        .emit();
        self.books.brave_total -= paid;
        x.in_flight += 1;
        self.save_extra(&who, x);
        if paid > idle {
            // Step 8: the rest is lent out; it comes back first, then the payout is made.
            return self.withdraw_then(&who, paid - idle, paid, amount, lending::Then::CashOut);
        }
        self.payout(&who, paid, Pool::Brave, Some(amount))
    }

    /// Callback of a payout. Success: logs `cashed_out`. Failure: puts everything back as it was.
    #[private]
    pub fn on_payout(
        &mut self,
        account_id: AccountId,
        pool: Pool,
        coins: Option<U128>,
        paid: U128,
    ) -> bool {
        let ok = !matches!(
            env::promise_result_checked(0, 64),
            Err(PromiseError::Failed)
        );
        let mut x = self.extra(&account_id);
        x.in_flight = x.in_flight.saturating_sub(1);
        self.save_extra(&account_id, x);
        if ok {
            self.feed.push(
                EventName::CashedOut,
                json!({"account_id": account_id, "pool": pool, "coins": coins, "paid": paid}),
            );
            return true;
        }
        match coins {
            Some(c) => {
                let before = self.bal(&account_id);
                self.token.internal_deposit(&account_id, c.0);
                self.note_holder(&account_id, before, before + c.0);
                FtMint {
                    owner_id: &account_id,
                    amount: c,
                    memo: Some("cash-out failed: put back"),
                }
                .emit();
                self.books.brave_total += paid.0;
            }
            None if pool == Pool::Safe => self.credit_safe(&account_id, paid.0),
            None => {
                // Back to waiting. If a round converted this account's money meanwhile, write that
                // first so the returned dollars wait for the next conversion.
                self.materialize(&account_id);
                self.add_pending(&account_id, paid.0);
            }
        }
        env::log_str(&format!(
            "payout of {} to {account_id} failed: put back",
            paid.0
        ));
        false
    }

    // ----- NEP-141: coin transfers (locked coins cannot move: step 5)

    #[payable]
    pub fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        let sender = env::predecessor_account_id();
        require!(
            receiver_id != Self::me(),
            "coins cannot be sent to the coin contract"
        );
        self.tick();
        self.materialize(&sender);
        self.materialize(&receiver_id);
        let (sb, rb) = (self.bal(&sender), self.bal(&receiver_id));
        require!(
            amount.0 <= sb.saturating_sub(self.locked_of(&sender)),
            "locked coins cannot be moved: unlock them first"
        );
        self.token.ft_transfer(receiver_id.clone(), amount, memo);
        self.after_transfer(&sender, sb, &receiver_id, rb);
    }

    #[payable]
    pub fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let sender = env::predecessor_account_id();
        require!(
            receiver_id != Self::me(),
            "coins cannot be sent to the coin contract"
        );
        self.tick();
        self.materialize(&sender);
        self.materialize(&receiver_id);
        let (sb, rb) = (self.bal(&sender), self.bal(&receiver_id));
        require!(
            amount.0 <= sb.saturating_sub(self.locked_of(&sender)),
            "locked coins cannot be moved: unlock them first"
        );
        let p = self
            .token
            .ft_transfer_call(receiver_id.clone(), amount, memo, msg);
        self.after_transfer(&sender, sb, &receiver_id, rb);
        let mut x = self.extra(&sender);
        x.in_flight += 1; // until ft_resolve_transfer, so a refund always has somewhere to go
        self.save_extra(&sender, x);
        p
    }

    #[private]
    pub fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let (sb, rb) = (self.bal(&sender_id), self.bal(&receiver_id));
        let (used, burned) =
            self.token
                .internal_ft_resolve_transfer(&sender_id, receiver_id.clone(), amount);
        let (sa, ra) = (self.bal(&sender_id), self.bal(&receiver_id));
        self.note_holder(&sender_id, sb, sa);
        self.note_holder(&receiver_id, rb, ra);
        if burned > 0 {
            FtBurn {
                owner_id: &receiver_id,
                amount: U128(burned),
                memo: Some("refund to an unregistered sender"),
            }
            .emit();
        }
        let mut x = self.extra(&sender_id);
        x.in_flight = x.in_flight.saturating_sub(1);
        self.save_extra(&sender_id, x);
        U128(used)
    }

    // ----- NEP-145

    /// Registers `account_id` (default: the caller). Needs `storage_balance_bounds().min`; the rest
    /// is refunded. Registering again refunds everything.
    #[payable]
    pub fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> wire::StorageBalance {
        let _ = registration_only; // min = max: there is never anything extra to keep
        let who = account_id.unwrap_or_else(env::predecessor_account_id);
        let attached = env::attached_deposit();
        let min = Self::storage_min();
        let refund = if self.registered(&who) {
            attached
        } else {
            require!(
                attached >= min,
                "attach at least storage_balance_bounds().min"
            );
            self.token.internal_register_account(&who);
            attached.saturating_sub(min)
        };
        if !refund.is_zero() {
            Promise::new(env::predecessor_account_id())
                .transfer(refund)
                .detach();
        }
        wire::StorageBalance {
            total: U128(min.as_yoctonear()),
            available: U128(0),
        }
    }

    /// Nothing is ever available to withdraw (min = max).
    #[payable]
    pub fn storage_withdraw(&mut self, amount: Option<U128>) -> wire::StorageBalance {
        assert_one_yocto();
        let who = env::predecessor_account_id();
        require!(self.registered(&who), "not registered");
        require!(
            amount.is_none_or(|a| a.0 == 0),
            "nothing is available to withdraw"
        );
        wire::StorageBalance {
            total: U128(Self::storage_min().as_yoctonear()),
            available: U128(0),
        }
    }

    /// Unregisters the caller and returns the registration deposit, only when they hold nothing:
    /// no coins, no pending money, nothing in flight. `force` is not supported (it would burn
    /// coins and hand their share to everyone else).
    #[payable]
    pub fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        assert_one_yocto();
        let _ = force;
        let who = env::predecessor_account_id();
        if !self.registered(&who) {
            return false;
        }
        self.tick();
        self.materialize(&who);
        let x = self.extra(&who);
        require!(
            self.bal(&who) == 0 && x.pending == 0 && x.in_flight == 0 && self.safe_of(&who) == 0,
            "cash out everything first"
        );
        self.token.accounts.remove(&who);
        self.extras.remove(&who);
        self.locks.remove(&who); // no coins means nothing locked; drops old vote ids
        Promise::new(who).transfer(Self::storage_min()).detach();
        true
    }

    // ===== section 8: views ===========================================================================

    pub fn get_constants(&self) -> wire::Constants {
        let c = &self.cfg;
        wire::Constants {
            interface_version: wire::INTERFACE_VERSION.to_string(),
            network: wire::Network::Testnet,
            usdc_token: c.usdc_token.clone(),
            coin_decimals: 6,
            ranks: Rank::ALL.into_iter().map(Self::limits_view).collect(),
            markets: rules::limits::MARKETS
                .iter()
                .map(|m| wire::MarketInfo {
                    market: m.market,
                    hl_name: m.hl_name.to_string(),
                    hl_asset: m.testnet_asset,
                    sz_decimals: m.sz_decimals,
                })
                .collect(),
            min_notional: U128(rules::limits::MIN_NOTIONAL),
            round: wire::RoundConstants {
                genesis_ms: c.genesis_ms,
                round_ms: c.round_ms,
                guess_close_ms: c.guess_close_ms,
                propose_from_ms: c.propose_from_ms,
                propose_until_ms: c.propose_until_ms,
                close_from_ms: c.close_from_ms,
                tail_fade_ms: c.tail_fade_ms,
            },
            vote: wire::VoteConstants {
                promote_pass_bps: rules::vote::RULES.promote_pass_bps,
                promote_quorum_bps: rules::vote::RULES.promote_quorum_bps,
                tighten_pass_bps: rules::vote::RULES.tighten_pass_bps,
                vote_ms: c.round_ms,
                weight_full_rounds: rules::vote::RULES.weight_full_rounds,
            },
            // The pinned model; a stand-in build names its stand-in, so nobody mistakes it for the real one.
            model: self.model_view(),
            funding: wire::FundingConstants {
                mode: wire::FundingMode::Recorded,
                quote_signer: "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc".to_string(),
                quote_max_age_ms: 60_000,
                max_funding_cost_bps: 400,
            },
            result_source: wire::ResultSource::Reported,
            lending: wire::LendingConstants {
                lender: self.s9.lender.clone(),
                mode: if self.s9.lender.is_some() {
                    wire::LendingMode::Standin
                } else {
                    wire::LendingMode::None
                },
            },
            hl: wire::HlConstants {
                testnet: self.pins.testnet,
                address: self.pins.hl_address.clone(),
                signer_contract: self.pins.signer_contract.clone(),
                path: self.pins.path.clone(),
                order_expiry_ms: self.pins.order_expiry_ms,
            },
            runner: c.runner.clone(),
            min_first_deposit: U128(c.min_first_deposit),
            refusal_codes: Refusal::ALL.to_vec(),
            coach_cut_bps: playbook::COACH_CUT_BPS,
            goals: wire::GoalConstants {
                boss_ladder: goals::BOSS_LADDER.to_vec(),
                tip_jar_target: U128(goals::TIP_JAR_TARGET),
                min_tip: U128(goals::MIN_TIP),
                hype_window_ms: goals::HYPE_WINDOW_MS,
                hype_levels: goals::HYPE_LEVELS.to_vec(),
            },
            stickers: self.s9.stickers.clone(),
            launchpad: self.s9.launchpad.clone(),
        }
    }

    pub fn get_limits(&self, rank: Rank) -> wire::Limits {
        Self::limits_view(rank)
    }

    pub fn get_round(&self) -> wire::Round {
        let (r, ..) = self.projected();
        self.round_view(&r)
    }

    pub fn get_round_by_id(&self, round_id: u64) -> Option<wire::Round> {
        if let Some(o) = self.plan(Self::now()) {
            if o.round.id == round_id {
                return Some(self.round_view(&o.round));
            }
            if let Some(prev) = o.closed.filter(|p| p.id == round_id) {
                return Some(self.round_view(&prev));
            }
        }
        self.rounds.get(&round_id).map(|r| self.round_view(r))
    }

    pub fn get_pot(&self) -> wire::Pot {
        let (_, b, _, supply) = self.projected();
        let lent = self.s9.lent + self.s9.lend_in_flight;
        let waiting = if self.plan(Self::now()).is_some() {
            0
        } else {
            self.s9.income_waiting
        };
        wire::Pot {
            brave: wire::BravePot {
                total: U128(b.brave_total),
                lent: U128(lent),
                in_play: U128(b.in_play),
                idle: U128(b.brave_total.saturating_sub(lent + b.in_play)),
                pending: U128(b.pending_total),
                interest: U128(self.s9.interest_total),
                income_waiting: U128(waiting),
            },
            safe: wire::SafePot {
                total: U128(self.books_safe),
                lent: U128(0),
                idle: U128(self.books_safe),
            },
            coin_supply: U128(supply),
            coin_price_e6: U128(shares::coin_price_e6(b.brave_total, b.in_play, supply)),
            bosses: b.holders + b.newcomers_converted,
            outside_income_total: U128(self.s9.outside_income_total),
        }
    }

    pub fn get_account(&self, account_id: AccountId) -> wire::Account {
        let registered = self.registered(&account_id);
        let (coins, pending, joined) = self.projected_account(&account_id);
        let (r, b, _, supply) = self.projected();
        let (locked, weight) = (
            self.locked_of(&account_id),
            self.weight_of(&account_id, r.id),
        );
        let safe = self.safe_of(&account_id);
        wire::Account {
            account_id,
            registered,
            coin: U128(coins),
            locked: U128(locked),
            brave_value: U128(shares::brave_value(coins, b.brave_total, b.in_play, supply)),
            pending_brave: U128(pending),
            safe: U128(safe),
            joined_round: joined,
            vote_weight: U128(weight),
        }
    }

    pub fn get_feed(&self, after_seq: Option<u64>, limit: Option<u32>) -> Vec<wire::FeedItem> {
        self.feed.page(after_seq, limit)
    }

    // ----- token views

    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.projected_account(&account_id).0)
    }

    pub fn ft_total_supply(&self) -> U128 {
        U128(self.projected().3)
    }

    pub fn ft_metadata(&self) -> wire::FtMetadata {
        wire::FtMetadata {
            spec: "ft-1.0.0".to_string(),
            name: "$INTERN (testnet)".to_string(),
            symbol: "INTERN".to_string(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 6,
        }
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<wire::StorageBalance> {
        self.registered(&account_id).then(|| wire::StorageBalance {
            total: U128(Self::storage_min().as_yoctonear()),
            available: U128(0),
        })
    }

    pub fn storage_balance_bounds(&self) -> wire::StorageBalanceBounds {
        let min = U128(Self::storage_min().as_yoctonear());
        wire::StorageBalanceBounds {
            min,
            max: Some(min),
        }
    }
}

impl Coin {
    fn limits_view(rank: Rank) -> wire::Limits {
        let l = rules::limits::limits(rank);
        wire::Limits {
            rank,
            per_bet_bps: l.per_bet_bps,
            max_bets: l.max_bets,
            per_round_bps: l.per_round_bps,
            sides: l.sides.to_vec(),
            max_leverage: l.max_leverage,
            markets: l.markets.to_vec(),
        }
    }

    fn after_transfer(&mut self, sender: &AccountId, sb: u128, receiver: &AccountId, rb: u128) {
        let (sa, ra) = (self.bal(sender), self.bal(receiver));
        self.note_holder(sender, sb, sa);
        self.note_holder(receiver, rb, ra);
        if ra > rb {
            let round = self.current.map(|r| r.id);
            let mut x = self.extra(receiver);
            if x.joined_round.is_none() {
                x.joined_round = round;
                self.save_extra(receiver, x);
            }
        }
    }
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_later;
#[cfg(test)]
mod tests_rewards;
#[cfg(test)]
mod tests_round;
#[cfg(test)]
mod tests_safe;
#[cfg(test)]
mod tests_sign;
#[cfg(test)]
mod tests_vote;
#[cfg(test)]
mod tests_weekly;
#[cfg(test)]
mod tests_auto;
