//! The ten canned scenes. Every time is an offset from a round boundary, so a scene drawn on the
//! real-product clock with round 42 starting at 1794355200000 reproduces the section 8.2 samples,
//! and the same scene on the 30-minute demo clock has the same story, faster.
//!
//! One story runs through round 42: the round opens, a boss pays in for the next round, the Intern
//! is refused twice (NOT_ON_LIST, then OVER_TRADE_LIMIT), then approved for $20 long DOGE, the
//! order is signed, and the bet is closed and settled. Each scene is a moment in that story, or a
//! side branch (an open vote, a promotion, a firing).

use near_sdk::json_types::U128;
use near_sdk::near;
use near_sdk::serde_json::{json, Value};
use near_sdk::AccountId;
use wire::*;

#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scene {
    Quiet,
    Refused,
    Approved,
    Holding,
    SettledWin,
    SettledLoss,
    VoteOpen,
    Promoted,
    Fired,
    Stuck,
}

impl Scene {
    pub const ALL: [Scene; 10] = [
        Scene::Quiet,
        Scene::Refused,
        Scene::Approved,
        Scene::Holding,
        Scene::SettledWin,
        Scene::SettledLoss,
        Scene::VoteOpen,
        Scene::Promoted,
        Scene::Fired,
        Scene::Stuck,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Scene::Quiet => "QUIET",
            Scene::Refused => "REFUSED",
            Scene::Approved => "APPROVED",
            Scene::Holding => "HOLDING",
            Scene::SettledWin => "SETTLED_WIN",
            Scene::SettledLoss => "SETTLED_LOSS",
            Scene::VoteOpen => "VOTE_OPEN",
            Scene::Promoted => "PROMOTED",
            Scene::Fired => "FIRED",
            Scene::Stuck => "STUCK",
        }
    }

    pub fn parse(s: &str) -> Option<Scene> {
        Scene::ALL.into_iter().find(|x| x.as_str() == s)
    }
}

/// The round offsets a scene is drawn with (section 5).
#[derive(Clone, Copy, Debug)]
pub struct Clock {
    pub round_ms: u64,
    pub guess_close_ms: u64,
    pub propose_from_ms: u64,
    pub propose_until_ms: u64,
    pub close_from_ms: u64,
    pub tail_fade_ms: u64,
}

/// The demo deployment's 30-minute round (section 5, `PROPOSED`).
pub const DEMO: Clock = Clock {
    round_ms: 1_800_000,
    guess_close_ms: 840_000,
    propose_from_ms: 900_000,
    propose_until_ms: 1_200_000,
    close_from_ms: 1_500_000,
    tail_fade_ms: 600_000,
};

/// The real product's 24-hour round. Used by the tests that compare with section 8.2.
pub const REAL: Clock = Clock {
    round_ms: 86_400_000,
    guess_close_ms: 42_900_000,
    propose_from_ms: 43_200_000,
    propose_until_ms: 46_800_000,
    close_from_ms: 79_200_000,
    tail_fade_ms: 600_000,
};

/// How far into the round "now" is at the moment a scene is switched on. Puts the moment inside
/// the scene's phase, just after the scene's last event.
pub fn scene_point(scene: Scene, c: &Clock) -> u64 {
    match scene {
        Scene::Quiet | Scene::VoteOpen | Scene::Promoted => c.propose_from_ms / 3,
        Scene::Refused => c.propose_from_ms + 30_000,
        Scene::Approved => c.propose_from_ms + 90_000,
        Scene::Fired => c.propose_from_ms + 120_000,
        Scene::Holding => c.propose_until_ms + 60_000,
        Scene::SettledWin | Scene::SettledLoss => c.close_from_ms + 120_000,
        Scene::Stuck => c.round_ms + 300_000,
    }
}

/// The round id each scene shows.
pub fn round_id(scene: Scene) -> u64 {
    if scene == Scene::Promoted {
        45
    } else {
        42
    }
}

/// Everything the views show for a scene.
pub struct SceneData {
    pub round: Round,
    pub rank: RankState,
    pub positions: Vec<Position>,
    /// Oldest first, ids rising.
    pub outbox: Vec<SignedAction>,
    pub pot: Pot,
    /// Newest first.
    pub votes: Vec<Vote>,
    /// Newest first.
    pub refusals: Vec<RefusalRecord>,
    pub firsts: Vec<StickerFirst>,
    /// The scene's feed, oldest first: (at, event, data).
    pub story: Vec<(u64, EventName, Value)>,
}

