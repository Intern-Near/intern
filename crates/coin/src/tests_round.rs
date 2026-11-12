//! Step 4 unit tests: `cargo test -p coin`. The AI check is the stand-in `Fake` (signature "FAKE").

use super::*;
use crate::ai::decision_line;
use near_sdk::serde_json::Value;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};
use shared::{Decision, Market, Side};
use std::path::PathBuf;

const ME: &str = "coin.test";
const USDC: &str = "usdc.test";
const RUNNER: &str = "runner.test";
const G: u64 = 1_794_355_200_000;

fn ctx_full(now: u64, caller: &str, deposit: u128, gas_tgas: u64, results: Vec<PromiseResult>) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(ME.parse().unwrap())
            .predecessor_account_id(caller.parse().unwrap())
            .block_timestamp(now * 1_000_000)
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .prepaid_gas(Gas::from_tgas(gas_tgas))
            .build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        results
    );
}

fn ctx(now: u64, caller: &str) {
    ctx_full(now, caller, 0, 300, vec![]);
}

fn acct(s: &str) -> AccountId {
    s.parse().unwrap()
}

/// A coin on the real 24-hour clock (the clock of the interface test cases), round 1 at G.
fn coin_real_clock() -> Coin {
    // A fresh contract: the test harness keeps storage between contexts, so empty it first.
    near_sdk::mock::with_mocked_blockchain(|b| {
        b.take_storage();
    });
    ctx(G + 1_000, "owner.test");
    Coin::new(InitConfig {
        usdc_token: acct(USDC),
        runner: acct(RUNNER),
        round: wire::RoundConstants {
            genesis_ms: G,
            round_ms: 86_400_000,
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

fn b64(bytes: &[u8]) -> String {
    use near_sdk::base64::Engine;
    near_sdk::base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Proposes `d` for the current round and nonce, signed "FAKE", as the runner at `now`.
fn propose(c: &mut Coin, now: u64, d: &Decision) -> wire::Verdict {
    ctx(now, RUNNER);
    let rb = c.get_rulebook();
    let line = decision_line(rb.round_id, &rb.nonce, d);
    c.propose(
        b64(rb.text.as_bytes()),
        b64(line.as_bytes()),
        b64(b"FAKE"),
        None,
        None,
    )
}

fn interface(rel: &str) -> Value {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../interface")
        .join(rel);
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn u(v: &Value) -> u128 {
    v.as_str().unwrap().parse().unwrap()
}

#[test]
fn all_26_interface_cases_through_the_real_propose() {
    let file = interface("vectors/checks.json");
    for case in file["rule_cases"].as_array().unwrap() {
        let id = case["id"].as_u64().unwrap();
        let st = &case["state"];
        let mut c = coin_real_clock();
        // The case's state.
        let rank: Rank = st["rank"].as_str().unwrap().parse().unwrap();
        let status: Status = st["status"].as_str().unwrap().parse().unwrap();
        c.rank.rank = rank as u8;
        c.rank.status = status as u8;
        let mut r = c.current.unwrap();
        r.brave_at_open = u(&st["brave_at_open"]);
        r.bets_used = st["bets_used"].as_u64().unwrap() as u32;
        r.at_risk = u(&st["at_risk"]);
        c.current = Some(r);
        c.rounds.insert(r.id, r);
        c.books.brave_total = u(&st["brave_now"]);
        let now = G + st["ms_into_round"].as_u64().unwrap();
        let d = &case["decision"];
        let decision = match d["action"].as_str().unwrap() {
            "SKIP" => Decision::Skip,
            _ => Decision::Bet {
                market: d["market"].as_str().unwrap().parse().unwrap(),
                side: d["side"].as_str().unwrap().parse().unwrap(),
                margin_e6: u(&d["margin"]),
                leverage: d["leverage"].as_u64().unwrap() as u32,
            },
        };
        let (pot_before, accounts_before) = (c.books, c.token.total_supply);
        let v = serde_json::to_value(propose(&mut c, now, &decision)).unwrap();
        let e = &case["expected"];
        assert_eq!(v["verdict"], e["verdict"], "case {id}: {v}");
        let r_after = c.current.unwrap();
        match e["verdict"].as_str().unwrap() {
            "YES" => {
                let after = &case["after"];
                assert_eq!(
                    r_after.bets_used as u64,
                    after["bets_used"].as_u64().unwrap(),
                    "case {id}"
                );
                assert_eq!(r_after.at_risk, u(&after["at_risk"]), "case {id}");
                let p = &c.get_positions(None)[0];
                assert_eq!(
                    (p.notional, p.status),
                    (U128(u(&after["notional"])), wire::PositionStatus::Approved),
                    "case {id}"
                );
                assert_eq!(
                    c.books.in_play,
                    pot_before.in_play + p.margin.0,
                    "case {id}: margin moves into play"
                );
            }
            "SKIP" => assert_eq!(r_after.skipped, 1, "case {id}"),
            _ => {
                assert_eq!(v["code"], e["code"], "case {id}");
                assert_eq!(v["asked"], e["asked"], "case {id}: asked");
                assert_eq!(v["limit"], e["limit"], "case {id}: limit");
                // A refusal leaves balances and counters untouched (bar the refusal count).
                assert_eq!(
                    (c.books, c.token.total_supply),
                    (pot_before, accounts_before),
                    "case {id}"
                );
                assert_eq!(
                    (r_after.bets_used, r_after.at_risk, r_after.refused),
                    (r.bets_used, r.at_risk, 1),
                    "case {id}"
                );
                let rec = &c.get_refusals(None, Some(1))[0];
                let code: Refusal = e["code"].as_str().unwrap().parse().unwrap();
                assert_eq!(rec.code, code);
                assert_eq!(
                    rec.decision.is_some(),
                    code.check_number() >= 6,
                    "case {id}: decision kept only once read"
                );
                assert!(rec.is_first, "case {id}: first of its code on a fresh coin");
            }
        }
    }
}

#[test]
fn the_same_proposal_twice_is_refused_the_second_time() {
    let mut c = coin_real_clock();
    let now = G + 43_260_000;
    ctx(now, RUNNER);
    let rb = c.get_rulebook();
    let line = decision_line(rb.round_id, &rb.nonce, &Decision::Skip);
    let args = (b64(rb.text.as_bytes()), b64(line.as_bytes()), b64(b"FAKE"));
    assert_eq!(
        c.propose(args.0.clone(), args.1.clone(), args.2.clone(), None, None),
        wire::Verdict::Skip
    );
    assert_ne!(c.get_rulebook().nonce, rb.nonce, "the nonce moved");
    match c.propose(args.0, args.1, args.2, None, None) {
        wire::Verdict::Nope { code, .. } => assert_eq!(code, Refusal::MalformedDecision),
        v => panic!("expected a NOPE, got {v:?}"),
    }
}

#[test]
#[should_panic(expected = "only the runner may propose")]
fn only_the_runner_may_propose() {
    let mut c = coin_real_clock();
    ctx(G + 43_260_000, "stranger.test");
    c.propose(String::new(), String::new(), String::new(), None, None);
}

#[test]
fn bad_input_is_a_recorded_nope_not_an_abort() {
    let mut c = coin_real_clock();
    let now = G + 43_260_000;
    ctx(now, RUNNER);
    let seq = c.feed.last_seq();
    let v = c.propose("not base64!".into(), b64(b"x"), b64(b"FAKE"), None, None);
    assert!(matches!(
        v,
        wire::Verdict::Nope {
            code: Refusal::BadModelSignature,
            ..
        }
    ));
    let v = c.propose(b64(b"x"), b64(b"x"), b64(b"not fake"), None, None);
    assert!(matches!(
        v,
        wire::Verdict::Nope {
            code: Refusal::BadModelSignature,
            ..
        }
    ));
    let v = c.propose(b64(b"x"), b64(b"I think DOGE"), b64(b"FAKE"), None, None);
    assert!(matches!(
        v,
        wire::Verdict::Nope {
            code: Refusal::MalformedDecision,
            ..
        }
    ));
    assert_eq!(c.feed.last_seq(), seq + 3, "each is in the feed");
    assert_eq!(c.get_refusals(None, None).len(), 3);
    // An attached funding quote cannot be checked before step 7: refused, not ignored.
    let d = Decision::Bet {
        market: Market::Doge,
        side: Side::Long,
        margin_e6: 20_000_000,
        leverage: 1,
    };
    c.books.brave_total = 1_000_000_000;
    let mut r = c.current.unwrap();
    r.brave_at_open = 1_000_000_000;
    c.current = Some(r);
    let rb = c.get_rulebook();
    let line = decision_line(rb.round_id, &rb.nonce, &d);
    let v = c.propose(
        b64(b"x"),
        b64(line.as_bytes()),
        b64(b"FAKE"),
        Some(wire::Funding {
            quote: b64(b"q"),
            signature: b64(b"s"),
        }),
        None,
    );
    assert!(
        matches!(
            v,
            wire::Verdict::Nope {
                code: Refusal::BadQuoteSignature,
                ..
            }
        ),
        "{v:?}"
    );
}

#[test]
fn firsts_and_newest_first_refusals() {
    let mut c = coin_real_clock();
    let early = G + 1_000; // OPEN: outside the window
    for _ in 0..3 {
        propose(&mut c, early, &Decision::Skip);
    }
    let all = c.get_refusals(None, None);
    assert_eq!(all.iter().map(|r| r.id).collect::<Vec<_>>(), vec![3, 2, 1]);
    assert_eq!(
        all.iter().map(|r| r.is_first).collect::<Vec<_>>(),
        vec![false, false, true]
    );
    assert_eq!(
        c.get_refusals(Some(2), Some(1))
            .iter()
            .map(|r| r.id)
            .collect::<Vec<_>>(),
        vec![2]
    );
    // 1.3: a sticker first counts only refusals the runner credited to a visitor.
    let firsts = c.get_sticker_firsts();
    assert_eq!(firsts.len(), 16);
    assert!(
        firsts
            .iter()
            .all(|f| f.account_id.is_none() && f.round_id.is_none()),
        "no credited refusal yet"
    );
    ctx(early, RUNNER);
    let rb = c.get_rulebook();
    let line = decision_line(rb.round_id, &rb.nonce, &Decision::Skip);
    c.propose(
        b64(rb.text.as_bytes()),
        b64(line.as_bytes()),
        b64(b"FAKE"),
        None,
        Some(acct("visitor.test")),
    );
    c.propose(
        b64(rb.text.as_bytes()),
        b64(line.as_bytes()),
        b64(b"FAKE"),
        None,
        Some(acct("later.test")),
    );
    let f = &c.get_sticker_firsts()[0];
    assert_eq!(
        (
            f.code,
            f.account_id.as_ref().map(|a| a.as_str()),
            f.round_id,
            f.claimed
        ),
        (Refusal::OutsideWindow, Some("visitor.test"), Some(1), false)
    );
    assert_eq!(
        c.get_refusals(None, Some(2))
            .iter()
            .map(|r| r.credited_to.clone())
            .collect::<Vec<_>>(),
        vec![Some(acct("later.test")), Some(acct("visitor.test"))]
    );
}

#[test]
fn the_rulebook_view_is_what_propose_checks_even_before_a_round_is_written() {
    let mut c = coin_real_clock();
    // Round 2 is due but not written: the view already shows its rulebook and nonce.
    let now = G + 86_400_000 + 43_260_000;
    ctx(now, RUNNER);
    let rb = c.get_rulebook();
    assert_eq!(rb.round_id, 2);
    assert!(rules::rulebook::is_valid_nonce(&rb.nonce));
    assert_eq!(
        rb.text,
        rules::rulebook::rulebook(2, &rb.nonce, Rank::Intern, 0, 0, 0, None)
    );
    // propose writes round 2 and checks against exactly that nonce: a skip is accepted.
    assert_eq!(propose(&mut c, now, &Decision::Skip), wire::Verdict::Skip);
}

fn with_a_bet(margin: u128) -> (Coin, u64) {
    let mut c = coin_real_clock();
    c.books.brave_total = 1_000_000_000;
    let mut r = c.current.unwrap();
    r.brave_at_open = 1_000_000_000;
    c.current = Some(r);
    c.rounds.insert(r.id, r);
    let d = Decision::Bet {
        market: Market::Doge,
        side: Side::Long,
        margin_e6: margin,
        leverage: 1,
    };
    let v = propose(&mut c, G + 43_260_000, &d);
    let wire::Verdict::Yes { position_id } = v else {
        panic!("{v:?}")
    };
    (c, position_id)
}

#[test]
fn report_and_settle_a_win_through_the_test_dollar_mint() {
    let (mut c, pid) = with_a_bet(20_000_000);
    assert_eq!(c.books.in_play, 20_000_000);
    ctx(G + 80_000_000, RUNNER);
    c.report_result(pid, U128(21_800_000));
    let p = &c.get_positions(None)[0];
    assert_eq!(
        (p.status, p.result),
        (wire::PositionStatus::Settled, Some(wire::I128(1_800_000)))
    );
    // settle asks the test dollar to mint the win; nothing changes until that lands.
    ctx_full(G + 80_000_100, "anyone.test", 0, 100, vec![]);
    let _ = c.settle(1);
    assert_eq!(c.settling, Some(1));
    assert_eq!(c.books.brave_total, 1_000_000_000);
    // The mint failed: nothing changed, settle may be called again.
    ctx_full(G + 80_000_200, ME, 0, 100, vec![PromiseResult::Failed]);
    assert_eq!(
        c.on_settle(1, U128(20_000_000), wire::I128(1_800_000)),
        None
    );
    assert_eq!(
        (c.settling, c.current.unwrap().settled, c.books.brave_total),
        (None, false, 1_000_000_000)
    );
    // The mint landed.
    ctx_full(G + 80_000_300, "anyone.test", 0, 100, vec![]);
    let _ = c.settle(1);
    ctx_full(
        G + 80_000_400,
        ME,
        0,
        100,
        vec![PromiseResult::Successful(vec![])],
    );
    assert_eq!(
        c.on_settle(1, U128(20_000_000), wire::I128(1_800_000)),
        Some(wire::I128(1_800_000))
    );
    let r = c.get_round();
    assert_eq!((r.settled, r.result), (true, Some(wire::I128(1_800_000))));
    assert_eq!((c.books.brave_total, c.books.in_play), (1_001_800_000, 0));
    // The next round opens at the next slot.
    ctx(G + 86_400_000 + 5, "anyone.test");
    assert_eq!(c.get_round().id, 2);
}

#[test]
fn a_round_that_breaks_even_settles_at_once() {
    let (mut c, pid) = with_a_bet(20_000_000);
    ctx(G + 80_000_000, RUNNER);
    c.report_result(pid, U128(20_000_000));
    ctx(G + 80_000_100, "anyone.test");
    assert!(matches!(
        c.settle(1),
        PromiseOrValue::Value(Some(wire::I128(0)))
    ));
    assert!(c.get_round().settled);
}

#[test]
#[should_panic(expected = "not every bet of the round has a result yet")]
fn settle_waits_for_every_result() {
    let (mut c, _) = with_a_bet(20_000_000);
    ctx(G + 80_000_000, "anyone.test");
    let _ = c.settle(1);
}

#[test]
#[should_panic(expected = "returned is more than ten times the margin")]
fn absurd_reports_are_refused() {
    let (mut c, pid) = with_a_bet(20_000_000);
    ctx(G + 80_000_000, RUNNER);
    c.report_result(pid, U128(200_000_001));
}

#[test]
#[should_panic(expected = "only the runner may report results")]
fn only_the_runner_reports() {
    let (mut c, pid) = with_a_bet(20_000_000);
    ctx(G + 80_000_000, "stranger.test");
    c.report_result(pid, U128(1));
}

#[test]
fn a_round_with_an_unsettled_bet_does_not_give_way() {
    let (c, _) = with_a_bet(20_000_000);
    ctx(G + 3 * 86_400_000, "anyone.test");
    let r = c.get_round();
    assert_eq!((r.id, r.stuck), (1, true), "stuck, not replaced");
}

#[test]
fn migrate_keeps_every_step_7_record() {
    // A step 7 state with a bet and a refusal, written as the contract's state, then migrated.
    let (mut c, pid) = with_a_bet(20_000_000);
    propose(&mut c, G + 1_000, &Decision::Skip); // too early: an OUTSIDE_WINDOW refusal
    let (positions_before, refusals_before, nonce_before, runner) = (
        c.get_positions(None),
        c.get_refusals(None, None),
        c.nonce_counter,
        c.cfg.runner.clone(),
    );
    let v7 = CoinV7 {
        cfg: c.cfg,
        token: c.token,
        extras: c.extras,
        rates: c.rates,
        rounds: c.rounds,
        current: c.current,
        books: c.books,
        feed: c.feed,
        rank: c.rank,
        nonce_counter: c.nonce_counter,
        positions: c.positions,
        round_positions: c.round_positions,
        next_position_id: c.next_position_id,
        refusals: c.refusals,
        next_refusal_id: c.next_refusal_id,
        firsts: c.firsts,
        settling: c.settling,
        locks: c.locks,
        locked_total: c.locked_total,
        locked_by_round: c.locked_by_round,
        votes: c.votes,
        next_vote_id: c.next_vote_id,
        open_by_kind: c.open_by_kind,
        safe: c.safe,
        books_safe: c.books_safe,
        pins: c.pins,
        outbox: c.outbox,
        outbox_first: c.outbox_first,
        outbox_next: c.outbox_next,
        sign_stage: c.sign_stage,
        last_hl_nonce: c.last_hl_nonce,
    };
    env::state_write(&v7);
    drop(v7); // saves the maps' cached entries, as the end of a real call does
    ctx(G + 43_280_000, ME);
    let m = Coin::migrate(
        acct("stickers.test"),
        acct("launch.test"),
        Some(acct("lender.test")),
    );
    assert_eq!(m.cfg.runner, runner);
    assert_eq!(m.get_positions(None), positions_before);
    assert_eq!(m.get_positions(None)[0].id, pid);
    let mut refusals = refusals_before.clone();
    for r in refusals.iter_mut() {
        r.credited_to = None;
    }
    assert_eq!(m.get_refusals(None, None), refusals);
    assert_eq!(m.nonce_counter, nonce_before);
    assert_eq!(m.books.in_play, 20_000_000);
    let k = m.get_constants();
    assert_eq!(
        (k.stickers.as_str(), k.launchpad.as_str(), k.coach_cut_bps),
        ("stickers.test", "launch.test", 1_000)
    );
    assert_eq!(
        (
            m.get_playbooks(None, None).len(),
            m.get_goal_fills(None, None).len()
        ),
        (0, 0)
    );
    assert_eq!(m.get_goals().tip_jar.jar, 1);
    assert_eq!(m.get_constants().lending.mode, wire::LendingMode::Standin);
}
