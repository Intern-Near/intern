//! `cargo test -p stub`. The host functions run through near-sdk's unit-testing VM.

use super::*;
use near_sdk::serde_json::{from_str, to_value};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;
use std::collections::BTreeSet;
use std::path::PathBuf;

const ME: &str = "stub.hackcheck-2026-1103.testnet";
/// Round 42 of the section 8.2 samples starts here (2026-11-11T00:00:00Z).
const S42: u64 = 1_794_355_200_000;

fn ctx(now_ms: u64, deposit: u128, caller: &str) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(ME.parse().unwrap())
        .predecessor_account_id(caller.parse().unwrap())
        .block_timestamp(now_ms * 1_000_000)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .build());
}

/// The HOLDING scene on the real 24-hour clock, round 42 starting at S42, "now" inside HOLD.
fn real_holding() -> Stub {
    ctx(S42 + scenes::scene_point(Scene::Holding, &REAL), 0, BOSS);
    Stub::make(Scene::Holding, true, Some(S42))
}

/// The deployed configuration: demo clock, placed relative to "now".
fn demo(scene: Scene, now: u64) -> Stub {
    ctx(now, 0, BOSS);
    Stub::make(scene, false, None)
}

const NOW: u64 = 1_794_400_000_000;

fn j<T: near_sdk::serde::Serialize>(x: T) -> Value {
    to_value(x).unwrap()
}

fn interface(rel: &str) -> Value {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../interface")
        .join(rel);
    from_str(&std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display())))
        .unwrap()
}

// ----- section 8.2 ----------------------------------------------------------------------------------

#[test]
fn holding_on_the_real_clock_reproduces_the_section_8_2_samples() {
    let s = real_holding();
    let sample = |t: &str| -> Value { from_str(t).unwrap() };

    assert_eq!(
        j(s.get_rank()),
        sample(r#"{"rank":"INTERN","status":"EMPLOYED","since_round":1,"pending":null}"#)
    );

    assert_eq!(
        j(s.get_round()),
        sample(
            r#"{"id":42,"phase":"HOLD","settled":false,"stuck":false,
 "started_at":1794355200000,"guess_closes_at":1794398100000,"propose_from":1794398400000,
 "propose_until":1794402000000,"close_from":1794434400000,"ends_at":1794441600000,
 "rank":"INTERN","status":"EMPLOYED","brave_at_open":"1000000000",
 "bets_used":1,"at_risk":"20000000","skipped":0,"refused":2,"result":null}"#
        )
    );

    assert_eq!(
        j(s.get_positions(None)),
        sample(
            r#"[{"id":7,"round_id":42,"market":"DOGE","side":"LONG","margin":"20000000","leverage":1,
  "notional":"20000000","status":"OPEN_SIGNED","approved_at":1794398460000,
  "open_signed_at":1794398481000,"close_signed_at":null,"settled_at":null,
  "sz_e8":"29300000000","returned":null,"result":null,"result_source":null}]"#
        )
    );

    // Section 8.2's pot sample says coin_price_e6 "1000000", but section 9.1 (1.1) says the price
    // leaves out margin in play: (1,000 - 20) / 1,000 coins = 0.98. The stub follows 9.1; this
    // difference is reported to the owner. Everything else is the sample.
    let mut pot = j(s.get_pot());
    assert_eq!(pot["coin_price_e6"], "980000");
    pot["coin_price_e6"] = "1000000".into();
    assert_eq!(
        pot,
        sample(
            r#"{"brave":{"total":"1000000000","lent":"980000000","in_play":"20000000","idle":"0","pending":"50000000","interest":"0","income_waiting":"0"},
 "safe":{"total":"400000000","lent":"400000000","idle":"0"},
 "coin_supply":"1000000000","coin_price_e6":"1000000","bosses":23,"outside_income_total":"0"}"#
        )
    );

    // Same reason: 250 coins at 0.98 = 245.
    let mut acc = j(s.get_account(BOSS.parse().unwrap()));
    assert_eq!(acc["brave_value"], "245000000");
    acc["brave_value"] = "250000000".into();
    assert_eq!(
        acc,
        sample(
            r#"{"account_id":"boss.testnet","registered":true,"coin":"250000000","locked":"100000000",
 "brave_value":"250000000","pending_brave":"0","safe":"100000000","joined_round":12,
 "vote_weight":"100000000"}"#
        )
    );

    assert_eq!(
        j(&s.get_refusals(None, None)[0]),
        sample(
            r#"{"id":31,"round_id":42,"code":"OVER_TRADE_LIMIT","at":1794398420000,
  "asked":"450000000","limit":"20000000",
  "decision":{"action":"BET","market":"DOGE","side":"LONG","margin":"450000000","leverage":1},
  "is_first":false,"credited_to":null}"#
        )
    );

    // The feed sample's two items appear in order (seq numbers differ). Section 10 gives `refused`
    // an `is_first` field that the 8.2 sample leaves out; the stub follows section 10.
    let feed: Vec<Value> = s.get_feed(None, None).into_iter().map(j).collect();
    let refused = feed
        .iter()
        .position(|f| f["event"] == "refused" && f["data"]["refusal_id"] == 31)
        .unwrap();
    let approved = feed.iter().position(|f| f["event"] == "approved").unwrap();
    assert!(refused < approved);
    let mut r = feed[refused].clone();
    assert_eq!(r["data"]["is_first"], false);
    r["data"].as_object_mut().unwrap().remove("is_first");
    // Feed items added by set_scene carry the block time (the site's 15-second freshness rule).
    let block_time = S42 + scenes::scene_point(Scene::Holding, &REAL);
    assert_eq!(r["at"], block_time);
    assert_eq!(
        r["data"],
        sample(
            r#"{"refusal_id":31,"round_id":42,"code":"OVER_TRADE_LIMIT","asked":"450000000","limit":"20000000"}"#
        )
    );
    assert_eq!(feed[approved]["at"], block_time);
    assert_eq!(
        feed[approved]["data"],
        sample(
            r#"{"position_id":7,"round_id":42,"market":"DOGE","side":"LONG","margin":"20000000","leverage":1}"#
        )
    );
}

