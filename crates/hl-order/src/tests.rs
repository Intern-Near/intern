//! Tests for hl-order, with a test `Host` built on ordinary Rust crates (sha2, sha3).
extern crate std;

use super::*;
use serde_json::Value;
use sha2::Sha256;
use sha3::{Digest, Keccak256};
use std::format;
use std::string::String;
use std::vec;
use std::vec::Vec;

struct TestHost;

impl Host for TestHost {
    fn sha256(&self, data: &[u8]) -> [u8; 32] {
        Sha256::digest(data).into()
    }
    fn keccak256(&self, data: &[u8]) -> [u8; 32] {
        Keccak256::digest(data).into()
    }
    fn ed25519_verify(&self, _: &[u8; 64], _: &[u8], _: &[u8; 32]) -> bool {
        unreachable!("hl-order never verifies signatures")
    }
    fn ecrecover(&self, _: &[u8; 32], _: &[u8; 64], _: u8) -> Option<[u8; 64]> {
        unreachable!("hl-order never recovers keys")
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// "0.068837" -> 6883700 (1e8 fixed point).
fn e8(s: &str) -> u64 {
    let (int, frac) = s.split_once('.').unwrap_or((s, ""));
    assert!(frac.len() <= 8, "too many decimals in {s}");
    let frac = format!("{frac:0<8}");
    int.parse::<u64>().unwrap() * E8 + frac.parse::<u64>().unwrap()
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

/// A small, fixed-seed random number generator (xorshift64*), so the property tests are repeatable.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

// ---- the reference digests ----

/// Computed with Hyperliquid's official Python SDK: intern/fixtures/hl/reference/ (script and output).
const REFERENCE: &str = include_str!("../../../fixtures/hl/reference/digests.json");

fn action_of(inputs: &Value) -> Action {
    let n = |key: &str| u32::try_from(inputs[key].as_u64().unwrap()).unwrap();
    match inputs["kind"].as_str().unwrap() {
        "order" => Action::Order {
            asset: n("asset"),
            is_buy: inputs["is_buy"].as_bool().unwrap(),
            px_e8: e8(inputs["px"].as_str().unwrap()),
            sz_e8: e8(inputs["sz"].as_str().unwrap()),
            reduce_only: inputs["reduce_only"].as_bool().unwrap(),
        },
        "leverage" => Action::Leverage {
            asset: n("asset"),
            leverage: n("leverage"),
        },
        other => panic!("unknown kind {other}"),
    }
}

#[test]
fn reference_cases_match_the_official_sdk() {
    let doc: Value = serde_json::from_str(REFERENCE).unwrap();
    assert_eq!(doc["generated_by"], "hyperliquid-python-sdk 0.24.0");
    let cases = doc["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 16);
    let probe = cases
        .iter()
        .filter(|c| c["id"].as_str().unwrap().starts_with("probe-"))
        .count();
    assert_eq!(
        probe, 8,
        "the 8 cases the research probe matched: 5 orders, 3 leverage actions"
    );

    for c in cases {
        let id = c["id"].as_str().unwrap();
        let action = action_of(&c["inputs"]);
        let nonce = c["nonce"].as_u64().unwrap();
        let expires = c["expires_after"].as_u64();
        let testnet = c["testnet"].as_bool().unwrap();

        let (json, packed) = encode(&action).unwrap();
        assert_eq!(
            json,
            c["action_json"].as_str().unwrap(),
            "{id}: action JSON"
        );
        assert_eq!(
            hex(&packed),
            c["msgpack_hex"].as_str().unwrap(),
            "{id}: msgpack bytes"
        );

        let (connection_id, digest) = l1_digest(&TestHost, &packed, nonce, expires, testnet);
        assert_eq!(
            format!("0x{}", hex(&connection_id)),
            c["connection_id"].as_str().unwrap(),
            "{id}: connectionId"
        );
        assert_eq!(
            format!("0x{}", hex(&digest)),
            c["digest"].as_str().unwrap(),
            "{id}: digest"
        );
        if let Some(printed) = c["printed_digest"].as_str() {
            assert_eq!(
                format!("0x{}", hex(&digest)),
                printed,
                "{id}: digest printed by the research run"
            );
        }

        // The public entry point gives the same result whenever there is an expiry (the contract always sets one).
        if let Some(e) = expires {
            let built = build(&TestHost, &action, nonce, e, testnet).unwrap();
            assert_eq!(built.action_json, json, "{id}: build() JSON");
            assert_eq!(built.digest, digest, "{id}: build() digest");
        }
    }
}

#[test]
fn testnet_and_mainnet_share_the_connection_id_but_not_the_digest() {
    let (_, packed) = encode(&Action::Leverage {
        asset: 173,
        leverage: 2,
    })
    .unwrap();
    let (cid_t, digest_t) = l1_digest(&TestHost, &packed, 1, Some(2), true);
    let (cid_m, digest_m) = l1_digest(&TestHost, &packed, 1, Some(2), false);
    assert_eq!(cid_t, cid_m);
    assert_ne!(digest_t, digest_m);
}

// ---- encoding details ----

#[test]
fn whole_numbers_take_the_shortest_msgpack_form() {
    let enc = |v: u64| {
        let mut o = Vec::new();
        put_uint(&mut o, v);
        o
    };
    assert_eq!(enc(12), vec![0x0c]); // kPEPE on testnet: one byte
    assert_eq!(enc(173), vec![0xcc, 0xad]); // DOGE on testnet: two bytes
    assert_eq!(enc(0), vec![0x00]);
    assert_eq!(enc(0x7f), vec![0x7f]);
    assert_eq!(enc(0x80), vec![0xcc, 0x80]);
    assert_eq!(enc(0xff), vec![0xcc, 0xff]);
    assert_eq!(enc(0x100), vec![0xcd, 0x01, 0x00]);
    assert_eq!(enc(0xffff), vec![0xcd, 0xff, 0xff]);
    assert_eq!(enc(0x1_0000), vec![0xce, 0x00, 0x01, 0x00, 0x00]);
    assert_eq!(enc(u64::from(u32::MAX)), vec![0xce, 0xff, 0xff, 0xff, 0xff]);
    assert_eq!(enc(1 << 32), vec![0xcf, 0, 0, 0, 1, 0, 0, 0, 0]);

    let order = |asset| Action::Order {
        asset,
        is_buy: true,
        px_e8: E8,
        sz_e8: E8,
        reduce_only: false,
    };
    let (_, doge) = encode(&order(173)).unwrap();
    assert!(contains(&doge, &[0xa1, b'a', 0xcc, 0xad, 0xa1, b'b']));
    let (_, pepe) = encode(&order(12)).unwrap();
    assert!(contains(&pepe, &[0xa1, b'a', 0x0c, 0xa1, b'b']));
}

#[test]
fn strings_use_fixstr_then_str8() {
    let enc = |s: &str| {
        let mut o = Vec::new();
        put_str(&mut o, s);
        o
    };
    assert_eq!(enc("na"), vec![0xa2, b'n', b'a']);
    assert_eq!(enc(&"x".repeat(31))[0], 0xbf);
    assert_eq!(enc(&"x".repeat(32))[..2], [0xd9, 32]);
    assert_eq!(enc(&"x".repeat(256))[..3], [0xda, 0x01, 0x00]);
}

#[test]
fn the_nonce_is_always_eight_bytes_big_endian() {
    assert_eq!(
        l1_data(&[0x80], 1, None),
        vec![0x80, 0, 0, 0, 0, 0, 0, 0, 1, 0x00]
    );
    assert_eq!(
        l1_data(&[0x80], 1, Some(2)),
        vec![0x80, 0, 0, 0, 0, 0, 0, 0, 1, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 2]
    );
}

#[test]
fn wire_strings_drop_trailing_zeros() {
    assert_eq!(wire(e8("0.068837")), "0.068837");
    assert_eq!(wire(6_883_700), "0.068837");
    assert_eq!(wire(17_700_000_000), "177");
    assert_eq!(wire(12_300), "0.000123");
    assert_eq!(wire(7_492_100_000_000), "74921");
    assert_eq!(wire(e8("12.345")), "12.345");
    assert_eq!(wire(1), "0.00000001");
    assert_eq!(wire(E8), "1");
    assert_eq!(wire(u64::MAX), "184467440737.09551615");
}

// ---- notional_e6, size_for, check_format ----

#[test]
fn notional_rounds_up() {
    assert_eq!(notional_e6(1, 1), 1);
    assert_eq!(notional_e6(e8("0.068837"), e8("177")), 12_184_149); // $12.184149, exact
    assert_eq!(notional_e6(e8("0.068837"), 1), 1);
    assert_eq!(notional_e6(0, 5), 0);
    let max = u128::from(u64::MAX);
    assert_eq!(
        notional_e6(u64::MAX, u64::MAX),
        (max * max).div_ceil(10_000_000_000)
    );
}

#[test]
fn size_for_examples() {
    // $20 of DOGE at 0.068391: 292 DOGE ($19.970172); 293 would be $20.038563.
    assert_eq!(size_for(20_000_000, e8("0.068391"), 0), e8("292"));
    // $20 of TRUMP at 1.1459, one size decimal: 17.4 ($19.93866).
    assert_eq!(size_for(20_000_000, e8("1.1459"), 1), e8("17.4"));
    // $10 of kPEPE at 0.005323: 1878 ($9.996594); 1879 would be $10.001917.
    assert_eq!(size_for(10_000_000, e8("0.005323"), 0), e8("1878"));
    assert_eq!(size_for(5_000_000, 0, 0), 0);
    assert_eq!(size_for(u128::MAX, 1, 0), u64::MAX - u64::MAX % E8);
}

#[test]
fn size_for_never_exceeds_the_notional_and_is_the_largest_such_size() {
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    for _ in 0..200_000 {
        let notional = u128::from(rng.below(10_000_000_000_000)); // up to $10 million
        let px_range = if rng.below(2) == 0 {
            10_000_000_000_000
        } else {
            10_000
        }; // up to $100,000, or tiny
        let px = 1 + rng.below(px_range);
        let sz_decimals = u8::try_from(rng.below(10)).unwrap(); // 0 to 9
        let size = size_for(notional, px, sz_decimals);
        let step = size_step(sz_decimals);
        assert_eq!(size % step, 0, "size {size} is not a multiple of {step}");
        assert!(
            notional_e6(px, size) <= notional,
            "px {px} size {size} exceeds {notional}"
        );
        if let Some(next) = size.checked_add(step) {
            assert!(
                notional_e6(px, next) > notional,
                "px {px} size {size} is not the largest for {notional}"
            );
        }
    }
}

#[test]
fn check_format_follows_hyperliquids_rule() {
    use HlError::*;
    // The examples on https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size
    // (read 2026-11-11).
    assert_eq!(check_format(e8("1234.5"), E8, 0), Ok(()));
    assert_eq!(check_format(e8("1234.56"), E8, 0), Err(BadPriceFormat)); // 6 significant figures
    assert_eq!(check_format(e8("0.001234"), E8, 0), Ok(()));
    assert_eq!(check_format(e8("0.0012345"), E8, 0), Err(BadPriceFormat)); // 7 decimal places
    assert_eq!(check_format(e8("0.01234"), E8, 1), Ok(()));
    assert_eq!(check_format(e8("0.012345"), E8, 1), Err(BadPriceFormat)); // more than 6 - 1 decimal places
    assert_eq!(check_format(E8, e8("1.001"), 3), Ok(()));
    assert_eq!(check_format(E8, e8("1.0001"), 3), Err(BadSizeFormat));
    // The docs: "123456 is a valid price". 01 §4, as written, allows 5 significant figures only (issue F).
    assert_eq!(check_format(e8("123456"), E8, 0), Err(BadPriceFormat));
    assert_eq!(check_format(e8("120000"), E8, 0), Ok(())); // 2 significant figures

    // Two of our markets: DOGE (size decimals 0) and TRUMP (1).
    assert_eq!(check_format(e8("0.068391"), e8("292"), 0), Ok(()));
    assert_eq!(
        check_format(e8("0.068391"), e8("292.5"), 0),
        Err(BadSizeFormat)
    );
    assert_eq!(check_format(e8("1.1459"), e8("17.4"), 1), Ok(()));
    assert_eq!(
        check_format(e8("1.1459"), e8("17.45"), 1),
        Err(BadSizeFormat)
    );
    assert_eq!(
        check_format(e8("1.14595"), e8("17.4"), 1),
        Err(BadPriceFormat)
    );

    // One decimal too many, for every size-decimals setting a perp market can have (0 to 5).
    for sz_decimals in 0u8..=5 {
        let finest_price = 10u64.pow(2 + u32::from(sz_decimals)); // 6 - sz_decimals decimal places
        assert_eq!(check_format(finest_price, E8, sz_decimals), Ok(()));
        assert_eq!(
            check_format(finest_price / 10, E8, sz_decimals),
            Err(BadPriceFormat)
        );
        let finest_size = size_step(sz_decimals);
        assert_eq!(check_format(E8, finest_size, sz_decimals), Ok(()));
        assert_eq!(
            check_format(E8, finest_size / 10, sz_decimals),
            Err(BadSizeFormat)
        );
    }

    // Zero, and size decimals that leave no room for any price.
    assert_eq!(check_format(0, E8, 0), Err(Zero));
    assert_eq!(check_format(E8, 0, 0), Err(Zero));
    assert_eq!(check_format(E8, E8, 7), Err(BadPriceFormat));
}

// ---- build ----

#[test]
fn build_refuses_zero_and_bad_prices() {
    let order = |px_e8, sz_e8| Action::Order {
        asset: 173,
        is_buy: true,
        px_e8,
        sz_e8,
        reduce_only: false,
    };
    let built = |a: &Action| build(&TestHost, a, 1, 2, true);
    assert_eq!(
        built(&Action::Leverage {
            asset: 173,
            leverage: 0
        }),
        Err(HlError::Zero)
    );
    assert_eq!(built(&order(0, E8)), Err(HlError::Zero));
    assert_eq!(built(&order(E8, 0)), Err(HlError::Zero));
    assert_eq!(
        built(&order(e8("1234.56"), E8)),
        Err(HlError::BadPriceFormat)
    );
    assert_eq!(
        built(&order(e8("0.0012345"), E8)),
        Err(HlError::BadPriceFormat)
    );
    // The size format depends on the market's size decimals, which build cannot see; check_format can.
    assert!(built(&order(e8("74921"), e8("0.000123"))).is_ok());
}

#[test]
fn action_json_is_valid_json_with_the_same_fields() {
    let mut rng = Rng(7);
    for _ in 0..5_000 {
        let asset = u32::try_from(rng.below(1 << 32)).unwrap();
        if rng.below(2) == 0 {
            let leverage = u32::try_from(1 + rng.below(u64::from(u32::MAX))).unwrap();
            let (json, _) = encode(&Action::Leverage { asset, leverage }).unwrap();
            let v: Value = serde_json::from_str(&json).unwrap();
            assert_eq!(v["type"], "updateLeverage");
            assert_eq!(v["asset"], asset);
            assert_eq!(v["isCross"], false);
            assert_eq!(v["leverage"], leverage);
        } else {
            // A price with at most 5 significant figures and 6 decimals; any size.
            let px_e8 =
                (1 + rng.below(99_999)) * 10u64.pow(2 + u32::try_from(rng.below(8)).unwrap());
            let sz_e8 = 1 + rng.below(u64::MAX - 1);
            let (is_buy, reduce_only) = (rng.below(2) == 0, rng.below(2) == 0);
            let (json, _) = encode(&Action::Order {
                asset,
                is_buy,
                px_e8,
                sz_e8,
                reduce_only,
            })
            .unwrap();
            let v: Value = serde_json::from_str(&json).unwrap();
            assert_eq!(v["type"], "order");
            assert_eq!(v["grouping"], "na");
            assert_eq!(v["orders"].as_array().unwrap().len(), 1);
            let o = &v["orders"][0];
            assert_eq!(o["a"], asset);
            assert_eq!(o["b"], is_buy);
            assert_eq!(o["p"], wire(px_e8));
            assert_eq!(o["s"], wire(sz_e8));
            assert_eq!(o["r"], reduce_only);
            assert_eq!(o["t"]["limit"]["tif"], "Ioc");
        }
    }
}

#[test]
fn never_panics_on_extreme_or_random_inputs() {
    let edges = [
        0u64,
        1,
        9,
        10,
        99_999,
        E8 - 1,
        E8,
        E8 + 1,
        u64::MAX / 2,
        u64::MAX - 1,
        u64::MAX,
    ];
    let assets = [0u32, 1, 127, 128, 255, 256, 65_535, 65_536, u32::MAX];
    for &asset in &assets {
        for &x in &edges {
            for &y in &edges {
                let order = Action::Order {
                    asset,
                    is_buy: x % 2 == 0,
                    px_e8: x,
                    sz_e8: y,
                    reduce_only: y % 2 == 0,
                };
                let _ = build(&TestHost, &order, x, y, asset % 2 == 0);
                let leverage = u32::try_from(x % (1 << 32)).unwrap();
                let _ = build(&TestHost, &Action::Leverage { asset, leverage }, y, x, true);
                let _ = check_format(x, y, (asset % 256) as u8);
                let _ = size_for(u128::from(x) * u128::from(y), x, (asset % 256) as u8);
                let _ = notional_e6(x, y);
            }
        }
    }
    let mut rng = Rng(42);
    for _ in 0..50_000 {
        let (x, y) = (rng.next(), rng.next());
        let asset = u32::try_from(rng.below(1 << 32)).unwrap();
        let sz_decimals = u8::try_from(rng.below(256)).unwrap();
        let order = Action::Order {
            asset,
            is_buy: x % 2 == 0,
            px_e8: x,
            sz_e8: y,
            reduce_only: true,
        };
        let _ = build(&TestHost, &order, x, y, false);
        let _ = check_format(x, y, sz_decimals);
        let _ = size_for(u128::from(x) << 32, y, sz_decimals);
    }
}
