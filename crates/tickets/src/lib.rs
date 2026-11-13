//! Interface 1.7, owner's decision (Engine 2's list, item 23): $INTERN's multi-token contract (NEP-245) with a player
//! market.
//!
//! - **Tokens.** One token type per id; the $INTERN coin is the only minter. Today: golden stickers, `golden:<CODE>`
//!   (a player who won a golden sticker by guessing may claim it here, as one unit of its code's type, instead of as a
//!   one-off NFT). Up to 100 of each code exist in all (the coin's cap).
//! - **NEP-245 core.** `mt_transfer`, `mt_batch_transfer` (1 yocto each), `mt_balance_of`, `mt_batch_balance_of`,
//!   `mt_supply`, `mt_batch_supply`, `mt_token`; NEP-297 events `mt_mint` and `mt_transfer` (standard `nep245`,
//!   version `1.0.0`). Not built: `mt_transfer_call` and approvals.
//! - **The market.** A holder lists units of a type at a price in the pinned USDC (`list`, 1 yocto; the units are
//!   held by the contract until sold or `unlist`ed). A buyer pays with `ft_transfer_call(tickets, price × amount,
//!   '{"buy":{"listing_id":N,"amount":"…"}}')`: the units move to the buyer and the USDC goes to the seller. Anything
//!   wrong is refunded. No fee.
//!
//! Registration: none. Storage is paid by the contract (a listing is small; the coin pays 0.02 NEAR per mint).

use near_contract_standards::fungible_token::core::ext_ft_core;
use near_sdk::json_types::U128;
use near_sdk::serde::Deserialize;
use near_sdk::serde_json::{self, json};
use near_sdk::store::LookupMap;
use near_sdk::{
    assert_one_yocto, env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, PromiseOrValue,
};

