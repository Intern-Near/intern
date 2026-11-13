//! The JSON shapes of `01-SHARED-INTERFACE.md` (version 1.1) sections 8, 9 and 10, as Rust types.
//!
//! Field names and enum spellings are the interface's, exactly. `U128` is NEAR's decimal-string
//! number ("20000000", never a JSON number); `I128` is the interface's `Signed`. `Ms` and the
//! other `number` fields are plain JSON numbers.
//!
//! The five enums the engines share (`Rank`, `Status`, `Market`, `Side`, `Refusal`) come from the
//! `shared` crate with its `serde` feature.

#![forbid(unsafe_code)]

use near_sdk::json_types::U128;
use near_sdk::serde::{de, Deserialize, Deserializer, Serialize, Serializer};
use near_sdk::serde_json::{self, Value};
use near_sdk::AccountId;
pub use shared::{Market, Rank, Refusal, Side, Status};

/// The interface version these shapes follow.
pub const INTERFACE_VERSION: &str = "1.7";

// ----- numbers --------------------------------------------------------------------------------

/// The interface's `Signed`: a whole number as a decimal string that may start with "-".
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Default, Hash)]
pub struct I128(pub i128);

impl Serialize for I128 {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.0.to_string())
    }
}

impl<'de> Deserialize<'de> for I128 {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let text = String::deserialize(d)?;
        let n: i128 = text.parse().map_err(de::Error::custom)?;
        if n.to_string() != text {
            return Err(de::Error::custom("not a plain decimal string"));
        }
        Ok(I128(n))
    }
}

// ----- enums that only the program and the site use ----------------------------------------------

macro_rules! wire_enum {
    ($case:literal, $name:ident { $($v:ident),+ $(,)? }) => {
        #[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
        #[serde(crate = "near_sdk::serde", rename_all = $case)]
        pub enum $name { $($v),+ }
    };
}

wire_enum!(
    "SCREAMING_SNAKE_CASE",
    Phase {
        Open,
        Propose,
        Hold,
        Close
    }
);
wire_enum!("SCREAMING_SNAKE_CASE", Pool { Brave, Safe });
wire_enum!(
    "SCREAMING_SNAKE_CASE",
    PositionStatus {
        Approved,
        OpenSigned,
        CloseSigned,
        Settled
    }
);
wire_enum!("SCREAMING_SNAKE_CASE", ResultSource { Reported, Measured, Abandoned /* 1.7: booked as lost by `abandon` */ });
wire_enum!(
    "SCREAMING_SNAKE_CASE",
    ActionKind {
        Leverage,
        Open,
        Close
    }
);
wire_enum!(
    "SCREAMING_SNAKE_CASE",
    VoteKind {
        Promote,
        Demote,
        Fire,
        Rehire,
        SetPlaybook,
        // 1.5 (R6)
        LongShot,
        // 1.7
        Renew
    }
);
wire_enum!(
    "SCREAMING_SNAKE_CASE",
    VoteState {
        Open,
        Passed,
        Failed
    }
);
wire_enum!("SCREAMING_SNAKE_CASE", FundingMode { Recorded, Oneclick });
wire_enum!(
    "SCREAMING_SNAKE_CASE",
    LendingMode {
        None,
        Standin,
        Rhea
    }
);
wire_enum!("lowercase", Network { Testnet, Mainnet });
wire_enum!("lowercase", SigningAlgo { Ecdsa, Ed25519 });
wire_enum!(
    "snake_case",
    EventName {
        RoundOpened,
        PaidIn,
        CoinsMinted,
        CashedOut,
        DialTurned,
        Locked,
        Unlocked,
        Skipped,
        Refused,
        Approved,
        OrderSigned,
        ResultReported,
        Settled,
        VoteOpened,
        VoteCast,
        VoteFinished,
        RankChanged,
        Fired,
        Rehired,
        OutsideIncome,
        // 1.3
        PlaybookSubmitted,
        PlaybookActivated,
        CoachPaid,
        Tipped,
        GoalFilled,
        HypeLevel,
        StickerClaimed,
        // 1.4
        Guessed,
        GuessSettled,
        GoldenDropped,
        JackpotGrew,
        JackpotWon,
        DrawHeld,
        PrizePaid,
        // 1.5
        LongShotAllowed,
        // 1.6
        LeagueClosed,
        ReviewWritten,
        ReviewBarFilled,
        // 1.7
        StrikesOut,
        BrakeOn,
        BrakeOff,
        TermLapsed,
        TermRenewed,
        Abandoned,
        StreakBanked,
        TrickPaid,
        BountyGrew,
        BountyPaid,
        RescueGrew,
        Rescued,
        RescuePaid,
        NftEarningsClaimed,
    }
);

