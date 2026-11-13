//! Step 7 unit tests: the real AI check with NEAR's host functions on Engine 2's recordings, and order
//! signing (sign_next, close, the callback, the outbox). `cargo test -p coin`.

use super::*;
use crate::ai::decision_line;
use crate::sign::{hex, unhex, PinsInit, OUTBOX_KEEP};
use k256::ecdsa::SigningKey;
use near_sdk::serde_json::Value;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};
use shared::{Decision, Host, Market, Side};
use std::path::PathBuf;

const ME: &str = "coin.test";
const RUNNER: &str = "runner.test";
const G: u64 = 1_794_355_200_000;
const ROUND: u64 = 86_400_000;
const IN_WINDOW: u64 = 43_260_000;
const IN_CLOSE: u64 = 79_300_000;
const GLM: &str = "z-ai/glm-5.3-flash";
const GLM_ED25519: &str = "5a0210f2442c79355784f9de021985429561da5bacc3a4424b01ac52b7e0caff";
const GLM_ECDSA: &str = "0x3b753b4406613c5e70ae640508632b600424fa0c";

fn ctx_full(now: u64, caller: &str, deposit: u128, gas: u64, results: Vec<PromiseResult>) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(ME.parse().unwrap())
            .predecessor_account_id(caller.parse().unwrap())
            .block_timestamp(now * 1_000_000)
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .prepaid_gas(Gas::from_tgas(gas))
            .build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        results
    );
}

fn ctx(now: u64, caller: &str, deposit: u128) {
    ctx_full(now, caller, deposit, 300, vec![]);
}

