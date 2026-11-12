//! Step 5 unit tests: locks, votes and rank changes. `cargo test -p coin`.

use super::*;
use crate::ai::decision_line;
use crate::vote::MAX_LOTS;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;
use shared::{Decision, Market, Side};

const ME: &str = "coin.test";
const RUNNER: &str = "runner.test";
const G: u64 = 1_794_355_200_000;
const ROUND: u64 = 86_400_000;
const IN_WINDOW: u64 = 43_260_000;

fn ctx(now: u64, caller: &str, deposit: u128) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(ME.parse().unwrap())
        .predecessor_account_id(caller.parse().unwrap())
        .block_timestamp(now * 1_000_000)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .prepaid_gas(Gas::from_tgas(300))
        .build());
}

fn acct(s: &str) -> AccountId {
    s.parse().unwrap()
}

/// `into` ms into round `round` (rounds on the 24-hour clock, one opened per slot).
fn at(round: u64, into: u64) -> u64 {
    G + (round - 1) * ROUND + into
}

fn coin() -> Coin {
    near_sdk::mock::with_mocked_blockchain(|b| {
        b.take_storage();
    });
    ctx(G + 1_000, "owner.test", 0);
    Coin::new(InitConfig {
        usdc_token: acct("usdc.test"),
        runner: acct(RUNNER),
        round: wire::RoundConstants {
            genesis_ms: G,
            round_ms: ROUND,
            guess_close_ms: 42_900_000,
            propose_from_ms: 43_200_000,
            propose_until_ms: 46_800_000,
            close_from_ms: 79_200_000,
            tail_fade_ms: 600_000,
        },
        min_first_deposit: U128(10_000_000),
        pins: None,
        stickers: None,
        launchpad: None,
        lender: None,
    })
}

/// Gives a boss coins (and the pool the dollars behind them).
fn give(c: &mut Coin, who: &str, coins: u128) {
    let a = acct(who);
    if !c.token.accounts.contains_key(&a) {
        c.token.internal_register_account(&a);
    }
    c.token.internal_deposit(&a, coins);
    c.books.brave_total += coins;
}

/// Moves to round `to`, opening every round on the way (each slot gets a transaction).
fn goto(c: &mut Coin, to: u64, into: u64) {
    let from = c.current.unwrap().id;
    for r in from + 1..=to {
        ctx(at(r, 1_000), "anyone.test", 0);
        c.tick();
    }
    ctx(at(to, into), "anyone.test", 0);
    c.tick();
    assert_eq!(c.current.unwrap().id, to);
}

fn lock(c: &mut Coin, now: u64, who: &str, n: u128) {
    ctx(now, who, 0);
    c.lock(U128(n));
}

fn open(c: &mut Coin, now: u64, who: &str, kind: wire::VoteKind) -> u64 {
    ctx(now, who, 0);
    c.open_vote(kind, None)
}

fn cast(c: &mut Coin, now: u64, who: &str, id: u64, yes: bool) {
    ctx(now, who, 0);
    c.cast(id, yes);
}

fn finish(c: &mut Coin, now: u64, id: u64) -> wire::Vote {
    ctx(now, "anyone.test", 0);
    c.finish_vote(id)
}

/// Two bosses with coins locked in round 1, now in round 9 (full weight for both).
fn two_bosses(a: u128, b: u128) -> Coin {
    let mut c = coin();
    give(&mut c, "a.test", a);
    give(&mut c, "b.test", b);
    lock(&mut c, at(1, 2_000), "a.test", a);
    lock(&mut c, at(1, 2_000), "b.test", b);
    goto(&mut c, 9, 1_000);
    c
}

