//! The $INTERN launchpad (01-SHARED-INTERFACE.md 1.3, section 9.5).
//!
//! Anyone registered launches a new memecoin; anyone registered buys it with the pinned USDC and sells
//! it back, against a constant-product curve with virtual reserves. A fee on every trade goes to the
//! coin contract as outside income (`{"income":{"source":"launchpad"}}`), which credits it to the BRAVE
//! pool. If the coin refuses it (the Intern is FIRED), the fee stays here and `forward_fees` can send it
//! later.
//!
//! The coin contract never calls this contract: the Intern never buys a launched coin with pool money.
//! Launched coins live in this contract's ledger (not separate NEP-141 contracts).

#![forbid(unsafe_code)]

use near_contract_standards::fungible_token::core::ext_ft_core;
use near_sdk::json_types::U128;
use near_sdk::serde::Deserialize;
use near_sdk::serde_json::{self, json};
use near_sdk::store::LookupMap;
use near_sdk::{
    assert_one_yocto, env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError, PromiseOrValue,
};

/// `PROPOSED` (01 1.3): a virtual 1,000 USDC against 1,000,000,000 tokens with 6 decimals.
pub const VIRTUAL_USDC: u128 = 1_000_000_000;
pub const SUPPLY: u128 = 1_000_000_000_000_000;
/// Any single payment above this ($1 trillion) is refunded, so no sum can ever overflow.
pub const MAX_AMOUNT: u128 = 1_000_000_000_000_000_000;
/// `PROPOSED`: 1% of each trade.
pub const FEE_BPS: u128 = 100;
/// Registration: storage for up to `MAX_BALANCES` balances and `MAX_LAUNCHES` launches.
pub const REGISTRATION: NearToken = NearToken::from_millinear(50);
pub const MAX_BALANCES: u32 = 20;
pub const MAX_LAUNCHES: u32 = 5;
const GAS_FEE: Gas = Gas::from_tgas(60);
const GAS_ON_FEE: Gas = Gas::from_tgas(5);
const GAS_PAY: Gas = Gas::from_tgas(10);
const GAS_ON_SOLD: Gas = Gas::from_tgas(10);

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LaunchRec {
    pub id: u64,
    pub name: String,
    pub symbol: String,
    pub creator: AccountId,
    pub created_at: u64,
    /// Tokens out of the curve, 6 decimals.
    pub sold: u128,
    /// Real USDC in the curve.
    pub reserve: u128,
}

#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Member {
    pub balances: u32,
    pub launches: u32,
}

#[near(serializers = [json])]
pub struct LaunchView {
    pub id: u64,
    pub name: String,
    pub symbol: String,
    pub creator: AccountId,
    pub created_at: u64,
    pub sold: U128,
    pub usdc_reserve: U128,
    /// USDC (6 decimals) for one whole token at the margin.
    pub price_e6: U128,
}

#[near(serializers = [json])]
pub struct Quote {
    pub out: U128,
    pub fee: U128,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct BuyMsg {
    buy: BuyBody,
}
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct BuyBody {
    token_id: u64,
    min_out: U128,
}

/// `ceil(a / b)`
fn div_up(a: u128, b: u128) -> u128 {
    a / b + u128::from(!a.is_multiple_of(b))
}

/// Tokens out for `net_in` USDC. k = x·y never goes down (every rounding favours the curve).
/// None when the numbers are too large to compute (refused, never an overflow).
pub fn buy_out(l: &LaunchRec, net_in: u128) -> Option<u128> {
    let (x, y) = (VIRTUAL_USDC.checked_add(l.reserve)?, SUPPLY - l.sold);
    let k = x.checked_mul(y)?;
    Some(y - div_up(k, x.checked_add(net_in)?))
}

/// The fee on `amount`, rounded down, without overflow: floor(a·f/10⁴) = (a/10⁴)·f + floor((a mod 10⁴)·f/10⁴).
pub fn fee_of(amount: u128) -> u128 {
    amount / 10_000 * FEE_BPS + (amount % 10_000) * FEE_BPS / 10_000
}

/// USDC out (before the fee) for `tokens_in` tokens.
/// `tokens_in` must be at most `l.sold`. None when the numbers are too large to compute.
pub fn sell_out(l: &LaunchRec, tokens_in: u128) -> Option<u128> {
    let (x, y) = (VIRTUAL_USDC.checked_add(l.reserve)?, SUPPLY - l.sold);
    let k = x.checked_mul(y)?;
    Some(x - div_up(k, y.checked_add(tokens_in)?))
}

fn event(name: &str, data: serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({"standard": "intern-launch", "version": "1.0.0", "event": name, "data": [data]})
    ));
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Launchpad {
    usdc: AccountId,
    coin: AccountId,
    launches: LookupMap<u64, LaunchRec>,
    next_id: u64,
    symbols: LookupMap<String, u64>,
    balances: LookupMap<(u64, AccountId), u128>,
    members: LookupMap<AccountId, Member>,
    fees_sent: u128,
    /// Fees the coin did not take (the Intern was FIRED), to forward later.
    fees_kept: u128,
}

