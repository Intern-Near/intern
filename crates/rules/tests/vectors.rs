//! `intern/interface/vectors/checks.json` and the other interface files, run through the real rules.

use rules::checks::{rule, Ctx, Ruling};
use rules::clock::{phase_at, Offsets};
use rules::limits::{limits, market_info, MIN_NOTIONAL};
use rules::rulebook::rulebook;
use rules::{Decision, Market, Rank, Refusal, Side, Status};
use serde_json::Value;
use std::cell::Cell;
use std::path::PathBuf;

fn load(rel: &str) -> Value {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../interface")
        .join(rel);
    serde_json::from_str(
        &std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display())),
    )
    .unwrap()
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap_or_else(|| panic!("not a string: {v}"))
}
fn n(v: &Value) -> u64 {
    v.as_u64().unwrap_or_else(|| panic!("not a number: {v}"))
}
fn u(v: &Value) -> u128 {
    s(v).parse().unwrap()
}

fn decision(d: &Value) -> Decision {
    match s(&d["action"]) {
        "SKIP" => Decision::Skip,
        "BET" => Decision::Bet {
            market: s(&d["market"]).parse().unwrap(),
            side: s(&d["side"]).parse().unwrap(),
            margin_e6: u(&d["margin"]),
            leverage: n(&d["leverage"]) as u32,
        },
        other => panic!("action {other}"),
    }
}

#[test]
fn all_26_rule_cases_pass_through_the_real_rule() {
    let file = load("vectors/checks.json");
    let r = &file["round"];
    let offsets = Offsets {
        round_ms: n(&r["round_ms"]),
        guess_close_ms: n(&r["guess_close_ms"]),
        propose_from_ms: n(&r["propose_from_ms"]),
        propose_until_ms: n(&r["propose_until_ms"]),
        close_from_ms: n(&r["close_from_ms"]),
        tail_fade_ms: 600_000,
    };
    assert_eq!(u(&file["min_notional"]), MIN_NOTIONAL);
    let cases = file["rule_cases"].as_array().unwrap();
    assert_eq!(cases.len(), 26);

    for case in cases {
        let id = n(&case["id"]);
        let st = &case["state"];
        let ctx = Ctx { ticket: None,
            offsets,
            ms_into_round: n(&st["ms_into_round"]),
            status: s(&st["status"]).parse().unwrap(),
            rank: s(&st["rank"]).parse().unwrap(),
            brave_at_open: u(&st["brave_at_open"]),
            brave_now: u(&st["brave_now"]),
            bets_used: n(&st["bets_used"]) as u32,
            at_risk: u(&st["at_risk"]),
        };
        assert_eq!(
            phase_at(&offsets, ctx.ms_into_round).as_str(),
            s(&st["phase"]),
            "case {id}: phase"
        );

        let d = decision(&case["decision"]);
        let asked_engine_2 = Cell::new(false);
        let ruling = rule(
            &ctx,
            || {
                asked_engine_2.set(true);
                Ok(d)
            },
            |_| Ok(()),
        );

        let e = &case["expected"];
        let num = |v: &Value| if v.is_null() { None } else { Some(u(v)) };
        match (s(&e["verdict"]), ruling) {
            ("YES", Ruling::Yes(bet)) => {
                let after = &case["after"];
                assert_eq!(bet.notional, u(&after["notional"]), "case {id}");
                assert_eq!(
                    ctx.bets_used as u64 + 1,
                    n(&after["bets_used"]),
                    "case {id}"
                );
                assert_eq!(ctx.at_risk + bet.margin, u(&after["at_risk"]), "case {id}");
            }
            ("SKIP", Ruling::Skip) => {}
            (
                "NOPE",
                Ruling::Nope {
                    refused,
                    decision: read,
                },
            ) => {
                let code: Refusal = s(&e["code"]).parse().unwrap();
                assert_eq!(refused.code, code, "case {id}");
                assert_eq!(refused.asked, num(&e["asked"]), "case {id}: asked");
                assert_eq!(refused.limit, num(&e["limit"]), "case {id}: limit");
                // Checks 1-2 fail before the answer is read: Engine 2's checks are not asked and
                // the refusal carries no decision. Checks 6-12 carry the decision.
                let before_reading = code.check_number() <= 2;
                assert_eq!(
                    asked_engine_2.get(),
                    !before_reading,
                    "case {id}: checks 3-5 asked?"
                );
                assert_eq!(read.is_none(), before_reading, "case {id}: decision kept?");
            }
            (want, got) => panic!("case {id}: expected {want}, got {got:?}"),
        }
    }
}

#[test]
fn rulebook_cases_match_byte_for_byte() {
    let file = load("vectors/checks.json");
    let cases = file["rulebook_cases"]["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 3);
    for case in cases {
        let st = &case["state"];
        let text = rulebook(
            n(&st["round_id"]),
            s(&st["nonce"]),
            s(&st["rank"]).parse().unwrap(),
            u(&st["brave_at_open"]),
            n(&st["bets_used"]) as u32,
            u(&st["at_risk"]),
            st["playbook"].as_str(), None,
        );
        assert_eq!(text, s(&case["text"]), "{}", s(&case["id"]));
    }
}

#[test]
fn rank_table_matches_ranks_json() {
    let file = load("ranks.json");
    assert_eq!(u(&file["min_notional"]), MIN_NOTIONAL);
    let rows = file["ranks"].as_array().unwrap();
    assert_eq!(rows.len(), 3);
    for (row, rank) in rows.iter().zip(Rank::ALL) {
        let l = limits(rank);
        assert_eq!(s(&row["rank"]), rank.as_str());
        assert_eq!(n(&row["per_bet_bps"]), l.per_bet_bps as u64);
        assert_eq!(n(&row["max_bets"]), l.max_bets as u64);
        assert_eq!(n(&row["per_round_bps"]), l.per_round_bps as u64);
        assert_eq!(n(&row["max_leverage"]), l.max_leverage as u64);
        let sides: Vec<Side> = row["sides"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| s(x).parse().unwrap())
            .collect();
        let markets: Vec<Market> = row["markets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| s(x).parse().unwrap())
            .collect();
        assert_eq!(sides, l.sides);
        assert_eq!(markets, l.markets);
    }
    assert_eq!(
        s(&file["starts_as"]["rank"]).parse::<Rank>(),
        Ok(Rank::Intern)
    );
    assert_eq!(
        s(&file["starts_as"]["status"]).parse::<Status>(),
        Ok(Status::Employed)
    );
}

#[test]
fn market_table_matches_markets_json() {
    let file = load("markets.json");
    for net in ["testnet", "mainnet"] {
        let rows = file[net].as_array().unwrap();
        assert_eq!(rows.len(), 6);
        for row in rows {
            let m: Market = s(&row["market"]).parse().unwrap();
            let info = market_info(m);
            assert_eq!(s(&row["hl_name"]), info.hl_name);
            let asset = if net == "testnet" {
                info.testnet_asset
            } else {
                info.mainnet_asset
            };
            assert_eq!(n(&row["hl_asset"]), asset as u64, "{net} {m}");
            assert_eq!(n(&row["sz_decimals"]), info.sz_decimals as u64);
        }
    }
}

#[test]
fn refusal_codes_match_in_check_order() {
    let file = load("refusal-codes.json");
    let codes: Vec<&str> = file["codes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| s(&c["code"]))
        .collect();
    let mine: Vec<&str> = Refusal::ALL.iter().map(|r| r.as_str()).collect();
    assert_eq!(codes, mine);
}