fn b64(bytes: &[u8]) -> String {
    use near_sdk::base64::Engine;
    near_sdk::base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn propose_bet(c: &mut Coin, now: u64) -> wire::Verdict {
    ctx(now, RUNNER, 0);
    let rb = c.get_rulebook();
    let d = Decision::Bet {
        market: Market::Doge,
        side: Side::Long,
        margin_e6: 11_000_000, // 1.2: the minimum is $11
        leverage: 1,
    };
    let line = decision_line(rb.round_id, &rb.nonce, &d);
    c.propose(
        b64(rb.text.as_bytes()),
        b64(line.as_bytes()),
        b64(b"FAKE"),
        None,
        None,
    )
}

// ----- the five tests the brief asks for ----------------------------------------------------------

#[test]
fn coins_locked_after_a_vote_opened_count_zero() {
    let mut c = two_bosses(500, 500);
    let id = open(&mut c, at(9, 2_000), "a.test", wire::VoteKind::Promote);
    give(&mut c, "late.test", 1_000);
    lock(&mut c, at(9, 3_000), "late.test", 1_000);
    ctx(at(9, 4_000), "anyone.test", 0);
    assert_eq!(
        c.get_votes(None, None)[0].locked_weight_at_open,
        U128(1_000),
        "the late lock is not in it"
    );
    // A vote opened right now would not count them either (same round).
    assert_eq!(c.get_account(acct("late.test")).vote_weight, U128(0));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        cast(&mut c, at(9, 5_000), "late.test", id, true)
    }));
    assert!(r.is_err(), "a zero-weight cast is refused");
    assert_eq!(c.votes.get(&id).unwrap().yes, 0);
}

#[test]
fn a_one_round_holder_has_one_seventh_of_a_seven_round_holder() {
    let mut c = coin();
    give(&mut c, "old.test", 700);
    give(&mut c, "new.test", 700);
    lock(&mut c, at(1, 2_000), "old.test", 700);
    goto(&mut c, 7, 1_000);
    lock(&mut c, at(7, 2_000), "new.test", 700);
    goto(&mut c, 9, 1_000);
    // Vote round 9: old has 9-1-1 = 7 full rounds, new has 9-7-1 = 1.
    ctx(at(9, 1_500), "anyone.test", 0);
    assert_eq!(c.get_account(acct("old.test")).vote_weight, U128(700));
    assert_eq!(c.get_account(acct("new.test")).vote_weight, U128(100));
    let id = open(&mut c, at(9, 2_000), "old.test", wire::VoteKind::Promote);
    cast(&mut c, at(9, 3_000), "old.test", id, true);
    cast(&mut c, at(9, 3_000), "new.test", id, false);
    let v = &c.get_votes(None, None)[0];
    assert_eq!(
        (v.yes, v.no, v.locked_weight_at_open),
        (U128(700), U128(100), U128(800))
    );
}

#[test]
fn a_demotion_passes_at_34_percent_of_all_locked_weight_with_no_quorum() {
    // 34% yes and nobody else voting: passes, early, and acts at once.
    let mut c = two_bosses(340, 660);
    c.rank.rank = Rank::Analyst as u8;
    let id = open(&mut c, at(9, 2_000), "a.test", wire::VoteKind::Demote);
    cast(&mut c, at(9, 3_000), "a.test", id, true);
    let v = finish(&mut c, at(9, 4_000), id);
    assert_eq!(
        (v.state, v.effective_round),
        (wire::VoteState::Passed, Some(9))
    );
    let r = c.get_rank();
    assert_eq!((r.rank, r.since_round, r.pending), (Rank::Intern, 9, None));
    // 33%: not enough, even with nobody against.
    let mut c = two_bosses(330, 670);
    c.rank.rank = Rank::Analyst as u8;
    let id = open(&mut c, at(9, 2_000), "a.test", wire::VoteKind::Demote);
    cast(&mut c, at(9, 3_000), "a.test", id, true);
    let early = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        finish(&mut c, at(9, 4_000), id)
    }));
    assert!(early.is_err(), "cannot finish early under 34%");
    let v = finish(&mut c, at(10, 2_000), id);
    assert_eq!(v.state, wire::VoteState::Failed);
    assert_eq!(c.get_rank().rank, Rank::Analyst);
}

#[test]
fn a_promotion_fails_without_quorum() {
    // 19% voted, all yes: under the 20% quorum.
    let mut c = two_bosses(190, 810);
    let id = open(&mut c, at(9, 2_000), "a.test", wire::VoteKind::Promote);
    cast(&mut c, at(9, 3_000), "a.test", id, true);
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| finish(
            &mut c,
            at(9, 4_000),
            id
        )))
        .is_err(),
        "no early finish"
    );
    assert_eq!(
        finish(&mut c, at(10, 2_000), id).state,
        wire::VoteState::Failed
    );
    assert_eq!(c.get_rank().pending, None);
    // 20% voted, all yes: passes.
    let mut c = two_bosses(200, 800);
    let id = open(&mut c, at(9, 2_000), "a.test", wire::VoteKind::Promote);
    cast(&mut c, at(9, 3_000), "a.test", id, true);
    assert_eq!(
        finish(&mut c, at(10, 2_000), id).state,
        wire::VoteState::Passed
    );
}

