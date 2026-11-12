//! Pure rules for $INTERN, following `01-SHARED-INTERFACE.md` version 1.1.
//!
//! Everything the program decides before money moves lives here, with no NEAR SDK, no clock, no
//! storage and no floating point, so it can be tested exhaustively and used unchanged by the
//! contract.
//!
//! | Module | Interface section |
//! |---|---|
//! | [`limits`] | 3 ranks, 4 markets |
//! | [`clock`] | 5 the round |
//! | [`rulebook`] | 6.1 the rulebook text |
//! | [`checks`] | 7 the NOPE checks 1, 2 and 6–12, and the order of all sixteen |
//! | [`shares`] | 5 and 9.1 coins, pending money, cash-out |
//! | [`vote`] | 9.2 voting |
//! | [`math`] | whole-number helpers, exact for every `u128` |
//!
//! Numbers marked `PROPOSED` in the interface are constants here; the names around them are fixed.

#![forbid(unsafe_code)]

pub mod checks;
pub mod clock;
pub mod limits;
pub mod math;
pub mod rulebook;
pub mod shares;
pub mod vote;

pub use shared::{Decision, Market, Rank, Refusal, Refused, Side, Status};
