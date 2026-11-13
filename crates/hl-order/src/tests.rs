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

        let (json, packed) = encode(&action, None).unwrap();
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
            // No cloid: byte for byte what build() gives, and so what the contract signs today.
            assert_eq!(
                build_with_cloid(&TestHost, &action, None, nonce, e, testnet).unwrap(),
                built,
                "{id}: build_with_cloid(None)"
            );
        }
    }
}

#[test]
fn testnet_and_mainnet_share_the_connection_id_but_not_the_digest() {
    let (_, packed) = encode(
        &Action::Leverage {
            asset: 173,
            leverage: 2,
        },
        None,
    )
    .unwrap();
    let (cid_t, digest_t) = l1_digest(&TestHost, &packed, 1, Some(2), true);
    let (cid_m, digest_m) = l1_digest(&TestHost, &packed, 1, Some(2), false);
    assert_eq!(cid_t, cid_m);
    assert_ne!(digest_t, digest_m);
}

// ---- the reference digests with a client order id (cloid) ----

/// Computed with the same SDK: intern/fixtures/hl/reference/sdk_cloid_digests.py and its output. A separate file,
/// because the contract's own test (crates/coin) builds every case of digests.json with `build`, without a cloid.
const CLOID_REFERENCE: &str = include_str!("../../../fixtures/hl/reference/cloid_digests.json");

/// "0x" and 32 hex digits -> a Cloid.
fn cloid_of(hex: &str) -> Cloid {
    let digits = hex.strip_prefix("0x").expect("0x");
    assert_eq!(digits.len(), 32, "{hex}");
    let mut bytes = [0u8; 16];
    for (i, b) in bytes.iter_mut().enumerate() {
        *b = u8::from_str_radix(&digits[2 * i..2 * i + 2], 16).unwrap();
    }
    Cloid(bytes)
}

/// The encoding proposed to the owner in crates/hl-order/README.md: round id (4 bytes), position id (4 bytes),
/// the order's nonce (8 bytes), all big-endian. Not part of the library: the owner decides the encoding (01).
fn proposed_cloid(round_id: u32, position_id: u32, nonce: u64) -> Cloid {
    let mut bytes = [0u8; 16];
    bytes[..4].copy_from_slice(&round_id.to_be_bytes());
    bytes[4..8].copy_from_slice(&position_id.to_be_bytes());
    bytes[8..].copy_from_slice(&nonce.to_be_bytes());
    Cloid(bytes)
}

