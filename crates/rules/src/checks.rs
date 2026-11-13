//! Section 7: the sixteen NOPE checks, in order, stopping at the first failure.
//!
//! This module owns checks 1, 2 and 6–12. Checks 3–5 belong to Engine 2's `ai-check` and checks
//! 13–16 to the funding-quote code (step 7); [`rule`] takes both as closures so the order of all
//! sixteen is fixed in one place and cannot be got wrong by a caller.
//!
//! Nothing here panics, whatever the numbers.

use crate::clock::{phase_at, Offsets, Phase};
use crate::limits::{dollar_limits, hl_max_leverage, limit_base, limits, MIN_NOTIONAL};
use shared::{Decision, Market, Rank, Refusal, Refused, Side, Status};

/// Everything checks 1, 2 and 6–12 look at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ctx {
    pub offsets: Offsets,
    /// Now minus the round's start, in ms.
    pub ms_into_round: u64,
    pub status: Status,
    /// The current rank: after a demotion, the lower one (section 9.2, 1.1).
    pub rank: Rank,
    pub brave_at_open: u128,
    /// The BRAVE pool now (`get_pot().brave.total`).
    pub brave_now: u128,
    pub bets_used: u32,
    pub at_risk: u128,
    /// 1.5 (R6): this round's long-shot ticket, when a passed LONG_SHOT vote allows one and it is unused.
    pub ticket: Option<Ticket>,
}

/// The long-shot ticket of a round: one extra bet at exactly `margin`, leverage up to `max_leverage`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ticket {
    pub margin: u128,
    pub max_leverage: u32,
}

/// An approved bet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Bet {
    pub market: Market,
    pub side: Side,
    pub margin: u128,
    pub leverage: u32,
    /// `margin × leverage`.
    pub notional: u128,
    /// 1.5 (R6): approved as the round's long-shot ticket.
    pub ticket: bool,
}

/// The program's answer to one proposal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ruling {
    Yes(Bet),
    Skip,
    /// `decision` is `None` when the answer was never read (checks 1–5), as the interface's
    /// `Refusal.decision` ("null when the answer could not be read").
    Nope {
        refused: Refused,
        decision: Option<Decision>,
    },
}

/// Checks 1 and 2.
pub fn check_gate(ctx: &Ctx) -> Result<(), Refused> {
    // 1 OUTSIDE_WINDOW: asked = ms into the round; limit = propose_from_ms if too early,
    //   propose_until_ms if too late (1.1).
    if phase_at(&ctx.offsets, ctx.ms_into_round) != Phase::Propose {
        let o = &ctx.offsets;
        let limit = if ctx.ms_into_round < o.propose_from_ms {
            o.propose_from_ms
        } else {
            o.propose_until_ms
        };
        return Err(Refused::with(
            Refusal::OutsideWindow,
            ctx.ms_into_round as u128,
            limit as u128,
        ));
    }
    // 2 FIRED
    if ctx.status == Status::Fired {
        return Err(Refused::bare(Refusal::Fired));
    }
    Ok(())
}

