//! Interface 1.7, owner's decisions (Engine 2's list, items 13, 14 and 24): NFTs that do something.
//!
//! - **The sixteen originals earn** (item 13). A quarter of every paid trick (`tricks.rs`) is shared equally by the
//!   originals that have been claimed ("first of its kind" stickers, `original:<CODE>`); with none claimed, it goes
//!   to the bounty. Whoever holds an original when claiming gets what it has earned.
//! - **A playbook's NFT carries its coach cut** (item 14). An author of a playbook may mint its NFT
//!   (`playbook:<id>`, 0.02 NEAR, once per playbook). From then on, the playbook's 10% coach cut of a winning
//!   round is kept for whoever holds that NFT, not sent to the authors, so the payout follows the token.
//! - **Career cards** (item 24). Anyone may mint a career card (`career:<n>`, 0.02 NEAR). Its picture is an SVG the
//!   contract draws from the Intern's record (rank, level, rounds, bets, refusals, result); anyone may refresh a
//!   card so it shows the record now. The level is the number of whole weeks the record covers.
//!
//! `claim_nft_earnings(token_id)` asks the sticker contract who holds the token; if it is the caller, what the token
//! has earned becomes the caller's prize (`claim_prizes`). Earnings waiting are USDC held apart from both pools: the
//! books add `get_nft_earnings().owed_total`. State lives under its own storage keys (prefix `e7`): no migration.

use crate::*;
use near_sdk::{borsh, ext_contract};

pub(crate) const KIND_PLAYBOOK: u8 = 4;
pub(crate) const KIND_CAREER: u8 = 5;
const GAS_OWNER: Gas = Gas::from_tgas(15);
const GAS_ON_OWNER: Gas = Gas::from_tgas(20);
const GAS_UPDATE: Gas = Gas::from_tgas(20);

#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EarnState {
    pub owed_total: u128,
    pub paid_total: u128,
    pub careers: u64,
}

#[near(serializers = [json])]
pub struct NftEarning {
    pub token_id: String,
    pub owed: U128,
}

#[near(serializers = [json])]
pub struct NftEarningsView {
    pub owed_total: U128,
    pub paid_total: U128,
    pub tokens: Vec<NftEarning>,
    pub careers_minted: u64,
}

#[near(serializers = [json])]
pub struct CareerView {
    pub rank: Rank,
    pub status: Status,
    pub level: u64,
    pub rounds: u64,
    pub bets: u64,
    pub refusals: u64,
    pub result: wire::I128,
    pub svg: String,
}

fn state() -> EarnState {
    env::storage_read(b"e7s").map_or_else(EarnState::default, |b| {
        borsh::from_slice(&b).unwrap_or_else(|_| env::panic_str("earn state"))
    })
}
fn put_state(s: &EarnState) {
    env::storage_write(b"e7s", &borsh::to_vec(s).unwrap_or_else(|_| env::panic_str("earn state")));
}
fn owed_key(token_id: &str) -> Vec<u8> {
    [b"e7o".as_slice(), token_id.as_bytes()].concat()
}
fn owed(token_id: &str) -> u128 {
    env::storage_read(&owed_key(token_id)).map_or(0, |b| u128::from_le_bytes(b.try_into().unwrap_or([0; 16])))
}
fn set_owed(token_id: &str, v: u128) {
    if v == 0 {
        env::storage_remove(&owed_key(token_id));
    } else {
        env::storage_write(&owed_key(token_id), &v.to_le_bytes());
    }
}
fn minted_key(pid: u64) -> Vec<u8> {
    [b"e7p".as_slice(), &pid.to_le_bytes()].concat()
}
/// Whether playbook `pid` has its NFT (minted or being minted).
pub(crate) fn playbook_nft(pid: u64) -> bool {
    env::storage_has_key(&minted_key(pid))
}