const GAS_PAY: Gas = Gas::from_tgas(15);
const MAX_ID: usize = 64;
const MAX_LISTINGS_VIEW: u64 = 50;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum Key {
    Balances,
    Supply,
    Meta,
    Listings,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenMeta {
    pub token_id: String,
    pub title: String,
    pub description: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Listing {
    pub id: u64,
    pub seller: AccountId,
    pub token_id: String,
    pub amount: U128,
    pub price_each: U128,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct BuyMsg {
    buy: BuyBody,
}
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct BuyBody {
    listing_id: u64,
    amount: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Tickets {
    minter: AccountId,
    usdc: AccountId,
    /// (account, token id) -> balance
    balances: LookupMap<(AccountId, String), u128>,
    supply: LookupMap<String, u128>,
    meta: LookupMap<String, TokenMeta>,
    listings: LookupMap<u64, Listing>,
    next_listing: u64,
}

fn mt_event(event: &str, data: serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({"standard": "nep245", "version": "1.0.0", "event": event, "data": [data]})
    ));
}

#[near]
impl Tickets {
    #[init]
    pub fn new(minter: AccountId, usdc: AccountId) -> Self {
        Self {
            minter,
            usdc,
            balances: LookupMap::new(Key::Balances),
            supply: LookupMap::new(Key::Supply),
            meta: LookupMap::new(Key::Meta),
            listings: LookupMap::new(Key::Listings),
            next_listing: 1,
        }
    }

    fn bal(&self, who: &AccountId, id: &str) -> u128 {
        self.balances.get(&(who.clone(), id.to_string())).copied().unwrap_or(0)
    }

    fn move_units(&mut self, from: &AccountId, to: &AccountId, id: &str, amount: u128) {
        require!(amount > 0, "amount must be above 0");
        let have = self.bal(from, id);
        require!(have >= amount, "not that many tokens");
        let left = have - amount;
        if left == 0 {
            self.balances.remove(&(from.clone(), id.to_string()));
        } else {
            self.balances.insert((from.clone(), id.to_string()), left);
        }
        let got = self.bal(to, id) + amount;
        self.balances.insert((to.clone(), id.to_string()), got);
    }

    /// The $INTERN coin only: mints `amount` units of `token_id` to `receiver_id` (setting its metadata the first
    /// time). The coin attaches 0.02 NEAR per claim for storage.
    #[payable]
    pub fn mint(&mut self, token_id: String, receiver_id: AccountId, amount: U128, title: String, description: String) {
        require!(env::predecessor_account_id() == self.minter, "only the $INTERN coin contract mints");
        require!(!token_id.is_empty() && token_id.len() <= MAX_ID, "a token id is 1 to 64 characters");
        require!(amount.0 > 0, "amount must be above 0");
        if !self.meta.contains_key(&token_id) {
            self.meta.insert(token_id.clone(), TokenMeta { token_id: token_id.clone(), title, description });
        }
        let got = self.bal(&receiver_id, &token_id) + amount.0;
        self.balances.insert((receiver_id.clone(), token_id.clone()), got);
        let s = self.supply.get(&token_id).copied().unwrap_or(0) + amount.0;
        self.supply.insert(token_id.clone(), s);
        mt_event("mt_mint", json!({"owner_id": receiver_id, "token_ids": [token_id], "amounts": [amount]}));
    }

    /// NEP-245. 1 yocto.
    #[payable]
    pub fn mt_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        approval: Option<(AccountId, u64)>,
        memo: Option<String>,
    ) {
        assert_one_yocto();
        require!(approval.is_none(), "approvals are not built");
        let from = env::predecessor_account_id();
        require!(from != receiver_id, "sender and receiver are the same");
        self.move_units(&from, &receiver_id, &token_id, amount.0);
        mt_event(
            "mt_transfer",
            json!({"old_owner_id": from, "new_owner_id": receiver_id, "token_ids": [token_id], "amounts": [amount], "memo": memo}),
        );
    }

    /// NEP-245. 1 yocto.
    #[payable]
    pub fn mt_batch_transfer(
        &mut self,
        receiver_id: AccountId,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        approvals: Option<Vec<Option<(AccountId, u64)>>>,
        memo: Option<String>,
    ) {
        assert_one_yocto();
        require!(approvals.is_none_or(|a| a.iter().all(|x| x.is_none())), "approvals are not built");
        require!(token_ids.len() == amounts.len() && !token_ids.is_empty(), "token_ids and amounts must match");
        let from = env::predecessor_account_id();
        require!(from != receiver_id, "sender and receiver are the same");
        for (id, a) in token_ids.iter().zip(&amounts) {
            self.move_units(&from, &receiver_id, id, a.0);
        }
        mt_event(
            "mt_transfer",
            json!({"old_owner_id": from, "new_owner_id": receiver_id, "token_ids": token_ids, "amounts": amounts, "memo": memo}),
        );
    }

    pub fn mt_balance_of(&self, account_id: AccountId, token_id: String) -> U128 {
        U128(self.bal(&account_id, &token_id))
    }

    pub fn mt_batch_balance_of(&self, account_id: AccountId, token_ids: Vec<String>) -> Vec<U128> {
        token_ids.iter().map(|id| U128(self.bal(&account_id, id))).collect()
    }

    pub fn mt_supply(&self, token_id: String) -> Option<U128> {
        self.supply.get(&token_id).map(|s| U128(*s))
    }

    pub fn mt_batch_supply(&self, token_ids: Vec<String>) -> Vec<Option<U128>> {
        token_ids.iter().map(|id| self.supply.get(id).map(|s| U128(*s))).collect()
    }

    pub fn mt_token(&self, token_ids: Vec<String>) -> Vec<Option<TokenMeta>> {
        token_ids.iter().map(|id| self.meta.get(id).cloned()).collect()
    }

    // ===== the market ===============================================================================

    /// Lists `amount` units for sale at `price_each` (USDC, 6 decimals). The units are held by the contract. 1 yocto.
    #[payable]
    pub fn list(&mut self, token_id: String, amount: U128, price_each: U128) -> u64 {
        assert_one_yocto();
        require!(price_each.0 > 0, "price must be above 0");
        let seller = env::predecessor_account_id();
        let me = env::current_account_id();
        self.move_units(&seller, &me, &token_id, amount.0);
        let id = self.next_listing;
        self.next_listing += 1;
        self.listings.insert(id, Listing { id, seller: seller.clone(), token_id: token_id.clone(), amount, price_each });
        env::log_str(&format!("listed {} of {token_id} at {} each: listing {id}", amount.0, price_each.0));
        id
    }

    /// Takes the rest of a listing back. Its seller only. 1 yocto.
    #[payable]
    pub fn unlist(&mut self, listing_id: u64) {
        assert_one_yocto();
        let l = self.listings.get(&listing_id).cloned().unwrap_or_else(|| env::panic_str("no such listing"));
        require!(l.seller == env::predecessor_account_id(), "only the seller can take a listing back");
        self.listings.remove(&listing_id);
        let me = env::current_account_id();
        self.move_units(&me, &l.seller, &l.token_id, l.amount.0);
    }

    pub fn get_listings(&self, from: Option<u64>, limit: Option<u64>) -> Vec<Listing> {
        let top = from.unwrap_or(self.next_listing.saturating_sub(1));
        let n = limit.unwrap_or(MAX_LISTINGS_VIEW).min(MAX_LISTINGS_VIEW);
        (1..=top).rev().filter_map(|i| self.listings.get(&i).cloned()).take(n as usize).collect()
    }

    /// Buying: the pinned USDC calls this after `ft_transfer_call(tickets, amount, '{"buy":{"listing_id","amount"}}')`.
    /// Pays the seller, moves the units to the buyer; anything wrong (another token, too little, no such listing,
    /// more than listed) is refunded in full.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        if env::predecessor_account_id() != self.usdc {
            return PromiseOrValue::Value(amount);
        }
        let Ok(BuyMsg { buy }) = serde_json::from_str::<BuyMsg>(&msg) else {
            env::log_str("unknown message: refunded");
            return PromiseOrValue::Value(amount);
        };
        let Some(mut l) = self.listings.get(&buy.listing_id).cloned() else {
            env::log_str("no such listing: refunded");
            return PromiseOrValue::Value(amount);
        };
        let units = buy.amount.0;
        let cost = l.price_each.0.saturating_mul(units);
        if units == 0 || units > l.amount.0 || amount.0 < cost || sender_id == l.seller {
            env::log_str("not that many units, too little paid, or the seller buying: refunded");
            return PromiseOrValue::Value(amount);
        }
        let me = env::current_account_id();
        self.move_units(&me, &sender_id, &l.token_id, units);
        l.amount = U128(l.amount.0 - units);
        if l.amount.0 == 0 {
            self.listings.remove(&l.id);
        } else {
            self.listings.insert(l.id, l.clone());
        }
        mt_event(
            "mt_transfer",
            json!({"old_owner_id": me, "new_owner_id": sender_id, "token_ids": [l.token_id], "amounts": [U128(units)],
                   "memo": format!("bought from listing {} (seller {})", l.id, l.seller)}),
        );
        ext_ft_core::ext(self.usdc.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_PAY)
            .ft_transfer(l.seller.clone(), U128(cost), Some("$INTERN tickets market sale".into()))
            .detach();
        PromiseOrValue::Value(U128(amount.0 - cost))
    }
}

#[cfg(test)]
mod tests;