// ----- section 8.1 shapes ------------------------------------------------------------------------------

fn keys(v: &Value) -> BTreeSet<String> {
    v.as_object()
        .unwrap_or_else(|| panic!("not an object: {v}"))
        .keys()
        .cloned()
        .collect()
}

fn has_keys(what: &str, v: &Value, want: &[&str]) {
    let want: BTreeSet<String> = want.iter().map(|s| s.to_string()).collect();
    assert_eq!(keys(v), want, "{what}");
}

fn is_u128(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) && (s == "0" || !s.starts_with('0'))
    })
}

fn is_signed(v: &Value) -> bool {
    v.as_str()
        .is_some_and(|s| is_u128(&Value::from(s.strip_prefix('-').unwrap_or(s))) && s != "-0")
}

const ROUND: &[&str] = &[
    "id",
    "phase",
    "settled",
    "stuck",
    "started_at",
    "guess_closes_at",
    "propose_from",
    "propose_until",
    "close_from",
    "ends_at",
    "rank",
    "status",
    "brave_at_open",
    "bets_used",
    "at_risk",
    "skipped",
    "refused",
    "result",
];
const POSITION: &[&str] = &[
    "id",
    "round_id",
    "market",
    "side",
    "margin",
    "leverage",
    "notional",
    "status",
    "approved_at",
    "open_signed_at",
    "close_signed_at",
    "settled_at",
    "sz_e8",
    "returned",
    "result",
    "result_source",
];

fn check_round(v: &Value) {
    has_keys("Round", v, ROUND);
    assert!(["OPEN", "PROPOSE", "HOLD", "CLOSE"].contains(&v["phase"].as_str().unwrap()));
    assert!(is_u128(&v["brave_at_open"]) && is_u128(&v["at_risk"]));
    assert!(v["result"].is_null() || is_signed(&v["result"]));
}

fn check_decision(v: &Value) {
    match v["action"].as_str().unwrap() {
        "SKIP" => has_keys("Decision", v, &["action"]),
        "BET" => {
            has_keys(
                "Decision",
                v,
                &["action", "market", "side", "margin", "leverage"],
            );
            assert!(is_u128(&v["margin"]));
        }
        other => panic!("action {other}"),
    }
}

fn check_signed_action(v: &Value) {
    has_keys(
        "SignedAction",
        v,
        &[
            "id",
            "position_id",
            "kind",
            "action",
            "nonce",
            "expires_after",
            "signature",
            "created_at",
        ],
    );
    has_keys("signature", &v["signature"], &["r", "s", "v"]);
    assert!(v["signature"]["r"].as_str().unwrap().starts_with("0x"));
    assert!(["LEVERAGE", "OPEN", "CLOSE"].contains(&v["kind"].as_str().unwrap()));
    assert!(v["action"].is_object());
    assert_eq!(
        v["expires_after"].as_u64().unwrap(),
        v["nonce"].as_u64().unwrap() + 120_000
    );
}

