//! Step 8 of the Engine 1 brief (01-SHARED-INTERFACE.md 1.3): lending, and outside income.
//!
//! Lending (`lending.mode` STANDIN on testnet): Rhea Lend works from a contract on mainnet but will not
//! take our test dollar on testnet (it only accepts tokens its owners listed; research of 2026-11-12),
//! so testnet lends to a small stand-in lender (crates/lender) that pays a fixed test rate. Nothing
//! here presents stand-in interest as real.
//! - `rebalance()` (anyone; the runner each round): keeps exactly the Intern's slice (its rank's
//!   per-round limit on the pool) idle, lending what is beyond it or bringing back what it is short of. Money waiting as `pending`, SAFE money and margin in play are never lent.
//! - A cash-out or a dial turn that needs more than is idle first brings the difference back from the
//!   lender (plus what the slice then lacks), then pays. If the lender cannot pay, nothing changes and the call can be made again.
//! - `collect_interest()` (anyone): the interest paid so far goes into the BRAVE pool.
//!
//! Outside income: dollars sent with `msg: {"income":{"source":"…"}}` (the launchpad's fees, tips) are
//! credited to the BRAVE pool at the next round's opening, before that opening converts pending money.
//! So they go only to coins present for the whole round in which the income arrived, and new money
//! cannot buy into income that is already known. Income is taken only while the Intern is EMPLOYED.

use crate::*;
use near_sdk::ext_contract;

/// `rebalance()` lends at least this much, and brings back at least `MIN_RECALL`.
pub const MIN_LEND: u128 = 10_000_000;
pub const MIN_RECALL: u128 = 1_000_000;
const GAS_LEND: Gas = Gas::from_tgas(40);
const GAS_ON_LENT: Gas = Gas::from_tgas(10);
const GAS_WITHDRAW: Gas = Gas::from_tgas(60);
const GAS_ON_WITHDRAWN: Gas = Gas::from_tgas(60);
const GAS_INTEREST: Gas = Gas::from_tgas(60);
const GAS_ON_INTEREST: Gas = Gas::from_tgas(10);
/// A cash-out or dial turn that must first bring money back from the lender.
pub const GAS_WITH_WITHDRAW: Gas = Gas::from_tgas(150);

/// The stand-in lender (crates/lender).
#[ext_contract(ext_lender)]
#[allow(dead_code)]
trait Lender {
    fn withdraw(&mut self, amount: U128) -> bool;
    fn claim_interest(&mut self) -> U128;
}

/// `{"income":{"source":"launchpad"}}`
#[derive(near_sdk::serde::Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub(crate) struct IncomeMsg {
    pub income: IncomeBody,
}
#[derive(near_sdk::serde::Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
pub(crate) struct IncomeBody {
    pub source: String,
}

pub(crate) fn valid_source(s: &str) -> bool {
    (1..=32).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

/// What a dollar amount was waiting for when it came back from the lender.
#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Then {
    /// A BRAVE cash-out of `coins` paying `paid`.
    CashOut,
    /// A dial turn to SAFE of `coins` worth `paid`.
    Dial,
}

impl Coin {
    /// BRAVE dollars here and free: not lent (or on the way), not in play.
    pub(crate) fn idle(&self) -> u128 {
        self.books
            .brave_total
            .saturating_sub(self.s9.lent + self.s9.lend_in_flight + self.books.in_play)
    }

    /// What `lend()` keeps idle: the most the Intern may put in play in one round at its rank.
    pub(crate) fn slice(&self) -> u128 {
        let l = rules::limits::limits(self.rank_now().0);
        self.books
            .brave_total
            .saturating_mul(l.per_round_bps as u128)
            / 10_000
    }

    pub(crate) fn lending_busy(&self) -> bool {
        self.s9.lend_in_flight > 0 || self.s9.withdraw_in_flight
    }

    /// Outside income: credited at the next round's opening (section above).
    pub(crate) fn take_income(&mut self, source: &str, amount: u128) {
        self.s9.income_waiting += amount;
        self.s9.outside_income_total += amount;
        self.feed.push(
            EventName::OutsideIncome,
            json!({"source": source, "amount": U128(amount)}),
        );
    }

    /// Brings `need` back from the lender, then finishes a cash-out or dial turn whose state was
    /// already written (coins burned, `paid` taken from the pool).
    pub(crate) fn withdraw_then(
        &mut self,
        who: &AccountId,
        need: u128,
        paid: u128,
        coins: U128,
        then: Then,
    ) -> Promise {
        require!(
            env::prepaid_gas() >= GAS_WITH_WITHDRAW,
            "attach 150 TGas: this much must first come back from the lender"
        );
        require!(
            !self.lending_busy(),
            "a lending move is in flight: try again in a few seconds"
        );
        let lender = self.s9.lender.clone().expect("only lent money is missing");
        // Also bring back what the Intern's slice would lack once `paid` has left the pool.
        let slice_after = self.slice();
        let need = (need + slice_after).min(self.s9.lent).max(need);
        self.s9.withdraw_in_flight = true;
        self.s9.lent -= need;
        ext_lender::ext(lender)
            .with_static_gas(GAS_WITHDRAW)
            .withdraw(U128(need))
            .then(
                Self::ext(Self::me())
                    .with_static_gas(GAS_ON_WITHDRAWN)
                    .on_withdrawn(who.clone(), U128(need), U128(paid), coins, then),
            )
    }
}