/// The card's picture: a small SVG with the record, as a `data:` URI.
fn career_svg(rank: &str, status: &str, level: u64, rounds: u64, bets: u64, refusals: u64, result: &str) -> String {
    let svg = format!(
        "<svg xmlns='http://www.w3.org/2000/svg' width='400' height='400' viewBox='0 0 400 400'>\
<rect width='400' height='400' rx='24' fill='#fff6b8'/><rect x='16' y='16' width='368' height='368' rx='16' fill='none' stroke='#1b1b1b' stroke-width='4'/>\
<text x='200' y='70' font-family='monospace' font-size='28' text-anchor='middle' fill='#1b1b1b'>THE INTERN</text>\
<text x='200' y='118' font-family='monospace' font-size='22' text-anchor='middle' fill='#c0392b'>{rank} · {status}</text>\
<text x='200' y='170' font-family='monospace' font-size='44' text-anchor='middle' fill='#1b1b1b'>LEVEL {level}</text>\
<text x='48' y='230' font-family='monospace' font-size='20' fill='#1b1b1b'>rounds   {rounds}</text>\
<text x='48' y='262' font-family='monospace' font-size='20' fill='#1b1b1b'>bets     {bets}</text>\
<text x='48' y='294' font-family='monospace' font-size='20' fill='#1b1b1b'>refused  {refusals}</text>\
<text x='48' y='326' font-family='monospace' font-size='20' fill='#1b1b1b'>result   {result}</text>\
<text x='200' y='366' font-family='monospace' font-size='14' text-anchor='middle' fill='#555'>$INTERN · drawn by the contract</text></svg>"
    );
    use near_sdk::base64::Engine;
    format!("data:image/svg+xml;base64,{}", near_sdk::base64::engine::general_purpose::STANDARD.encode(svg))
}

/// Dollars e6, signed, as "+$1.23" / "-$0.04".
fn usd(v: i128) -> String {
    let sign = if v < 0 { "-" } else { "+" };
    let a = v.unsigned_abs();
    format!("{sign}${}.{:02}", a / 1_000_000, (a % 1_000_000) / 10_000)
}

impl Coin {
    /// Adds to what a token has earned (the money is already held apart by the caller's accounting).
    pub(crate) fn credit_nft(&mut self, token_id: &str, amount: u128) {
        if amount == 0 {
            return;
        }
        set_owed(token_id, owed(token_id) + amount);
        let mut s = state();
        s.owed_total += amount;
        put_state(&s);
    }

    /// The claimed originals, by code index.
    fn minted_originals(&self) -> Vec<usize> {
        (0..Refusal::ALL.len()).filter(|&i| matches!(self.s9.sticker_firsts[i], Some((_, _, true)))).collect()
    }

    /// tricks.rs: a quarter of a paid trick, shared by the claimed originals. Returns what was not placed (none
    /// claimed), for the bounty.
    pub(crate) fn share_with_originals(&mut self, amount: u128) -> u128 {
        let codes = self.minted_originals();
        if codes.is_empty() || amount == 0 {
            return amount;
        }
        let each = amount / codes.len() as u128;
        for i in &codes {
            self.credit_nft(&format!("original:{}", Refusal::ALL[*i].as_str()), each);
        }
        amount - each * codes.len() as u128
    }

    /// The Intern's record for a career card: (rounds, bets, refusals, result, level).
    fn career_record(&self) -> (u64, u64, u64, i128, u64) {
        let (r, ..) = self.projected();
        let (mut bets, mut result) = (0u64, 0i128);
        // Bets: positions ever approved; result: settled rounds' results (at most 400 most recent rounds read).
        let first = r.id.saturating_sub(400).max(1);
        for id in first..=r.id {
            if let Some(rr) = self.rounds.get(&id) {
                if rr.settled {
                    result += rr.result;
                }
            }
        }
        bets += self.next_position_id.saturating_sub(1);
        let refusals = self.next_refusal_id.saturating_sub(1);
        (r.id, bets, refusals, result, r.id / crate::weekly::WEEK_ROUNDS)
    }

    fn career_view(&self) -> CareerView {
        let (rank, status) = self.rank_at(self.projected().0.id);
        let (rounds, bets, refusals, result, level) = self.career_record();
        CareerView {
            rank,
            status,
            level,
            rounds,
            bets,
            refusals,
            result: wire::I128(result),
            svg: career_svg(rank.as_str(), status.as_str(), level, rounds, bets, refusals, &usd(result)),
        }
    }
}

#[ext_contract(ext_sticker_owner)]
#[allow(dead_code)]
trait StickerOwner {
    fn nft_token(&self, token_id: String) -> Option<near_sdk::serde_json::Value>;
    fn update_token(
        &mut self,
        token_id: String,
        title: Option<String>,
        description: Option<String>,
        media: Option<String>,
        extra: Option<String>,
    );
}

