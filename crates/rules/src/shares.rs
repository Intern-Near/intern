//! Coins (shares of the BRAVE pool), pending money and cash-out. Sections 5 and 9.1 (1.1).
//!
//! - Money paid into BRAVE waits as pending and becomes coins when the next round opens, at the
//!   price of that moment. Opening a round never loops over depositors (1.1): the round records
//!   one [`Rate`] and adds the pending total to the pool and the matching coins to the supply;
//!   each account's coins are worked out later, from the same `Rate`, with [`convert`].
//! - The first conversion ever locks 1,000 units for ever, so nobody can bend the share price by
//!   being first with a tiny deposit.
//! - Cash-out pays a pro-rata share of what the pool holds *except margin out on open bets*.
//! - Every rounding favours the pool: coins are rounded down on the way in, dollars rounded down on
//!   the way out. The few units of dust this leaves belong to nobody and stay in the pool.

use crate::math::mul_div_floor;

/// Coin units locked for ever at the first conversion (section 9.1).
pub const LOCKED_FOREVER: u128 = 1_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShareError {
    ZeroAmount,
    /// More coins asked for than exist.
    NotEnoughCoins,
    /// Coins exist but the pool holds nothing; new money would be handed to old coins.
    PoolEmpty,
    /// The pool holds money but no coins exist. Cannot happen once 1,000 units are locked.
    NoCoins,
    Overflow,
}

/// The price at which one round's pending money becomes coins: `coins = dollars × supply / pool`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rate {
    pub pool: u128,
    pub supply: u128,
}

/// What opening a round does with the pending money.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenMint {
    /// No money is waiting.
    Nothing,
    /// The very first conversion would be under the minimum: the money keeps waiting.
    Wait,
    /// Record `rate` for this round; add the pending total to the pool and `minted` to the supply.
    /// `locked` of the minted coins (plus the rounding dust of the per-account conversions) belong
    /// to nobody.
    Mint {
        rate: Rate,
        minted: u128,
        locked: u128,
    },
}

/// The pool's side of opening a round. `pool` and `supply` are the BRAVE pool and the coin supply
/// before the pending money is added; at a round opening nothing is in play, because the previous
/// round has settled.
///
/// First conversion ever (`supply` 0): it must total at least `min_first_deposit` (and more than
/// the locked 1,000 units). Everyone converting in that round shares the locked units pro-rata:
/// `rate` = (pool: P, supply: P − 1,000). Later conversions: `rate` = (pool, supply).
pub fn open_round_mint(
    pool: u128,
    supply: u128,
    pending: u128,
    min_first_deposit: u128,
) -> Result<OpenMint, ShareError> {
    if pending == 0 {
        return Ok(OpenMint::Nothing);
    }
    if supply == 0 {
        if pool != 0 {
            return Err(ShareError::NoCoins);
        }
        if pending < min_first_deposit || pending <= LOCKED_FOREVER {
            return Ok(OpenMint::Wait);
        }
        return Ok(OpenMint::Mint {
            rate: Rate {
                pool: pending,
                supply: pending - LOCKED_FOREVER,
            },
            minted: pending,
            locked: LOCKED_FOREVER,
        });
    }
    if pool == 0 {
        return Err(ShareError::PoolEmpty);
    }
    let minted = mul_div_floor(pending, supply, pool).ok_or(ShareError::Overflow)?;
    if minted == 0 {
        // Under one coin unit at today's price: adding the money would give it to the old coins.
        return Ok(OpenMint::Wait);
    }
    Ok(OpenMint::Mint {
        rate: Rate { pool, supply },
        minted,
        locked: 0,
    })
}

/// One account's coins for `dollars` it had pending, at the rate its round recorded. Rounded down.
/// The sum over every account of a round is never more than that round's `minted − locked`.
pub fn convert(dollars: u128, rate: Rate) -> u128 {
    mul_div_floor(dollars, rate.supply, rate.pool).unwrap_or(0)
}

/// Dollars paid for burning `coins` of `supply`, when the pool holds `held` (the BRAVE total
/// minus margin in play, section 9.1 1.1). Rounded down.
pub fn redeem(coins: u128, held: u128, supply: u128) -> Result<u128, ShareError> {
    if coins == 0 {
        return Err(ShareError::ZeroAmount);
    }
    if coins > supply {
        return Err(ShareError::NotEnoughCoins);
    }
    mul_div_floor(held, coins, supply).ok_or(ShareError::Overflow)
}

/// What the pool holds for its coins: the BRAVE total minus margin out on open bets (1.1).
pub fn held(brave_total: u128, in_play: u128) -> u128 {
    brave_total.saturating_sub(in_play)
}

