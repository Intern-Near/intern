//! STAND-IN: test dollars for NEAR testnet (Engine 1 brief, step 3).
//!
//! A plain NEP-141 token with 6 decimals, built from near-contract-standards, plus an open `mint`
//! so anyone can get test dollars. It is worth nothing and the README says so.
//!
//! Mint into a registered account: call `storage_deposit` first (NEP-145), then
//! `mint({ account_id, amount })`. One call mints at most 1,000,000 test dollars.

#![forbid(unsafe_code)]

use near_contract_standards::fungible_token::events::FtMint;
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::U128;
use near_sdk::{
    near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, PromiseOrValue,
};

/// The most one `mint` call creates: $1,000,000 with 6 decimals.
pub const MAX_MINT: u128 = 1_000_000_000_000;

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Accounts,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockUsdc {
    token: FungibleToken,
}

#[near]
impl MockUsdc {
    #[init]
    pub fn new() -> Self {
        Self {
            token: FungibleToken::new(Key::Accounts),
        }
    }

    /// STAND-IN ONLY. Open to anyone: mints test dollars into a registered account.
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        require!(
            amount.0 > 0 && amount.0 <= MAX_MINT,
            "amount must be between 1 and 1000000000000 (one million test dollars)"
        );
        self.token.internal_deposit(&account_id, amount.0);
        FtMint {
            owner_id: &account_id,
            amount,
            memo: Some("test dollars, worth nothing"),
        }
        .emit();
    }
    /// STAND-IN ONLY. Burns the caller's own test dollars. The coin contract uses it on testnet to
    /// remove the dollars a reported loss took out of the pool (01-SHARED-INTERFACE.md section 14.12).
    pub fn burn(&mut self, amount: U128) {
        require!(amount.0 > 0, "amount must be above 0");
        let who = near_sdk::env::predecessor_account_id();
        self.token.internal_withdraw(&who, amount.0);
        near_contract_standards::fungible_token::events::FtBurn {
            owner_id: &who,
            amount,
            memo: Some("test dollars burned"),
        }
        .emit();
    }
}

#[near]
impl FungibleTokenCore for MockUsdc {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for MockUsdc {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        self.token
            .internal_ft_resolve_transfer(&sender_id, receiver_id, amount)
            .0
            .into()
    }
}

#[near]
impl StorageManagement for MockUsdc {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        // `force` burns the balance, as the standard allows; the sandbox tests use it to make a
        // payout fail on purpose.
        self.token.internal_storage_unregister(force).is_some()
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for MockUsdc {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "Mock USDC (testnet stand-in, worth nothing)".to_string(),
            symbol: "mUSDC".to_string(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 6,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn ctx(caller: &str, deposit: NearToken) {
        testing_env!(VMContextBuilder::new()
            .current_account_id("usdc.test".parse().unwrap())
            .predecessor_account_id(caller.parse().unwrap())
            .attached_deposit(deposit)
            .build());
    }

    #[test]
    fn anyone_can_mint_into_a_registered_account() {
        ctx("alice.test", NearToken::from_millinear(10));
        let mut c = MockUsdc::new();
        c.storage_deposit(None, None);
        ctx("bob.test", NearToken::from_yoctonear(0));
        c.mint("alice.test".parse().unwrap(), U128(5_000_000));
        assert_eq!(
            c.ft_balance_of("alice.test".parse().unwrap()),
            U128(5_000_000)
        );
        assert_eq!(c.ft_total_supply(), U128(5_000_000));
        assert_eq!(c.ft_metadata().decimals, 6);
    }

    #[test]
    fn burn_takes_from_the_caller_only() {
        ctx("alice.test", NearToken::from_millinear(10));
        let mut c = MockUsdc::new();
        c.storage_deposit(None, None);
        c.mint("alice.test".parse().unwrap(), U128(5_000_000));
        c.burn(U128(2_000_000));
        assert_eq!(
            c.ft_balance_of("alice.test".parse().unwrap()),
            U128(3_000_000)
        );
        assert_eq!(c.ft_total_supply(), U128(3_000_000));
    }

    #[test]
    #[should_panic(expected = "doesn't have enough balance")]
    fn cannot_burn_more_than_held() {
        ctx("alice.test", NearToken::from_millinear(10));
        let mut c = MockUsdc::new();
        c.storage_deposit(None, None);
        c.burn(U128(1));
    }

    #[test]
    #[should_panic(expected = "is not registered")]
    fn minting_needs_registration() {
        ctx("alice.test", NearToken::from_yoctonear(0));
        let mut c = MockUsdc::new();
        c.mint("alice.test".parse().unwrap(), U128(1));
    }

    #[test]
    #[should_panic(expected = "amount must be between")]
    fn one_mint_is_capped() {
        ctx("alice.test", NearToken::from_millinear(10));
        let mut c = MockUsdc::new();
        c.storage_deposit(None, None);
        c.mint("alice.test".parse().unwrap(), U128(MAX_MINT + 1));
    }
}