impl Launchpad {
    fn member(&self, who: &AccountId) -> Member {
        *self
            .members
            .get(who)
            .unwrap_or_else(|| env::panic_str("register first (storage_deposit)"))
    }

    fn launch_rec(&self, id: u64) -> LaunchRec {
        self.launches
            .get(&id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("no such launch"))
    }

    fn balance(&self, id: u64, who: &AccountId) -> u128 {
        self.balances.get(&(id, who.clone())).copied().unwrap_or(0)
    }

    /// Adds to a balance, counting a new entry against the account's registration.
    fn credit(&mut self, id: u64, who: &AccountId, amount: u128) -> bool {
        let key = (id, who.clone());
        let now = self.balances.get(&key).copied();
        if now.is_none() {
            let mut m = self.member(who);
            if m.balances >= MAX_BALANCES {
                return false;
            }
            m.balances += 1;
            self.members.insert(who.clone(), m);
        }
        self.balances.insert(key, now.unwrap_or(0) + amount);
        true
    }

    fn debit(&mut self, id: u64, who: &AccountId, amount: u128) {
        let key = (id, who.clone());
        let now = self.balances.get(&key).copied().unwrap_or(0);
        require!(amount > 0 && amount <= now, "not that many tokens");
        if now == amount {
            self.balances.remove(&key);
            let mut m = self.member(who);
            m.balances -= 1;
            self.members.insert(who.clone(), m);
        } else {
            self.balances.insert(key, now - amount);
        }
    }

    fn send_fee(&mut self, fee: u128) {
        if fee == 0 {
            return;
        }
        ext_ft_core::ext(self.usdc.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FEE)
            .ft_transfer_call(
                self.coin.clone(),
                U128(fee),
                Some("$INTERN launchpad fee".into()),
                json!({"income": {"source": "launchpad"}}).to_string(),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_FEE)
                    .on_fee(U128(fee)),
            )
            .detach();
    }

    fn view(l: &LaunchRec) -> LaunchView {
        let (x, y) = (VIRTUAL_USDC + l.reserve, SUPPLY - l.sold);
        LaunchView {
            id: l.id,
            name: l.name.clone(),
            symbol: l.symbol.clone(),
            creator: l.creator.clone(),
            created_at: l.created_at,
            sold: U128(l.sold),
            usdc_reserve: U128(l.reserve),
            price_e6: U128(x * 1_000_000 / y),
        }
    }
}

#[near]
impl Launchpad {
    #[init]
    pub fn new(usdc: AccountId, coin: AccountId) -> Self {
        Launchpad {
            usdc,
            coin,
            launches: LookupMap::new(b"l"),
            next_id: 1,
            symbols: LookupMap::new(b"s"),
            balances: LookupMap::new(b"b"),
            members: LookupMap::new(b"m"),
            fees_sent: 0,
            fees_kept: 0,
        }
    }