fn check_all_views(s: &Stub, scene: &str) {
    let c = j(s.get_constants());
    has_keys(
        "Constants",
        &c,
        &[
            "interface_version",
            "network",
            "usdc_token",
            "coin_decimals",
            "ranks",
            "markets",
            "min_notional",
            "round",
            "vote",
            "model",
            "funding",
            "result_source",
            "lending",
            "hl",
            "runner",
            "min_first_deposit",
            "refusal_codes",
            "coach_cut_bps",
            "goals",
            "stickers",
            "launchpad",
        ],
    );
    assert_eq!(c["interface_version"], "1.6");
    has_keys(
        "Constants.round",
        &c["round"],
        &[
            "genesis_ms",
            "round_ms",
            "guess_close_ms",
            "propose_from_ms",
            "propose_until_ms",
            "close_from_ms",
            "tail_fade_ms",
        ],
    );
    has_keys(
        "Constants.vote",
        &c["vote"],
        &[
            "promote_pass_bps",
            "promote_quorum_bps",
            "tighten_pass_bps",
            "vote_ms",
            "weight_full_rounds",
        ],
    );
    has_keys(
        "Constants.model",
        &c["model"],
        &["id", "signing_algo", "signer"],
    );
    has_keys(
        "Constants.funding",
        &c["funding"],
        &[
            "mode",
            "quote_signer",
            "quote_max_age_ms",
            "max_funding_cost_bps",
        ],
    );
    has_keys("Constants.lending", &c["lending"], &["mode"]);
    has_keys(
        "Constants.hl",
        &c["hl"],
        &[
            "testnet",
            "address",
            "signer_contract",
            "path",
            "order_expiry_ms",
        ],
    );
    assert_eq!(c["ranks"].as_array().unwrap().len(), 3);
    assert_eq!(c["markets"].as_array().unwrap().len(), 6);
    assert_eq!(c["refusal_codes"].as_array().unwrap().len(), 16);
    for m in c["markets"].as_array().unwrap() {
        has_keys(
            "MarketInfo",
            m,
            &["market", "hl_name", "hl_asset", "sz_decimals"],
        );
    }
    // The round grid: the shown round starts on it.
    let round = j(s.get_round());
    let (g, rm) = (
        c["round"]["genesis_ms"].as_u64().unwrap(),
        c["round"]["round_ms"].as_u64().unwrap(),
    );
    assert_eq!(
        round["started_at"].as_u64().unwrap(),
        g + (round["id"].as_u64().unwrap() - 1) * rm,
        "{scene}"
    );

    for r in Rank::ALL {
        let l = j(s.get_limits(r));
        has_keys(
            "Limits",
            &l,
            &[
                "rank",
                "per_bet_bps",
                "max_bets",
                "per_round_bps",
                "sides",
                "max_leverage",
                "markets",
            ],
        );
    }

    let rank = j(s.get_rank());
    has_keys(
        "RankState",
        &rank,
        &["rank", "status", "since_round", "pending"],
    );
    if !rank["pending"].is_null() {
        has_keys(
            "RankState.pending",
            &rank["pending"],
            &["rank", "status", "effective_round"],
        );
    }

    check_round(&round);
    let id = round["id"].as_u64().unwrap();
    assert_eq!(j(s.get_round_by_id(id)), round);
    check_round(&j(s.get_round_by_id(id - 1)));
    assert!(s.get_round_by_id(id + 1).is_none());
    assert!(s.get_round_by_id(0).is_none());

    let rb = j(s.get_rulebook());
    has_keys("Rulebook", &rb, &["round_id", "nonce", "text"]);
    let nonce = rb["nonce"].as_str().unwrap();
    assert!(
        nonce.len() == 16
            && nonce
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    );
    assert!(rb["text"]
        .as_str()
        .unwrap()
        .contains(&format!("nonce: {nonce}\n")));

    for p in s.get_positions(None).into_iter().map(j) {
        has_keys("Position", &p, POSITION);
        assert!(is_u128(&p["margin"]) && is_u128(&p["notional"]));
        assert!(p["result"].is_null() || is_signed(&p["result"]));
    }
    for a in s.get_outbox(None, None).into_iter().map(j) {
        check_signed_action(&a);
    }

    let pot = j(s.get_pot());
    has_keys(
        "Pot",
        &pot,
        &[
            "brave",
            "safe",
            "coin_supply",
            "coin_price_e6",
            "bosses",
            "outside_income_total",
        ],
    );
    has_keys(
        "Pot.brave",
        &pot["brave"],
        &[
            "total",
            "lent",
            "in_play",
            "idle",
            "pending",
            "interest",
            "income_waiting",
        ],
    );
    has_keys("Pot.safe", &pot["safe"], &["total", "lent", "idle"]);
    let n = |v: &Value| v.as_str().unwrap().parse::<u128>().unwrap();
    let b = &pot["brave"];
    assert_eq!(
        n(&b["total"]),
        n(&b["lent"]) + n(&b["in_play"]) + n(&b["idle"]),
        "{scene}: brave adds up"
    );
    assert_eq!(
        n(&pot["safe"]["total"]),
        n(&pot["safe"]["lent"]) + n(&pot["safe"]["idle"])
    );
    assert_eq!(
        n(&pot["coin_price_e6"]),
        (n(&b["total"]) - n(&b["in_play"])) * 1_000_000 / n(&pot["coin_supply"]),
        "{scene}: price leaves out margin in play"
    );

    for who in [BOSS, "nobody.testnet"] {
        let a = j(s.get_account(who.parse().unwrap()));
        has_keys(
            "Account",
            &a,
            &[
                "account_id",
                "registered",
                "coin",
                "locked",
                "brave_value",
                "pending_brave",
                "safe",
                "joined_round",
                "vote_weight",
            ],
        );
        for k in [
            "coin",
            "locked",
            "brave_value",
            "pending_brave",
            "safe",
            "vote_weight",
        ] {
            assert!(is_u128(&a[k]), "{k}");
        }
    }

    for v in s.get_votes(None, None).into_iter().map(j) {
        has_keys(
            "Vote",
            &v,
            &[
                "id",
                "kind",
                "playbook_id",
                "opened_by",
                "opened_at",
                "closes_at",
                "yes",
                "no",
                "locked_weight_at_open",
                "state",
                "effective_round",
            ],
        );
    }
    for r in s.get_refusals(None, None).into_iter().map(j) {
        has_keys(
            "Refusal",
            &r,
            &[
                "id",
                "round_id",
                "code",
                "at",
                "asked",
                "limit",
                "decision",
                "is_first",
                "credited_to",
            ],
        );
        if !r["decision"].is_null() {
            check_decision(&r["decision"]);
        }
        let code: Refusal = r["code"].as_str().unwrap().parse().unwrap();
        assert_eq!(
            !r["asked"].is_null(),
            code.carries_numbers(),
            "{scene} refusal {}",
            r["id"]
        );
    }
    let firsts: Vec<Value> = s.get_sticker_firsts().into_iter().map(j).collect();
    assert_eq!(firsts.len(), 16);
    for (f, code) in firsts.iter().zip(Refusal::ALL) {
        has_keys(
            "StickerFirst",
            f,
            &["code", "account_id", "round_id", "claimed"],
        );
        assert_eq!(f["code"], code.as_str());
    }
    for f in s.get_feed(None, None).into_iter().map(j) {
        check_feed_item(&f);
    }
    assert!(s.get_active_playbook().is_none());

    has_keys(
        "ft_metadata",
        &j(s.ft_metadata()),
        &[
            "spec",
            "name",
            "symbol",
            "icon",
            "reference",
            "reference_hash",
            "decimals",
        ],
    );
    assert!(is_u128(&j(s.ft_total_supply())));
    assert!(is_u128(&j(s.ft_balance_of(BOSS.parse().unwrap()))));
    has_keys(
        "storage_balance_of",
        &j(s.storage_balance_of(BOSS.parse().unwrap())),
        &["total", "available"],
    );
    assert!(s
        .storage_balance_of("nobody.testnet".parse().unwrap())
        .is_none());
    has_keys(
        "storage_balance_bounds",
        &j(s.storage_balance_bounds()),
        &["min", "max"],
    );
}