fn acct(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn at(round: u64, into: u64) -> u64 {
    G + (round - 1) * ROUND + into
}

fn fixtures(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures")
        .join(rel)
}

// ----- the real AI check, through NEAR's host functions ------------------------------------------------

struct Recording {
    name: String,
    request: Vec<u8>,
    response: Vec<u8>,
    sig_ed25519: Vec<u8>,
    sig_ecdsa: Vec<u8>,
    rulebook: String,
    round_id: u64,
    nonce: String,
}

fn glm_recordings() -> Vec<Recording> {
    let dir = fixtures("ai/z-ai--glm-5.3-flash");
    let mut out = vec![];
    for e in std::fs::read_dir(&dir).unwrap() {
        let p = e.unwrap().path();
        if !p.join("meta.json").exists() {
            continue;
        }
        let meta: Value =
            serde_json::from_str(&std::fs::read_to_string(p.join("meta.json")).unwrap()).unwrap();
        let sig = |f: &str| -> Vec<u8> {
            let v: Value =
                serde_json::from_str(&std::fs::read_to_string(p.join(f)).unwrap()).unwrap();
            unhex(v["signature"].as_str().unwrap()).unwrap()
        };
        out.push(Recording {
            name: p.file_name().unwrap().to_string_lossy().into(),
            request: std::fs::read(p.join("request.bin")).unwrap(),
            response: std::fs::read(p.join("response.bin")).unwrap(),
            sig_ed25519: sig("signature-ed25519.json"),
            sig_ecdsa: sig("signature-ecdsa.json"),
            rulebook: meta["expected"]["rulebook"].as_str().unwrap().into(),
            round_id: meta["expected"]["round_id"].as_u64().unwrap(),
            nonce: meta["expected"]["nonce"].as_str().unwrap().into(),
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    assert_eq!(
        out.len(),
        4,
        "the four GLM recordings of Engine 2's handover"
    );
    out
}

fn pins(algo: wire::SigningAlgo, signer: &str, hl_address: &str) -> sign::Pins {
    sign::Pins::from_init(PinsInit {
        model: GLM.into(),
        signing_algo: algo,
        signer: signer.into(),
        hl_address: hl_address.into(),
        signer_contract: None,
        path: None,
    })
}

#[test]
fn every_glm_recording_passes_the_real_check_with_near_host_functions_under_both_schemes() {
    ctx(G, "anyone.test", 0);
    let ed = pins(
        wire::SigningAlgo::Ed25519,
        GLM_ED25519,
        &format!("0x{}", "0".repeat(40)),
    );
    let ec = pins(
        wire::SigningAlgo::Ecdsa,
        GLM_ECDSA,
        &format!("0x{}", "0".repeat(40)),
    );
    for r in glm_recordings() {
        let e = ai::Expected {
            rulebook: &r.rulebook,
            round_id: r.round_id,
            nonce: &r.nonce,
        };
        let a = sign::real_check(&ed, &e, &r.request, &r.response, &r.sig_ed25519);
        let b = sign::real_check(&ec, &e, &r.request, &r.response, &r.sig_ecdsa);
        println!("{}: {:?}", r.name, a);
        assert_eq!(a, b, "{}: both schemes read the same", r.name);
        assert!(
            !matches!(
                a,
                Err(Refusal::BadModelSignature) | Err(Refusal::WrongRulebook)
            ),
            "{}: {a:?}",
            r.name
        );
        // Signed with ed25519, the ecdsa pin refuses it, and the other way round.
        assert_eq!(
            sign::real_check(&ed, &e, &r.request, &r.response, &r.sig_ecdsa),
            Err(Refusal::BadModelSignature)
        );
        assert_eq!(
            sign::real_check(&ec, &e, &r.request, &r.response, &r.sig_ed25519),
            Err(Refusal::BadModelSignature)
        );
    }
}

#[test]
fn one_changed_byte_or_another_rulebook_gives_the_right_refusal() {
    ctx(G, "anyone.test", 0);
    let ed = pins(
        wire::SigningAlgo::Ed25519,
        GLM_ED25519,
        &format!("0x{}", "0".repeat(40)),
    );
    let r = &glm_recordings()[1];
    let e = ai::Expected {
        rulebook: &r.rulebook,
        round_id: r.round_id,
        nonce: &r.nonce,
    };
    let flip = |b: &[u8], i: usize| {
        let mut v = b.to_vec();
        v[i] ^= 1;
        v
    };
    for i in [0, r.request.len() / 2, r.request.len() - 1] {
        assert_eq!(
            sign::real_check(&ed, &e, &flip(&r.request, i), &r.response, &r.sig_ed25519),
            Err(Refusal::BadModelSignature)
        );
    }
    for i in [0, r.response.len() / 2, r.response.len() - 1] {
        assert_eq!(
            sign::real_check(&ed, &e, &r.request, &flip(&r.response, i), &r.sig_ed25519),
            Err(Refusal::BadModelSignature)
        );
    }
    for i in [0, 31, 63] {
        assert_eq!(
            sign::real_check(&ed, &e, &r.request, &r.response, &flip(&r.sig_ed25519, i)),
            Err(Refusal::BadModelSignature)
        );
    }
    // A genuine signature over a request that carried a different rulebook than the program's.
    let other = r.rulebook.replace("max_margin_e6: ", "max_margin_e6: 9");
    let e2 = ai::Expected {
        rulebook: &other,
        round_id: r.round_id,
        nonce: &r.nonce,
    };
    assert_eq!(
        sign::real_check(&ed, &e2, &r.request, &r.response, &r.sig_ed25519),
        Err(Refusal::WrongRulebook)
    );
    // The wrong model pinned.
    let mut wrong = ed.clone();
    wrong.model = "Qwen/Qwen3.8-27B".into();
    assert_eq!(
        sign::real_check(&wrong, &e, &r.request, &r.response, &r.sig_ed25519),
        Err(Refusal::BadModelSignature)
    );
    // Nothing pinned: everything refused, nothing panics.
    assert_eq!(
        sign::real_check(
            &sign::Pins::unset(),
            &e,
            &r.request,
            &r.response,
            &r.sig_ed25519
        ),
        Err(Refusal::BadModelSignature)
    );
    assert_eq!(
        sign::real_check(&ed, &e, b"", b"", b""),
        Err(Refusal::BadModelSignature)
    );
}

// ----- hashes -----------------------------------------------------------------------------------------

#[test]
fn the_contract_builds_the_same_hashes_as_hl_orders_reference_cases() {
    ctx(G, "anyone.test", 0);
    let file: Value = serde_json::from_str(
        &std::fs::read_to_string(fixtures("hl/reference/digests.json")).unwrap(),
    )
    .unwrap();
    let e8 = |s: &str| -> u64 {
        let (w, f) = s.split_once('.').unwrap_or((s, ""));
        w.parse::<u64>().unwrap() * 100_000_000 + format!("{f:0<8}").parse::<u64>().unwrap()
    };
    let mut n = 0;
    for c in file["cases"].as_array().unwrap() {
        let Some(expires) = c["expires_after"].as_u64() else {
            continue;
        };
        let i = &c["inputs"];
        let action = match i["kind"].as_str().unwrap() {
            "order" => hl_order::Action::Order {
                asset: i["asset"].as_u64().unwrap() as u32,
                is_buy: i["is_buy"].as_bool().unwrap(),
                px_e8: e8(i["px"].as_str().unwrap()),
                sz_e8: e8(i["sz"].as_str().unwrap()),
                reduce_only: i["reduce_only"].as_bool().unwrap(),
            },
            _ => hl_order::Action::Leverage {
                asset: i["asset"].as_u64().unwrap() as u32,
                leverage: i["leverage"].as_u64().unwrap() as u32,
            },
        };
        let built = hl_order::build(
            &host::NearHost,
            &action,
            c["nonce"].as_u64().unwrap(),
            expires,
            c["testnet"].as_bool().unwrap(),
        )
        .unwrap();
        assert_eq!(
            format!("0x{}", hex(&built.digest)),
            c["digest"].as_str().unwrap(),
            "{}",
            c["id"]
        );
        assert_eq!(
            built.action_json,
            c["action_json"].as_str().unwrap(),
            "{}",
            c["id"]
        );
        n += 1;
    }
    assert!(n >= 5, "{n} cases with an expiry");
}

// ----- signing ----------------------------------------------------------------------------------------

/// A test key standing in for NEAR's signing network, and the address it gives.
fn test_key() -> (SigningKey, String) {
    let k = SigningKey::from_slice(&[7u8; 32]).unwrap();
    let point = k.verifying_key().to_sec1_point(false);
    let addr = format!(
        "0x{}",
        hex(&env::keccak256_array(&point.as_bytes()[1..])[12..])
    );
    (k, addr)
}

/// The signing network's answer for `digest`, in its own shape.
fn mpc_reply(k: &SigningKey, digest: &[u8; 32]) -> Vec<u8> {
    let (sig, rid) = k.sign_prehash_recoverable(digest);
    let rs = sig.to_bytes();
    let prefix = if rid.is_y_odd() { "03" } else { "02" };
    json!({"scheme": "Secp256k1", "big_r": {"affine_point": format!("{prefix}{}", hex(&rs[..32]).to_uppercase())},
           "s": {"scalar": hex(&rs[32..]).to_uppercase()}, "recovery_id": rid.to_byte()})
    .to_string()
    .into_bytes()
}

/// A coin with the test key's address pinned, $1,000 in BRAVE, and a $11 DOGE long approved in round 1.
fn with_a_yes(addr: &str) -> (Coin, u64) {
    near_sdk::mock::with_mocked_blockchain(|b| {
        b.take_storage();
    });
    ctx(G + 1_000, "owner.test", 0);
    let mut c = Coin::new(InitConfig {
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
        pins: Some(PinsInit {
            model: GLM.into(),
            signing_algo: wire::SigningAlgo::Ed25519,
            signer: GLM_ED25519.into(),
            hl_address: addr.into(),
            signer_contract: None,
            path: None,
        }),
        stickers: None,
        launchpad: None,
        lender: None,
    });
    c.books.brave_total = 1_000_000_000;
    let mut r = c.current.unwrap();
    r.brave_at_open = 1_000_000_000;
    c.current = Some(r);
    c.rounds.insert(r.id, r);
    ctx(at(1, IN_WINDOW), RUNNER, 0);
    let rb = c.get_rulebook();
    let d = Decision::Bet {
        market: Market::Doge,
        side: Side::Long,
        margin_e6: 11_000_000,
        leverage: 1,
    };
    let line = decision_line(rb.round_id, &rb.nonce, &d);
    let b64 = |b: &[u8]| {
        use near_sdk::base64::Engine;
        near_sdk::base64::engine::general_purpose::STANDARD.encode(b)
    };
    let v = c.propose(
        b64(rb.text.as_bytes()),
        b64(line.as_bytes()),
        b64(b"FAKE"),
        None,
        None,
    );
    let wire::Verdict::Yes { position_id } = v else {
        panic!("{v:?}")
    };
    (c, position_id)
}

const DOGE: u32 = 173; // testnet asset index (01 §4)
const PX: u64 = 6_826_000; // $0.06826

/// What the program really asked for in its last call, read from the calls it made: the `sign` call to
/// the signing network and the `on_signed` callback's arguments. Checked against `expect`, built here
/// independently with the program's nonce.
struct Asked {
    pid: u64,
    kind: u8,
    action_json: String,
    digest: String,
    nonce: u64,
    expires: u64,
    prev: u8,
    sz: Option<u64>,
}

fn last_request(c: &Coin, expect: hl_order::Action) -> Asked {
    let receipts = near_sdk::test_utils::get_created_receipts();
    let calls: Vec<(String, AccountId, Value, NearToken, Gas)> = receipts
        .iter()
        .flat_map(|r| {
            r.actions.iter().filter_map(move |a| match a {
                near_sdk::mock::MockAction::FunctionCallWeight {
                    method_name,
                    args,
                    attached_deposit,
                    prepaid_gas,
                    ..
                } => Some((
                    String::from_utf8(method_name.clone()).unwrap(),
                    r.receiver_id.clone(),
                    serde_json::from_slice(args).unwrap(),
                    *attached_deposit,
                    *prepaid_gas,
                )),
                _ => None,
            })
        })
        .collect();
    let (_, to, sign_args, deposit, gas) = calls
        .iter()
        .rev()
        .find(|c| c.0 == "sign")
        .expect("a sign call")
        .clone();
    let (_, _, cb, _, _) = calls
        .iter()
        .rev()
        .find(|c| c.0 == "on_signed")
        .expect("a callback")
        .clone();
    assert_eq!(
        (to.as_str(), deposit, gas),
        (
            "v1.signer-prod.testnet",
            NearToken::from_yoctonear(1),
            Gas::from_tgas(200)
        )
    );
    assert_eq!(sign_args["request"]["path"], "intern-1");
    assert_eq!(sign_args["request"]["domain_id"], 0);
    let a = Asked {
        pid: cb["position_id"].as_u64().unwrap(),
        kind: cb["kind"].as_u64().unwrap() as u8,
        action_json: cb["action_json"].as_str().unwrap().into(),
        digest: cb["digest"].as_str().unwrap().into(),
        nonce: cb["nonce"].as_str().unwrap().parse().unwrap(),
        expires: cb["expires_after"].as_str().unwrap().parse().unwrap(),
        prev: cb["prev_stage"].as_u64().unwrap() as u8,
        sz: cb["sz_e8"].as_str().map(|s| s.parse().unwrap()),
    };
    assert_eq!(
        sign_args["request"]["payload_v2"]["Ecdsa"]
            .as_str()
            .unwrap(),
        a.digest,
        "it signs the digest it checks"
    );
    assert_eq!(a.nonce, c.last_hl_nonce);
    assert_eq!(a.expires, a.nonce + 120_000);
    // 1.6: an order carries its client order id (round, position, nonce); a leverage change carries none.
    let cloid = match expect {
        hl_order::Action::Order { .. } => {
            let round_id = c.positions.get(&a.pid).unwrap().round_id;
            Some(crate::sign::order_cloid(round_id, a.pid, a.nonce))
        }
        hl_order::Action::Leverage { .. } => None,
    };
    let built =
        hl_order::build_with_cloid(&host::NearHost, &expect, cloid, a.nonce, a.expires, true).unwrap();
    assert_eq!(
        (a.action_json.as_str(), a.digest.as_str()),
        (built.action_json.as_str(), hex(&built.digest).as_str()),
        "the order asked for"
    );
    match cloid {
        Some(id) => assert!(a.action_json.ends_with(&format!(r#","c":"{}"}}],"grouping":"na"}}"#, id.to_hex()))),
        None => assert!(!a.action_json.contains(r#""c":"#)),
    }
    a
}

#[test]
fn an_orders_client_order_id_is_its_round_position_and_nonce() {
    // The worked example of crates/hl-order/README.md: round 7's opening order, position 3, nonce 1794483574065.
    assert_eq!(crate::sign::order_cloid(7, 3, 1_794_483_574_065).to_hex(), "0x0000000700000003000001a1cf8e5531");
}

/// Lands a signing call's callback with `reply`.
fn land(c: &mut Coin, now: u64, a: &Asked, reply: PromiseResult) -> Option<wire::SignedAction> {
    ctx_full(now, ME, 0, 100, vec![reply]);
    c.on_signed(
        a.pid,
        a.kind,
        a.action_json.clone(),
        a.digest.clone(),
        U64(a.nonce),
        U64(a.expires),
        a.prev,
        a.sz.map(U64),
    )
}

/// Runs `f`, which must panic with a message containing `msg` (not some other failure).
fn assert_panics_with(f: impl FnOnce(), msg: &str) {
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
    let e = r.expect_err("it should have been refused");
    let text = e
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default();
    assert!(text.contains(msg), "refused for another reason: {text}");
}

fn digest_of(a: &Asked) -> [u8; 32] {
    unhex(&a.digest).unwrap().try_into().unwrap()
}
use near_sdk::json_types::U64;

#[test]
fn sign_next_twice_puts_two_checked_signatures_in_the_outbox() {
    let (k, addr) = test_key();
    let (mut c, pid) = with_a_yes(&addr);
    // 1. Leverage.
    ctx(at(1, IN_WINDOW + 1_000), RUNNER, 0);
    let _ = c.sign_next(pid, wire::PxE8(PX));
    let lev = last_request(
        &c,
        hl_order::Action::Leverage {
            asset: DOGE,
            leverage: 1,
        },
    );
    let a = land(
        &mut c,
        at(1, IN_WINDOW + 10_000),
        &lev,
        PromiseResult::Successful(mpc_reply(&k, &digest_of(&lev))),
    )
    .expect("signed");
    assert_eq!(
        (a.id, a.kind, a.position_id),
        (1, wire::ActionKind::Leverage, pid)
    );
    assert_eq!(
        a.action,
        serde_json::from_str::<Value>(&lev.action_json).unwrap()
    );
    assert!(
        a.signature.v == 27 || a.signature.v == 28,
        "Hyperliquid's own form"
    );
    assert_eq!(
        c.get_positions(None)[0].status,
        wire::PositionStatus::Approved,
        "not open yet"
    );
    // 2. The opening order: size floor($11 / $0.06826) = 161 DOGE (0 size decimals), worth $10.99.
    ctx(at(1, IN_WINDOW + 20_000), RUNNER, 0);
    let _ = c.sign_next(pid, wire::PxE8(PX));
    let sz = hl_order::size_for(11_000_000, PX, 0);
    assert_eq!(sz, 16_100_000_000);
    assert!(
        hl_order::notional_e6(PX, sz) <= 11_000_000 && hl_order::notional_e6(PX, sz) >= 10_000_000,
        "worth $10 to $11"
    );
    let open = last_request(
        &c,
        hl_order::Action::Order {
            asset: DOGE,
            is_buy: true,
            px_e8: PX,
            sz_e8: sz,
            reduce_only: false,
        },
    );
    let b = land(
        &mut c,
        at(1, IN_WINDOW + 30_000),
        &open,
        PromiseResult::Successful(mpc_reply(&k, &digest_of(&open))),
    )
    .expect("signed");
    assert_eq!((b.id, b.kind), (2, wire::ActionKind::Open));
    assert!(b.nonce > a.nonce, "nonces only go up");
    assert_eq!(b.expires_after, b.nonce + 120_000);
    let p = &c.get_positions(None)[0];
    assert_eq!(
        (p.status, p.sz_e8),
        (wire::PositionStatus::OpenSigned, Some(U128(sz as u128)))
    );
    assert!(p.open_signed_at.is_some());
    // The outbox, oldest first, and the feed.
    ctx(at(1, IN_WINDOW + 31_000), "anyone.test", 0);
    assert_eq!(
        c.get_outbox(None, None)
            .iter()
            .map(|x| x.id)
            .collect::<Vec<_>>(),
        vec![1, 2]
    );
    assert_eq!(
        c.get_outbox(Some(1), None)
            .iter()
            .map(|x| x.id)
            .collect::<Vec<_>>(),
        vec![2]
    );
    let signed: Vec<_> = c
        .get_feed(None, Some(100))
        .into_iter()
        .filter(|f| f.event == EventName::OrderSigned)
        .collect();
    assert_eq!(signed.len(), 2);
    // A third call has nothing left to sign.
    ctx(at(1, IN_WINDOW + 32_000), RUNNER, 0);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.sign_next(pid, wire::PxE8(PX))
    }));
    assert!(r.is_err());
}

#[test]
fn a_failed_or_foreign_signature_leaves_the_bet_where_it_was() {
    let (k, addr) = test_key();
    let (mut c, pid) = with_a_yes(&addr);
    ctx(at(1, IN_WINDOW + 1_000), RUNNER, 0);
    let _ = c.sign_next(pid, wire::PxE8(PX));
    let lev = last_request(
        &c,
        hl_order::Action::Leverage {
            asset: DOGE,
            leverage: 1,
        },
    );
    // While it is being made, a second call (its own transaction) is refused: no double signing.
    ctx(at(1, IN_WINDOW + 2_000), RUNNER, 0);
    assert_panics_with(|| drop(c.sign_next(pid, wire::PxE8(PX))), "is being made");
    // The signing network failed.
    assert_eq!(
        land(
            &mut c,
            at(1, IN_WINDOW + 9_000),
            &lev,
            PromiseResult::Failed
        ),
        None
    );
    // It answered with something unreadable.
    ctx(at(1, IN_WINDOW + 10_000), RUNNER, 0);
    let _ = c.sign_next(pid, wire::PxE8(PX));
    let lev = last_request(
        &c,
        hl_order::Action::Leverage {
            asset: DOGE,
            leverage: 1,
        },
    );
    assert_eq!(
        land(
            &mut c,
            at(1, IN_WINDOW + 11_000),
            &lev,
            PromiseResult::Successful(b"{\"oops\":1}".to_vec())
        ),
        None
    );
    // It answered with a signature from another key: it does not recover to our address.
    ctx(at(1, IN_WINDOW + 12_000), RUNNER, 0);
    let _ = c.sign_next(pid, wire::PxE8(PX));
    let lev = last_request(
        &c,
        hl_order::Action::Leverage {
            asset: DOGE,
            leverage: 1,
        },
    );
    let other = SigningKey::from_slice(&[9u8; 32]).unwrap();
    assert_eq!(
        land(
            &mut c,
            at(1, IN_WINDOW + 13_000),
            &lev,
            PromiseResult::Successful(mpc_reply(&other, &digest_of(&lev)))
        ),
        None
    );
    ctx(at(1, IN_WINDOW + 14_000), "anyone.test", 0);
    assert!(
        c.get_outbox(None, None).is_empty(),
        "nothing went into the outbox"
    );
    // And then it works.
    ctx(at(1, IN_WINDOW + 15_000), RUNNER, 0);
    let _ = c.sign_next(pid, wire::PxE8(PX));
    let lev = last_request(
        &c,
        hl_order::Action::Leverage {
            asset: DOGE,
            leverage: 1,
        },
    );
    assert!(land(
        &mut c,
        at(1, IN_WINDOW + 16_000),
        &lev,
        PromiseResult::Successful(mpc_reply(&k, &digest_of(&lev)))
    )
    .is_some());
}

/// A bet opened (both signatures in), for the close tests.
fn opened() -> (Coin, u64, SigningKey, u64) {
    let (k, addr) = test_key();
    let (mut c, pid) = with_a_yes(&addr);
    ctx(at(1, IN_WINDOW + 1_000), RUNNER, 0);
    let _ = c.sign_next(pid, wire::PxE8(PX));
    let lev = last_request(
        &c,
        hl_order::Action::Leverage {
            asset: DOGE,
            leverage: 1,
        },
    );
    land(
        &mut c,
        at(1, IN_WINDOW + 2_000),
        &lev,
        PromiseResult::Successful(mpc_reply(&k, &digest_of(&lev))),
    )
    .unwrap();
    ctx(at(1, IN_WINDOW + 3_000), RUNNER, 0);
    let _ = c.sign_next(pid, wire::PxE8(PX));
    let sz = hl_order::size_for(11_000_000, PX, 0);
    let open = last_request(
        &c,
        hl_order::Action::Order {
            asset: DOGE,
            is_buy: true,
            px_e8: PX,
            sz_e8: sz,
            reduce_only: false,
        },
    );
    land(
        &mut c,
        at(1, IN_WINDOW + 4_000),
        &open,
        PromiseResult::Successful(mpc_reply(&k, &digest_of(&open))),
    )
    .unwrap();
    (c, pid, k, sz)
}

#[test]
fn close_signs_a_reduce_only_order_for_the_size_and_a_second_close_does_no_harm() {
    let (mut c, pid, k, sz) = opened();
    let pot = c.get_pot();
    // Not before the CLOSE phase.
    ctx(at(1, IN_WINDOW + 5_000), "anyone.test", 1);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(
        || c.close(pid, wire::PxE8(6_700_000))
    ))
    .is_err());
    // In the CLOSE phase, by anyone: a sell, reduce-only, the recorded size.
    for (i, px) in [6_700_000u64, 6_600_000].into_iter().enumerate() {
        ctx(at(1, IN_CLOSE + i as u64 * 60_000), "stranger.test", 1);
        let _ = c.close(pid, wire::PxE8(px));
        let req = last_request(
            &c,
            hl_order::Action::Order {
                asset: DOGE,
                is_buy: false,
                px_e8: px,
                sz_e8: sz,
                reduce_only: true,
            },
        );
        let a = land(
            &mut c,
            at(1, IN_CLOSE + i as u64 * 60_000 + 9_000),
            &req,
            PromiseResult::Successful(mpc_reply(&k, &digest_of(&req))),
        )
        .unwrap();
        assert_eq!(a.kind, wire::ActionKind::Close);
        assert!(
            a.action.to_string().contains("\"r\":true"),
            "reduce-only: {}",
            a.action
        );
    }
    ctx(at(1, IN_CLOSE + 200_000), "anyone.test", 0);
    let p = &c.get_positions(None)[0];
    assert_eq!(
        (p.status, p.sz_e8),
        (wire::PositionStatus::CloseSigned, Some(U128(sz as u128)))
    );
    assert_eq!(
        c.get_outbox(None, None).len(),
        4,
        "leverage, open, two closes"
    );
    assert_eq!(c.get_pot(), pot, "signing moves no money");
    // Once the result is in, no more closes.
    ctx(at(1, IN_CLOSE + 300_000), RUNNER, 0);
    c.report_result(pid, U128(11_500_000));
    ctx(at(1, IN_CLOSE + 301_000), "anyone.test", 1);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(
        || c.close(pid, wire::PxE8(6_700_000))
    ))
    .is_err());
}

#[test]
fn a_firing_allows_closing_at_once_and_stops_new_orders() {
    let (mut c, pid, _, _) = opened();
    c.rank.status = Status::Fired as u8;
    ctx(at(1, IN_WINDOW + 10_000), "anyone.test", 1);
    let _ = c.close(pid, wire::PxE8(6_700_000)); // allowed before the CLOSE phase once FIRED
                                                 // An approved bet that was never opened: no orders once FIRED.
    let (_, addr) = test_key();
    let (mut c2, pid2) = with_a_yes(&addr);
    c2.rank.status = Status::Fired as u8;
    ctx(at(1, IN_WINDOW + 1_000), RUNNER, 0);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(
        || c2.sign_next(pid2, wire::PxE8(PX))
    ))
    .is_err());
}