/// Checks 6 to 12 for one bet. Limits use the limit base of section 3 (1.1).
pub fn check_bet(
    ctx: &Ctx,
    market: Market,
    side: Side,
    margin: u128,
    leverage: u32,
) -> Result<Bet, Refused> {
    let l = limits(ctx.rank);
    // 6 NOT_ON_LIST
    if !l.allows_market(market) {
        return Err(Refused::bare(Refusal::NotOnList));
    }
    // 7 SHORT_NOT_UNLOCKED
    if !l.allows_side(side) {
        return Err(Refused::bare(Refusal::ShortNotUnlocked));
    }
    // 8 ZERO_MARGIN: margin 0, or notional under the exchange minimum. asked = notional.
    let notional = margin.saturating_mul(leverage as u128);
    if margin == 0 || notional < MIN_NOTIONAL {
        return Err(Refused::with(Refusal::ZeroMargin, notional, MIN_NOTIONAL));
    }
    // R6 (1.5): the round's long-shot ticket. A bet at exactly the ticket's margin and above the rank's leverage is
    // the ticket: leverage up to the ticket's cap (and the market's), one extra bet (check 10 does not apply), a
    // fixed size (check 11 does not apply), still inside the round's limit (check 12).
    if let Some(t) = ctx.ticket {
        if margin == t.margin && leverage > l.max_leverage {
            let cap = t.max_leverage.min(hl_max_leverage(market));
            if leverage > cap {
                return Err(Refused::with(Refusal::OverLeverage, leverage as u128, cap as u128));
            }
            let d = dollar_limits(ctx.rank, limit_base(ctx.brave_at_open, ctx.brave_now));
            let after = ctx.at_risk.saturating_add(margin);
            if after > d.per_round {
                return Err(Refused::with(Refusal::OverRoundLimit, after, d.per_round));
            }
            return Ok(Bet { market, side, margin, leverage, notional, ticket: true });
        }
    }
    // 9 OVER_LEVERAGE
    if leverage > l.max_leverage {
        return Err(Refused::with(
            Refusal::OverLeverage,
            leverage as u128,
            l.max_leverage as u128,
        ));
    }
    // 10 TOO_MANY_TRADES ("already equals"; after a demotion it can be above)
    if ctx.bets_used >= l.max_bets {
        return Err(Refused::with(
            Refusal::TooManyTrades,
            ctx.bets_used as u128 + 1,
            l.max_bets as u128,
        ));
    }
    let d = dollar_limits(ctx.rank, limit_base(ctx.brave_at_open, ctx.brave_now));
    // 11 OVER_TRADE_LIMIT
    if margin > d.per_bet {
        return Err(Refused::with(Refusal::OverTradeLimit, margin, d.per_bet));
    }
    // 12 OVER_ROUND_LIMIT
    let after = ctx.at_risk.saturating_add(margin);
    if after > d.per_round {
        return Err(Refused::with(Refusal::OverRoundLimit, after, d.per_round));
    }
    Ok(Bet {
        market,
        side,
        margin,
        leverage,
        notional,
        ticket: false,
    })
}

/// The whole of section 7 in order.
///
/// - `verify` is checks 3–5 (`ai_check::verify`); it is called only if checks 1–2 pass, and must
///   return a decision or one of BAD_MODEL_SIGNATURE, WRONG_RULEBOOK, MALFORMED_DECISION.
/// - `funding` is checks 13–16 for the approved bet; it is called only if checks 6–12 pass. With
///   no quote attached it returns `Ok(())` (section 9.4).
///
/// A skip that passes 1–5 is a SKIP and uses none of the limits.
pub fn rule<V, F>(ctx: &Ctx, verify: V, funding: F) -> Ruling
where
    V: FnOnce() -> Result<Decision, Refusal>,
    F: FnOnce(&Bet) -> Result<(), Refused>,
{
    if let Err(refused) = check_gate(ctx) {
        return Ruling::Nope {
            refused,
            decision: None,
        };
    }
    let decision = match verify() {
        Ok(d) => d,
        Err(code) => {
            return Ruling::Nope {
                refused: Refused::bare(code),
                decision: None,
            }
        }
    };
    let (market, side, margin_e6, leverage) = match decision {
        Decision::Skip => return Ruling::Skip,
        Decision::Bet {
            market,
            side,
            margin_e6,
            leverage,
        } => (market, side, margin_e6, leverage),
    };
    let bet = match check_bet(ctx, market, side, margin_e6, leverage) {
        Ok(b) => b,
        Err(refused) => {
            return Ruling::Nope {
                refused,
                decision: Some(decision),
            }
        }
    };
    match funding(&bet) {
        Ok(()) => Ruling::Yes(bet),
        Err(refused) => Ruling::Nope {
            refused,
            decision: Some(decision),
        },
    }
}