// ----- section 10 event data -------------------------------------------------------------------------

fn check_feed_item(f: &Value) {
    has_keys("FeedItem", f, &["seq", "at", "event", "data"]);
    let want: &[&str] = match f["event"].as_str().unwrap() {
        "round_opened" => &["round_id", "rank", "status", "brave_at_open"],
        "paid_in" => &["account_id", "pool", "amount", "pending"],
        "coins_minted" => &["account_id", "coins", "round_id"],
        "cashed_out" => &["account_id", "pool", "coins", "paid"],
        "dial_turned" => &["account_id", "to", "amount"],
        "locked" | "unlocked" => &["account_id", "amount"],
        "skipped" => &["round_id"],
        "refused" => &[
            "refusal_id",
            "round_id",
            "code",
            "asked",
            "limit",
            "is_first",
        ],
        "approved" => &[
            "position_id",
            "round_id",
            "market",
            "side",
            "margin",
            "leverage",
        ],
        "order_signed" => &["action_id", "position_id", "kind"],
        "result_reported" => &["position_id", "returned", "result", "result_source"],
        "settled" => &["round_id", "result", "brave_after"],
        "vote_opened" => &["vote_id", "kind", "playbook_id", "opened_by", "closes_at"],
        "vote_cast" => &["vote_id", "account_id", "support", "weight"],
        "vote_finished" => &["vote_id", "state", "effective_round"],
        "rank_changed" => &["from", "to", "effective_round"],
        "fired" => &["round_id"],
        "rehired" => &["effective_round"],
        "outside_income" => &["source", "amount"],
        other => panic!("event {other} is not in section 10"),
    };
    has_keys(f["event"].as_str().unwrap(), &f["data"], want);
}

#[test]
fn every_view_has_the_section_8_shapes_in_every_scene() {
    for scene in Scene::ALL {
        let s = demo(scene, NOW);
        check_all_views(&s, scene.as_str());
        // The real 24-hour clock too.
        ctx(S42 + 5 * 86_400_000, 0, BOSS);
        let s = Stub::make(scene, true, None);
        check_all_views(&s, scene.as_str());
    }
}

#[test]
fn each_scene_is_in_its_phase_at_the_moment_it_is_switched_on() {
    for clock_real in [false, true] {
        for scene in Scene::ALL {
            let s = demo(scene, NOW);
            let s = if clock_real {
                ctx(NOW, 0, BOSS);
                Stub::make(scene, true, None)
            } else {
                s
            };
            let r = s.get_round();
            let into = NOW - r.started_at;
            let c = s.clock();
            let phase_by_clock = if into < c.propose_from_ms {
                Phase::Open
            } else if into < c.propose_until_ms {
                Phase::Propose
            } else if into < c.close_from_ms {
                Phase::Hold
            } else {
                Phase::Close
            };
            assert_eq!(r.phase, phase_by_clock, "{}", scene.as_str());
            assert_eq!(
                r.stuck,
                !r.settled && NOW > r.ends_at,
                "{}: stuck rule of section 5",
                scene.as_str()
            );
            // Every story event is in the past.
            assert!(
                s.get_feed(None, Some(100)).iter().all(|f| f.at <= NOW),
                "{}",
                scene.as_str()
            );
        }
    }
}

