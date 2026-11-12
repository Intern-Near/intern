//! The fixed tables of 01-SHARED-INTERFACE.md sections 3, 4 and 7, and the section 6.1 rulebook
//! text, taken from the `rules` crate (the same code the real contract uses) and put into the
//! interface's JSON shapes.

use wire::{Limits, MarketInfo, Rank, Refusal};

pub fn limits(rank: Rank) -> Limits {
    let l = rules::limits::limits(rank);
    Limits {
        rank,
        per_bet_bps: l.per_bet_bps,
        max_bets: l.max_bets,
        per_round_bps: l.per_round_bps,
        sides: l.sides.to_vec(),
        max_leverage: l.max_leverage,
        markets: l.markets.to_vec(),
    }
}

/// Section 4, testnet column.
pub fn testnet_markets() -> Vec<MarketInfo> {
    rules::limits::MARKETS
        .iter()
        .map(|m| MarketInfo {
            market: m.market,
            hl_name: m.hl_name.to_string(),
            hl_asset: m.testnet_asset,
            sz_decimals: m.sz_decimals,
        })
        .collect()
}

pub fn refusal_codes() -> Vec<Refusal> {
    Refusal::ALL.to_vec()
}

/// The section 6.1 text (from `rules::rulebook`).
pub fn rulebook_text(
    round_id: u64,
    nonce: &str,
    rank: Rank,
    brave_at_open: u128,
    bets_used: u32,
    at_risk: u128,
    playbook: Option<&str>,
) -> String {
    rules::rulebook::rulebook(
        round_id,
        nonce,
        rank,
        brave_at_open,
        bets_used,
        at_risk,
        playbook,
    )
}
