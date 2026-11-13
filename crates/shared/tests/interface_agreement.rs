//! Fails if the machine-readable interface files (`intern/interface/*.json`) and the Rust types in
//! this crate ever disagree, or if a test case in `vectors/checks.json` does not follow from the
//! rules of `01-SHARED-INTERFACE.md` section 7 and the ranks in `ranks.json`.
//!
//! The small rule checker and rulebook writer below are test-only reference copies, written
//! straight from the interface text. The real ones live in `crates/rules` (step 2) and must pass
//! the same file.

use serde_json::Value;
use shared::{Market, Rank, Refusal, Side, Status, INTERFACE_VERSION};
use std::path::PathBuf;

fn load(rel: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../interface")
        .join(rel);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|e| panic!("{} is not valid JSON: {e}", path.display()))
}

fn s(v: &Value) -> &str {
    v.as_str()
        .unwrap_or_else(|| panic!("expected a string, got {v}"))
}
fn n(v: &Value) -> u64 {
    v.as_u64()
        .unwrap_or_else(|| panic!("expected a whole number, got {v}"))
}
/// A U128 on the wire: a decimal string, never a JSON number.
fn u(v: &Value) -> u128 {
    let t = s(v);
    assert!(
        !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit()),
        "not a decimal string: {t:?}"
    );
    assert!(t == "0" || !t.starts_with('0'), "leading zero: {t:?}");
    t.parse().unwrap()
}
fn arr(v: &Value) -> &Vec<Value> {
    v.as_array()
        .unwrap_or_else(|| panic!("expected an array, got {v}"))
}

#[test]
fn every_file_names_the_same_interface_version() {
    for f in [
        "refusal-codes.json",
        "ranks.json",
        "markets.json",
        "vectors/checks.json",
    ] {
        assert_eq!(s(&load(f)["interface_version"]), INTERFACE_VERSION, "{f}");
    }
}

#[test]
fn refusal_codes_match_the_rust_enum_in_check_order() {
    let file = load("refusal-codes.json");
    let codes = arr(&file["codes"]);
    assert_eq!(codes.len(), 16);
    assert_eq!(codes.len(), Refusal::ALL.len());
    for (row, rust) in codes.iter().zip(Refusal::ALL) {
        assert_eq!(s(&row["code"]), rust.as_str());
        assert_eq!(s(&row["code"]).parse::<Refusal>(), Ok(rust));
        assert_eq!(n(&row["check"]), rust.check_number() as u64);
        // asked/limit present exactly where section 7 shows numbers.
        assert_eq!(
            !row["asked"].is_null(),
            rust.carries_numbers(),
            "{rust} asked"
        );
        assert_eq!(
            !row["limit"].is_null(),
            rust.carries_numbers(),
            "{rust} limit"
        );
    }
    // The five lights cover checks 1-16 once each, in order, and agree with each code's light.
    let mut next = 1;
    for light in arr(&file["lights"]) {
        for c in arr(&light["checks"]) {
            assert_eq!(n(c), next);
            assert_eq!(n(&codes[(next - 1) as usize]["light"]), n(&light["light"]));
            next += 1;
        }
    }
    assert_eq!(next, 17);
}

struct RankRow {
    rank: Rank,
    per_bet_bps: u128,
    max_bets: u64,
    per_round_bps: u128,
    sides: Vec<Side>,
    max_leverage: u64,
    markets: Vec<Market>,
}

fn ranks() -> Vec<RankRow> {
    let file = load("ranks.json");
    arr(&file["ranks"])
        .iter()
        .map(|r| RankRow {
            rank: s(&r["rank"]).parse().expect("rank name"),
            per_bet_bps: n(&r["per_bet_bps"]) as u128,
            max_bets: n(&r["max_bets"]),
            per_round_bps: n(&r["per_round_bps"]) as u128,
            sides: arr(&r["sides"])
                .iter()
                .map(|x| s(x).parse().expect("side"))
                .collect(),
            max_leverage: n(&r["max_leverage"]),
            markets: arr(&r["markets"])
                .iter()
                .map(|x| s(x).parse().expect("market"))
                .collect(),
        })
        .collect()
}

fn rank_row(rank: Rank) -> RankRow {
    ranks().into_iter().find(|r| r.rank == rank).unwrap()
}