#[test]
fn a_promotion_that_passed_does_not_change_the_round_in_progress_or_the_next() {
    let mut c = two_bosses(500, 500);
    let id = open(&mut c, at(9, 1_000), "a.test", wire::VoteKind::Promote);
    cast(&mut c, at(9, 2_000), "a.test", id, true);
    cast(&mut c, at(9, 2_000), "b.test", id, true);
    // closes_at is one round later: in round 10. Finished then, it takes effect in round 12.
    goto(&mut c, 10, 1_000);
    let v = finish(&mut c, at(10, 1_000), id);
    assert_eq!(
        (v.state, v.effective_round),
        (wire::VoteState::Passed, Some(12))
    );
    let again = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        open(&mut c, at(10, 2_000), "b.test", wire::VoteKind::Promote)
    }));
    assert!(again.is_err(), "no second promotion while one waits");
    let pending = |c: &Coin| c.get_rank().pending.map(|p| (p.rank, p.effective_round));
    for (round, rank) in [
        (10, Rank::Intern),
        (11, Rank::Intern),
        (12, Rank::Analyst),
        (13, Rank::Analyst),
    ] {
        goto(&mut c, round, IN_WINDOW);
        let rb = c.get_rulebook();
        assert!(
            rb.text.contains(&format!("rank: {}\n", rank.as_str())),
            "round {round}: {}",
            rb.text
        );
        assert_eq!(c.get_round().rank, rank, "round {round}");
        assert_eq!(c.get_rank().rank, rank, "round {round}");
        assert_eq!(
            pending(&c),
            (round < 12).then_some((Rank::Analyst, 12)),
            "round {round}"
        );
    }
    assert_eq!(c.get_rank().since_round, 12);
}

// ----- more ----------------------------------------------------------------------------------------

#[test]
fn one_tiny_boss_cannot_fire_the_intern_alone() {
    let mut c = two_bosses(1, 999_999);
    let id = open(&mut c, at(9, 2_000), "a.test", wire::VoteKind::Fire);
    cast(&mut c, at(9, 3_000), "a.test", id, true);
    assert_eq!(
        finish(&mut c, at(10, 2_000), id).state,
        wire::VoteState::Failed
    );
    assert_eq!(c.get_rank().status, Status::Employed);
}

#[test]
fn a_firing_stops_propose_in_the_same_round_and_cash_out_still_works() {
    let mut c = two_bosses(400_000_000, 600_000_000);
    goto(&mut c, 9, IN_WINDOW);
    assert!(
        matches!(
            propose_bet(&mut c, at(9, IN_WINDOW)),
            wire::Verdict::Yes { .. }
        ),
        "employed: a YES"
    );
    let id = open(
        &mut c,
        at(9, IN_WINDOW + 1_000),
        "a.test",
        wire::VoteKind::Fire,
    );
    cast(&mut c, at(9, IN_WINDOW + 2_000), "a.test", id, true);
    let v = finish(&mut c, at(9, IN_WINDOW + 3_000), id);
    assert_eq!(v.state, wire::VoteState::Passed);
    assert_eq!(c.get_rank().status, Status::Fired);
    match propose_bet(&mut c, at(9, IN_WINDOW + 4_000)) {
        wire::Verdict::Nope { code, .. } => assert_eq!(code, Refusal::Fired),
        v => panic!("expected FIRED, got {v:?}"),
    }
    // Cash-out still works.
    give(&mut c, "free.test", 50_000_000);
    ctx(at(9, IN_WINDOW + 5_000), "free.test", 1);
    let _ = c.cash_out(Pool::Brave, U128(10_000_000), None);
    assert_eq!(c.bal(&acct("free.test")), 40_000_000);
}

