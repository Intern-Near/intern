//! Sections 3 and 4: the ranks and the markets. Fixed at deploy; no vote can change them.
//! Numbers are `PROPOSED` in the interface.

use crate::math::bps_of;
use shared::{Market, Rank, Side};

/// Hyperliquid refuses orders under $10 (section 3, VERIFIED in its docs).
/// 1.2: $11, not $10. Hyperliquid refuses orders under $10, and an order is sized `floor(notional / px)`
/// cut to the size decimals, so a $10 bet always became an order a little under $10.
pub const MIN_NOTIONAL: u128 = 11_000_000;

/// One rank's fixed limits (the interface's `Limits`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub rank: Rank,
    pub per_bet_bps: u32,
    pub max_bets: u32,
    pub per_round_bps: u32,
    pub sides: &'static [Side],
    pub max_leverage: u32,
    pub markets: &'static [Market],
}

const LONG: &[Side] = &[Side::Long];
const BOTH: &[Side] = &[Side::Long, Side::Short];
const FOUR: &[Market] = &[Market::Doge, Market::Shib, Market::Pepe, Market::Pengu];
const SIX: &[Market] = &Market::ALL;

/// The table of section 3.
pub const fn limits(rank: Rank) -> Limits {
    match rank {
        Rank::Intern => Limits {
            rank,
            per_bet_bps: 200,
            max_bets: 1,
            per_round_bps: 200,
            sides: LONG,
            max_leverage: 1,
            markets: FOUR,
        },
        Rank::Analyst => Limits {
            rank,
            per_bet_bps: 500,
            max_bets: 2,
            per_round_bps: 800,
            sides: LONG,
            max_leverage: 1,
            markets: SIX,
        },
        Rank::Trader => Limits {
            rank,
            per_bet_bps: 1000,
            max_bets: 3,
            per_round_bps: 2000,
            sides: BOTH,
            max_leverage: 2,
            markets: SIX,
        },
    }
}

impl Limits {
    pub fn allows_market(&self, m: Market) -> bool {
        self.markets.contains(&m)
    }
    pub fn allows_side(&self, s: Side) -> bool {
        self.sides.contains(&s)
    }
}

/// The limit base of section 3 (1.1): the smaller of the BRAVE pool when the round opened and the
/// BRAVE pool now. A limit is never sized on money that has left.
pub fn limit_base(brave_at_open: u128, brave_now: u128) -> u128 {
    brave_at_open.min(brave_now)
}

/// A rank's limits in dollars (6 decimals) for a given base, rounded down.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DollarLimits {
    pub per_bet: u128,
    pub per_round: u128,
}

pub fn dollar_limits(rank: Rank, base: u128) -> DollarLimits {
    let l = limits(rank);
    DollarLimits {
        per_bet: bps_of(base, l.per_bet_bps),
        per_round: bps_of(base, l.per_round_bps),
    }
}

/// The largest margin the next bet may have: the smaller of the per-bet limit and what is left of
/// the per-round limit. Stops at 0 (a demotion can leave `at_risk` above the new limit).
pub fn max_next_margin(rank: Rank, base: u128, at_risk: u128) -> u128 {
    let d = dollar_limits(rank, base);
    d.per_bet.min(d.per_round.saturating_sub(at_risk))
}

/// `max_bets − bets_used`, stopping at 0.
pub fn bets_left(rank: Rank, bets_used: u32) -> u32 {
    limits(rank).max_bets.saturating_sub(bets_used)
}

// ----- section 4 ----------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Network {
    Testnet,
    Mainnet,
}

/// One market as Hyperliquid knows it. Indexes VERIFIED against Hyperliquid's market list on
/// 2026-11-11 (`research-scripts/hl_markets_2026-11-11.txt`); re-check before each deploy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MarketInfo {
    pub market: Market,
    pub hl_name: &'static str,
    pub testnet_asset: u32,
    pub mainnet_asset: u32,
    pub sz_decimals: u8,
}

impl MarketInfo {
    pub fn asset(&self, network: Network) -> u32 {
        match network {
            Network::Testnet => self.testnet_asset,
            Network::Mainnet => self.mainnet_asset,
        }
    }
}

/// In the order of section 4 (the order of `Market::ALL`).
pub const MARKETS: [MarketInfo; 6] = [
    MarketInfo {
        market: Market::Doge,
        hl_name: "DOGE",
        testnet_asset: 173,
        mainnet_asset: 12,
        sz_decimals: 0,
    },
    MarketInfo {
        market: Market::Shib,
        hl_name: "kSHIB",
        testnet_asset: 29,
        mainnet_asset: 38,
        sz_decimals: 0,
    },
    MarketInfo {
        market: Market::Pepe,
        hl_name: "kPEPE",
        testnet_asset: 12,
        mainnet_asset: 15,
        sz_decimals: 0,
    },
    MarketInfo {
        market: Market::Pengu,
        hl_name: "PENGU",
        testnet_asset: 139,
        mainnet_asset: 163,
        sz_decimals: 0,
    },
    MarketInfo {
        market: Market::Wif,
        hl_name: "WIF",
        testnet_asset: 78,
        mainnet_asset: 98,
        sz_decimals: 0,
    },
    MarketInfo {
        market: Market::Trump,
        hl_name: "TRUMP",
        testnet_asset: 150,
        mainnet_asset: 174,
        sz_decimals: 1,
    },
];

pub fn market_info(m: Market) -> &'static MarketInfo {
    &MARKETS[m as usize]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn market_table_is_in_enum_order() {
        for (i, m) in Market::ALL.iter().enumerate() {
            assert_eq!(MARKETS[i].market, *m);
            assert_eq!(market_info(*m).market, *m);
        }
    }

    #[test]
    fn section_12_dollar_limits_at_a_1000_pool() {
        let b = 1_000_000_000;
        assert_eq!(
            dollar_limits(Rank::Intern, b),
            DollarLimits {
                per_bet: 20_000_000,
                per_round: 20_000_000
            }
        );
        assert_eq!(
            dollar_limits(Rank::Analyst, b),
            DollarLimits {
                per_bet: 50_000_000,
                per_round: 80_000_000
            }
        );
        assert_eq!(
            dollar_limits(Rank::Trader, b),
            DollarLimits {
                per_bet: 100_000_000,
                per_round: 200_000_000
            }
        );
    }

    #[test]
    fn the_limit_base_is_the_smaller_figure() {
        assert_eq!(limit_base(1_000, 500), 500);
        assert_eq!(limit_base(500, 1_000), 500);
    }

    #[test]
    fn next_margin_and_bets_left_stop_at_zero() {
        // TRADER counters, then demoted to ANALYST mid-round.
        assert_eq!(
            max_next_margin(Rank::Analyst, 1_000_000_000, 200_000_000),
            0
        );
        assert_eq!(bets_left(Rank::Analyst, 3), 0);
        assert_eq!(
            max_next_margin(Rank::Trader, 1_000_000_000, 150_000_000),
            50_000_000
        );
    }
}