// ----- section 8.1 --------------------------------------------------------------------------------

macro_rules! wire_struct {
    ($name:ident { $($field:ident : $ty:ty),+ $(,)? }) => {
        #[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
        #[serde(crate = "near_sdk::serde", deny_unknown_fields)]
        pub struct $name { $(pub $field: $ty),+ }
    };
}

wire_struct!(Limits {
    rank: Rank, per_bet_bps: u32, max_bets: u32, per_round_bps: u32,
    sides: Vec<Side>, max_leverage: u32, markets: Vec<Market>,
});
wire_struct!(MarketInfo {
    market: Market,
    hl_name: String,
    hl_asset: u32,
    sz_decimals: u8
});
wire_struct!(RoundConstants {
    genesis_ms: u64,
    round_ms: u64,
    guess_close_ms: u64,
    propose_from_ms: u64,
    propose_until_ms: u64,
    close_from_ms: u64,
    tail_fade_ms: u64,
});
wire_struct!(VoteConstants {
    promote_pass_bps: u32,
    promote_quorum_bps: u32,
    tighten_pass_bps: u32,
    vote_ms: u64,
    weight_full_rounds: u32,
});
wire_struct!(ModelPin {
    id: String,
    signing_algo: SigningAlgo,
    signer: String
});
wire_struct!(FundingConstants {
    mode: FundingMode,
    quote_signer: String,
    quote_max_age_ms: u64,
    max_funding_cost_bps: u32,
});
// 1.7: `lender` names the lending contract (null with no lending), so a books check needs no other source.
wire_struct!(LendingConstants { mode: LendingMode, lender: Option<AccountId> });
wire_struct!(HlConstants {
    testnet: bool,
    address: String,
    signer_contract: AccountId,
    path: String,
    order_expiry_ms: u64,
});
wire_struct!(Constants {
    interface_version: String,
    network: Network,
    usdc_token: AccountId,
    coin_decimals: u8,
    ranks: Vec<Limits>,
    markets: Vec<MarketInfo>,
    min_notional: U128,
    round: RoundConstants,
    vote: VoteConstants,
    model: ModelPin,
    funding: FundingConstants,
    result_source: ResultSource,
    lending: LendingConstants,
    hl: HlConstants,
    runner: AccountId,
    min_first_deposit: U128,
    refusal_codes: Vec<Refusal>,
    // 1.3
    coach_cut_bps: u32,
    goals: GoalConstants,
    stickers: AccountId,
    launchpad: AccountId,
});

wire_struct!(GoalConstants {
    boss_ladder: Vec<u64>,
    tip_jar_target: U128,
    min_tip: U128,
    hype_window_ms: u64,
    hype_levels: Vec<u32>,
});

wire_struct!(PendingRank {
    rank: Rank,
    status: Status,
    effective_round: u64
});
wire_struct!(RankState { rank: Rank, status: Status, since_round: u64, pending: Option<PendingRank> });

wire_struct!(Round {
    id: u64, phase: Phase, settled: bool, stuck: bool,
    started_at: u64, guess_closes_at: u64, propose_from: u64, propose_until: u64, close_from: u64, ends_at: u64,
    rank: Rank, status: Status,
    brave_at_open: U128,
    bets_used: u32, at_risk: U128, skipped: u32, refused: u32,
    result: Option<I128>,
});

wire_struct!(Rulebook {
    round_id: u64,
    nonce: String,
    text: String
});

wire_struct!(Position {
    id: u64, round_id: u64, market: Market, side: Side,
    margin: U128, leverage: u32, notional: U128,
    status: PositionStatus,
    approved_at: u64, open_signed_at: Option<u64>, close_signed_at: Option<u64>, settled_at: Option<u64>,
    sz_e8: Option<U128>,
    returned: Option<U128>, result: Option<I128>,
    result_source: Option<ResultSource>,
});

wire_struct!(EcdsaSignature {
    r: String,
    s: String,
    v: u8
});
wire_struct!(SignedAction {
    id: u64,
    position_id: u64,
    kind: ActionKind,
    action: Value,
    nonce: u64,
    expires_after: u64,
    signature: EcdsaSignature,
    created_at: u64,
});