#[near]
impl Coin {
    /// 1.7. What a token has earned becomes the caller's prize, if the caller holds the token (the sticker contract
    /// is asked). At least 50 TGas.
    pub fn claim_nft_earnings(&mut self, token_id: String) -> Promise {
        require!(env::prepaid_gas() >= Gas::from_tgas(50), "attach at least 50 TGas");
        let who = env::predecessor_account_id();
        require!(owed(&token_id) > 0, "this token has earned nothing to claim");
        let stickers = self.s9.stickers.clone();
        ext_sticker_owner::ext(stickers)
            .with_static_gas(GAS_OWNER)
            .nft_token(token_id.clone())
            .then(Self::ext(Self::me()).with_static_gas(GAS_ON_OWNER).on_nft_owner(token_id, who))
    }

    #[private]
    pub fn on_nft_owner(&mut self, token_id: String, who: AccountId) -> bool {
        let owner = match env::promise_result_checked(0, 4_096) {
            Ok(bytes) => near_sdk::serde_json::from_slice::<near_sdk::serde_json::Value>(&bytes)
                .ok()
                .and_then(|v| v.get("owner_id").and_then(|o| o.as_str().map(str::to_string))),
            Err(_) => None,
        };
        if owner.as_deref() != Some(who.as_str()) {
            env::log_str("only the token's holder can claim what it earned");
            return false;
        }
        let amount = owed(&token_id);
        if amount == 0 {
            return false;
        }
        set_owed(&token_id, 0);
        let mut s = state();
        s.owed_total -= amount;
        s.paid_total += amount;
        put_state(&s);
        self.rw_credit_prize(&who, amount);
        self.feed.push(
            EventName::NftEarningsClaimed,
            json!({"token_id": token_id, "account_id": who, "amount": U128(amount)}),
        );
        true
    }

    /// 1.7. An author mints a playbook's NFT (0.02 NEAR, once per playbook); its coach cut then follows the token.
    #[payable]
    pub fn claim_playbook_nft(&mut self, playbook_id: u64) -> Promise {
        let who = env::predecessor_account_id();
        self.tick();
        let p = self.playbooks.get(&playbook_id).cloned().unwrap_or_else(|| env::panic_str("no such playbook"));
        require!(p.authors.iter().any(|(a, _)| *a == who), "only an author of this playbook can mint its NFT");
        require!(!playbook_nft(playbook_id), "this playbook already has its NFT");
        env::storage_write(&minted_key(playbook_id), &[1]);
        self.start_claim(
            who,
            format!("playbook:{playbook_id}"),
            format!("$INTERN playbook #{playbook_id}"),
            format!(
                "Playbook {playbook_id} of the $INTERN coin. Whoever holds this token is paid its 10% coach cut of every \
                 winning round it is active in."
            ),
            Some(json!({"playbook_id": playbook_id}).to_string()),
            true,
            KIND_PLAYBOOK,
            playbook_id,
        )
    }

    /// 1.7. Mints a career card (0.02 NEAR). Refresh it any time with `refresh_career_card`.
    #[payable]
    pub fn mint_career_card(&mut self) -> Promise {
        let who = env::predecessor_account_id();
        self.tick();
        let mut s = state();
        s.careers += 1;
        let n = s.careers;
        put_state(&s);
        let v = self.career_view();
        self.start_claim(
            who,
            format!("career:{n}"),
            format!("The Intern's career card #{n}"),
            format!(
                "The $INTERN AI trader's record, drawn by the contract: {} {}, level {}, {} rounds, {} bets, {} refused, \
                 result {}. Refresh it to see the record now.",
                v.rank.as_str(),
                v.status.as_str(),
                v.level,
                v.rounds,
                v.bets,
                v.refusals,
                usd(v.result.0)
            ),
            Some(json!({"career": n}).to_string()),
            true,
            KIND_CAREER,
            n,
        )
    }