    /// NEP-145 registration: 0.05 NEAR (the rest is refunded), once.
    #[payable]
    pub fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> near_sdk::serde_json::Value {
        let _ = registration_only;
        let who = account_id.unwrap_or_else(env::predecessor_account_id);
        let paid = env::attached_deposit();
        if self.members.contains_key(&who) {
            if !paid.is_zero() {
                Promise::new(env::predecessor_account_id())
                    .transfer(paid)
                    .detach();
            }
        } else {
            require!(paid >= REGISTRATION, "attach 0.05 NEAR to register");
            self.members.insert(who.clone(), Member::default());
            if paid > REGISTRATION {
                Promise::new(env::predecessor_account_id())
                    .transfer(paid.saturating_sub(REGISTRATION))
                    .detach();
            }
        }
        json!({"total": U128(REGISTRATION.as_yoctonear()), "available": "0"})
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<near_sdk::serde_json::Value> {
        self.members
            .contains_key(&account_id)
            .then(|| json!({"total": U128(REGISTRATION.as_yoctonear()), "available": "0"}))
    }

    pub fn storage_balance_bounds(&self) -> near_sdk::serde_json::Value {
        json!({"min": U128(REGISTRATION.as_yoctonear()), "max": U128(REGISTRATION.as_yoctonear())})
    }

    /// Launches a new memecoin: `name` 1–32 bytes, `symbol` 2–8 of A–Z and 0–9, not taken. Returns its id.
    pub fn launch(&mut self, name: String, symbol: String) -> u64 {
        let who = env::predecessor_account_id();
        let mut m = self.member(&who);
        require!(m.launches < MAX_LAUNCHES, "at most 5 launches per account");
        require!((1..=32).contains(&name.len()), "name: 1 to 32 bytes");
        require!(
            (2..=8).contains(&symbol.len())
                && symbol
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()),
            "symbol: 2 to 8 of A-Z, 0-9"
        );
        require!(!self.symbols.contains_key(&symbol), "that symbol is taken");
        let id = self.next_id;
        self.next_id += 1;
        m.launches += 1;
        self.members.insert(who.clone(), m);
        self.symbols.insert(symbol.clone(), id);
        self.launches.insert(
            id,
            LaunchRec {
                id,
                name: name.clone(),
                symbol: symbol.clone(),
                creator: who.clone(),
                created_at: env::block_timestamp_ms(),
                sold: 0,
                reserve: 0,
            },
        );
        event(
            "launched",
            json!({"token_id": id, "name": name, "symbol": symbol, "creator": who}),
        );
        id
    }