#[test]
fn set_scene_changes_round_rank_positions_and_feed() {
    let mut s = demo(Scene::Quiet, NOW);
    let mut seen = vec![];
    let mut last_seq = 0;
    for scene in Scene::ALL {
        ctx(NOW, 0, "anyone.testnet");
        s.set_scene(scene.as_str().to_string());
        let feed = s.get_feed(None, Some(100));
        assert!(
            feed.first().unwrap().seq > last_seq,
            "seq only goes up across scene switches"
        );
        last_seq = feed.last().unwrap().seq;
        let events: Vec<String> = feed
            .iter()
            .map(|f| j(f.event).as_str().unwrap().to_string())
            .collect();
        let story: Vec<Value> = feed
            .iter()
            .map(|f| near_sdk::serde_json::json!([j(f.event), f.data.clone()]))
            .collect();
        seen.push((
            scene,
            j(s.get_round()),
            j(s.get_rank()),
            j(s.get_positions(None)),
            events,
            story,
        ));
    }
    let get = |sc: Scene| seen.iter().find(|x| x.0 == sc).unwrap();
    // get_round: phases and states as named.
    let phase = |sc| get(sc).1["phase"].as_str().unwrap().to_string();
    assert_eq!(phase(Scene::Quiet), "OPEN");
    assert_eq!(phase(Scene::Refused), "PROPOSE");
    assert_eq!(phase(Scene::Holding), "HOLD");
    assert_eq!(phase(Scene::Stuck), "CLOSE");
    assert_eq!(get(Scene::Stuck).1["stuck"], true);
    assert_eq!(get(Scene::SettledWin).1["result"], "1800000");
    assert_eq!(get(Scene::SettledLoss).1["result"], "-2500000");
    // get_rank
    assert_eq!(get(Scene::Promoted).2["rank"], "ANALYST");
    assert_eq!(get(Scene::Fired).2["status"], "FIRED");
    assert_eq!(get(Scene::Quiet).2["rank"], "INTERN");
    // get_positions
    assert_eq!(get(Scene::Quiet).3, Value::Array(vec![]));
    assert_eq!(get(Scene::Approved).3[0]["status"], "APPROVED");
    assert_eq!(get(Scene::Holding).3[0]["status"], "OPEN_SIGNED");
    assert_eq!(get(Scene::Stuck).3[0]["status"], "CLOSE_SIGNED");
    assert_eq!(get(Scene::SettledWin).3[0]["status"], "SETTLED");
    // get_feed: every scene's story is different, and each ends as named.
    for (i, a) in seen.iter().enumerate() {
        for b in &seen[i + 1..] {
            assert_ne!(a.5, b.5, "{} vs {}", a.0.as_str(), b.0.as_str());
        }
    }
    let last = |sc| get(sc).4.last().unwrap().clone();
    assert_eq!(last(Scene::Refused), "refused");
    assert_eq!(last(Scene::Approved), "approved");
    assert_eq!(last(Scene::SettledWin), "settled");
    assert_eq!(last(Scene::Fired), "refused");
    assert_eq!(last(Scene::VoteOpen), "vote_cast");
    // REFUSED: a fresh OVER_TRADE_LIMIT at the end of the feed.
    ctx(NOW, 0, BOSS);
    s.set_scene("REFUSED".to_string());
    let f = s.get_feed(None, Some(1));
    assert_eq!(j(&f[0])["data"]["code"], "OVER_TRADE_LIMIT");
}

#[test]
#[should_panic(
    expected = "NOPE\\\"; one of QUIET, REFUSED, APPROVED, HOLDING, SETTLED_WIN, SETTLED_LOSS, VOTE_OPEN, PROMOTED, FIRED, STUCK"
)]
fn an_unknown_scene_is_refused_with_the_list() {
    let mut s = demo(Scene::Quiet, NOW);
    s.set_scene("NOPE".to_string());
}

// ----- paging ---------------------------------------------------------------------------------------

#[test]
fn feed_paging_and_the_1000_item_ring() {
    let mut s = demo(Scene::Quiet, NOW);
    let story = s.get_feed(None, None).len() as u64;
    // 1,100 more events, in batches (each test context allows a limited number of log lines).
    for batch in 0..22 {
        ctx(NOW + batch, 0, BOSS);
        for _ in 0..50 {
            s.lock(U128(1));
        }
    }
    let total = story + 1_100;
    let newest = s.get_feed(None, None);
    assert_eq!(newest.len(), 50, "default limit 50");
    assert_eq!(newest.last().unwrap().seq, s.feed_next - 1);
    assert!(
        newest.windows(2).all(|w| w[1].seq == w[0].seq + 1),
        "oldest first"
    );
    assert_eq!(s.get_feed(None, Some(500)).len(), 100, "capped at 100");
    // Only 1,000 are kept.
    assert_eq!(s.feed_next - s.feed_first, FEED_KEEP);
    assert_eq!(
        s.feed_next - 1,
        total,
        "the newest seq counts every event ever pushed"
    );
    assert_eq!(s.feed_first, total - FEED_KEEP + 1);
    // A reader far behind starts at the oldest kept item.
    let behind = s.get_feed(Some(1), Some(10));
    assert_eq!(behind[0].seq, s.feed_first);
    // after_seq is exclusive.
    let mid = s.feed_first + 500;
    assert_eq!(
        s.get_feed(Some(mid), Some(3))
            .iter()
            .map(|f| f.seq)
            .collect::<Vec<_>>(),
        vec![mid + 1, mid + 2, mid + 3]
    );
    // Caught up: nothing new.
    assert!(s.get_feed(Some(s.feed_next - 1), None).is_empty());
}