    /// 1.7. Anyone: redraws a career card's picture from the record now.
    pub fn refresh_career_card(&mut self, n: u64) -> Promise {
        require!(n >= 1 && n <= state().careers, "no such career card");
        let v = self.career_view();
        ext_sticker_owner::ext(self.s9.stickers.clone()).with_static_gas(GAS_UPDATE).update_token(
            format!("career:{n}"),
            Some(format!("The Intern's career card #{n} · level {}", v.level)),
            None,
            Some(v.svg),
            Some(
                json!({"career": n, "rank": v.rank, "status": v.status, "level": v.level, "rounds": v.rounds,
                       "bets": v.bets, "refused": v.refusals, "result": v.result})
                .to_string(),
            ),
        )
    }

    /// 1.7. What each earning token is owed now (claimed originals and playbooks with an NFT).
    pub fn get_nft_earnings(&self) -> NftEarningsView {
        let s = state();
        let mut tokens: Vec<NftEarning> = self
            .minted_originals()
            .into_iter()
            .map(|i| format!("original:{}", Refusal::ALL[i].as_str()))
            .map(|t| NftEarning { owed: U128(owed(&t)), token_id: t })
            .collect();
        for pid in 1..self.s9.next_playbook_id {
            if playbook_nft(pid) {
                let t = format!("playbook:{pid}");
                tokens.push(NftEarning { owed: U128(owed(&t)), token_id: t });
            }
        }
        NftEarningsView {
            owed_total: U128(s.owed_total),
            paid_total: U128(s.paid_total),
            tokens,
            careers_minted: s.careers,
        }
    }

    /// 1.7. The Intern's record as a career card shows it, with the picture.
    pub fn get_career(&self) -> CareerView {
        self.career_view()
    }
}

// ----- 1.7 (item 23): golden stickers as NEP-245 multi-tokens on the tickets contract ------------------------

pub(crate) const KIND_GOLDEN_MT: u8 = 6;

/// The tickets contract (`crates/tickets`), set by the contract's own key (`set_tickets`).
pub(crate) fn tickets_account() -> Option<AccountId> {
    env::storage_read(b"m7t").and_then(|b| String::from_utf8(b).ok()).and_then(|s| s.parse().ok())
}

#[ext_contract(ext_tickets)]
#[allow(dead_code)]
trait TicketsContract {
    fn mint(&mut self, token_id: String, receiver_id: AccountId, amount: U128, title: String, description: String);
}

#[near]
impl Coin {
    /// 1.7. The contract's own key only: the multi-token contract golden stickers can be claimed on.
    #[private]
    pub fn set_tickets(&mut self, tickets: AccountId) {
        env::storage_write(b"m7t", tickets.as_bytes());
    }

    /// 1.7. The contract's own key only: points the coin at its sticker contract. For a test deployment that was set
    /// up without one (coin-fast); the live coin's never changes.
    #[private]
    pub fn set_stickers(&mut self, stickers: AccountId) {
        self.s9.stickers = stickers;
    }

    /// 1.7. Claims a golden sticker won by guessing as one unit of `golden:<CODE>` on the tickets contract (NEP-245),
    /// tradable on its market, instead of as a one-off NFT. 0.02 NEAR, at least 60 TGas; a failed mint puts it back.
    #[payable]
    pub fn claim_golden_mt(&mut self, code: Refusal, serial: u16) -> Promise {
        require!(env::prepaid_gas() >= crate::claims::GAS_CLAIM_MIN, "attach at least 60 TGas");
        require!(env::attached_deposit() >= crate::claims::CLAIM_DEPOSIT, "attach 0.02 NEAR for the token's storage");
        let tickets = tickets_account().unwrap_or_else(|| env::panic_str("no tickets contract is set"));
        let who = env::predecessor_account_id();
        self.tick();
        self.take_golden(&who, code, serial);
        let token_id = format!("golden:{}", code.as_str());
        ext_tickets::ext(tickets)
            .with_attached_deposit(crate::claims::CLAIM_DEPOSIT)
            .with_static_gas(Gas::from_tgas(20))
            .mint(
                token_id.clone(),
                who.clone(),
                U128(1),
                format!("Golden {}", code.as_str()),
                format!("A golden {} sticker of $INTERN, one of at most 100, won by a free guess.", code.as_str()),
            )
            .then(Self::ext(Self::me()).with_static_gas(Gas::from_tgas(15)).on_claimed(
                who,
                token_id,
                KIND_GOLDEN_MT,
                (code as u64) << 16 | serial as u64,
            ))
    }
}