pub const BOSS: &str = "boss.testnet";
pub const BOSS2: &str = "boss2.testnet";
pub const MARGIN: u128 = 20_000_000;
pub const DOGE_TESTNET_ASSET: u32 = 173;
pub const SUPPLY: u128 = 1_000_000_000;

fn acct(s: &str) -> AccountId {
    s.parse().expect("valid account id")
}

/// Dollars per whole coin, 6 decimals, not counting margin out on open bets (section 9.1, 1.1).
pub fn coin_price_e6(brave_total: u128, in_play: u128, supply: u128) -> u128 {
    if supply == 0 {
        return 1_000_000;
    }
    (brave_total - in_play) * 1_000_000 / supply
}

fn pot(scene: Scene) -> Pot {
    // (total, lent, in_play, idle, pending, supply, bosses)
    let (total, lent, in_play, idle, pending, supply, bosses): (
        u128,
        u128,
        u128,
        u128,
        u128,
        u128,
        u32,
    ) = match scene {
        Scene::Quiet | Scene::Refused | Scene::VoteOpen | Scene::Fired => {
            (1_000_000_000, 1_000_000_000, 0, 0, 50_000_000, SUPPLY, 23)
        }
        Scene::Approved | Scene::Holding | Scene::Stuck => (
            1_000_000_000,
            980_000_000,
            MARGIN,
            0,
            50_000_000,
            SUPPLY,
            23,
        ),
        Scene::SettledWin => (
            1_001_800_000,
            980_000_000,
            0,
            21_800_000,
            50_000_000,
            SUPPLY,
            23,
        ),
        Scene::SettledLoss => (
            997_500_000,
            980_000_000,
            0,
            17_500_000,
            50_000_000,
            SUPPLY,
            23,
        ),
        // Rounds 43-45: the $50 waiting since round 42 became 49,910,161 coins at round 43's price
        // ($1.0018 after the win), and the pool was lent in full.
        Scene::Promoted => (
            1_051_800_000,
            1_051_800_000,
            0,
            0,
            0,
            SUPPLY + 49_910_161,
            24,
        ),
    };
    Pot {
        brave: BravePot {
            total: U128(total),
            lent: U128(lent),
            in_play: U128(in_play),
            idle: U128(idle),
            pending: U128(pending),
            interest: U128(0),
            income_waiting: U128(0),
        },
        safe: SafePot {
            total: U128(400_000_000),
            lent: U128(400_000_000),
            idle: U128(0),
        },
        coin_supply: U128(supply),
        coin_price_e6: U128(coin_price_e6(total, in_play, supply)),
        bosses,
        outside_income_total: U128(0),
    }
}

fn bet(market: Market, margin: u128) -> Decision {
    Decision::Bet {
        market,
        side: Side::Long,
        margin: U128(margin),
        leverage: 1,
    }
}

fn fake_signature(id: u64) -> EcdsaSignature {
    // Not a signature. The stub never asks NEAR's signing network for anything.
    EcdsaSignature {
        r: format!("0x{:064x}", 0x5757_0000 + id),
        s: format!("0x{:064x}", 0x5151_0000 + id),
        v: 27,
    }
}

fn signed(id: u64, kind: ActionKind, at: u64) -> SignedAction {
    let action = match kind {
        ActionKind::Leverage => {
            json!({"type":"updateLeverage","asset":DOGE_TESTNET_ASSET,"isCross":false,"leverage":1})
        }
        ActionKind::Open => {
            json!({"type":"order","orders":[{"a":DOGE_TESTNET_ASSET,"b":true,"p":"0.06826","s":"293","r":false,"t":{"limit":{"tif":"Ioc"}}}],"grouping":"na"})
        }
        ActionKind::Close => {
            json!({"type":"order","orders":[{"a":DOGE_TESTNET_ASSET,"b":false,"p":"0.06","s":"293","r":true,"t":{"limit":{"tif":"Ioc"}}}],"grouping":"na"})
        }
    };
    SignedAction {
        id,
        position_id: 7,
        kind,
        action,
        nonce: at,
        expires_after: at + 120_000,
        signature: fake_signature(id),
        created_at: at,
    }
}

