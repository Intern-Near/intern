//! The decision line of 01 §6.2, read by its fixed shape.
//!
//! The line has only two forms, so instead of a general parser this matches the exact text piece by piece: the
//! fixed parts must be there byte for byte, and the variable parts (market, side, margin, leverage) must be written
//! the canonical way. Only a canonical line can match, so "parse, write back, compare" holds by construction; the
//! caller still compares with `decision_line` as a second guard.
//!
//! 01 version 1.2 §6.2: a margin of "0" reads as a bet (the rank checks then say ZERO_MARGIN, test case D13); the
//! leverage is a whole number, 1 or more, so a leverage of 0 does not read. A market outside the six, a margin above
//! u128 and a leverage above u32 do not read either (MALFORMED_DECISION).

use alloc::format;
use shared::{Decision, Market, Side};

/// Digits only, no sign, no leading zero (except "0" itself).
fn canonical_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) && (s == "0" || !s.starts_with('0'))
}

/// Reads one decision line for this round and nonce. None for anything that is not exactly such a line.
pub fn parse(line: &str, round_id: u64, nonce: &str) -> Option<Decision> {
    let head = format!(r#"{{"v":1,"round":{round_id},"nonce":"{nonce}","action":"#);
    let rest = line.strip_prefix(head.as_str())?;
    if rest == r#""skip"}"# {
        return Some(Decision::Skip);
    }
    let rest = rest.strip_prefix(r#""bet","market":""#)?;
    // The six names exactly as `Market::as_str` spells them, each followed by the closing quote.
    let (market, rest) = Market::ALL.iter().find_map(|m| {
        rest.strip_prefix(m.as_str())
            .and_then(|r| r.strip_prefix('"'))
            .map(|r| (*m, r))
    })?;
    let rest = rest.strip_prefix(r#","side":""#)?;
    let (side, rest) = if let Some(r) = rest.strip_prefix("long") {
        (Side::Long, r)
    } else {
        (Side::Short, rest.strip_prefix("short")?)
    };
    let rest = rest.strip_prefix(r#"","margin_e6":""#)?;
    let (margin, rest) = rest.split_once('"')?;
    let rest = rest.strip_prefix(r#","leverage":"#)?;
    let leverage = rest.strip_suffix('}')?;
    if !canonical_digits(margin) || !canonical_digits(leverage) || leverage == "0" {
        return None;
    }
    Some(Decision::Bet {
        market,
        side,
        margin_e6: margin.parse::<u128>().ok()?,
        leverage: leverage.parse::<u32>().ok()?,
    })
}