wire_struct!(BravePot {
    total: U128,
    lent: U128,
    in_play: U128,
    idle: U128,
    pending: U128,
    // 1.3 (step 8)
    interest: U128,
    income_waiting: U128,
});
wire_struct!(SafePot {
    total: U128,
    lent: U128,
    idle: U128
});
wire_struct!(Pot {
    brave: BravePot,
    safe: SafePot,
    coin_supply: U128,
    coin_price_e6: U128,
    bosses: u32,
    outside_income_total: U128,
});

wire_struct!(Account {
    account_id: AccountId, registered: bool,
    coin: U128, locked: U128, brave_value: U128, pending_brave: U128, safe: U128,
    joined_round: Option<u64>,
    vote_weight: U128,
});

wire_struct!(Vote {
    id: u64, kind: VoteKind, playbook_id: Option<u64>, opened_by: AccountId,
    opened_at: u64, closes_at: u64,
    yes: U128, no: U128, locked_weight_at_open: U128,
    state: VoteState, effective_round: Option<u64>,
});

/// `{ action: "SKIP" } | { action: "BET", market, side, margin, leverage }`
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(
    crate = "near_sdk::serde",
    tag = "action",
    rename_all = "SCREAMING_SNAKE_CASE",
    deny_unknown_fields
)]
pub enum Decision {
    Skip,
    Bet {
        market: Market,
        side: Side,
        margin: U128,
        leverage: u32,
    },
}

// The interface's `Refusal` record (the code alone is `shared::Refusal`, the TS `RefusalCode`).
wire_struct!(RefusalRecord {
    id: u64, round_id: u64, code: Refusal, at: u64,
    asked: Option<U128>, limit: Option<U128>,
    decision: Option<Decision>,
    is_first: bool,
    credited_to: Option<AccountId>,
});

wire_struct!(Author {
    account_id: AccountId,
    share_bps: u32
});
wire_struct!(Playbook {
    id: u64, text: String, authors: Vec<Author>, submitted_round: u64,
    active_from: Option<u64>, paid_total: U128,
});

wire_struct!(StickerFirst { code: Refusal, account_id: Option<AccountId>, round_id: Option<u64>, claimed: bool });

// ----- 1.3: goals and claims (section 9.5) ------------------------------------------------------------

wire_enum!("SCREAMING_SNAKE_CASE", GoalKind { Boss, TipJar, Hype });
wire_struct!(BossGoal { level: u32, target: Option<u64>, now: u64 });
wire_struct!(TipJar {
    jar: u64,
    target: U128,
    now: U128
});
wire_struct!(Hype { train: u64, level: u32, points: u32, ends_at: Option<u64> });
wire_struct!(Goals {
    boss: BossGoal,
    tip_jar: TipJar,
    hype: Hype
});
wire_struct!(GoalFill {
    id: u64,
    goal: GoalKind,
    level: u32,
    at: u64,
    round_id: u64
});
wire_struct!(Claimable { badge: bool, originals: Vec<Refusal>, goal_fills: Vec<u64> });

wire_struct!(FeedItem {
    seq: u64,
    at: u64,
    event: EventName,
    data: Value
});

// ----- section 9 ----------------------------------------------------------------------------------

/// `{ verdict: "YES", position_id } | { verdict: "SKIP" } | { verdict: "NOPE", refusal_id, code, asked, limit }`
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(
    crate = "near_sdk::serde",
    tag = "verdict",
    rename_all = "SCREAMING_SNAKE_CASE",
    deny_unknown_fields
)]
pub enum Verdict {
    Yes {
        position_id: u64,
    },
    Skip,
    Nope {
        refusal_id: u64,
        code: Refusal,
        asked: Option<U128>,
        limit: Option<U128>,
    },
}

wire_struct!(Funding {
    quote: String,
    signature: String
});

// ----- standards the coin also speaks ---------------------------------------------------------------

wire_struct!(StorageBalance {
    total: U128,
    available: U128
});
wire_struct!(StorageBalanceBounds { min: U128, max: Option<U128> });
wire_struct!(FtMetadata {
    spec: String, name: String, symbol: String,
    icon: Option<String>, reference: Option<String>, reference_hash: Option<String>,
    decimals: u8,
});

// ----- section 10: the event log line -----------------------------------------------------------------