#[test]
fn ranks_match_the_rust_enum_and_section_3() {
    let file = load("ranks.json");
    assert_eq!(u(&file["min_notional"]), 11_000_000); // 1.2: $11
    assert_eq!(
        s(&file["starts_as"]["rank"]).parse::<Rank>(),
        Ok(Rank::Intern)
    );
    assert_eq!(
        s(&file["starts_as"]["status"]).parse::<Status>(),
        Ok(Status::Employed)
    );

    let rows = ranks();
    assert_eq!(
        rows.iter().map(|r| r.rank).collect::<Vec<_>>(),
        Rank::ALL.to_vec()
    );

    // The table of section 3, typed in a second time:
    // (per_bet_bps, max_bets, per_round_bps, sides, max_leverage, number of markets).
    type Row = (u128, u64, u128, &'static [Side], u64, usize);
    let want: [Row; 3] = [
        (200, 1, 200, &[Side::Long], 1, 4),
        (500, 2, 800, &[Side::Long], 1, 6),
        (1000, 3, 2000, &[Side::Long, Side::Short], 2, 6),
    ];
    for (r, w) in rows.iter().zip(want) {
        assert_eq!(
            (
                r.per_bet_bps,
                r.max_bets,
                r.per_round_bps,
                r.sides.as_slice(),
                r.max_leverage,
                r.markets.len()
            ),
            w
        );
        // Markets are listed in the order of section 4, which is the order of the Rust enum.
        assert!(
            r.markets.windows(2).all(|p| p[0] < p[1]),
            "{} markets out of order",
            r.rank
        );
        assert!(r.per_bet_bps <= r.per_round_bps && r.per_round_bps < 10_000);
    }
    // A higher rank never has a tighter limit or fewer markets or sides.
    for p in rows.windows(2) {
        let (lo, hi) = (&p[0], &p[1]);
        assert!(
            hi.per_bet_bps >= lo.per_bet_bps
                && hi.max_bets >= lo.max_bets
                && hi.per_round_bps >= lo.per_round_bps
        );
        assert!(hi.max_leverage >= lo.max_leverage);
        assert!(lo.markets.iter().all(|m| hi.markets.contains(m)));
        assert!(lo.sides.iter().all(|x| hi.sides.contains(x)));
    }
    assert_eq!(
        rank_row(Rank::Intern).markets,
        vec![Market::Doge, Market::Shib, Market::Pepe, Market::Pengu]
    );
    assert_eq!(rank_row(Rank::Trader).markets, Market::ALL.to_vec());
}

#[test]
fn markets_match_the_rust_enum_on_both_networks() {
    let file = load("markets.json");
    let t = arr(&file["testnet"]);
    let m = arr(&file["mainnet"]);
    let want = [
        ("DOGE", "DOGE", 173, 12, 0),
        ("SHIB", "kSHIB", 29, 38, 0),
        ("PEPE", "kPEPE", 12, 15, 0),
        ("PENGU", "PENGU", 139, 163, 0),
        ("WIF", "WIF", 78, 98, 0),
        ("TRUMP", "TRUMP", 150, 174, 1),
    ];
    assert_eq!(t.len(), 6);
    assert_eq!(m.len(), 6);
    for (i, market) in Market::ALL.iter().enumerate() {
        let (name, hl, ti, mi, sz) = want[i];
        assert_eq!(market.as_str(), name);
        for (row, idx) in [(&t[i], ti), (&m[i], mi)] {
            assert_eq!(s(&row["market"]).parse::<Market>(), Ok(*market));
            assert_eq!(s(&row["hl_name"]), hl);
            assert_eq!(n(&row["hl_asset"]), idx);
            assert_eq!(n(&row["sz_decimals"]), sz);
        }
    }
}

#[test]
fn deployments_file_has_the_section_13_keys() {
    let file = load("deployments.json");
    let testnet = file["testnet"].as_object().expect("testnet object");
    let mut keys: Vec<&str> = testnet.keys().map(|k| k.as_str()).collect();
    keys.sort();
    // 1.3 added stickers, launchpad and lender; 1.4 the two off-chain services (the trick page's API, the
    // Tail or Fade faucet).
    assert_eq!(
        keys,
        ["coin", "launchpad", "lender", "rpc", "runner", "stickers", "stub", "tailfade_faucet", "trick_api", "usdc"]
    );
}

// ----- the test cases -----------------------------------------------------------------------

#[derive(Debug, PartialEq)]
enum Outcome {
    Yes,
    Skip,
    Nope(Refusal, Option<u128>, Option<u128>),
}

struct Clock {
    started_at: u64,
    propose_from: u64,
    propose_until: u64,
    close_from: u64,
}

fn phase_of(c: &Clock, ms_into_round: u64) -> &'static str {
    if ms_into_round < c.propose_from {
        "OPEN"
    } else if ms_into_round < c.propose_until {
        "PROPOSE"
    } else if ms_into_round < c.close_from {
        "HOLD"
    } else {
        "CLOSE"
    }
}

