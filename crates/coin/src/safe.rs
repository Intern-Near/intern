//! Step 6 of the Engine 1 brief: the SAFE side and the dial (01-SHARED-INTERFACE.md section 9.1).
//!
//! SAFE is a plain dollar ledger: credited at once on pay-in, paid out in dollars, no coin, no vote,
//! never in `brave_at_open`, never touched by a bet's result. Lending (step 8) will lend it; until
//! then all of it is idle.
//!
//! `turn_dial` is the same as cashing out of one side and paying into the other, without the money
//! leaving: to SAFE, `amount` is coins, priced like a cash-out (1.1: margin in play excluded); to
//! BRAVE, `amount` is dollars, which wait as pending until the next round like any pay-in.

use crate::*;

impl Coin {
    pub(crate) fn safe_of(&self, who: &AccountId) -> u128 {
        self.safe.get(who).copied().unwrap_or(0)
    }

    pub(crate) fn credit_safe(&mut self, who: &AccountId, amount: u128) {
        let s = self.safe_of(who) + amount;
        self.safe.insert(who.clone(), s);
        self.books_safe += amount;
    }

    pub(crate) fn debit_safe(&mut self, who: &AccountId, amount: u128) {
        let s = self.safe_of(who);
        require!(amount <= s, "not that much in SAFE");
        if s == amount {
            self.safe.remove(who);
        } else {
            self.safe.insert(who.clone(), s - amount);
        }
        self.books_safe -= amount;
    }
}

#[near]
impl Coin {
    /// Turns the dial, 1 yocto. `to: SAFE`: `amount` coins leave BRAVE at the cash-out price and
    /// arrive as dollars in SAFE at once. `to: BRAVE`: `amount` dollars leave SAFE and wait as
    /// pending for the next round.
    #[payable]
    pub fn turn_dial(&mut self, to: Pool, amount: U128) -> PromiseOrValue<bool> {
        assert_one_yocto();
        require!(amount.0 > 0, "amount must be above 0");
        let who = env::predecessor_account_id();
        require!(self.registered(&who), "not registered");
        self.tick();
        self.materialize(&who);
        match to {
            Pool::Safe => {
                let coins = amount.0;
                let before = self.bal(&who);
                require!(
                    coins <= before.saturating_sub(self.locked_of(&who)),
                    "not that many free coins"
                );
                let held = shares::held(self.books.brave_total, self.books.in_play);
                let value = shares::redeem(coins, held, self.supply())
                    .unwrap_or_else(|_| env::panic_str("cannot price these coins"));
                require!(value > 0, "too few coins to move anything");
                let idle = self.idle(); // step 8
                self.token.internal_withdraw(&who, coins);
                self.note_holder(&who, before, before - coins);
                FtBurn {
                    owner_id: &who,
                    amount,
                    memo: Some("dial to SAFE"),
                }
                .emit();
                self.books.brave_total -= value;
                if value > idle {
                    // Step 8: the rest is lent out; it comes back first, then SAFE is credited.
                    return PromiseOrValue::Promise(self.withdraw_then(
                        &who,
                        value - idle,
                        value,
                        amount,
                        crate::lending::Then::Dial,
                    ));
                }
                self.credit_safe(&who, value);
            }
            Pool::Brave => {
                require!(amount.0 <= self.safe_of(&who), "not that much in SAFE");
                require!(
                    !(self.supply() == 0
                        && self.books.pending_total == 0
                        && amount.0 < self.cfg.min_first_deposit),
                    "the first money ever into BRAVE must be at least min_first_deposit"
                );
                self.debit_safe(&who, amount.0);
                self.add_pending(&who, amount.0);
            }
        }
        self.feed.push(
            EventName::DialTurned,
            json!({"account_id": who, "to": to, "amount": amount}),
        );
        PromiseOrValue::Value(true)
    }
}
