//! The $INTERN sticker NFTs (01-SHARED-INTERFACE.md 1.3, section 9.5): NEP-171 with metadata (NEP-177)
//! and enumeration (NEP-181).
//!
//! - Only the coin contract (`minter`) mints, after it has checked the claim. The NEAR it attaches pays
//!   the token's storage; what is left goes back to the claimer (the token's receiver).
//! - Boss badges (`badge:<account>`) cannot be transferred: they record when a boss joined. The sixteen
//!   originals (`original:<CODE>`) and goal stickers (`goal:<fill>:<account>`) can.
//! - No approvals (NEP-178): nobody but the owner moves a token.

#![forbid(unsafe_code)]

use near_contract_standards::non_fungible_token::core::{
    NonFungibleTokenCore, NonFungibleTokenResolver,
};
use near_contract_standards::non_fungible_token::enumeration::NonFungibleTokenEnumeration;
use near_contract_standards::non_fungible_token::metadata::{
    NFTContractMetadata, NonFungibleTokenMetadataProvider, TokenMetadata, NFT_METADATA_SPEC,
};
use near_contract_standards::non_fungible_token::{NonFungibleToken, Token, TokenId};
use near_sdk::json_types::U128;
use near_sdk::store::{LazyOption, LookupSet};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, PanicOnDefault, PromiseOrValue};
use std::collections::HashMap;

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Owners,
    Metadata,
    Enumeration,
    Contract,
    Fixed,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Stickers {
    tokens: NonFungibleToken,
    metadata: LazyOption<NFTContractMetadata>,
    minter: AccountId,
    /// Token ids that cannot be transferred (boss badges).
    fixed: LookupSet<TokenId>,
}

#[near]
impl Stickers {
    #[init]
    pub fn new(minter: AccountId) -> Self {
        let metadata = NFTContractMetadata {
            spec: NFT_METADATA_SPEC.to_string(),
            name: "$INTERN stickers".to_string(),
            symbol: "INTERNSTK".to_string(),
            icon: None,
            base_uri: None,
            reference: None,
            reference_hash: None,
        };
        Stickers {
            tokens: NonFungibleToken::new(
                Key::Owners,
                minter.clone(),
                Some(Key::Metadata),
                Some(Key::Enumeration),
                None::<Key>,
            ),
            metadata: LazyOption::new(Key::Contract, Some(metadata)),
            minter,
            fixed: LookupSet::new(Key::Fixed),
        }
    }

    /// The coin contract only. `transferable: false` makes the token stay with its owner for good.
    #[payable]
    pub fn mint(
        &mut self,
        token_id: TokenId,
        receiver_id: AccountId,
        title: String,
        description: String,
        extra: Option<String>,
        transferable: bool,
    ) -> Token {
        require!(
            env::predecessor_account_id() == self.minter,
            "only the $INTERN coin contract mints stickers"
        );
        if !transferable {
            self.fixed.insert(token_id.clone());
        }
        let meta = TokenMetadata {
            title: Some(title),
            description: Some(description),
            media: None,
            media_hash: None,
            copies: Some(1),
            issued_at: Some(env::block_timestamp_ms().to_string()),
            expires_at: None,
            starts_at: None,
            updated_at: None,
            extra,
            reference: None,
            reference_hash: None,
        };
        self.tokens.internal_mint_with_refund(
            token_id,
            receiver_id.clone(),
            Some(meta),
            Some(receiver_id),
        )
    }

    /// Whether a token can be transferred (false for boss badges).
    pub fn is_transferable(&self, token_id: TokenId) -> bool {
        !self.fixed.contains(&token_id)
    }
}

#[near]
impl NonFungibleTokenCore for Stickers {
    #[payable]
    fn nft_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
    ) {
        require!(
            !self.fixed.contains(&token_id),
            "a boss badge cannot be transferred"
        );
        self.tokens
            .nft_transfer(receiver_id, token_id, approval_id, memo)
    }

    #[payable]
    fn nft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<bool> {
        require!(
            !self.fixed.contains(&token_id),
            "a boss badge cannot be transferred"
        );
        self.tokens
            .nft_transfer_call(receiver_id, token_id, approval_id, memo, msg)
    }

    fn nft_token(&self, token_id: TokenId) -> Option<Token> {
        self.tokens.nft_token(token_id)
    }
}