#[test]
fn newest_first_lists_page_from_the_highest_id() {
    let s = demo(Scene::Holding, NOW);
    let ids = |v: Vec<RefusalRecord>| v.into_iter().map(|r| r.id).collect::<Vec<_>>();
    assert_eq!(ids(s.get_refusals(None, None)), vec![31, 30, 29, 28]);
    assert_eq!(
        ids(s.get_refusals(Some(30), None)),
        vec![30, 29, 28],
        "from is the highest id to return"
    );
    assert_eq!(ids(s.get_refusals(Some(30), Some(1))), vec![30]);
    assert_eq!(ids(s.get_refusals(Some(27), None)), Vec::<u64>::new());
    let s = demo(Scene::VoteOpen, NOW);
    assert_eq!(
        s.get_votes(None, None)
            .iter()
            .map(|v| v.id)
            .collect::<Vec<_>>(),
        vec![4, 3]
    );
    assert_eq!(
        s.get_votes(Some(3), None)
            .iter()
            .map(|v| v.id)
            .collect::<Vec<_>>(),
        vec![3]
    );
    let s = demo(Scene::SettledWin, NOW);
    assert_eq!(
        s.get_outbox(Some(13), None)
            .iter()
            .map(|a| a.id)
            .collect::<Vec<_>>(),
        vec![14, 15]
    );
    assert_eq!(s.get_outbox(None, Some(1)).len(), 1);
}

// ----- section 9 actions --------------------------------------------------------------------------------

fn last_event(s: &Stub) -> Value {
    let f = j(s.get_feed(None, Some(1)).pop().unwrap());
    check_feed_item(&f);
    f
}

fn b64(t: &str) -> String {
    use near_sdk::base64::Engine;
    near_sdk::base64::engine::general_purpose::STANDARD.encode(t)
}