/// Reference copy of checks 1, 2 and 6-12, straight from section 7 (checks 3-5 assumed good).
fn reference_check(c: &Clock, min_notional: u128, case: &Value) -> Outcome {
    let st = &case["state"];
    let ms = n(&st["ms_into_round"]);
    // 1
    if s(&st["phase"]) != "PROPOSE" {
        let limit = if ms < c.propose_from {
            c.propose_from
        } else {
            c.propose_until
        };
        return Outcome::Nope(
            Refusal::OutsideWindow,
            Some(ms as u128),
            Some(limit as u128),
        );
    }
    // 2
    if s(&st["status"]).parse::<Status>().unwrap() == Status::Fired {
        return Outcome::Nope(Refusal::Fired, None, None);
    }
    let d = &case["decision"];
    if s(&d["action"]) == "SKIP" {
        return Outcome::Skip;
    }
    let r = rank_row(s(&st["rank"]).parse().unwrap());
    let base = u(&st["brave_at_open"]).min(u(&st["brave_now"]));
    let (bets_used, at_risk) = (n(&st["bets_used"]), u(&st["at_risk"]));
    let market: Market = s(&d["market"]).parse().unwrap();
    let side: Side = s(&d["side"]).parse().unwrap();
    let (margin, leverage) = (u(&d["margin"]), n(&d["leverage"]));
    // 6, 7
    if !r.markets.contains(&market) {
        return Outcome::Nope(Refusal::NotOnList, None, None);
    }
    if !r.sides.contains(&side) {
        return Outcome::Nope(Refusal::ShortNotUnlocked, None, None);
    }
    // 8
    let notional = margin * leverage as u128;
    if margin == 0 || notional < min_notional {
        return Outcome::Nope(Refusal::ZeroMargin, Some(notional), Some(min_notional));
    }
    // 9
    if leverage > r.max_leverage {
        return Outcome::Nope(
            Refusal::OverLeverage,
            Some(leverage as u128),
            Some(r.max_leverage as u128),
        );
    }
    // 10
    if bets_used >= r.max_bets {
        return Outcome::Nope(
            Refusal::TooManyTrades,
            Some(bets_used as u128 + 1),
            Some(r.max_bets as u128),
        );
    }
    // 11
    let per_bet = base * r.per_bet_bps / 10_000;
    if margin > per_bet {
        return Outcome::Nope(Refusal::OverTradeLimit, Some(margin), Some(per_bet));
    }
    // 12
    let per_round = base * r.per_round_bps / 10_000;
    if at_risk + margin > per_round {
        return Outcome::Nope(
            Refusal::OverRoundLimit,
            Some(at_risk + margin),
            Some(per_round),
        );
    }
    Outcome::Yes
}

fn expected_outcome(case: &Value) -> Outcome {
    let e = &case["expected"];
    match s(&e["verdict"]) {
        "YES" => Outcome::Yes,
        "SKIP" => Outcome::Skip,
        "NOPE" => {
            let code: Refusal = s(&e["code"]).parse().expect("code spelling");
            let num = |v: &Value| if v.is_null() { None } else { Some(u(v)) };
            Outcome::Nope(code, num(&e["asked"]), num(&e["limit"]))
        }
        other => panic!("unknown verdict {other}"),
    }
}

