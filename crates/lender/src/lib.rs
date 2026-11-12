//! STAND-IN lender for NEAR testnet (01-SHARED-INTERFACE.md 1.3, Engine 1 step 8).
//!
//! Rhea Lend works from a contract on mainnet, but its testnet market only takes tokens its owners
//! listed, not our test dollar. So testnet lends here instead. This contract:
//! - takes the pinned test dollar through `ft_transfer_call` (any `msg`) and credits the sender;
//! - accrues simple interest at a fixed test rate (`rate_bps` a year) on what each account lent;
//! - pays back with `withdraw(amount)` and pays interest with `claim_interest()`. Interest is minted
//!   from the test dollar's open `mint`, so it is worth nothing. It is labelled STAND-IN everywhere.
//!
//! It never runs out of money and never pauses: unlike a real market, it has no borrowers.

#![forbid(unsafe_code)]

use near_contract_standards::fungible_token::core::ext_ft_core;
use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{
    env, ext_contract, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError, PromiseOrValue,
};

const YEAR_MS: u128 = 31_536_000_000;
const GAS_MINT: Gas = Gas::from_tgas(10);
const GAS_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_ON_SENT: Gas = Gas::from_tgas(10);

#[ext_contract(ext_mock_usdc)]
#[allow(dead_code)]
trait MockUsdc {
    fn mint(&mut self, account_id: AccountId, amount: U128);
}

#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Deposit {
    pub principal: u128,
    /// Accrued and not yet claimed.
    pub interest: u128,
    pub since_ms: u64,
}

#[near(serializers = [json])]
pub struct AccountView {
    pub principal: U128,
    pub interest: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Lender {
    usdc: AccountId,
    rate_bps: u32,
    accounts: LookupMap<AccountId, Deposit>,
    /// Test dollars this contract holds, by its own count.
    held: u128,
}

fn now_ms() -> u64 {
    env::block_timestamp_ms()
}

impl Lender {
    fn accrued(&self, d: Deposit, now: u64) -> Deposit {
        let elapsed = now.saturating_sub(d.since_ms) as u128;
        let add = d
            .principal
            .saturating_mul(self.rate_bps as u128)
            .saturating_mul(elapsed)
            / (10_000 * YEAR_MS);
        Deposit {
            principal: d.principal,
            interest: d.interest + add,
            since_ms: now,
        }
    }

    fn load(&self, who: &AccountId) -> Deposit {
        let d = self.accounts.get(who).copied().unwrap_or(Deposit {
            since_ms: now_ms(),
            ..Default::default()
        });
        self.accrued(d, now_ms())
    }

    /// Sends `amount` to `who`, minting test dollars first if this contract holds too few. `kind` 0:
    /// principal, 1: interest (for the callback to put back on failure).
    fn send(&mut self, who: &AccountId, amount: u128, kind: u8) -> Promise {
        let transfer = ext_ft_core::ext(self.usdc.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_TRANSFER)
            .ft_transfer(who.clone(), U128(amount), Some("STAND-IN lender".into()));
        let first = if self.held < amount {
            let short = amount - self.held;
            self.held = amount;
            ext_mock_usdc::ext(self.usdc.clone())
                .with_static_gas(GAS_MINT)
                .mint(env::current_account_id(), U128(short))
                .then(transfer)
        } else {
            transfer
        };
        first.then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_ON_SENT)
                .on_sent(who.clone(), U128(amount), kind),
        )
    }
}

#[near]
impl Lender {
    #[init]
    pub fn new(usdc: AccountId, rate_bps: u32) -> Self {
        require!(rate_bps <= 10_000, "rate above 100%");
        Lender {
            usdc,
            rate_bps,
            accounts: LookupMap::new(b"a"),
            held: 0,
        }
    }

