//! Types shared by every $INTERN build, and the `Host` trait.
//!
//! This is `01-SHARED-INTERFACE.md` section 11, written out as code. The trait and the enums are
//! exactly as printed there. Everything below the enums is an addition that section 11 allows
//! ("`as_str` / `from_str` on every enum, and a small struct carrying a refusal with its `asked`
//! and `limit` numbers"); nothing printed has been renamed or removed.
//!
//! Pure: no NEAR SDK, no network, no clock, no storage, no allocation, `no_std`.

#![no_std]
#![forbid(unsafe_code)]

use core::fmt;
use core::str::FromStr;

/// The interface version this crate follows.
pub const INTERFACE_VERSION: &str = "1.4";

// ---------------------------------------------------------------------------------------------
// As printed in section 11.
// ---------------------------------------------------------------------------------------------

/// Hashing and signature checks. The contract implements this with NEAR's host
/// functions; tests implement it with ordinary Rust crates.
#[rustfmt::skip]
pub trait Host {
    fn sha256(&self, data: &[u8]) -> [u8; 32];
    fn keccak256(&self, data: &[u8]) -> [u8; 32];
    fn ed25519_verify(&self, signature: &[u8; 64], message: &[u8], public_key: &[u8; 32]) -> bool;
    /// Returns the 64-byte uncompressed public key, or None.
    /// `v` is the recovery id, 0 or 1. It is NOT Ethereum's 27 or 28: a caller holding a 65-byte
    /// Ethereum-style signature subtracts 27 from its last byte first.
    /// High-s signatures are accepted (no malleability check). Replays are stopped by the nonce.
    fn ecrecover(&self, hash: &[u8; 32], signature: &[u8; 64], v: u8) -> Option<[u8; 64]>;
}

// `Hash`, `PartialOrd` and `Ord` are added to the printed derives. The order is the order of
// declaration, which is the order of the interface tables (ranks low to high, markets as in
// section 4, refusals in check order).

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)] #[rustfmt::skip] pub enum Rank { Intern, Analyst, Trader }
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)] #[rustfmt::skip] pub enum Status { Employed, Fired }
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)] #[rustfmt::skip] pub enum Market { Doge, Shib, Pepe, Pengu, Wif, Trump }
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)] #[rustfmt::skip] pub enum Side { Long, Short }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[rustfmt::skip]
pub enum Decision {
    Skip,
    Bet { market: Market, side: Side, margin_e6: u128, leverage: u32 },
}

/// The sixteen codes of section 7, in that order. `as_str()` gives the exact spelling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[rustfmt::skip]
pub enum Refusal {
    OutsideWindow, Fired, BadModelSignature, WrongRulebook, MalformedDecision,
    NotOnList, ShortNotUnlocked, ZeroMargin, OverLeverage, TooManyTrades,
    OverTradeLimit, OverRoundLimit, BadQuoteSignature, StaleQuote, QuoteMismatch, TooExpensive,
}

// ---------------------------------------------------------------------------------------------
// Additions (allowed by section 11).
// ---------------------------------------------------------------------------------------------

/// Returned by `from_str` when a name is not one of the exact spellings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UnknownName;

impl fmt::Display for UnknownName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("not one of the names in 01-SHARED-INTERFACE.md")
    }
}

impl core::error::Error for UnknownName {}

/// Gives an enum `ALL` (in declaration order), `as_str()`, `FromStr` and `Display`.
/// `from_str` is exact: same letters, same case, nothing around them.
macro_rules! names {
    ($ty:ident, $n:literal, [$($variant:ident => $text:literal),+ $(,)?]) => {
        impl $ty {
            /// Every value, in the order of the interface tables.
            pub const ALL: [$ty; $n] = [$($ty::$variant),+];

            /// The exact spelling used in JSON, logs and on screen.
            pub const fn as_str(self) -> &'static str {
                match self { $($ty::$variant => $text),+ }
            }
        }

        impl FromStr for $ty {
            type Err = UnknownName;
            fn from_str(s: &str) -> Result<Self, Self::Err> {
                match s { $($text => Ok($ty::$variant),)+ _ => Err(UnknownName) }
            }
        }

        impl fmt::Display for $ty {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(self.as_str())
            }
        }

        /// With the optional `serde` feature: written and read as the exact spelling.
        #[cfg(feature = "serde")]
        impl serde::Serialize for $ty {
            fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                s.serialize_str(self.as_str())
            }
        }

        #[cfg(feature = "serde")]
        impl<'de> serde::Deserialize<'de> for $ty {
            fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                struct V;
                impl serde::de::Visitor<'_> for V {
                    type Value = $ty;
                    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                        write!(f, "one of {:?}", $ty::ALL.map($ty::as_str))
                    }
                    fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<$ty, E> {
                        v.parse().map_err(|_| E::invalid_value(serde::de::Unexpected::Str(v), &self))
                    }
                }
                d.deserialize_str(V)
            }
        }
    };
}

