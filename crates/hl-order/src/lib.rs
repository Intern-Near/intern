//! hl-order: builds the exact bytes and hash Hyperliquid expects for an order or a leverage change.
//!
//! A port of the research probe `research-scripts/hl-guard/src/lib.rs`, whose hashes matched the reference in
//! 8 of 8 cases and whose signatures Hyperliquid testnet accepted, with the NEAR-specific parts taken out.
//! Pure: no NEAR SDK, no network, no clock, no storage. All hashing goes through [`Host`].
//!
//! Hashing follows Hyperliquid's official Python SDK, `hyperliquid/utils/signing.py`:
//! - `action_hash`: keccak256(msgpack(action) ‖ nonce as 8 bytes big-endian ‖ 0x00 for "no vault"
//!   ‖ 0x00 ‖ expiresAfter as 8 bytes big-endian). This is the phantom agent's `connectionId`.
//! - `construct_phantom_agent` and `l1_payload`: the EIP-712 struct `Agent(string source,bytes32 connectionId)`
//!   with `source` "a" on mainnet and "b" on testnet, in the domain name "Exchange", version "1",
//!   chain id 1337, verifying contract 0x0.
//!
//! Only two fixed-shape actions can be built: an isolated `updateLeverage` and an immediate-or-cancel limit
//! order. Nothing that moves money or hands over trading rights can be expressed.
//!
//! The function signatures are fixed in 01-SHARED-INTERFACE.md section 11.2 (version 1.2). The contract calls
//! [`check_format`] with the market's size decimals before [`build`], since `Action::Order` carries none (01 1.2).
#![no_std]
#![forbid(unsafe_code)]

extern crate alloc;

use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;

pub use shared::Host;

#[cfg(test)]
mod tests;