#[near]
impl Coin {
    /// Anyone (the runner each round). Keeps exactly the Intern's slice idle: lends what is idle beyond
    /// it (at least $10), or brings back from the lender what the slice is short of (at least $1).
    /// Returns the dollars moved: positive lent, negative brought back.
    pub fn rebalance(&mut self) -> Promise {
        let lender = self
            .s9
            .lender
            .clone()
            .unwrap_or_else(|| env::panic_str("no lender: lending.mode is NONE"));
        self.tick();
        require!(
            !self.lending_busy(),
            "a lending move is in flight: try again in a few seconds"
        );
        let (idle, slice) = (self.idle(), self.slice());
        let short = slice.saturating_sub(idle).min(self.s9.lent);
        if short >= MIN_RECALL {
            // The slice is short (after cash-outs): bring that much back.
            self.s9.withdraw_in_flight = true;
            self.s9.lent -= short;
            return ext_lender::ext(lender)
                .with_static_gas(GAS_WITHDRAW)
                .withdraw(U128(short))
                .then(
                    Self::ext(Self::me())
                        .with_static_gas(GAS_ON_LENT)
                        .on_recalled(U128(short)),
                );
        }
        let amount = idle.saturating_sub(slice);
        require!(
            amount >= MIN_LEND,
            "nothing to move: the Intern's slice is idle and the rest beyond it is under $10"
        );
        self.s9.lend_in_flight = amount;
        ext_ft_core::ext(self.cfg.usdc_token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_LEND)
            .ft_transfer_call(
                lender,
                U128(amount),
                Some("$INTERN lends idle BRAVE money".into()),
                String::new(),
            )
            .then(
                Self::ext(Self::me())
                    .with_static_gas(GAS_ON_LENT)
                    .on_lent(U128(amount)),
            )
    }

    /// Callback of `rebalance` bringing money back. Failure: it stays counted as lent.
    #[private]
    pub fn on_recalled(&mut self, amount: U128) -> wire::I128 {
        self.s9.withdraw_in_flight = false;
        if matches!(env::promise_result_checked(0, 64), Ok(b) if b == b"true") {
            env::log_str(&format!(
                "brought back {}; lent now {}",
                amount.0, self.s9.lent
            ));
            return wire::I128(-(amount.0 as i128));
        }
        self.s9.lent += amount.0;
        env::log_str("the lender could not pay back: nothing changed, try again");
        wire::I128(0)
    }

    #[private]
    pub fn on_lent(&mut self, amount: U128) -> U128 {
        // The token's ft_transfer_call answers with the amount the receiver kept.
        let used = match env::promise_result_checked(0, 64) {
            Ok(b) => serde_json::from_slice::<U128>(&b)
                .map(|u| u.0.min(amount.0))
                .unwrap_or(0),
            Err(_) => 0,
        };
        self.s9.lend_in_flight = 0;
        self.s9.lent += used;
        env::log_str(&format!(
            "lent {used} of {}; lent now {}",
            amount.0, self.s9.lent
        ));
        U128(used)
    }

    /// Anyone. Collects the interest the lender owes on what was lent, into the BRAVE pool.
    pub fn collect_interest(&mut self) -> Promise {
        let lender = self
            .s9
            .lender
            .clone()
            .unwrap_or_else(|| env::panic_str("no lender: lending.mode is NONE"));
        self.tick();
        ext_lender::ext(lender)
            .with_static_gas(GAS_INTEREST)
            .claim_interest()
            .then(
                Self::ext(Self::me())
                    .with_static_gas(GAS_ON_INTEREST)
                    .on_interest(),
            )
    }

    #[private]
    pub fn on_interest(&mut self) -> U128 {
        let paid = match env::promise_result_checked(0, 64) {
            Ok(b) => serde_json::from_slice::<U128>(&b).map(|u| u.0).unwrap_or(0),
            Err(_) => 0,
        };
        self.books.brave_total += paid;
        self.s9.interest_total += paid;
        env::log_str(&format!(
            "interest collected: {paid} (STAND-IN lender, a fixed test rate)"
        ));
        U128(paid)
    }

    /// Callback of a withdrawal for a cash-out or dial turn. Success: finish it. Failure: put
    /// everything back as it was.
    #[private]
    pub fn on_withdrawn(
        &mut self,
        who: AccountId,
        need: U128,
        paid: U128,
        coins: U128,
        then: Then,
    ) -> PromiseOrValue<bool> {
        self.s9.withdraw_in_flight = false;
        let ok = matches!(env::promise_result_checked(0, 64), Ok(b) if b == b"true");
        if ok {
            return match then {
                Then::CashOut => {
                    PromiseOrValue::Promise(self.payout(&who, paid.0, Pool::Brave, Some(coins)))
                }
                Then::Dial => {
                    self.credit_safe(&who, paid.0);
                    self.feed.push(
                        EventName::DialTurned,
                        json!({"account_id": who, "to": Pool::Safe, "amount": coins}),
                    );
                    PromiseOrValue::Value(true)
                }
            };
        }
        self.s9.lent += need.0;
        let before = self.bal(&who);
        self.token.internal_deposit(&who, coins.0);
        self.note_holder(&who, before, before + coins.0);
        near_contract_standards::fungible_token::events::FtMint {
            owner_id: &who,
            amount: coins,
            memo: Some("the lender could not pay: put back"),
        }
        .emit();
        self.books.brave_total += paid.0;
        if then == Then::CashOut {
            let mut x = self.extra(&who);
            x.in_flight = x.in_flight.saturating_sub(1);
            self.save_extra(&who, x);
        }
        env::log_str("the lender could not pay back in time: nothing changed, try again");
        PromiseOrValue::Value(false)
    }
}