#[test]
fn rule_cases_are_complete_consistent_and_follow_section_7() {
    let file = load("vectors/checks.json");
    let round = &file["round"];
    let c = Clock {
        started_at: n(&round["started_at"]),
        propose_from: n(&round["propose_from_ms"]),
        propose_until: n(&round["propose_until_ms"]),
        close_from: n(&round["close_from_ms"]),
    };
    // Section 5 real-product offsets.
    assert_eq!(n(&round["round_ms"]), 86_400_000);
    assert_eq!(n(&round["guess_close_ms"]), 42_900_000);
    assert_eq!(
        (c.propose_from, c.propose_until, c.close_from),
        (43_200_000, 46_800_000, 79_200_000)
    );
    let min_notional = u(&file["min_notional"]);
    assert_eq!(min_notional, 11_000_000); // 1.2: $11

    let cases = arr(&file["rule_cases"]);
    assert_eq!(cases.len(), 26, "section 12 has 26 rule cases in 1.1");
    for (i, case) in cases.iter().enumerate() {
        let id = n(&case["id"]);
        assert_eq!(id, i as u64 + 1, "case ids run 1..26 in order");
        let st = &case["state"];
        let ms = n(&st["ms_into_round"]);
        assert_eq!(n(&st["now"]), c.started_at + ms, "case {id}: now");
        assert_eq!(s(&st["phase"]), phase_of(&c, ms), "case {id}: phase");

        let want = expected_outcome(case);
        if let Outcome::Nope(code, asked, limit) = &want {
            assert_eq!(asked.is_some(), code.carries_numbers(), "case {id}: asked");
            assert_eq!(limit.is_some(), code.carries_numbers(), "case {id}: limit");
        }
        assert_eq!(reference_check(&c, min_notional, case), want, "case {id}");

        // 'after': unchanged unless YES; YES adds one bet and the margin, and states the notional.
        let after = &case["after"];
        let (used, risk) = (n(&st["bets_used"]), u(&st["at_risk"]));
        match want {
            Outcome::Yes => {
                let d = &case["decision"];
                let margin = u(&d["margin"]);
                assert_eq!(n(&after["bets_used"]), used + 1, "case {id}");
                assert_eq!(u(&after["at_risk"]), risk + margin, "case {id}");
                assert_eq!(
                    u(&after["notional"]),
                    margin * n(&d["leverage"]) as u128,
                    "case {id}"
                );
            }
            _ => {
                assert_eq!(n(&after["bets_used"]), used, "case {id}");
                assert_eq!(u(&after["at_risk"]), risk, "case {id}");
                assert!(after.get("notional").is_none(), "case {id}");
            }
        }
    }
    // Every one of checks 1, 2 and 6-12 is exercised at least once.
    let seen: Vec<Refusal> = cases
        .iter()
        .filter_map(|c| match expected_outcome(c) {
            Outcome::Nope(code, _, _) => Some(code),
            _ => None,
        })
        .collect();
    for code in Refusal::ALL
        .iter()
        .filter(|r| matches!(r.check_number(), 1 | 2 | 6..=12))
    {
        assert!(seen.contains(code), "no case for {code}");
    }
}

// ----- decision lines -------------------------------------------------------------------------