#[test]
fn a_firing_cancels_a_waiting_promotion_and_rehire_returns_at_intern_two_rounds_later() {
    let mut c = two_bosses(500, 500);
    let p = open(&mut c, at(9, 1_000), "a.test", wire::VoteKind::Promote);
    cast(&mut c, at(9, 2_000), "a.test", p, true);
    goto(&mut c, 10, 1_000);
    finish(&mut c, at(10, 1_000), p);
    assert!(c.get_rank().pending.is_some());
    let f = open(&mut c, at(10, 2_000), "b.test", wire::VoteKind::Fire);
    cast(&mut c, at(10, 3_000), "b.test", f, true);
    finish(&mut c, at(10, 4_000), f);
    let r = c.get_rank();
    assert_eq!(
        (r.status, r.pending),
        (Status::Fired, None),
        "the promotion is cancelled"
    );
    goto(&mut c, 12, 1_000);
    assert_eq!(
        (c.get_rank().rank, c.get_rank().status),
        (Rank::Intern, Status::Fired)
    );
    // Rehire: majority and quorum, then two rounds.
    let h = open(&mut c, at(12, 2_000), "a.test", wire::VoteKind::Rehire);
    cast(&mut c, at(12, 3_000), "a.test", h, true);
    goto(&mut c, 13, 2_000);
    assert_eq!(finish(&mut c, at(13, 2_000), h).effective_round, Some(15));
    goto(&mut c, 14, 1_000);
    assert_eq!(c.get_rank().status, Status::Fired);
    goto(&mut c, 15, 1_000);
    let r = c.get_rank();
    assert_eq!(
        (r.rank, r.status, r.since_round),
        (Rank::Intern, Status::Employed, 15)
    );
}

#[test]
fn opening_rules() {
    let mut c = two_bosses(500, 500);
    let fails = |c: &mut Coin, who: &str, k: wire::VoteKind| {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            open(c, at(9, 2_000), who, k)
        }))
        .is_err()
    };
    assert!(
        fails(&mut c, "a.test", wire::VoteKind::Demote),
        "no DEMOTE at INTERN"
    );
    assert!(
        fails(&mut c, "a.test", wire::VoteKind::Rehire),
        "no REHIRE while EMPLOYED"
    );
    assert!(
        fails(&mut c, "a.test", wire::VoteKind::SetPlaybook),
        "later phase"
    );
    give(&mut c, "nolock.test", 10);
    assert!(
        fails(&mut c, "nolock.test", wire::VoteKind::Promote),
        "needs locked coins"
    );
    let id = open(&mut c, at(9, 2_000), "a.test", wire::VoteKind::Promote);
    assert!(
        fails(&mut c, "b.test", wire::VoteKind::Promote),
        "one open vote per kind"
    );
    cast(&mut c, at(9, 3_000), "a.test", id, true);
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| cast(
            &mut c,
            at(9, 3_000),
            "a.test",
            id,
            false
        )))
        .is_err(),
        "once per vote"
    );
}

#[test]
fn a_vote_whose_time_ran_out_unfinished_is_finished_by_the_next_of_its_kind() {
    let mut c = two_bosses(500, 500);
    let id = open(&mut c, at(9, 2_000), "a.test", wire::VoteKind::Promote);
    cast(&mut c, at(9, 3_000), "a.test", id, false);
    goto(&mut c, 10, 5_000);
    let id2 = open(&mut c, at(10, 5_000), "b.test", wire::VoteKind::Promote);
    let v = c.get_votes(None, None);
    assert_eq!((v[0].id, v[0].state), (id2, wire::VoteState::Open));
    assert_eq!((v[1].id, v[1].state), (id, wire::VoteState::Failed));
}

#[test]
fn unlock_waits_for_the_votes_you_cast_in() {
    let mut c = two_bosses(500, 500);
    let id = open(&mut c, at(9, 2_000), "a.test", wire::VoteKind::Promote);
    cast(&mut c, at(9, 3_000), "a.test", id, true);
    ctx(at(9, 4_000), "a.test", 0);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ctx(at(9, 4_000), "a.test", 0);
        c.unlock(U128(1))
    }));
    assert!(r.is_err(), "refused while the vote is open");
    // b did not vote: b may unlock at once.
    ctx(at(9, 5_000), "b.test", 0);
    c.unlock(U128(500));
    assert_eq!(c.get_account(acct("b.test")).locked, U128(0));
    // After closes_at, unfinished or not, a may unlock.
    ctx(at(10, 3_000), "a.test", 0);
    c.unlock(U128(500));
    assert_eq!(c.locked_total, 0);
    assert!(c.locks.get(&acct("a.test")).is_none(), "the record is gone");
}