#[test]
fn every_action_records_a_feed_item_and_returns_its_shape() {
    let mut s = demo(Scene::Approved, NOW);
    let me: AccountId = "alice.testnet".parse().unwrap();

    ctx(NOW, STORAGE_MIN, "alice.testnet");
    assert!(!s.get_account(me.clone()).registered);
    has_keys(
        "StorageBalance",
        &j(s.storage_deposit(None, None)),
        &["total", "available"],
    );
    assert!(s.get_account(me.clone()).registered);

    ctx(NOW, 0, "usdc.testnet");
    let used = |p: PromiseOrValue<U128>| match p {
        PromiseOrValue::Value(v) => v.0,
        _ => panic!("value expected"),
    };
    assert_eq!(
        used(s.ft_on_transfer(me.clone(), U128(5_000_000), r#"{"pool":"BRAVE"}"#.into())),
        0
    );
    let e = last_event(&s);
    assert_eq!(
        (
            e["event"].as_str(),
            &e["data"]["pending"],
            &e["data"]["pool"]
        ),
        (Some("paid_in"), &Value::Bool(true), &Value::from("BRAVE"))
    );
    assert_eq!(
        used(s.ft_on_transfer(me.clone(), U128(5_000_000), r#"{"pool":"SAFE"}"#.into())),
        0
    );
    assert_eq!(last_event(&s)["data"]["pending"], false);
    let before = s.feed_next;
    assert_eq!(
        used(s.ft_on_transfer(me.clone(), U128(5_000_000), "BRAVE".into())),
        5_000_000,
        "bad msg: all returned"
    );
    assert_eq!(
        used(s.ft_on_transfer(
            me.clone(),
            U128(5_000_000),
            r#"{"pool":"BRAVE","x":1}"#.into()
        )),
        5_000_000
    );
    assert_eq!(s.feed_next, before, "a refunded pay-in records nothing");

    ctx(NOW, 1, "alice.testnet");
    s.cash_out(Pool::Brave, U128(10_000_000), None);
    let e = last_event(&s);
    assert_eq!(e["event"], "cashed_out");
    assert_eq!(e["data"]["coins"], "10000000");
    assert_eq!(
        e["data"]["paid"], "9800000",
        "at 0.98 while the bet is in play"
    );
    s.cash_out(Pool::Brave, U128(3_000_000), Some(true));
    assert_eq!(last_event(&s)["data"]["coins"], Value::Null);
    s.cash_out(Pool::Safe, U128(3_000_000), None);
    assert_eq!(last_event(&s)["data"]["paid"], "3000000");
    s.turn_dial(Pool::Safe, U128(1_000_000));
    assert_eq!(last_event(&s)["event"], "dial_turned");
    s.ft_transfer("bob.testnet".parse().unwrap(), U128(1), None);
    assert!(matches!(
        s.ft_transfer_call("bob.testnet".parse().unwrap(), U128(7), None, "".into()),
        PromiseOrValue::Value(U128(7))
    ));
    has_keys(
        "StorageBalance",
        &j(s.storage_withdraw(None)),
        &["total", "available"],
    );

    ctx(NOW, 0, "alice.testnet");
    s.lock(U128(1_000_000));
    assert_eq!(last_event(&s)["event"], "locked");
    s.unlock(U128(1_000_000));
    assert_eq!(last_event(&s)["event"], "unlocked");
    let vote_id = s.open_vote(VoteKind::Promote, None);
    let e = last_event(&s);
    assert_eq!(
        (e["event"].as_str(), e["data"]["vote_id"].as_u64()),
        (Some("vote_opened"), Some(vote_id))
    );
    s.cast(vote_id, true);
    assert_eq!(last_event(&s)["event"], "vote_cast");
    s.finish_vote(vote_id);
    assert_eq!(last_event(&s)["event"], "vote_finished");

    ctx(NOW, 0, "runner.testnet");
    let v = j(s.propose(b64("{}"), b64("x"), b64("sig"), None));
    has_keys("Verdict YES", &v, &["verdict", "position_id"]);
    assert_eq!(last_event(&s)["event"], "approved");
    // A skip line inside a JSON response body (escaped), and a bare one: both read as SKIP.
    let v = j(s.propose(
        b64("{}"),
        b64(r#"{"content":"{\"v\":1,\"action\":\"skip\"}"}"#),
        b64("sig"),
        None,
    ));
    has_keys("Verdict SKIP", &v, &["verdict"]);
    assert_eq!(last_event(&s)["event"], "skipped");
    let v = j(s.propose(
        b64("{}"),
        b64(r#"{"v":1,"round":42,"nonce":"x","action":"skip"}"#),
        b64("sig"),
        None,
    ));
    assert_eq!(v["verdict"], "SKIP");
    let v = j(s.propose("not base64!".into(), b64("x"), b64("sig"), None));
    has_keys(
        "Verdict NOPE",
        &v,
        &["verdict", "refusal_id", "code", "asked", "limit"],
    );
    assert_eq!(v["code"], "BAD_MODEL_SIGNATURE");
    let v = j(s.propose(
        b64("{}"),
        b64("x"),
        b64("sig"),
        Some(Funding {
            quote: "%%".into(),
            signature: b64("s"),
        }),
    ));
    assert_eq!(v["code"], "BAD_QUOTE_SIGNATURE");
    assert_eq!(last_event(&s)["event"], "refused");

    let a = j(s.sign_next(7, PxE8(6_826_000)));
    check_signed_action(&a);
    assert_eq!(a["kind"], "LEVERAGE");
    let a = j(s.sign_next(7, PxE8(6_826_000)));
    assert_eq!(a["kind"], "OPEN");
    assert_eq!(a["action"]["orders"][0]["p"], "0.06826");
    assert_eq!(last_event(&s)["event"], "order_signed");

    ctx(NOW, 1, "someone.testnet");
    let a = j(s.close(7, PxE8(6_000_000)));
    assert_eq!(
        (a["kind"].as_str(), a["action"]["orders"][0]["r"].as_bool()),
        (Some("CLOSE"), Some(true))
    );
    ctx(NOW, 0, "runner.testnet");
    s.report_result(7, U128(21_800_000));
    let e = last_event(&s);
    assert_eq!(
        (
            e["data"]["result"].as_str(),
            e["data"]["result_source"].as_str()
        ),
        (Some("1800000"), Some("REPORTED"))
    );
    assert!(is_signed(&j(s.settle(42))));
    assert_eq!(last_event(&s)["event"], "settled");
}

#[test]
fn propose_follows_the_scene() {
    let want = [
        (Scene::Quiet, "OUTSIDE_WINDOW"),
        (Scene::Refused, "OVER_TRADE_LIMIT"),
        (Scene::Approved, "YES"),
        (Scene::Holding, "OUTSIDE_WINDOW"),
        (Scene::SettledWin, "OUTSIDE_WINDOW"),
        (Scene::VoteOpen, "OUTSIDE_WINDOW"),
        (Scene::Promoted, "OUTSIDE_WINDOW"),
        (Scene::Fired, "FIRED"),
        (Scene::Stuck, "OUTSIDE_WINDOW"),
    ];
    for (scene, expect) in want {
        let mut s = demo(scene, NOW);
        let nonce_before = s.get_rulebook().nonce;
        let v = j(s.propose(b64("{}"), b64("x"), b64("sig"), None));
        let got = if v["verdict"] == "NOPE" {
            v["code"].clone()
        } else {
            v["verdict"].clone()
        };
        assert_eq!(got, expect, "{}", scene.as_str());
        assert_ne!(
            s.get_rulebook().nonce,
            nonce_before,
            "the nonce moves after every ruling"
        );
        if expect == "OUTSIDE_WINDOW" {
            let c = s.clock();
            let limit = if s.get_round().phase == Phase::Open {
                c.propose_from_ms
            } else {
                c.propose_until_ms
            };
            assert_eq!(
                v["limit"],
                limit.to_string(),
                "{}: limit for too early / too late",
                scene.as_str()
            );
            assert_eq!(v["asked"], (NOW - s.anchor()).to_string());
        }
    }
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn cash_out_needs_one_yocto() {
    let mut s = demo(Scene::Quiet, NOW);
    s.cash_out(Pool::Brave, U128(1), None);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn close_needs_one_yocto() {
    let mut s = demo(Scene::Holding, NOW);
    s.close(7, PxE8(1));
}

#[test]
#[should_panic(expected = "attach at least storage_balance_bounds().min")]
fn registering_needs_the_storage_deposit() {
    let mut s = demo(Scene::Quiet, NOW);
    ctx(NOW, 1, "carol.testnet");
    s.storage_deposit(None, None);
}

#[test]
fn px_e8_is_read_as_a_number_or_a_string() {
    let n: PxE8 = from_str("6826000").unwrap();
    let t: PxE8 = from_str("\"6826000\"").unwrap();
    assert_eq!((n.0, t.0), (6_826_000, 6_826_000));
    assert!(from_str::<PxE8>("0").is_err());
    assert!(from_str::<PxE8>("\"-1\"").is_err());
    assert_eq!(wire_number(6_826_000), "0.06826");
    assert_eq!(wire_number(100_000_000), "1");
    assert_eq!(wire_number(29_300_000_000), "293");
}

// ----- the stub's tables against the interface files ------------------------------------------------

#[test]
fn tables_match_the_interface_files() {
    let ranks = interface("ranks.json");
    let mine: Vec<Value> = Rank::ALL.into_iter().map(|r| j(table::limits(r))).collect();
    assert_eq!(Value::Array(mine), ranks["ranks"]);
    let markets = interface("markets.json");
    assert_eq!(j(table::testnet_markets()), markets["testnet"]);
    let codes: Vec<Value> = interface("refusal-codes.json")["codes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["code"].clone())
        .collect();
    assert_eq!(j(table::refusal_codes()), Value::Array(codes));
}

#[test]
fn rulebook_text_matches_every_rulebook_case() {
    let checks = interface("vectors/checks.json");
    for case in checks["rulebook_cases"]["cases"].as_array().unwrap() {
        let st = &case["state"];
        let n = |k: &str| st[k].as_str().unwrap().parse::<u128>().unwrap();
        let text = table::rulebook_text(
            st["round_id"].as_u64().unwrap(),
            st["nonce"].as_str().unwrap(),
            st["rank"].as_str().unwrap().parse().unwrap(),
            n("brave_at_open"),
            st["bets_used"].as_u64().unwrap() as u32,
            n("at_risk"),
            st["playbook"].as_str(),
        );
        assert_eq!(text, case["text"].as_str().unwrap(), "{}", case["id"]);
    }
}

#[test]
fn the_rulebook_view_uses_the_scene_state() {
    let s = demo(Scene::Holding, NOW);
    let rb = s.get_rulebook();
    assert_eq!(rb.round_id, 42);
    assert!(
        rb.text.contains("rank: INTERN\n")
            && rb.text.contains("max_margin_e6: 0\n")
            && rb.text.contains("bets_left: 0\n")
    );
    let s = demo(Scene::Promoted, NOW);
    let rb = s.get_rulebook();
    assert!(
        rb.text.contains("round: 45\n")
            && rb.text.contains("rank: ANALYST\n")
            && rb.text.contains("max_margin_e6: 52590000\n")
    );
}

// ----- the website's finding (2026-11-11): times went stale between set_scene calls ----------------------

#[test]
fn the_round_follows_the_clock_so_the_phase_always_matches_the_scene() {
    for scene in Scene::ALL {
        let mut s = demo(scene, NOW);
        let phase = s.get_round().phase;
        // Hours later, with no set_scene in between.
        for later in [NOW + 31 * 60_000, NOW + 5 * 3_600_000, NOW + 3 * 86_400_000] {
            ctx(later, 0, BOSS);
            let r = s.get_round();
            assert_eq!(r.phase, phase, "{} at +{} ms", scene.as_str(), later - NOW);
            assert_eq!(
                later - r.started_at,
                scenes::scene_point(scene, &DEMO),
                "now sits at the scene's point"
            );
            assert_eq!(
                r.stuck,
                scene == Scene::Stuck,
                "{}: only STUCK is stuck",
                scene.as_str()
            );
            let c = j(s.get_constants());
            let g = c["round"]["genesis_ms"].as_u64().unwrap();
            assert_eq!(
                r.started_at,
                g + (r.id - 1) * DEMO.round_ms,
                "still on the grid"
            );
        }
        // set_scene's feed items carry the block time of the set_scene call.
        let at = NOW + 6 * 3_600_000;
        ctx(at, 0, "anyone.testnet");
        s.set_scene(scene.as_str().to_string());
        assert!(
            s.get_feed(None, Some(100)).iter().all(|f| f.at == at),
            "{}",
            scene.as_str()
        );
    }
}

#[test]
fn a_fired_refusal_carries_no_decision() {
    let s = demo(Scene::Fired, NOW);
    let r = &s.get_refusals(None, Some(1))[0];
    assert_eq!((r.code, r.decision.is_none()), (Refusal::Fired, true));
}