    /// Buying: the USDC token calls this after `ft_transfer_call(launchpad, amount, '{"buy":{"token_id":N,"min_out":"…"}}')`.
    /// Anything wrong (another token, an unknown launch, too few tokens out, an unregistered buyer) is
    /// refunded in full.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let refund = PromiseOrValue::Value(amount);
        if env::predecessor_account_id() != self.usdc
            || amount.0 == 0
            || amount.0 > MAX_AMOUNT
            || !self.members.contains_key(&sender_id)
        {
            return refund;
        }
        let Ok(BuyMsg { buy }) = serde_json::from_str::<BuyMsg>(&msg) else {
            return refund;
        };
        let Some(mut l) = self.launches.get(&buy.token_id).cloned() else {
            return refund;
        };
        let fee = fee_of(amount.0);
        let net = amount.0 - fee;
        let out = buy_out(&l, net).unwrap_or(0);
        if out == 0 || out < buy.min_out.0 || !self.credit(l.id, &sender_id, out) {
            env::log_str("buy refunded: too few tokens out, or too many balances for this account");
            return refund;
        }
        l.sold += out;
        l.reserve += net;
        self.launches.insert(l.id, l.clone());
        self.send_fee(fee);
        event(
            "bought",
            json!({"token_id": l.id, "account_id": sender_id, "usdc": amount, "tokens": U128(out), "fee": U128(fee)}),
        );
        PromiseOrValue::Value(U128(0))
    }

    /// Sells `amount` tokens back to the curve, 1 yocto. Pays the USDC out minus the fee, at least `min_out`.
    #[payable]
    pub fn sell(&mut self, token_id: u64, amount: U128, min_out: U128) -> Promise {
        assert_one_yocto();
        let who = env::predecessor_account_id();
        let mut l = self.launch_rec(token_id);
        require!(amount.0 <= l.sold, "more than the curve has sold");
        let gross = sell_out(&l, amount.0).unwrap_or_else(|| env::panic_str("too large"));
        let fee = fee_of(gross);
        let net = gross - fee;
        require!(net > 0 && net >= min_out.0, "less USDC out than min_out");
        self.debit(token_id, &who, amount.0);
        l.sold -= amount.0;
        l.reserve -= gross;
        self.launches.insert(token_id, l);
        ext_ft_core::ext(self.usdc.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_PAY)
            .ft_transfer(
                who.clone(),
                U128(net),
                Some("$INTERN launchpad sale".into()),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_SOLD)
                    .on_sold(who, token_id, amount, U128(gross), U128(fee)),
            )
    }

    /// Moves tokens to another registered account, 1 yocto.
    #[payable]
    pub fn transfer(&mut self, token_id: u64, receiver_id: AccountId, amount: U128) {
        assert_one_yocto();
        let who = env::predecessor_account_id();
        require!(receiver_id != who, "send to someone else");
        self.launch_rec(token_id);
        self.member(&receiver_id);
        self.debit(token_id, &who, amount.0);
        require!(
            self.credit(token_id, &receiver_id, amount.0),
            "the receiver holds too many different tokens"
        );
    }

    /// Anyone: sends the fees the coin refused earlier (when the Intern was FIRED), once it takes them.
    pub fn forward_fees(&mut self) {
        let fee = std::mem::take(&mut self.fees_kept);
        require!(fee > 0, "no fees waiting");
        self.send_fee(fee);
    }

    #[private]
    pub fn on_fee(&mut self, fee: U128) {
        let used = match env::promise_result_checked(0, 64) {
            Ok(b) => serde_json::from_slice::<U128>(&b)
                .map(|u| u.0.min(fee.0))
                .unwrap_or(0),
            Err(_) => 0,
        };
        self.fees_sent += used;
        self.fees_kept += fee.0 - used;
    }

    /// A sale's payout failed: the tokens and the curve go back as they were.
    #[private]
    pub fn on_sold(
        &mut self,
        who: AccountId,
        token_id: u64,
        amount: U128,
        gross: U128,
        fee: U128,
    ) -> bool {
        if !matches!(
            env::promise_result_checked(0, 64),
            Err(PromiseError::Failed)
        ) {
            self.send_fee(fee.0);
            event(
                "sold",
                json!({"token_id": token_id, "account_id": who, "tokens": amount, "usdc": U128(gross.0 - fee.0), "fee": fee}),
            );
            return true;
        }
        let mut l = self.launch_rec(token_id);
        l.sold += amount.0;
        l.reserve += gross.0;
        self.launches.insert(token_id, l);
        if !self.credit(token_id, &who, amount.0) {
            // Cannot fail: the entry was just removed and the count with it.
            env::panic_str("could not put the tokens back");
        }
        env::log_str("the sale's payout failed: tokens put back");
        false
    }

    // ----- views

    pub fn get_launches(&self, from: Option<u64>, limit: Option<u32>) -> Vec<LaunchView> {
        let last = self.next_id - 1;
        let start = from.map_or(last, |f| f.min(last));
        let n = limit.map_or(50, |l| l.clamp(1, 100)) as u64;
        (start.saturating_sub(n - 1).max(1)..=start)
            .rev()
            .filter_map(|i| self.launches.get(&i))
            .map(Self::view)
            .collect()
    }

    pub fn get_launch(&self, token_id: u64) -> Option<LaunchView> {
        self.launches.get(&token_id).map(Self::view)
    }

    pub fn get_balance(&self, token_id: u64, account_id: AccountId) -> U128 {
        U128(self.balance(token_id, &account_id))
    }

    /// `side` "BUY": `amount` is USDC in, `out` tokens. "SELL": `amount` is tokens in, `out` USDC after the fee.
    pub fn get_quote(&self, token_id: u64, side: String, amount: U128) -> Quote {
        let l = self.launch_rec(token_id);
        match side.as_str() {
            "BUY" => {
                let fee = fee_of(amount.0);
                Quote {
                    out: U128(
                        buy_out(&l, amount.0 - fee).unwrap_or_else(|| env::panic_str("too large")),
                    ),
                    fee: U128(fee),
                }
            }
            "SELL" => {
                require!(amount.0 <= l.sold, "more than the curve has sold");
                let gross = sell_out(&l, amount.0).unwrap_or_else(|| env::panic_str("too large"));
                let fee = fee_of(gross);
                Quote {
                    out: U128(gross - fee),
                    fee: U128(fee),
                }
            }
            _ => env::panic_str("side is BUY or SELL"),
        }
    }

    pub fn get_info(&self) -> near_sdk::serde_json::Value {
        json!({"usdc": self.usdc, "coin": self.coin, "fee_bps": FEE_BPS as u64, "virtual_usdc": U128(VIRTUAL_USDC), "supply": U128(SUPPLY),
               "fees_sent": U128(self.fees_sent), "fees_kept": U128(self.fees_kept), "launches": self.next_id - 1})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn ctx(caller: &str, deposit: NearToken) {
        testing_env!(VMContextBuilder::new()
            .current_account_id("launch.test".parse().unwrap())
            .predecessor_account_id(caller.parse().unwrap())
            .attached_deposit(deposit)
            .build());
    }

    fn setup() -> (Launchpad, u64) {
        ctx("owner.test", NearToken::from_yoctonear(0));
        let mut p = Launchpad::new("usdc.test".parse().unwrap(), "coin.test".parse().unwrap());
        for who in ["alice.test", "bob.test"] {
            ctx(who, REGISTRATION);
            p.storage_deposit(None, None);
        }
        ctx("alice.test", NearToken::from_yoctonear(0));
        let id = p.launch("Stamp Coin".into(), "STAMP".into());
        (p, id)
    }

    fn buy(p: &mut Launchpad, who: &str, id: u64, usdc: u128, min_out: u128) -> u128 {
        ctx("usdc.test", NearToken::from_yoctonear(0));
        match p.ft_on_transfer(
            who.parse().unwrap(),
            U128(usdc),
            json!({"buy": {"token_id": id, "min_out": U128(min_out)}}).to_string(),
        ) {
            PromiseOrValue::Value(v) => v.0,
            _ => panic!(),
        }
    }

    #[test]
    fn buy_then_sell_back_returns_less_than_paid_and_the_curve_never_owes() {
        let (mut p, id) = setup();
        assert_eq!(buy(&mut p, "bob.test", id, 100_000_000, 0), 0, "kept");
        let got = p.get_balance(id, "bob.test".parse().unwrap()).0;
        // $99 (after the 1% fee) into a virtual $1,000: about 9% of the supply.
        assert!(
            got > 89_000_000_000_000 && got < 91_000_000_000_000,
            "{got}"
        );
        let l = p.get_launch(id).unwrap();
        assert_eq!(l.usdc_reserve, U128(99_000_000));
        let q = p.get_quote(id, "SELL".into(), U128(got));
        assert!(q.out.0 < 99_000_000 && q.out.0 > 97_000_000, "{}", q.out.0);
        ctx("bob.test", NearToken::from_yoctonear(1));
        let _ = p.sell(id, U128(got), U128(q.out.0));
        let l = p.get_launch(id).unwrap();
        assert_eq!(l.sold, U128(0));
        assert!(
            l.usdc_reserve.0 < 1_000,
            "only rounding dust stays: {}",
            l.usdc_reserve.0
        );
    }

    #[test]
    fn refunds() {
        let (mut p, id) = setup();
        assert_eq!(
            buy(&mut p, "carol.test", id, 10_000_000, 0),
            10_000_000,
            "unregistered"
        );
        assert_eq!(
            buy(&mut p, "bob.test", id + 1, 10_000_000, 0),
            10_000_000,
            "no such launch"
        );
        assert_eq!(
            buy(&mut p, "bob.test", id, 10_000_000, u128::MAX),
            10_000_000,
            "min_out not met"
        );
        ctx("junk.test", NearToken::from_yoctonear(0));
        assert!(matches!(
            p.ft_on_transfer("bob.test".parse().unwrap(), U128(5), "{}".into()),
            PromiseOrValue::Value(U128(5))
        ));
    }

    #[test]
    fn huge_numbers_are_refused_not_overflowed() {
        let (mut p, id) = setup();
        assert_eq!(
            fee_of(u128::MAX),
            u128::MAX / 10_000 * FEE_BPS + (u128::MAX % 10_000) * FEE_BPS / 10_000
        );
        assert_eq!(
            buy(&mut p, "bob.test", id, u128::MAX, 0),
            u128::MAX,
            "above $1 trillion: refunded in full"
        );
        let l = p.launches.get(&id).cloned().unwrap();
        assert_eq!(buy_out(&l, u128::MAX), None);
        assert_eq!(p.get_launch(id).unwrap().sold, U128(0));
    }

    #[test]
    #[should_panic(expected = "that symbol is taken")]
    fn symbols_are_unique() {
        let (mut p, _) = setup();
        ctx("bob.test", NearToken::from_yoctonear(0));
        p.launch("Another".into(), "STAMP".into());
    }

    #[test]
    fn prices_rise_as_people_buy() {
        let (mut p, id) = setup();
        let before = p.get_launch(id).unwrap().price_e6.0;
        buy(&mut p, "bob.test", id, 500_000_000, 0);
        assert!(p.get_launch(id).unwrap().price_e6.0 > before);
    }
}