    /// Lending: the test dollar calls this after `ft_transfer_call(lender, amount, msg)`. Any other
    /// token is refunded in full.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let _ = msg;
        if env::predecessor_account_id() != self.usdc || amount.0 == 0 {
            return PromiseOrValue::Value(amount);
        }
        let mut d = self.load(&sender_id);
        d.principal += amount.0;
        self.accounts.insert(sender_id, d);
        self.held += amount.0;
        PromiseOrValue::Value(U128(0))
    }

    /// Pays back `amount` of what the caller lent. The final value is true when the dollars arrived.
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        let who = env::predecessor_account_id();
        let mut d = self.load(&who);
        require!(
            amount.0 > 0 && amount.0 <= d.principal,
            "not that much lent"
        );
        d.principal -= amount.0;
        self.accounts.insert(who.clone(), d);
        self.send(&who, amount.0, 0)
    }

    /// Pays the caller the interest accrued so far. The final value is the amount that arrived.
    pub fn claim_interest(&mut self) -> PromiseOrValue<U128> {
        let who = env::predecessor_account_id();
        let mut d = self.load(&who);
        let amount = d.interest;
        if amount == 0 {
            return PromiseOrValue::Value(U128(0));
        }
        d.interest = 0;
        self.accounts.insert(who.clone(), d);
        PromiseOrValue::Promise(self.send(&who, amount, 1))
    }

    /// Withdrawal: true or false. Interest: the amount paid (0 on failure). A failed payment is put back.
    #[private]
    pub fn on_sent(
        &mut self,
        who: AccountId,
        amount: U128,
        kind: u8,
    ) -> near_sdk::serde_json::Value {
        let ok = !matches!(
            env::promise_result_checked(0, 64),
            Err(PromiseError::Failed)
        );
        if ok {
            self.held = self.held.saturating_sub(amount.0);
        } else {
            let mut d = self.load(&who);
            if kind == 0 {
                d.principal += amount.0;
            } else {
                d.interest += amount.0;
            }
            self.accounts.insert(who, d);
        }
        match (kind, ok) {
            (0, ok) => near_sdk::serde_json::json!(ok),
            (_, true) => near_sdk::serde_json::json!(amount),
            _ => near_sdk::serde_json::json!(U128(0)),
        }
    }

    pub fn get_account(&self, account_id: AccountId) -> AccountView {
        let d = self.load(&account_id);
        AccountView {
            principal: U128(d.principal),
            interest: U128(d.interest),
        }
    }

    /// The fixed test rate, in bps a year. STAND-IN.
    pub fn get_rate(&self) -> u32 {
        self.rate_bps
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn ctx(now_ms: u64, caller: &str) {
        testing_env!(VMContextBuilder::new()
            .current_account_id("lender.test".parse().unwrap())
            .predecessor_account_id(caller.parse().unwrap())
            .block_timestamp(now_ms * 1_000_000)
            .build());
    }

    #[test]
    fn interest_accrues_at_the_test_rate_and_principal_comes_back() {
        ctx(1_000, "lender.test");
        let mut l = Lender::new("usdc.test".parse().unwrap(), 500);
        ctx(1_000, "usdc.test");
        assert!(matches!(
            l.ft_on_transfer(
                "coin.test".parse().unwrap(),
                U128(1_000_000_000),
                String::new()
            ),
            PromiseOrValue::Value(U128(0))
        ));
        ctx(1_000 + YEAR_MS as u64, "anyone.test");
        let a = l.get_account("coin.test".parse().unwrap());
        assert_eq!(
            (a.principal, a.interest),
            (U128(1_000_000_000), U128(50_000_000)),
            "5% of $1,000 in a year"
        );
        ctx(1_000 + YEAR_MS as u64, "coin.test");
        let _ = l.withdraw(U128(400_000_000));
        assert_eq!(
            l.get_account("coin.test".parse().unwrap()).principal,
            U128(600_000_000)
        );
    }

    #[test]
    fn other_tokens_are_refunded() {
        ctx(1_000, "lender.test");
        let mut l = Lender::new("usdc.test".parse().unwrap(), 500);
        ctx(1_000, "junk.test");
        assert!(matches!(
            l.ft_on_transfer("coin.test".parse().unwrap(), U128(5), String::new()),
            PromiseOrValue::Value(U128(5))
        ));
    }

    #[test]
    #[should_panic(expected = "not that much lent")]
    fn cannot_withdraw_more_than_lent() {
        ctx(1_000, "lender.test");
        let mut l = Lender::new("usdc.test".parse().unwrap(), 500);
        ctx(2_000, "coin.test");
        let _ = l.withdraw(U128(1));
    }
}