#[test]
fn only_the_runner_signs_with_enough_gas_and_prices_must_fit_hyperliquids_format() {
    let (_, addr) = test_key();
    let (mut c, pid) = with_a_yes(&addr);
    let fails = |c: &mut Coin, who: &str, gas: u64, px: u64| {
        ctx_full(at(1, IN_WINDOW + 1_000), who, 0, gas, vec![]);
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.sign_next(pid, wire::PxE8(px))
        }))
        .is_err()
    };
    assert!(fails(&mut c, "stranger.test", 300, PX), "only the runner");
    assert!(
        fails(&mut c, RUNNER, 200, PX),
        "too little gas for the signing network and the callback"
    );
    assert_eq!(c.sign_stage.get(&pid), None, "nothing changed");
    // A price with 6 significant figures is not Hyperliquid's format (checked on the opening order).
    let (k, _) = test_key();
    ctx(at(1, IN_WINDOW + 2_000), RUNNER, 0);
    let _ = c.sign_next(pid, wire::PxE8(PX));
    let lev = last_request(
        &c,
        hl_order::Action::Leverage {
            asset: DOGE,
            leverage: 1,
        },
    );
    land(
        &mut c,
        at(1, IN_WINDOW + 3_000),
        &lev,
        PromiseResult::Successful(mpc_reply(&k, &digest_of(&lev))),
    )
    .unwrap();
    assert!(
        fails(&mut c, RUNNER, 300, 6_826_150),
        "$0.0682615 has six significant figures"
    );
}