/// One action this library can build.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// Isolated margin only.
    Leverage { asset: u32, leverage: u32 },
    /// Immediate-or-cancel limit order.
    Order {
        asset: u32,
        is_buy: bool,
        px_e8: u64,
        sz_e8: u64,
        reduce_only: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Built {
    /// The exact JSON Hyperliquid expects as "action".
    pub action_json: String,
    /// What NEAR's signing network must sign.
    pub digest: [u8; 32],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HlError {
    BadPriceFormat,
    BadSizeFormat,
    Zero,
}

/// 1e8: prices and sizes are whole numbers scaled by this (01 §2).
const E8: u64 = 100_000_000;
/// px_e8 × sz_e8 is in 1e16 units; dollars with 6 decimals are 1e6 units.
const E16_TO_E6: u128 = 10_000_000_000;

/// Builds the bytes Hyperliquid hashes and the final digest. No vault address.
///
/// Refuses a zero price, size or leverage (`Zero`) and a price with more than 5 significant figures or more
/// than 6 decimals (`BadPriceFormat`). The size format depends on the market's size decimals, which an
/// [`Action`] does not carry: the caller must also run [`check_format`] with them.
pub fn build<H: Host>(
    host: &H,
    action: &Action,
    nonce_ms: u64,
    expires_after_ms: u64,
    testnet: bool,
) -> Result<Built, HlError> {
    let (action_json, packed) = encode(action)?;
    let (_, digest) = l1_digest(host, &packed, nonce_ms, Some(expires_after_ms), testnet);
    Ok(Built {
        action_json,
        digest,
    })
}

/// Dollars (6 decimals) of an order: px_e8 × sz_e8 / 10^10, rounded up.
pub fn notional_e6(px_e8: u64, sz_e8: u64) -> u128 {
    // (2^64 - 1)^2 + 10^10 still fits in u128, so this cannot overflow.
    (u128::from(px_e8) * u128::from(sz_e8)).div_ceil(E16_TO_E6)
}

/// Largest size with `sz_decimals` decimals whose notional at px_e8 is ≤ notional_e6.
///
/// A zero price gives 0. The result is capped at the largest such size that fits in a u64.
pub fn size_for(notional_e6: u128, px_e8: u64, sz_decimals: u8) -> u64 {
    if px_e8 == 0 {
        return 0;
    }
    // notional_e6(px, s) ≤ n  ⇔  ceil(px·s / 10^10) ≤ n  ⇔  px·s ≤ n·10^10.
    let raw = match notional_e6.checked_mul(E16_TO_E6) {
        Some(limit) => limit / u128::from(px_e8),
        None => u128::MAX,
    };
    let raw = u64::try_from(raw).unwrap_or(u64::MAX);
    let step = size_step(sz_decimals);
    raw - raw % step
}

/// Checks Hyperliquid's number format (01 §4): a price has at most 5 significant figures and at most
/// `6 - sz_decimals` decimal places; a size has at most `sz_decimals` decimal places.
///
/// Follows 01 §4 as written. Hyperliquid's docs also allow any whole-number price whatever its significant
/// figures ("123456 is a valid price"); 01 does not, so this refuses it. Raised with the owner (issue F).
/// No price of the six markets is near that size.
pub fn check_format(px_e8: u64, sz_e8: u64, sz_decimals: u8) -> Result<(), HlError> {
    if px_e8 == 0 || sz_e8 == 0 {
        return Err(HlError::Zero);
    }
    let max_px_decimals = 6u32
        .checked_sub(u32::from(sz_decimals))
        .ok_or(HlError::BadPriceFormat)?;
    if significant_figures(px_e8) > 5 || decimals(px_e8) > max_px_decimals {
        return Err(HlError::BadPriceFormat);
    }
    if decimals(sz_e8) > u32::from(sz_decimals) {
        return Err(HlError::BadSizeFormat);
    }
    Ok(())
}

/// The smallest size increment, in 1e8 units, for a market with `sz_decimals` size decimals.
fn size_step(sz_decimals: u8) -> u64 {
    if sz_decimals >= 8 {
        1
    } else {
        10u64.pow(8 - u32::from(sz_decimals))
    }
}

/// Decimal places of a 1e8 fixed-point value once trailing zeros are removed (0 to 8).
fn decimals(v_e8: u64) -> u32 {
    let mut frac = v_e8 % E8;
    if frac == 0 {
        return 0;
    }
    let mut d = 8;
    while frac.is_multiple_of(10) {
        frac /= 10;
        d -= 1;
    }
    d
}

/// Significant figures of a 1e8 fixed-point value: its digits from the first non-zero one to the last
/// non-zero one. 0 for zero.
fn significant_figures(v_e8: u64) -> u32 {
    if v_e8 == 0 {
        return 0;
    }
    let mut x = v_e8;
    while x.is_multiple_of(10) {
        x /= 10;
    }
    x.ilog10() + 1
}

/// 1e8 fixed point -> Hyperliquid's wire string: no trailing zeros, no trailing dot (the SDK's `float_to_wire`).
fn wire(v_e8: u64) -> String {
    let (int, frac) = (v_e8 / E8, v_e8 % E8);
    if frac == 0 {
        return format!("{int}");
    }
    let digits = format!("{frac:08}");
    format!("{int}.{}", digits.trim_end_matches('0'))
}

/// The action's JSON and its msgpack bytes. Both list the fields in the same order.
fn encode(action: &Action) -> Result<(String, Vec<u8>), HlError> {
    match *action {
        Action::Leverage { asset, leverage } => {
            if leverage == 0 {
                return Err(HlError::Zero);
            }
            let json = format!(
                r#"{{"type":"updateLeverage","asset":{asset},"isCross":false,"leverage":{leverage}}}"#
            );
            Ok((json, leverage_msgpack(asset, leverage)))
        }
        Action::Order {
            asset,
            is_buy,
            px_e8,
            sz_e8,
            reduce_only,
        } => {
            if px_e8 == 0 || sz_e8 == 0 {
                return Err(HlError::Zero);
            }
            if significant_figures(px_e8) > 5 || decimals(px_e8) > 6 {
                return Err(HlError::BadPriceFormat);
            }
            let (px, sz) = (wire(px_e8), wire(sz_e8));
            let json = format!(
                r#"{{"type":"order","orders":[{{"a":{asset},"b":{is_buy},"p":"{px}","s":"{sz}","r":{reduce_only},"t":{{"limit":{{"tif":"Ioc"}}}}}}],"grouping":"na"}}"#
            );
            Ok((json, order_msgpack(asset, is_buy, &px, &sz, reduce_only)))
        }
    }
}

// ---- msgpack, written by hand for the two fixed shapes. Same encodings as Python's msgpack.packb. ----

fn put_str(o: &mut Vec<u8>, s: &str) {
    let b = s.as_bytes();
    let n = b.len();
    if n < 32 {
        o.push(0xa0 | n as u8); // fixstr
    } else if n <= 0xff {
        o.push(0xd9); // str 8
        o.push(n as u8);
    } else if n <= 0xffff {
        o.push(0xda); // str 16
        o.extend_from_slice(&(n as u16).to_be_bytes());
    } else {
        o.push(0xdb); // str 32; unreachable here: every string this crate writes is under 32 bytes
        o.extend_from_slice(&(n as u32).to_be_bytes());
    }
    o.extend_from_slice(b);
}

fn put_bool(o: &mut Vec<u8>, b: bool) {
    o.push(if b { 0xc3 } else { 0xc2 });
}

/// The shortest msgpack form of an unsigned whole number, as msgpack.packb writes it.
fn put_uint(o: &mut Vec<u8>, v: u64) {
    if v < 0x80 {
        o.push(v as u8); // positive fixint
    } else if v <= 0xff {
        o.push(0xcc);
        o.push(v as u8);
    } else if v <= 0xffff {
        o.push(0xcd);
        o.extend_from_slice(&(v as u16).to_be_bytes());
    } else if v <= 0xffff_ffff {
        o.push(0xce);
        o.extend_from_slice(&(v as u32).to_be_bytes());
    } else {
        o.push(0xcf);
        o.extend_from_slice(&v.to_be_bytes());
    }
}

/// msgpack of {"type":"order","orders":[{"a","b","p","s","r","t":{"limit":{"tif":"Ioc"}}}],"grouping":"na"},
/// the shape of the SDK's `order_wires_to_order_action(order_request_to_order_wire(...))`.
fn order_msgpack(asset: u32, is_buy: bool, px: &str, sz: &str, reduce_only: bool) -> Vec<u8> {
    let mut o = Vec::with_capacity(96);
    o.push(0x83); // map of 3
    put_str(&mut o, "type");
    put_str(&mut o, "order");
    put_str(&mut o, "orders");
    o.push(0x91); // array of 1
    o.push(0x86); // map of 6
    put_str(&mut o, "a");
    put_uint(&mut o, u64::from(asset));
    put_str(&mut o, "b");
    put_bool(&mut o, is_buy);
    put_str(&mut o, "p");
    put_str(&mut o, px);
    put_str(&mut o, "s");
    put_str(&mut o, sz);
    put_str(&mut o, "r");
    put_bool(&mut o, reduce_only);
    put_str(&mut o, "t");
    o.push(0x81); // map of 1
    put_str(&mut o, "limit");
    o.push(0x81);
    put_str(&mut o, "tif");
    put_str(&mut o, "Ioc");
    put_str(&mut o, "grouping");
    put_str(&mut o, "na");
    o
}

/// msgpack of {"type":"updateLeverage","asset":n,"isCross":false,"leverage":n}, the shape the SDK's
/// `Exchange.update_leverage` builds.
fn leverage_msgpack(asset: u32, leverage: u32) -> Vec<u8> {
    let mut o = Vec::with_capacity(48);
    o.push(0x84); // map of 4
    put_str(&mut o, "type");
    put_str(&mut o, "updateLeverage");
    put_str(&mut o, "asset");
    put_uint(&mut o, u64::from(asset));
    put_str(&mut o, "isCross");
    put_bool(&mut o, false);
    put_str(&mut o, "leverage");
    put_uint(&mut o, u64::from(leverage));
    o
}

/// The bytes `action_hash` hashes: msgpack ‖ nonce (8 bytes, big-endian) ‖ 0x00 (no vault)
/// [‖ 0x00 ‖ expiresAfter (8 bytes, big-endian)].
fn l1_data(packed: &[u8], nonce: u64, expires_after: Option<u64>) -> Vec<u8> {
    let mut data = Vec::with_capacity(packed.len() + 18);
    data.extend_from_slice(packed);
    data.extend_from_slice(&nonce.to_be_bytes());
    data.push(0x00);
    if let Some(e) = expires_after {
        data.push(0x00);
        data.extend_from_slice(&e.to_be_bytes());
    }
    data
}

/// (connectionId, EIP-712 digest) for an L1 action with no vault address.
fn l1_digest<H: Host>(
    host: &H,
    packed: &[u8],
    nonce: u64,
    expires_after: Option<u64>,
    testnet: bool,
) -> ([u8; 32], [u8; 32]) {
    let connection_id = host.keccak256(&l1_data(packed, nonce, expires_after));

    let mut domain = Vec::with_capacity(160);
    domain.extend_from_slice(&host.keccak256(
        b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
    ));
    domain.extend_from_slice(&host.keccak256(b"Exchange"));
    domain.extend_from_slice(&host.keccak256(b"1"));
    let mut chain_id = [0u8; 32];
    chain_id[30..].copy_from_slice(&1337u16.to_be_bytes());
    domain.extend_from_slice(&chain_id);
    domain.extend_from_slice(&[0u8; 32]); // verifyingContract 0x0
    let domain_separator = host.keccak256(&domain);

    let mut agent = Vec::with_capacity(96);
    agent.extend_from_slice(&host.keccak256(b"Agent(string source,bytes32 connectionId)"));
    agent.extend_from_slice(&host.keccak256(if testnet { b"b" } else { b"a" }));
    agent.extend_from_slice(&connection_id);
    let struct_hash = host.keccak256(&agent);

    let mut message = Vec::with_capacity(66);
    message.extend_from_slice(&[0x19, 0x01]);
    message.extend_from_slice(&domain_separator);
    message.extend_from_slice(&struct_hash);
    (connection_id, host.keccak256(&message))
}