#[near]
impl NonFungibleTokenResolver for Stickers {
    #[private]
    fn nft_resolve_transfer(
        &mut self,
        previous_owner_id: AccountId,
        receiver_id: AccountId,
        token_id: TokenId,
        approved_account_ids: Option<HashMap<AccountId, u64>>,
    ) -> bool {
        self.tokens.nft_resolve_transfer(
            previous_owner_id,
            receiver_id,
            token_id,
            approved_account_ids,
        )
    }
}

#[near]
impl NonFungibleTokenEnumeration for Stickers {
    fn nft_total_supply(&self) -> U128 {
        self.tokens.nft_total_supply()
    }
    fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.tokens.nft_tokens(from_index, limit)
    }
    fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        self.tokens.nft_supply_for_owner(account_id)
    }
    fn nft_tokens_for_owner(
        &self,
        account_id: AccountId,
        from_index: Option<U128>,
        limit: Option<u64>,
    ) -> Vec<Token> {
        self.tokens
            .nft_tokens_for_owner(account_id, from_index, limit)
    }
}

#[near]
impl NonFungibleTokenMetadataProvider for Stickers {
    fn nft_metadata(&self) -> NFTContractMetadata {
        self.metadata.get().clone().expect("set at init")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{testing_env, NearToken};

    fn ctx(caller: &str, deposit: NearToken) {
        testing_env!(VMContextBuilder::new()
            .current_account_id("stickers.test".parse().unwrap())
            .predecessor_account_id(caller.parse().unwrap())
            .attached_deposit(deposit)
            .build());
    }

    fn setup() -> Stickers {
        ctx("coin.test", NearToken::from_yoctonear(0));
        Stickers::new("coin.test".parse().unwrap())
    }

    #[test]
    fn the_coin_mints_and_originals_move() {
        let mut s = setup();
        ctx("coin.test", NearToken::from_millinear(10));
        s.mint(
            "original:FIRED".into(),
            "alice.test".parse().unwrap(),
            "First of its kind: FIRED".into(),
            "One of sixteen.".into(),
            None,
            true,
        );
        assert_eq!(
            s.nft_token("original:FIRED".into())
                .unwrap()
                .owner_id
                .as_str(),
            "alice.test"
        );
        ctx("alice.test", NearToken::from_yoctonear(1));
        s.nft_transfer(
            "bob.test".parse().unwrap(),
            "original:FIRED".into(),
            None,
            None,
        );
        assert_eq!(
            s.nft_token("original:FIRED".into())
                .unwrap()
                .owner_id
                .as_str(),
            "bob.test"
        );
        assert_eq!(s.nft_total_supply(), U128(1));
    }

    #[test]
    #[should_panic(expected = "a boss badge cannot be transferred")]
    fn badges_stay() {
        let mut s = setup();
        ctx("coin.test", NearToken::from_millinear(10));
        s.mint(
            "badge:alice.test".into(),
            "alice.test".parse().unwrap(),
            "Boss badge".into(),
            "Since round 3.".into(),
            None,
            false,
        );
        assert!(!s.is_transferable("badge:alice.test".into()));
        ctx("alice.test", NearToken::from_yoctonear(1));
        s.nft_transfer(
            "bob.test".parse().unwrap(),
            "badge:alice.test".into(),
            None,
            None,
        );
    }

    #[test]
    #[should_panic(expected = "only the $INTERN coin contract mints stickers")]
    fn only_the_coin_mints() {
        let mut s = setup();
        ctx("mallory.test", NearToken::from_millinear(10));
        s.mint(
            "original:FIRED".into(),
            "mallory.test".parse().unwrap(),
            "x".into(),
            "x".into(),
            None,
            true,
        );
    }

    #[test]
    #[should_panic(expected = "Must attach")]
    fn a_mint_without_storage_is_refused() {
        let mut s = setup();
        ctx("coin.test", NearToken::from_yoctonear(0));
        s.mint(
            "original:FIRED".into(),
            "alice.test".parse().unwrap(),
            "x".into(),
            "x".into(),
            None,
            true,
        );
    }
}