/// Reference copy of the decision line's one correct writing (section 6.2).
fn canonical_line(round: u64, nonce: &str, d: &Value) -> String {
    match s(&d["action"]) {
        "SKIP" => format!(r#"{{"v":1,"round":{round},"nonce":"{nonce}","action":"skip"}}"#),
        "BET" => {
            let side: Side = s(&d["side"]).parse().unwrap();
            let market: Market = s(&d["market"]).parse().unwrap();
            format!(
                r#"{{"v":1,"round":{round},"nonce":"{nonce}","action":"bet","market":"{}","side":"{}","margin_e6":"{}","leverage":{}}}"#,
                market.as_str(),
                side.as_decision_str(),
                u(&d["margin"]),
                n(&d["leverage"])
            )
        }
        other => panic!("unknown action {other}"),
    }
}

#[test]
fn decision_line_cases_are_complete_and_well_written() {
    let file = load("vectors/checks.json");
    let block = &file["decision_line_cases"];
    let (round, nonce) = (n(&block["round_id"]), s(&block["nonce"]));
    assert_eq!((round, nonce), (42, "9f2c41d07ab35e16"));
    let cases = arr(&block["cases"]);
    assert_eq!(cases.len(), 13, "D1..D13 in 1.1");

    let d2 = s(&cases[1]["text"]).to_string();
    for (i, case) in cases.iter().enumerate() {
        let id = s(&case["id"]);
        assert_eq!(id, format!("D{}", i + 1));
        let text = s(&case["text"]);
        let e = &case["expected"];
        if let Some(ok) = e.get("ok") {
            // A well-formed answer is exactly the one correct writing of its decision.
            assert_eq!(text, canonical_line(round, nonce, ok), "{id}");
        } else {
            assert_eq!(
                s(&e["refusal"]),
                Refusal::MalformedDecision.as_str(),
                "{id}"
            );
            assert_ne!(text, d2, "{id} must differ from D2");
            // It is not the correct writing of any well-formed case either.
            for other in cases.iter().filter_map(|c| c["expected"].get("ok")) {
                assert_ne!(text, canonical_line(round, nonce, other), "{id}");
            }
        }
    }
    // Spot checks on the cases whose wording is easiest to get wrong.
    assert_eq!(
        s(&cases[11]["text"]),
        format!("{}\n", s(&cases[0]["text"])),
        "D12 = D1 + newline"
    );
    assert!(
        s(&cases[3]["text"]).starts_with("```") && s(&cases[3]["text"]).contains(&d2),
        "D4 fences D2"
    );
    assert!(
        s(&cases[10]["text"]).ends_with(&d2) && !s(&cases[10]["text"]).starts_with('{'),
        "D11 = sentence + D2"
    );
}

// ----- rulebook text --------------------------------------------------------------------------

/// Reference copy of the section 6.1 template.
fn reference_rulebook(st: &Value) -> String {
    let r = rank_row(s(&st["rank"]).parse().unwrap());
    let base = u(&st["brave_at_open"]); // the rulebook always uses brave_at_open
    let (bets_used, at_risk) = (n(&st["bets_used"]), u(&st["at_risk"]));
    let per_bet = base * r.per_bet_bps / 10_000;
    let per_round_left = (base * r.per_round_bps / 10_000).saturating_sub(at_risk);
    let max_margin = per_bet.min(per_round_left);
    let bets_left = r.max_bets.saturating_sub(bets_used);
    let markets: Vec<&str> = r.markets.iter().map(|m| m.as_str()).collect();
    let sides: Vec<&str> = r.sides.iter().map(|x| x.as_decision_str()).collect();
    let playbook = if st["playbook"].is_null() {
        "none".to_string()
    } else {
        s(&st["playbook"]).to_string()
    };
    let (round, nonce) = (n(&st["round_id"]), s(&st["nonce"]));
    [
        "You are the Intern, an AI trader. A program checks your answer against the rules below. An answer that breaks a rule is refused.".to_string(),
        format!("round: {round}"),
        format!("nonce: {nonce}"),
        format!("rank: {}", r.rank.as_str()),
        format!("markets: {}", markets.join(", ")),
        format!("sides: {}", sides.join(", ")),
        format!("max_leverage: {}", r.max_leverage),
        format!("max_margin_e6: {max_margin}"),
        "min_notional_e6: 11000000".to_string(),
        format!("bets_left: {bets_left}"),
        format!("playbook: {playbook}"),
        "Amounts are US dollars times 1,000,000, so 10000000 is $10. A bet's notional is margin_e6 times leverage and must be at least min_notional_e6.".to_string(),
        "Answer with exactly one line of JSON and nothing else, in one of these two forms:".to_string(),
        format!(r#"{{"v":1,"round":{round},"nonce":"{nonce}","action":"skip"}}"#),
        format!(r#"{{"v":1,"round":{round},"nonce":"{nonce}","action":"bet","market":"DOGE","side":"long","margin_e6":"11000000","leverage":1}}"#),
    ]
    .join("\n")
}

#[test]
fn rulebook_cases_match_the_section_6_1_template() {
    let file = load("vectors/checks.json");
    let cases = arr(&file["rulebook_cases"]["cases"]);
    assert!(
        !cases.is_empty(),
        "section 12 asks for at least one rulebook case"
    );
    for case in cases {
        let id = s(&case["id"]);
        let text = s(&case["text"]);
        let st = &case["state"];
        assert_eq!(text, reference_rulebook(st), "{id}");
        assert!(
            !text.ends_with('\n'),
            "{id}: no newline after the last line"
        );
        assert_eq!(text.lines().count(), 15, "{id}: fifteen lines (1.2)");
        let nonce = s(&st["nonce"]);
        assert!(
            nonce.len() == 16
                && nonce
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "{id}: nonce"
        );
    }
    // R1 is typed out a second time by hand, so the template itself is pinned, not only the copies.
    let r1 = "You are the Intern, an AI trader. A program checks your answer against the rules below. An answer that breaks a rule is refused.\n\
round: 42\n\
nonce: 9f2c41d07ab35e16\n\
rank: INTERN\n\
markets: DOGE, SHIB, PEPE, PENGU\n\
sides: long\n\
max_leverage: 1\n\
max_margin_e6: 20000000\n\
min_notional_e6: 11000000\n\
bets_left: 1\n\
playbook: none\n\
Amounts are US dollars times 1,000,000, so 10000000 is $10. A bet's notional is margin_e6 times leverage and must be at least min_notional_e6.\n\
Answer with exactly one line of JSON and nothing else, in one of these two forms:\n\
{\"v\":1,\"round\":42,\"nonce\":\"9f2c41d07ab35e16\",\"action\":\"skip\"}\n\
{\"v\":1,\"round\":42,\"nonce\":\"9f2c41d07ab35e16\",\"action\":\"bet\",\"market\":\"DOGE\",\"side\":\"long\",\"margin_e6\":\"11000000\",\"leverage\":1}";
    assert_eq!(s(&cases[0]["text"]), r1);
}