#[test]
fn cloid_cases_match_the_official_sdk() {
    let doc: Value = serde_json::from_str(CLOID_REFERENCE).unwrap();
    assert_eq!(doc["generated_by"], "hyperliquid-python-sdk 0.24.0");
    let cases = doc["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 10);
    for (with_cloid, testnet) in [(true, true), (true, false), (false, true), (false, false)] {
        assert!(
            cases
                .iter()
                .any(|c| c["inputs"]["cloid"].is_string() == with_cloid
                    && c["testnet"].as_bool() == Some(testnet)),
            "a case with cloid {with_cloid}, testnet {testnet}"
        );
    }

    for c in cases {
        let id = c["id"].as_str().unwrap();
        let action = action_of(&c["inputs"]);
        let cloid = c["inputs"]["cloid"].as_str().map(|hex| {
            let cloid = cloid_of(hex);
            // Our hex form is the SDK's, byte for byte (lower case, zero padded).
            assert_eq!(cloid.to_hex(), hex, "{id}: cloid hex");
            cloid
        });
        let nonce = c["nonce"].as_u64().unwrap();
        let expires = c["expires_after"]
            .as_u64()
            .expect("every case has an expiry");
        let testnet = c["testnet"].as_bool().unwrap();

        let (json, packed) = encode(&action, cloid).unwrap();
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
        let (connection_id, digest) = l1_digest(&TestHost, &packed, nonce, Some(expires), testnet);
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

        let built = build_with_cloid(&TestHost, &action, cloid, nonce, expires, testnet).unwrap();
        assert_eq!(built.action_json, json, "{id}: build_with_cloid() JSON");
        assert_eq!(built.digest, digest, "{id}: build_with_cloid() digest");
        if cloid.is_none() {
            assert_eq!(
                build(&TestHost, &action, nonce, expires, testnet).unwrap(),
                built,
                "{id}: build()"
            );
        }

        // The cases tagged with the README's proposal really use it.
        if let Some(parts) = c["cloid_parts"].as_object() {
            let n = |key: &str| parts[key].as_u64().unwrap();
            let proposed = proposed_cloid(
                u32::try_from(n("round_id")).unwrap(),
                u32::try_from(n("position_id")).unwrap(),
                n("nonce"),
            );
            assert_eq!(cloid, Some(proposed), "{id}: the proposed encoding");
            assert_eq!(
                n("nonce"),
                nonce,
                "{id}: the cloid carries the order's own nonce"
            );
        }
    }
}

#[test]
fn the_readme_example_cloid() {
    // Round 7's opening order (position 3, nonce 1794483574065), as crates/hl-order/README.md shows it.
    assert_eq!(
        proposed_cloid(7, 3, 1_794_483_574_065).to_hex(),
        "0x0000000700000003000001a1cf8e5531"
    );
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
    let (_, doge) = encode(&order(173), None).unwrap();
    assert!(contains(&doge, &[0xa1, b'a', 0xcc, 0xad, 0xa1, b'b']));
    let (_, pepe) = encode(&order(12), None).unwrap();
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
fn a_cloid_is_0x_and_32_lower_case_hex_digits() {
    assert_eq!(
        Cloid([0; 16]).to_hex(),
        "0x00000000000000000000000000000000"
    );
    assert_eq!(
        Cloid([0xff; 16]).to_hex(),
        "0xffffffffffffffffffffffffffffffff"
    );
    // The SDK's Cloid.from_int(n) is n as 16 big-endian bytes; from_int(1) is the value its own signing test uses.
    assert_eq!(
        Cloid(1u128.to_be_bytes()).to_hex(),
        "0x00000000000000000000000000000001"
    );
    // The example in Hyperliquid's API docs.
    assert_eq!(
        Cloid(0x1234_5678_90ab_cdef_1234_5678_90ab_cdef_u128.to_be_bytes()).to_hex(),
        "0x1234567890abcdef1234567890abcdef"
    );
}

#[test]
fn a_cloid_adds_one_key_after_t_and_changes_nothing_else() {
    let order = Action::Order {
        asset: 173,
        is_buy: true,
        px_e8: e8("0.067076"),
        sz_e8: e8("268"),
        reduce_only: false,
    };
    let cloid = proposed_cloid(7, 3, 1_794_483_574_065);
    let (json0, packed0) = encode(&order, None).unwrap();
    let (json1, packed1) = encode(&order, Some(cloid)).unwrap();

    // JSON: `,"c":"0x…"` right after the order's "t" value, before the order map closes.
    let at = json0.find(r#"}],"grouping""#).unwrap();
    let mut expected = json0.clone();
    expected.insert_str(at, &format!(r#","c":"{}""#, cloid.to_hex()));
    assert_eq!(json1, expected);

    // msgpack: the order's map grows from 6 entries to 7, and "c" (a 34-byte str 8) comes after "t".
    let header = packed0.windows(2).position(|w| w == [0x91, 0x86]).unwrap() + 1;
    let grouping = packed0
        .windows(9)
        .position(|w| w == b"\xa8grouping")
        .unwrap();
    let mut expected = packed0.clone();
    expected[header] = 0x87;
    let mut c = vec![0xa1, b'c', 0xd9, 34];
    c.extend_from_slice(cloid.to_hex().as_bytes());
    expected.splice(grouping..grouping, c);
    assert_eq!(packed1, expected);

    // The cloid is inside the hash: another cloid, or none, gives another digest.
    let digest = |cloid| {
        build_with_cloid(&TestHost, &order, cloid, 1, 2, true)
            .unwrap()
            .digest
    };
    let other = proposed_cloid(7, 3, 1_794_483_574_066);
    assert_ne!(digest(Some(cloid)), digest(None));
    assert_ne!(digest(Some(cloid)), digest(Some(other)));
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

    // With a cloid an order is refused for exactly the same reasons.
    let tagged = |a: &Action| build_with_cloid(&TestHost, a, Some(Cloid([7; 16])), 1, 2, true);
    assert_eq!(tagged(&order(0, E8)), Err(HlError::Zero));
    assert_eq!(tagged(&order(E8, 0)), Err(HlError::Zero));
    assert_eq!(
        tagged(&order(e8("1234.56"), E8)),
        Err(HlError::BadPriceFormat)
    );
    assert!(tagged(&order(e8("74921"), e8("0.000123"))).is_ok());
}

#[test]
fn a_cloid_on_a_leverage_change_is_refused() {
    let leverage = Action::Leverage {
        asset: 173,
        leverage: 2,
    };
    assert_eq!(
        build_with_cloid(&TestHost, &leverage, Some(Cloid([1; 16])), 1, 2, true),
        Err(HlError::CloidOnLeverage)
    );
    assert_eq!(
        build_with_cloid(&TestHost, &leverage, None, 1, 2, true),
        build(&TestHost, &leverage, 1, 2, true)
    );
}

#[test]
fn action_json_is_valid_json_with_the_same_fields() {
    let mut rng = Rng(7);
    for _ in 0..5_000 {
        let asset = u32::try_from(rng.below(1 << 32)).unwrap();
        if rng.below(2) == 0 {
            let leverage = u32::try_from(1 + rng.below(u64::from(u32::MAX))).unwrap();
            let (json, _) = encode(&Action::Leverage { asset, leverage }, None).unwrap();
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
            let cloid = (rng.below(2) == 0).then(|| {
                let mut bytes = [0u8; 16];
                bytes[..8].copy_from_slice(&rng.next().to_be_bytes());
                bytes[8..].copy_from_slice(&rng.next().to_be_bytes());
                Cloid(bytes)
            });
            let (json, _) = encode(
                &Action::Order {
                    asset,
                    is_buy,
                    px_e8,
                    sz_e8,
                    reduce_only,
                },
                cloid,
            )
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
            match cloid {
                Some(c) => assert_eq!(o["c"], c.to_hex()),
                None => assert!(o.get("c").is_none()),
            }
            assert_eq!(
                o.as_object().unwrap().len(),
                if cloid.is_some() { 7 } else { 6 }
            );
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
                let cloid = Cloid([(x % 256) as u8; 16]);
                let _ = build_with_cloid(&TestHost, &order, Some(cloid), x, y, asset % 2 == 1);
                let leverage = u32::try_from(x % (1 << 32)).unwrap();
                let _ = build(&TestHost, &Action::Leverage { asset, leverage }, y, x, true);
                let _ = build_with_cloid(
                    &TestHost,
                    &Action::Leverage { asset, leverage },
                    Some(cloid),
                    y,
                    x,
                    false,
                );
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
        let mut cloid = [0u8; 16];
        cloid[..8].copy_from_slice(&x.to_le_bytes());
        cloid[8..].copy_from_slice(&y.to_le_bytes());
        let _ = build_with_cloid(&TestHost, &order, Some(Cloid(cloid)), y, x, true);
        let _ = check_format(x, y, sz_decimals);
        let _ = size_for(u128::from(x) << 32, y, sz_decimals);
    }
}

// ---- 1.7: user-signed actions, against the official SDK's vectors (tailfade/test/vectors.json) ------------------

fn h32(s: &str) -> [u8; 32] {
    let s = s.trim_start_matches("0x");
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap();
    }
    out
}
fn a20(s: &str) -> [u8; 20] {
    let s = s.trim_start_matches("0x");
    let mut out = [0u8; 20];
    for i in 0..20 {
        out[i] = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap();
    }
    out
}

#[test]
fn approve_agent_digests_match_the_sdk() {
    let agent = a20("0x1563915e194d8cfba1943570603f7606a3115508");
    let (json, d) = approve_agent(&TestHost, agent, "tailfade", 1794500000000, true);
    assert_eq!(d, h32("0xfabef0942deeafb03999b82a5e0d79759bab85f5a3bb53e6729276edbb89299c"));
    assert_eq!(
        json,
        r#"{"type":"approveAgent","signatureChainId":"0x66eee","hyperliquidChain":"Testnet","agentAddress":"0x1563915e194d8cfba1943570603f7606a3115508","agentName":"tailfade","nonce":1794500000000}"#
    );
    let (_, d) = approve_agent(&TestHost, agent, "", 1794500000123, true);
    assert_eq!(d, h32("0x9db282d61489ee73303de6c1f6f745fa02b968ca6715499c9b63f911f455efbc"));
}

#[test]
fn usd_send_digests_match_the_sdk() {
    let (_, d) = usd_send(&TestHost, "0x66726d2cf438f3d9b3b61bc6e1f52dbf51f4df43", "30", 1794500001000, true);
    assert_eq!(d, h32("0x01a1fcfc669415a61e9692e02095b6553a6b541ca6d165acb50fbedf33a0bca3"));
    let (json, d) = usd_send(&TestHost, "0x46f8eb2a044a826c70e9682fe3bfd65970340132", "12.5", 1794500002000, true);
    assert_eq!(d, h32("0x00b09a8fd97f5830e6347b1e796b138e4e9db3ebd9155377bb4ebd0ce4cb7baf"));
    assert!(json.contains(r#""amount":"12.5""#) && json.contains(r#""time":1794500002000"#));
}