/// `get_pot().coin_price_e6`: dollars per whole coin, 6 decimals, rounded down, leaving out
/// margin in play. "1000000" ($1.00) before any coin exists.
pub fn coin_price_e6(brave_total: u128, in_play: u128, supply: u128) -> u128 {
    if supply == 0 {
        return 1_000_000;
    }
    mul_div_floor(held(brave_total, in_play), 1_000_000, supply).unwrap_or(u128::MAX)
}

/// `get_account().brave_value`: what `coins` would be paid now.
pub fn brave_value(coins: u128, brave_total: u128, in_play: u128, supply: u128) -> u128 {
    if coins == 0 || supply == 0 {
        return 0;
    }
    redeem(coins.min(supply), held(brave_total, in_play), supply).unwrap_or(0)
}

/// A settled position's result: dollars back minus dollars out (`Signed`).
pub fn result_of(margin: u128, returned: u128) -> i128 {
    let clamp = |x: u128| x.min(i128::MAX as u128) as i128;
    clamp(returned) - clamp(margin)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    const MIN_FIRST: u128 = 10_000_000;

    fn mint(pool: u128, supply: u128, pending: u128) -> (Rate, u128, u128) {
        match open_round_mint(pool, supply, pending, MIN_FIRST).unwrap() {
            OpenMint::Mint {
                rate,
                minted,
                locked,
            } => (rate, minted, locked),
            other => panic!("expected a mint, got {other:?}"),
        }
    }

    #[test]
    fn the_first_conversion_locks_1000_units_and_needs_the_minimum() {
        let (rate, minted, locked) = mint(0, 0, 1_000_000_000);
        assert_eq!((minted, locked), (1_000_000_000, 1_000));
        assert_eq!(convert(1_000_000_000, rate), 999_999_000);
        assert_eq!(
            open_round_mint(0, 0, MIN_FIRST - 1, MIN_FIRST),
            Ok(OpenMint::Wait)
        );
        assert_eq!(
            open_round_mint(0, 0, 1_000, 0),
            Ok(OpenMint::Wait),
            "must exceed the locked units"
        );
        assert_eq!(
            open_round_mint(5, 0, MIN_FIRST, MIN_FIRST),
            Err(ShareError::NoCoins)
        );
        assert_eq!(open_round_mint(0, 0, 0, MIN_FIRST), Ok(OpenMint::Nothing));
    }

    #[test]
    fn two_first_depositors_share_the_locked_units() {
        let (rate, minted, locked) = mint(0, 0, 30_000_000);
        let (a, b) = (convert(10_000_000, rate), convert(20_000_000, rate));
        assert_eq!((a, b), (9_999_666, 19_999_333));
        assert!(a + b + locked <= minted);
    }

    #[test]
    fn later_money_gets_coins_at_the_price_of_the_opening() {
        // The pool doubled since the coins were issued: half as many coins per dollar.
        let (rate, minted, _) = mint(2_000_000, 1_000_000, 1_000);
        assert_eq!((minted, convert(1_000, rate)), (500, 500));
        assert_eq!(
            open_round_mint(0, 5, 10, MIN_FIRST),
            Err(ShareError::PoolEmpty)
        );
        // Under one unit at today's price: wait rather than gift it.
        assert_eq!(
            open_round_mint(3_000_000, 1_000_000, 2, MIN_FIRST),
            Ok(OpenMint::Wait)
        );
    }

    #[test]
    fn cash_out_leaves_out_margin_in_play() {
        // $1,000 pool, $20 in play, 1,000 coins: a quarter of the coins gets a quarter of $980.
        assert_eq!(
            redeem(250_000_000, held(1_000_000_000, 20_000_000), 1_000_000_000),
            Ok(245_000_000)
        );
        assert_eq!(
            coin_price_e6(1_000_000_000, 20_000_000, 1_000_000_000),
            980_000
        );
        assert_eq!(
            brave_value(250_000_000, 1_000_000_000, 20_000_000, 1_000_000_000),
            245_000_000
        );
        assert_eq!(coin_price_e6(0, 0, 0), 1_000_000);
        assert_eq!(redeem(2, 10, 1), Err(ShareError::NotEnoughCoins));
        assert_eq!(redeem(0, 10, 1), Err(ShareError::ZeroAmount));
    }

    #[test]
    fn results() {
        assert_eq!(result_of(20_000_000, 21_800_000), 1_800_000);
        assert_eq!(result_of(20_000_000, 17_500_000), -2_500_000);
        assert_eq!(result_of(20_000_000, 0), -20_000_000);
    }

    proptest! {
        /// One depositor in a round puts money in and takes it straight out: never more than paid.
        #[test]
        fn in_then_out_never_profits_alone(
            pool in 1u128..=1 << 90,
            supply in 1u128..=1 << 90,
            paid in 1u128..=1 << 90,
        ) {
            if let Ok(OpenMint::Mint { rate, minted, .. }) = open_round_mint(pool, supply, paid, MIN_FIRST) {
                let coins = convert(paid, rate);
                prop_assert_eq!(coins, minted);
                let out = redeem(coins, pool + paid, supply + minted).unwrap();
                prop_assert!(out <= paid, "paid {paid}, got back {out}");
            }
        }

        /// Several depositors in one round, all leaving at once: together they never take out more
        /// than they paid in, so the coins that were already there lose nothing. (One of them can get
        /// a unit or two more than they paid when another's few units rounded down to no coin: that
        /// dust stays in the pool, which is the rounding the interface asks for.)
        #[test]
        fn depositors_together_never_take_out_more_than_they_paid(
            pool in 1u128..=1 << 70,
            supply in 1u128..=1 << 70,
            parts in proptest::collection::vec(1u128..=1 << 50, 1..20),
        ) {
            let paid: u128 = parts.iter().sum();
            if let Ok(OpenMint::Mint { rate, minted, .. }) = open_round_mint(pool, supply, paid, MIN_FIRST) {
                let (total, all) = (pool + paid, supply + minted);
                let out: u128 = parts
                    .iter()
                    .map(|p| convert(*p, rate))
                    .filter(|c| *c > 0)
                    .map(|c| redeem(c, total, all).unwrap())
                    .sum();
                prop_assert!(out <= paid, "paid {paid}, took out {out}");
            }
        }

        /// A conversion never lowers the value of a coin that already exists.
        #[test]
        fn a_conversion_never_dilutes_existing_coins(
            pool in 1u128..=1 << 60,
            supply in 1u128..=1 << 60,
            pending in 1u128..=1 << 60,
        ) {
            if let Ok(OpenMint::Mint { minted, .. }) = open_round_mint(pool, supply, pending, MIN_FIRST) {
                // (pool + pending) / (supply + minted) >= pool / supply, cross-multiplied.
                prop_assert!((pool + pending) * supply >= pool * (supply + minted));
            }
        }

        /// Per-account conversions never add up to more coins than the round minted.
        #[test]
        fn accounts_never_get_more_than_was_minted(
            pool in 0u128..=1 << 70,
            supply_raw in 0u128..=1 << 70,
            parts in proptest::collection::vec(1u128..=1 << 50, 1..40),
        ) {
            let supply = if pool == 0 { 0 } else { supply_raw.max(1) };
            let pending: u128 = parts.iter().sum();
            if let Ok(OpenMint::Mint { rate, minted, locked }) = open_round_mint(pool, supply, pending, MIN_FIRST) {
                let given: u128 = parts.iter().map(|p| convert(*p, rate)).sum();
                prop_assert!(given + locked <= minted);
            }
        }

        /// The first-depositor trick: be first with the minimum, then make the pool look rich, and
        /// hope the next depositor's coins round to nothing. (The contract's ledger ignores money it
        /// was not paid through the pay-in path, so the "donation" here is a gain on a bet.)
        /// The victim must lose no more than a dust amount.
        #[test]
        fn being_first_cannot_take_a_real_part_of_the_next_deposit(
            gain in 0u128..=1 << 70,
            victim in 1_000_000u128..=1 << 70,
        ) {
            let (rate, minted, _) = mint(0, 0, MIN_FIRST);
            let attacker = convert(MIN_FIRST, rate);
            let (pool, supply) = (MIN_FIRST + gain, minted);
            match open_round_mint(pool, supply, victim, MIN_FIRST).unwrap() {
                OpenMint::Mint { rate, minted, .. } => {
                    let coins = convert(victim, rate);
                    let total = pool + victim;
                    let all = supply + minted;
                    let back = if coins == 0 { 0 } else { redeem(coins, total, all).unwrap() };
                    let attacker_back = redeem(attacker, total, all).unwrap();
                    prop_assert!(back <= victim);
                    // What the victim loses is at most one coin unit's worth plus one unit of dust
                    // per coin rounding: the price of a unit is pool / supply.
                    let unit_price = total / all + 1;
                    prop_assert!(victim - back <= 2 * unit_price, "victim lost {} at unit price {unit_price}", victim - back);
                    prop_assert!(attacker_back <= MIN_FIRST + gain + unit_price);
                }
                OpenMint::Wait => prop_assert!(victim < pool / supply + 1, "only waits when under one unit"),
                OpenMint::Nothing => unreachable!(),
            }
        }
    }
}