names!(Rank, 3, [Intern => "INTERN", Analyst => "ANALYST", Trader => "TRADER"]);
names!(Status, 2, [Employed => "EMPLOYED", Fired => "FIRED"]);
names!(Market, 6, [Doge => "DOGE", Shib => "SHIB", Pepe => "PEPE", Pengu => "PENGU", Wif => "WIF", Trump => "TRUMP"]);
names!(Side, 2, [Long => "LONG", Short => "SHORT"]);
names!(Refusal, 16, [
    OutsideWindow => "OUTSIDE_WINDOW",
    Fired => "FIRED",
    BadModelSignature => "BAD_MODEL_SIGNATURE",
    WrongRulebook => "WRONG_RULEBOOK",
    MalformedDecision => "MALFORMED_DECISION",
    NotOnList => "NOT_ON_LIST",
    ShortNotUnlocked => "SHORT_NOT_UNLOCKED",
    ZeroMargin => "ZERO_MARGIN",
    OverLeverage => "OVER_LEVERAGE",
    TooManyTrades => "TOO_MANY_TRADES",
    OverTradeLimit => "OVER_TRADE_LIMIT",
    OverRoundLimit => "OVER_ROUND_LIMIT",
    BadQuoteSignature => "BAD_QUOTE_SIGNATURE",
    StaleQuote => "STALE_QUOTE",
    QuoteMismatch => "QUOTE_MISMATCH",
    TooExpensive => "TOO_EXPENSIVE",
]);

impl Side {
    /// The lower-case spelling used inside the decision line and the rulebook (section 6):
    /// `"long"` or `"short"`.
    pub const fn as_decision_str(self) -> &'static str {
        match self {
            Side::Long => "long",
            Side::Short => "short",
        }
    }

    /// Reads the decision-line spelling. Exact: `"long"` or `"short"` only.
    pub fn from_decision_str(s: &str) -> Option<Side> {
        match s {
            "long" => Some(Side::Long),
            "short" => Some(Side::Short),
            _ => None,
        }
    }
}

impl Refusal {
    /// The check's number in section 7, 1 to 16. Checks run in this order.
    pub const fn check_number(self) -> u8 {
        self as u8 + 1
    }

    /// Whether section 7 gives this code an `asked` and a `limit` number.
    /// `false` where the table shows "—".
    pub const fn carries_numbers(self) -> bool {
        matches!(
            self,
            Refusal::OutsideWindow
                | Refusal::ZeroMargin
                | Refusal::OverLeverage
                | Refusal::TooManyTrades
                | Refusal::OverTradeLimit
                | Refusal::OverRoundLimit
                | Refusal::StaleQuote
                | Refusal::QuoteMismatch
                | Refusal::TooExpensive
        )
    }
}

/// A refusal with the two numbers of section 7. Both are `None` for the codes whose table row
/// shows "—" (see [`Refusal::carries_numbers`]). On the wire they are decimal strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Refused {
    pub code: Refusal,
    pub asked: Option<u128>,
    pub limit: Option<u128>,
}

impl Refused {
    /// A refusal that carries no numbers.
    pub const fn bare(code: Refusal) -> Refused {
        Refused {
            code,
            asked: None,
            limit: None,
        }
    }

    /// A refusal with its `asked` and `limit` numbers.
    pub const fn with(code: Refusal, asked: u128, limit: u128) -> Refused {
        Refused {
            code,
            asked: Some(asked),
            limit: Some(limit),
        }
    }
}

impl From<Refusal> for Refused {
    fn from(code: Refusal) -> Refused {
        Refused::bare(code)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_name_round_trips_and_nothing_else_parses() {
        for r in Rank::ALL {
            assert_eq!(r.as_str().parse::<Rank>(), Ok(r));
        }
        for s in Status::ALL {
            assert_eq!(s.as_str().parse::<Status>(), Ok(s));
        }
        for m in Market::ALL {
            assert_eq!(m.as_str().parse::<Market>(), Ok(m));
        }
        for s in Side::ALL {
            assert_eq!(s.as_str().parse::<Side>(), Ok(s));
            assert_eq!(Side::from_decision_str(s.as_decision_str()), Some(s));
        }
        for c in Refusal::ALL {
            assert_eq!(c.as_str().parse::<Refusal>(), Ok(c));
        }
        // Exact only: no other case, no spaces.
        assert_eq!("doge".parse::<Market>(), Err(UnknownName));
        assert_eq!(" DOGE".parse::<Market>(), Err(UnknownName));
        assert_eq!("Intern".parse::<Rank>(), Err(UnknownName));
        assert_eq!("long".parse::<Side>(), Err(UnknownName));
        assert_eq!(Side::from_decision_str("LONG"), None);
        assert_eq!("fired".parse::<Refusal>(), Err(UnknownName));
    }

    #[test]
    fn refusals_are_numbered_in_check_order() {
        for (i, c) in Refusal::ALL.iter().enumerate() {
            assert_eq!(c.check_number() as usize, i + 1);
        }
        assert_eq!(Refusal::OutsideWindow.check_number(), 1);
        assert_eq!(Refusal::TooExpensive.check_number(), 16);
    }

    #[test]
    fn ranks_order_low_to_high() {
        assert!(Rank::Intern < Rank::Analyst && Rank::Analyst < Rank::Trader);
    }

    #[test]
    fn refused_constructors() {
        assert_eq!(
            Refused::from(Refusal::Fired),
            Refused {
                code: Refusal::Fired,
                asked: None,
                limit: None
            }
        );
        assert_eq!(
            Refused::with(Refusal::ZeroMargin, 0, 10_000_000).asked,
            Some(0)
        );
    }
}