#[test]
fn the_outbox_keeps_the_last_200() {
    let (mut c, pid, k, sz) = opened();
    for i in 0..OUTBOX_KEEP + 5 {
        let now = at(1, IN_CLOSE + i * 20_000);
        ctx(now, "anyone.test", 1);
        let _ = c.close(pid, wire::PxE8(6_700_000));
        let req = last_request(
            &c,
            hl_order::Action::Order {
                asset: DOGE,
                is_buy: false,
                px_e8: 6_700_000,
                sz_e8: sz,
                reduce_only: true,
            },
        );
        land(
            &mut c,
            now + 9_000,
            &req,
            PromiseResult::Successful(mpc_reply(&k, &digest_of(&req))),
        )
        .unwrap();
    }
    ctx(at(2, 1_000), "anyone.test", 0);
    let all = c.get_outbox(Some(0), Some(100));
    let total = 2 + OUTBOX_KEEP + 5; // leverage, open, then 205 closes
    assert_eq!(
        all.first().unwrap().id,
        total - OUTBOX_KEEP + 1,
        "the oldest kept"
    );
    assert_eq!(c.outbox_next - c.outbox_first, OUTBOX_KEEP);
}

#[test]
fn constants_show_the_pins() {
    let (_, addr) = test_key();
    let (c, _) = with_a_yes(&addr);
    let k = c.get_constants();
    assert_eq!(
        (
            k.hl.address,
            k.hl.path.as_str(),
            k.hl.signer_contract.as_str()
        ),
        (addr, "intern-1", "v1.signer-prod.testnet")
    );
    assert_eq!(
        (k.model.signing_algo, k.model.signer.as_str()),
        (wire::SigningAlgo::Ed25519, GLM_ED25519)
    );
    assert!(
        k.model.id.starts_with("FAKE-AI-CHECK"),
        "a test build names its stand-in"
    );
    let _ = host::NearHost.sha256(b"");
}