/// Builds a scene on clock `c`, with the shown round starting at `started_at`.
pub fn build(scene: Scene, c: &Clock, started_at: u64) -> SceneData {
    use Scene::*;
    let s = started_at;
    let r = c.round_ms;
    let id = round_id(scene);
    // Round 42's start: the shown round, or three rounds back for PROMOTED (round 45).
    let s42 = s - (id - 42) * r;
    let pf = s42 + c.propose_from_ms;
    let cf = s42 + c.close_from_ms;

    let phase = match scene {
        Quiet | VoteOpen | Promoted => Phase::Open,
        Refused | Approved | Fired => Phase::Propose,
        Holding => Phase::Hold,
        SettledWin | SettledLoss | Stuck => Phase::Close,
    };
    let has_bet = matches!(scene, Approved | Holding | SettledWin | SettledLoss | Stuck);
    let refused_count: u32 = match scene {
        Refused | Approved | Holding | SettledWin | SettledLoss | Stuck => 2,
        Fired => 1,
        _ => 0,
    };
    let (returned, result): (Option<u128>, Option<i128>) = match scene {
        SettledWin => (Some(21_800_000), Some(1_800_000)),
        SettledLoss => (Some(17_500_000), Some(-2_500_000)),
        _ => (None, None),
    };
    let rank_now = if scene == Promoted {
        Rank::Analyst
    } else {
        Rank::Intern
    };
    let pot = pot(scene);

    let round = Round {
        id,
        phase,
        settled: matches!(scene, SettledWin | SettledLoss),
        stuck: scene == Stuck,
        started_at: s,
        guess_closes_at: s + c.guess_close_ms,
        propose_from: s + c.propose_from_ms,
        propose_until: s + c.propose_until_ms,
        close_from: s + c.close_from_ms,
        ends_at: s + r,
        rank: rank_now,
        status: Status::Employed,
        brave_at_open: if scene == Promoted {
            pot.brave.total
        } else {
            U128(1_000_000_000)
        },
        bets_used: has_bet as u32,
        at_risk: U128(if has_bet { MARGIN } else { 0 }),
        skipped: 0,
        refused: refused_count,
        result: result.map(I128),
    };

    let rank = match scene {
        Promoted => RankState {
            rank: Rank::Analyst,
            status: Status::Employed,
            since_round: 45,
            pending: None,
        },
        Fired => RankState {
            rank: Rank::Intern,
            status: Status::Fired,
            since_round: 42,
            pending: None,
        },
        _ => RankState {
            rank: Rank::Intern,
            status: Status::Employed,
            since_round: 1,
            pending: None,
        },
    };

    let positions = if has_bet {
        let (status, open_signed_at, close_signed_at, settled_at, sz) = match scene {
            Approved => (PositionStatus::Approved, None, None, None, None),
            Holding => (
                PositionStatus::OpenSigned,
                Some(pf + 81_000),
                None,
                None,
                Some(U128(29_300_000_000)),
            ),
            Stuck => (
                PositionStatus::CloseSigned,
                Some(pf + 81_000),
                Some(cf + 5_000),
                None,
                Some(U128(29_300_000_000)),
            ),
            _ => (
                PositionStatus::Settled,
                Some(pf + 81_000),
                Some(cf + 5_000),
                Some(cf + 60_000),
                Some(U128(29_300_000_000)),
            ),
        };
        vec![Position {
            id: 7,
            round_id: 42,
            market: Market::Doge,
            side: Side::Long,
            margin: U128(MARGIN),
            leverage: 1,
            notional: U128(MARGIN),
            status,
            approved_at: pf + 60_000,
            open_signed_at,
            close_signed_at,
            settled_at,
            sz_e8: sz,
            returned: returned.map(U128),
            result: result.map(I128),
            result_source: returned.map(|_| ResultSource::Reported),
        }]
    } else {
        vec![]
    };

    let outbox = match scene {
        Holding => vec![
            signed(13, ActionKind::Leverage, pf + 71_000),
            signed(14, ActionKind::Open, pf + 81_000),
        ],
        SettledWin | SettledLoss | Stuck => vec![
            signed(13, ActionKind::Leverage, pf + 71_000),
            signed(14, ActionKind::Open, pf + 81_000),
            signed(15, ActionKind::Close, cf + 5_000),
        ],
        _ => vec![],
    };

    // ----- votes, newest first
    let old_vote = Vote {
        id: 3,
        kind: VoteKind::Promote,
        playbook_id: None,
        opened_by: acct(BOSS2),
        opened_at: s42 - 10 * r + 60_000,
        closes_at: s42 - 9 * r + 60_000,
        yes: U128(40_000_000),
        no: U128(90_000_000),
        locked_weight_at_open: U128(280_000_000),
        state: VoteState::Failed,
        effective_round: None,
    };
    let vote4 = |kind, yes: u128, no: u128, state, effective_round| Vote {
        id: 4,
        kind,
        playbook_id: None,
        opened_by: acct(BOSS),
        opened_at: s42 + 60_000,
        closes_at: s42 + 60_000 + r,
        yes: U128(yes),
        no: U128(no),
        locked_weight_at_open: U128(300_000_000),
        state,
        effective_round,
    };
    let votes = match scene {
        VoteOpen => vec![
            vote4(
                VoteKind::Promote,
                100_000_000,
                15_000_000,
                VoteState::Open,
                None,
            ),
            old_vote,
        ],
        Promoted => vec![
            vote4(
                VoteKind::Promote,
                160_000_000,
                15_000_000,
                VoteState::Passed,
                Some(45),
            ),
            old_vote,
        ],
        Fired => vec![
            vote4(VoteKind::Fire, 110_000_000, 0, VoteState::Passed, Some(42)),
            old_vote,
        ],
        _ => vec![old_vote],
    };

    // ----- refusals, newest first
    let r28 = RefusalRecord {
        id: 28,
        round_id: 40,
        code: Refusal::MalformedDecision,
        at: s42 - 2 * r + c.propose_from_ms + 10_000,
        asked: None,
        limit: None,
        decision: None,
        is_first: false,
        credited_to: None,
    };
    let r29 = RefusalRecord {
        id: 29,
        round_id: 41,
        code: Refusal::ZeroMargin,
        at: s42 - r + c.propose_from_ms + 15_000,
        asked: Some(U128(5_000_000)),
        limit: Some(U128(rules::limits::MIN_NOTIONAL)),
        decision: Some(bet(Market::Pepe, 5_000_000)),
        is_first: false,
        credited_to: None,
    };
    let r30 = RefusalRecord {
        id: 30,
        round_id: 42,
        code: Refusal::NotOnList,
        at: pf + 5_000,
        asked: None,
        limit: None,
        decision: Some(bet(Market::Wif, MARGIN)),
        is_first: false,
        credited_to: None,
    };
    let r31 = RefusalRecord {
        id: 31,
        round_id: 42,
        code: Refusal::OverTradeLimit,
        at: pf + 20_000,
        asked: Some(U128(450_000_000)),
        limit: Some(U128(MARGIN)),
        decision: Some(bet(Market::Doge, 450_000_000)),
        is_first: false,
        credited_to: None,
    };
    let r30_fired = RefusalRecord {
        id: 30,
        round_id: 42,
        code: Refusal::Fired,
        at: pf + 60_000,
        asked: None,
        limit: None,
        decision: None, // checks 1-2 fail before the answer is read
        is_first: true,
        credited_to: None,
    };
    let refusals = match scene {
        Quiet | VoteOpen => vec![r29, r28],
        Fired => vec![r30_fired.clone(), r29, r28],
        _ => vec![r31.clone(), r30.clone(), r29, r28],
    };

    // ----- first-of-its-kind refusals: all sixteen codes, in check order
    let firsts = Refusal::ALL
        .into_iter()
        .map(|code| {
            let (account, round) = match code {
                Refusal::OutsideWindow => (None, Some(2)),
                Refusal::MalformedDecision => (None, Some(3)),
                Refusal::NotOnList => (Some(acct(BOSS)), Some(5)),
                Refusal::ZeroMargin => (None, Some(9)),
                Refusal::OverTradeLimit => (Some(acct(BOSS)), Some(12)),
                Refusal::Fired if scene == Fired => (None, Some(42)),
                _ => (None, None),
            };
            StickerFirst {
                claimed: account.is_some() && code == Refusal::OverTradeLimit,
                code,
                account_id: account,
                round_id: round,
            }
        })
        .collect();

    // ----- the feed
    let mut story: Vec<(u64, EventName, Value)> = vec![];
    let opened = |story: &mut Vec<_>, at, round_id: u64, rank: Rank, brave: U128| {
        story.push((at, EventName::RoundOpened, json!({"round_id": round_id, "rank": rank, "status": Status::Employed, "brave_at_open": brave})));
    };
    let refused = |rec: &RefusalRecord| {
        (
            rec.at,
            EventName::Refused,
            json!({"refusal_id": rec.id, "round_id": rec.round_id, "code": rec.code,
                                             "asked": rec.asked, "limit": rec.limit, "is_first": rec.is_first}),
        )
    };
    if scene == Promoted {
        story.push((
            s42 + 60_000 + r,
            EventName::VoteFinished,
            json!({"vote_id": 4, "state": VoteState::Passed, "effective_round": 45}),
        ));
        story.push((
            s,
            EventName::RankChanged,
            json!({"from": Rank::Intern, "to": Rank::Analyst, "effective_round": 45}),
        ));
        opened(&mut story, s, 45, Rank::Analyst, pot.brave.total);
        story.push((
            s + 30_000,
            EventName::CoinsMinted,
            json!({"account_id": BOSS, "coins": U128(49_910_161), "round_id": 43}),
        ));
    } else {
        opened(&mut story, s42, 42, Rank::Intern, U128(1_000_000_000));
        story.push((s42 + 120_000, EventName::PaidIn, json!({"account_id": BOSS, "pool": Pool::Brave, "amount": U128(50_000_000), "pending": true})));
    }
    if matches!(
        scene,
        Refused | Approved | Holding | SettledWin | SettledLoss | Stuck
    ) {
        story.push(refused(&r30));
        story.push(refused(&r31));
    }
    if has_bet {
        story.push((pf + 60_000, EventName::Approved, json!({"position_id": 7, "round_id": 42, "market": Market::Doge,
                                                            "side": Side::Long, "margin": U128(MARGIN), "leverage": 1})));
    }
    let order_signed = |a: &SignedAction| {
        (
            a.created_at,
            EventName::OrderSigned,
            json!({"action_id": a.id, "position_id": a.position_id, "kind": a.kind}),
        )
    };
    for a in &outbox {
        story.push(order_signed(a));
    }
    if let (Some(back), Some(res)) = (returned, result) {
        story.push((cf + 50_000, EventName::ResultReported, json!({"position_id": 7, "returned": U128(back), "result": I128(res),
                                                                  "result_source": ResultSource::Reported})));
        story.push((
            cf + 60_000,
            EventName::Settled,
            json!({"round_id": 42, "result": I128(res), "brave_after": pot.brave.total}),
        ));
    }
    if scene == VoteOpen {
        story.push((s + 60_000, EventName::VoteOpened, json!({"vote_id": 4, "kind": VoteKind::Promote, "playbook_id": null,
                                                             "opened_by": BOSS, "closes_at": s + 60_000 + r})));
        story.push((
            s + 90_000,
            EventName::VoteCast,
            json!({"vote_id": 4, "account_id": BOSS, "support": true, "weight": U128(100_000_000)}),
        ));
        story.push((s + 150_000, EventName::VoteCast, json!({"vote_id": 4, "account_id": BOSS2, "support": false, "weight": U128(15_000_000)})));
    }
    if scene == Fired {
        story.push((s + 60_000, EventName::VoteOpened, json!({"vote_id": 4, "kind": VoteKind::Fire, "playbook_id": null,
                                                             "opened_by": BOSS, "closes_at": s + 60_000 + r})));
        story.push((
            pf + 20_000,
            EventName::VoteCast,
            json!({"vote_id": 4, "account_id": BOSS, "support": true, "weight": U128(100_000_000)}),
        ));
        story.push((
            pf + 25_000,
            EventName::VoteCast,
            json!({"vote_id": 4, "account_id": BOSS2, "support": true, "weight": U128(10_000_000)}),
        ));
        story.push((
            pf + 30_000,
            EventName::VoteFinished,
            json!({"vote_id": 4, "state": VoteState::Passed, "effective_round": 42}),
        ));
        story.push((pf + 30_000, EventName::Fired, json!({"round_id": 42})));
        story.push(refused(&r30_fired));
    }
    story.sort_by_key(|(at, _, _)| *at); // stable: same-time events keep their order

    SceneData {
        round,
        rank,
        positions,
        outbox,
        pot,
        votes,
        refusals,
        firsts,
        story,
    }
}