/// Section 9.3 "close": a reduce-only order for the recorded size on the other side. Shown here so
/// the side flip lives next to the rules; the order itself is built in step 7.
pub fn closing_side(side: Side) -> Side {
    match side {
        Side::Long => Side::Short,
        Side::Short => Side::Long,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::REAL;

    fn ctx(rank: Rank) -> Ctx {
        Ctx { ticket: None,
            offsets: REAL,
            ms_into_round: REAL.propose_from_ms + 60_000,
            status: Status::Employed,
            rank,
            brave_at_open: 1_000_000_000,
            brave_now: 1_000_000_000,
            bets_used: 0,
            at_risk: 0,
        }
    }

    // ----- R6 (1.5): the long-shot ticket

    /// INTERN, $1,000 at open: the ticket is $5 (0.5%), up to 10x.
    fn with_ticket() -> Ctx {
        let mut c = ctx(Rank::Intern);
        c.ticket = Some(Ticket { margin: crate::limits::long_shot_margin(c.brave_at_open), max_leverage: 10 });
        c
    }

    #[test]
    fn the_ticket_is_one_extra_bet_at_its_exact_margin_up_to_10x() {
        let mut c = with_ticket();
        assert_eq!(c.ticket.map(|t| t.margin), Some(5_000_000));
        c.bets_used = 1; // the rank's one bet is already used: the ticket is extra
        c.at_risk = 15_000_000;
        let b = check_bet(&c, Market::Doge, Side::Long, 5_000_000, 10).expect("the ticket");
        assert!(b.ticket);
        assert_eq!((b.leverage, b.notional), (10, 50_000_000));
        // At the rank's own leverage it is an ordinary bet, judged as one: $5 at 1x is under the $11 minimum.
        assert_eq!(
            check_bet(&c, Market::Doge, Side::Long, 5_000_000, 1),
            Err(Refused::with(Refusal::ZeroMargin, 5_000_000, MIN_NOTIONAL))
        );
    }

    #[test]
    fn the_ticket_keeps_every_other_rule() {
        let c = with_ticket();
        // Another margin at high leverage is an ordinary bet: refused for leverage.
        assert_eq!(check_bet(&c, Market::Doge, Side::Long, 6_000_000, 10), Err(Refused::with(Refusal::OverLeverage, 10, 1)));
        // Above 10x, or above what the market allows (PENGU and WIF: 5x).
        assert_eq!(check_bet(&c, Market::Doge, Side::Long, 5_000_000, 11), Err(Refused::with(Refusal::OverLeverage, 11, 10)));
        assert_eq!(check_bet(&c, Market::Pengu, Side::Long, 5_000_000, 10), Err(Refused::with(Refusal::OverLeverage, 10, 5)));
        assert!(check_bet(&c, Market::Pengu, Side::Long, 5_000_000, 5).expect("5x on PENGU").ticket);
        // The rank's markets and sides, and the $11 minimum, still apply.
        assert_eq!(check_bet(&c, Market::Wif, Side::Long, 5_000_000, 5), Err(Refused::bare(Refusal::NotOnList)));
        assert_eq!(check_bet(&c, Market::Doge, Side::Short, 5_000_000, 10), Err(Refused::bare(Refusal::ShortNotUnlocked)));
        assert_eq!(check_bet(&c, Market::Doge, Side::Long, 5_000_000, 2), Err(Refused::with(Refusal::ZeroMargin, 10_000_000, MIN_NOTIONAL)));
        // Inside the round's limit (2% of $1,000 = $20), not on top of it.
        let mut full = with_ticket();
        full.at_risk = 16_000_000;
        assert_eq!(check_bet(&full, Market::Doge, Side::Long, 5_000_000, 10), Err(Refused::with(Refusal::OverRoundLimit, 21_000_000, 20_000_000)));
        // No ticket this round: 10x is refused as always.
        assert_eq!(check_bet(&ctx(Rank::Intern), Market::Doge, Side::Long, 5_000_000, 10), Err(Refused::with(Refusal::OverLeverage, 10, 1)));
    }

    #[test]
    fn the_ticket_margin_is_half_a_percent_rounded_down() {
        use crate::limits::long_shot_margin;
        assert_eq!(long_shot_margin(1_574_694_996), 7_873_474);
        assert_eq!(long_shot_margin(199), 0);
        assert_eq!(long_shot_margin(u128::MAX), u128::MAX / 10_000 * 50 + u128::MAX % 10_000 * 50 / 10_000);
    }

    #[test]
    fn checks_3_to_5_are_not_asked_when_1_or_2_fail() {
        let mut c = ctx(Rank::Intern);
        c.status = Status::Fired;
        let r = rule(
            &c,
            || panic!("verify must not run"),
            |_| panic!("funding must not run"),
        );
        assert_eq!(
            r,
            Ruling::Nope {
                refused: Refused::bare(Refusal::Fired),
                decision: None
            }
        );
    }

    #[test]
    fn funding_runs_last_and_only_for_an_approved_bet() {
        let c = ctx(Rank::Intern);
        let bet = Decision::Bet {
            market: Market::Doge,
            side: Side::Long,
            margin_e6: 20_000_000,
            leverage: 1,
        };
        let r = rule(
            &c,
            || Ok(bet),
            |_| Err(Refused::with(Refusal::StaleQuote, 61_000, 60_000)),
        );
        assert_eq!(
            r,
            Ruling::Nope {
                refused: Refused::with(Refusal::StaleQuote, 61_000, 60_000),
                decision: Some(bet)
            }
        );
        let over = Decision::Bet {
            market: Market::Doge,
            side: Side::Long,
            margin_e6: 20_000_001,
            leverage: 1,
        };
        let r = rule(
            &c,
            || Ok(over),
            |_| panic!("funding must not run for a refused bet"),
        );
        assert!(matches!(
            r,
            Ruling::Nope {
                refused: Refused {
                    code: Refusal::OverTradeLimit,
                    ..
                },
                ..
            }
        ));
    }

    #[test]
    fn a_verify_refusal_carries_no_decision() {
        let r = rule(
            &ctx(Rank::Trader),
            || Err(Refusal::MalformedDecision),
            |_| Ok(()),
        );
        assert_eq!(
            r,
            Ruling::Nope {
                refused: Refused::bare(Refusal::MalformedDecision),
                decision: None
            }
        );
    }

    #[test]
    fn a_skip_uses_no_limits_even_when_none_are_left() {
        let mut c = ctx(Rank::Intern);
        c.bets_used = 5;
        c.at_risk = u128::MAX;
        assert_eq!(rule(&c, || Ok(Decision::Skip), |_| panic!()), Ruling::Skip);
    }

    #[test]
    fn huge_numbers_do_not_panic() {
        let mut c = ctx(Rank::Trader);
        c.at_risk = u128::MAX;
        c.brave_now = u128::MAX;
        c.brave_at_open = u128::MAX;
        let r = check_bet(&c, Market::Doge, Side::Short, u128::MAX, u32::MAX);
        assert_eq!(r.unwrap_err().code, Refusal::OverLeverage);
        let r = check_bet(&c, Market::Doge, Side::Short, u128::MAX / 3, 2);
        assert_eq!(r.unwrap_err().code, Refusal::OverTradeLimit);
        c.ms_into_round = u64::MAX;
        assert_eq!(
            check_gate(&c).unwrap_err().limit,
            Some(REAL.propose_until_ms as u128)
        );
    }

    #[test]
    fn a_demotion_applies_the_lower_limits_to_the_same_counters() {
        // TRADER placed one $100 bet; then demoted to ANALYST in the same round.
        let mut c = ctx(Rank::Analyst);
        c.bets_used = 1;
        c.at_risk = 100_000_000;
        // ANALYST: 2 bets, $50 per bet, $80 per round: $100 already at risk, so nothing more fits.
        let r = check_bet(&c, Market::Doge, Side::Long, 11_000_000, 1).unwrap_err();
        assert_eq!(
            r,
            Refused::with(Refusal::OverRoundLimit, 111_000_000, 80_000_000)
        );
        // And a short is no longer allowed.
        assert_eq!(
            check_bet(&c, Market::Doge, Side::Short, 11_000_000, 1)
                .unwrap_err()
                .code,
            Refusal::ShortNotUnlocked
        );
    }

    #[test]
    fn closing_flips_the_side() {
        assert_eq!(closing_side(Side::Long), Side::Short);
        assert_eq!(closing_side(Side::Short), Side::Long);
    }
}