#[test]
#[should_panic(expected = "locked coins cannot be moved")]
fn locked_coins_cannot_be_transferred() {
    let mut c = two_bosses(500, 500);
    ctx(at(9, 2_000), "a.test", 1);
    c.ft_transfer(acct("b.test"), U128(1), None);
}

#[test]
#[should_panic(expected = "locked coins cannot be cashed out")]
fn locked_coins_cannot_be_cashed_out() {
    let mut c = two_bosses(500, 500);
    ctx(at(9, 2_000), "a.test", 1);
    let _ = c.cash_out(Pool::Brave, U128(1), None);
}

#[test]
fn free_coins_move_and_lots_stay_at_four() {
    let mut c = coin();
    give(&mut c, "a.test", 1_000);
    give(&mut c, "b.test", 0);
    for r in 1..=6u64 {
        goto(&mut c, r, 2_000);
        lock(&mut c, at(r, 3_000), "a.test", 10);
    }
    let l = c.lock_rec(&acct("a.test"));
    assert_eq!(l.lots.len(), MAX_LOTS);
    assert_eq!(l.total, 60);
    assert_eq!(l.lots.iter().map(|x| x.0).sum::<u128>(), 60);
    // The totals per round agree with the lots, and the weight of all locked coins equals this
    // one boss's weight at every later round.
    for v in 7..=20 {
        assert_eq!(
            c.total_weight(v),
            c.weight_of(&acct("a.test"), v),
            "round {v}"
        );
    }
    ctx(at(6, 4_000), "a.test", 1);
    c.ft_transfer(acct("b.test"), U128(940), None);
    assert_eq!(c.bal(&acct("a.test")), 60);
}

#[test]
fn votes_page_newest_first() {
    let mut c = two_bosses(500, 500);
    c.rank.rank = Rank::Analyst as u8;
    let a = open(&mut c, at(9, 2_000), "a.test", wire::VoteKind::Promote);
    let b = open(&mut c, at(9, 2_000), "a.test", wire::VoteKind::Demote);
    let f = open(&mut c, at(9, 2_000), "b.test", wire::VoteKind::Fire);
    ctx(at(9, 3_000), "anyone.test", 0);
    assert_eq!(
        c.get_votes(None, None)
            .iter()
            .map(|v| v.id)
            .collect::<Vec<_>>(),
        vec![f, b, a]
    );
    assert_eq!(
        c.get_votes(Some(b), Some(1))
            .iter()
            .map(|v| v.id)
            .collect::<Vec<_>>(),
        vec![b]
    );
    let v = &c.get_votes(None, None)[0];
    assert_eq!(
        (v.kind, v.state, v.opened_by.as_str()),
        (wire::VoteKind::Fire, wire::VoteState::Open, "b.test")
    );
}

#[test]
fn one_boss_with_every_record_fits_in_the_registration_storage() {
    let mut c = coin();
    let long: AccountId = format!("{}.test", "a".repeat(59)).parse().unwrap();
    let before = env::storage_usage();
    ctx(G + 2_000, long.as_str(), Coin::storage_min().as_yoctonear());
    c.storage_deposit(None, None);
    c.extras.insert(
        long.clone(),
        Extra {
            pending: u128::MAX,
            pending_epoch: u64::MAX,
            newcomer: true,
            joined_round: Some(u64::MAX),
            in_flight: u32::MAX,
        },
    );
    c.locks.insert(
        long.clone(),
        LockRec {
            lots: vec![(u128::MAX, u64::MAX); MAX_LOTS],
            total: u128::MAX,
            cast_in: vec![u64::MAX; 5],
        },
    );
    c.extras.flush();
    c.locks.flush();
    let used = env::storage_usage() - before;
    println!("one boss with every record uses {used} of {ACCOUNT_STORAGE_BYTES} bytes");
    assert!(
        used + 16 <= ACCOUNT_STORAGE_BYTES,
        "used {used}, and SAFE (step 6) needs 16 more"
    );
}