/// The NEP-297 log line of section 10:
/// `EVENT_JSON:{"standard":"intern","version":"1.0.0","event":"<name>","data":[{…}]}`
pub fn event_log(event: EventName, data: &Value) -> String {
    let name = serde_json::to_string(&event).expect("an enum name always serializes");
    format!(
        r#"EVENT_JSON:{{"standard":"intern","version":"1.0.0","event":{name},"data":[{data}]}}"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::serde_json::json;

    #[test]
    fn signed_numbers_are_strings_both_ways() {
        assert_eq!(
            serde_json::to_value(I128(-2_500_000)).unwrap(),
            json!("-2500000")
        );
        assert_eq!(
            serde_json::to_value(I128(1_800_000)).unwrap(),
            json!("1800000")
        );
        assert_eq!(
            serde_json::from_value::<I128>(json!("-2500000")).unwrap(),
            I128(-2_500_000)
        );
        assert!(serde_json::from_value::<I128>(json!(5)).is_err());
        assert!(serde_json::from_value::<I128>(json!("+5")).is_err());
        assert!(serde_json::from_value::<I128>(json!("05")).is_err());
    }

    #[test]
    fn enums_use_the_interface_spellings() {
        assert_eq!(
            serde_json::to_value(PositionStatus::OpenSigned).unwrap(),
            json!("OPEN_SIGNED")
        );
        assert_eq!(
            serde_json::to_value(VoteKind::SetPlaybook).unwrap(),
            json!("SET_PLAYBOOK")
        );
        assert_eq!(
            serde_json::to_value(FundingMode::Oneclick).unwrap(),
            json!("ONECLICK")
        );
        assert_eq!(
            serde_json::to_value(LendingMode::Standin).unwrap(),
            json!("STANDIN")
        );
        assert_eq!(
            serde_json::to_value(Network::Testnet).unwrap(),
            json!("testnet")
        );
        assert_eq!(
            serde_json::to_value(SigningAlgo::Ed25519).unwrap(),
            json!("ed25519")
        );
        assert_eq!(
            serde_json::to_value(EventName::ResultReported).unwrap(),
            json!("result_reported")
        );
        assert_eq!(
            serde_json::to_value(Refusal::OverTradeLimit).unwrap(),
            json!("OVER_TRADE_LIMIT")
        );
        assert_eq!(
            serde_json::to_value(Rank::Analyst).unwrap(),
            json!("ANALYST")
        );
        assert!(serde_json::from_value::<Market>(json!("doge")).is_err());
    }

    #[test]
    fn tagged_unions_match_section_8_and_9() {
        assert_eq!(
            serde_json::to_value(Decision::Skip).unwrap(),
            json!({"action":"SKIP"})
        );
        let bet = Decision::Bet {
            market: Market::Doge,
            side: Side::Long,
            margin: U128(20_000_000),
            leverage: 1,
        };
        assert_eq!(
            serde_json::to_value(&bet).unwrap(),
            json!({"action":"BET","market":"DOGE","side":"LONG","margin":"20000000","leverage":1})
        );
        assert_eq!(
            serde_json::to_value(Verdict::Yes { position_id: 7 }).unwrap(),
            json!({"verdict":"YES","position_id":7})
        );
        assert_eq!(
            serde_json::to_value(Verdict::Skip).unwrap(),
            json!({"verdict":"SKIP"})
        );
        let nope = Verdict::Nope {
            refusal_id: 31,
            code: Refusal::Fired,
            asked: None,
            limit: None,
        };
        assert_eq!(
            serde_json::to_value(nope).unwrap(),
            json!({"verdict":"NOPE","refusal_id":31,"code":"FIRED","asked":null,"limit":null})
        );
    }

    #[test]
    fn the_event_log_line_has_the_nep297_form() {
        let line = event_log(EventName::Skipped, &json!({"round_id": 42}));
        assert_eq!(
            line,
            r#"EVENT_JSON:{"standard":"intern","version":"1.0.0","event":"skipped","data":[{"round_id":42}]}"#
        );
    }
}

/// `px_e8` for `sign_next` and `close`: a decimal string (1.2), like `sz_e8`; a JSON number is also
/// accepted. Must be above 0.
pub struct PxE8(pub u64);

impl<'de> Deserialize<'de> for PxE8 {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(crate = "near_sdk::serde", untagged)]
        enum Either {
            Num(u64),
            Str(String),
        }
        let v = match Either::deserialize(d)? {
            Either::Num(n) => n,
            Either::Str(s) => s.parse().map_err(de::Error::custom)?,
        };
        if v == 0 {
            return Err(de::Error::custom("px_e8 must be above 0"));
        }
        Ok(PxE8(v))
    }
}

impl Serialize for PxE8 {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_u64(self.0)
    }
}
