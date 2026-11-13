//! Step 9 (01-SHARED-INTERFACE.md 1.3, section 9.5): the boss badge, the sixteen originals and goal
//! stickers. They live in a separate NEP-171 contract (`s9.stickers`); only this contract mints there.
//! A claim is made here: this contract checks the right, marks it used, and asks the sticker contract
//! to mint. A failed mint puts the right back and refunds the deposit.
//!
//! The "first of its kind" original of each refusal code goes to the visitor credited with the first
//! credited refusal of that code (`propose(.., credited_to)`). The program cannot check that name; it
//! trusts the runner for it, as it does for the user message (section 6.3).

use crate::*;
use near_sdk::ext_contract;

/// 1.3, `PROPOSED`: the NEAR a claim attaches for the token's storage. The sticker contract refunds
/// what the token does not use straight to the claimer (a long account id needs about 0.0105 NEAR).
pub const CLAIM_DEPOSIT: NearToken = NearToken::from_millinear(20);
const GAS_MINT: Gas = Gas::from_tgas(30);
const GAS_ON_CLAIM: Gas = Gas::from_tgas(15);
pub const GAS_CLAIM_MIN: Gas = Gas::from_tgas(60);

const KIND_BADGE: u8 = 0;
const KIND_ORIGINAL: u8 = 1;
const KIND_GOAL: u8 = 2;
/// 1.4: a golden sticker won by guessing; `key` is code << 16 | serial.
pub(crate) const KIND_GOLDEN: u8 = 3;

/// The sticker contract (crates/stickers).
#[ext_contract(ext_stickers)]
#[allow(dead_code)]
trait Stickers {
    fn mint(
        &mut self,
        token_id: String,
        receiver_id: AccountId,
        title: String,
        description: String,
        extra: Option<String>,
        transferable: bool,
    );
}

impl Coin {
    /// Records a credited refusal and, if it is the first credited one of its code, who may claim the original.
    pub(crate) fn credit_refusal(
        &mut self,
        refusal_id: u64,
        code: Refusal,
        round_id: u64,
        account: AccountId,
    ) {
        self.refusal_credit.insert(refusal_id, account.clone());
        let slot = &mut self.s9.sticker_firsts[code as usize];
        if slot.is_none() {
            *slot = Some((account, round_id, false));
        }
    }

    /// Whether `who` may claim the goal sticker of `fill_id` (claimed or not).
    pub(crate) fn goal_eligible(&self, fill_id: u64, who: &AccountId) -> bool {
        let Some(f) = self.goal_fills.get(&fill_id) else {
            return false;
        };
        match f.goal {
            goals::BOSS => {
                let (coins, _, joined) = self.projected_account(who);
                coins > 0 && joined.is_some_and(|j| j <= f.round_id)
            }
            goals::TIP_JAR => self.jar_tippers.contains(&(f.key, who.clone())),
            // Only the top level of a hype train gives a sticker.
            _ => {
                f.level as usize == goals::HYPE_LEVELS.len()
                    && self.hype_riders.contains(&(f.key, who.clone()))
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn start_claim(
        &mut self,
        who: AccountId,
        token_id: String,
        title: String,
        description: String,
        extra: Option<String>,
        transferable: bool,
        kind: u8,
        key: u64,
    ) -> Promise {
        require!(
            env::prepaid_gas() >= GAS_CLAIM_MIN,
            "attach at least 60 TGas"
        );
        let paid = env::attached_deposit();
        require!(
            paid >= CLAIM_DEPOSIT,
            "attach 0.02 NEAR for the sticker's storage (the rest is refunded)"
        );
        if paid > CLAIM_DEPOSIT {
            Promise::new(who.clone())
                .transfer(paid.saturating_sub(CLAIM_DEPOSIT))
                .detach();
        }
        ext_stickers::ext(self.s9.stickers.clone())
            .with_attached_deposit(CLAIM_DEPOSIT)
            .with_static_gas(GAS_MINT)
            .mint(
                token_id.clone(),
                who.clone(),
                title,
                description,
                extra,
                transferable,
            )
            .then(
                Self::ext(Self::me())
                    .with_static_gas(GAS_ON_CLAIM)
                    .on_claimed(who, token_id, kind, key),
            )
    }
}

#[near]
impl Coin {
    /// The boss badge: anyone who holds or ever held coins, once. Not transferable. 0.02 NEAR.
    #[payable]
    pub fn claim_badge(&mut self) -> Promise {
        let who = env::predecessor_account_id();
        self.tick();
        self.materialize(&who);
        let joined = self.extra(&who).joined_round.unwrap_or_else(|| {
            env::panic_str("only a boss (someone who holds or held coins) has a badge")
        });
        require!(
            self.badges.insert(who.clone()),
            "this account already has its badge"
        );
        self.start_claim(
            who.clone(),
            format!("badge:{who}"),
            "Boss badge".to_string(),
            format!("{who} has been a boss of the Intern since round {joined}."),
            Some(json!({"joined_round": joined}).to_string()),
            false,
            KIND_BADGE,
            0,
        )
    }

    /// The "first of its kind" original of a refusal code, by the account it was credited to. 0.02 NEAR.
    #[payable]
    pub fn claim_sticker(&mut self, code: Refusal) -> Promise {
        let who = env::predecessor_account_id();
        self.tick();
        let slot = code as usize;
        let (account, round, claimed) = self.s9.sticker_firsts[slot]
            .clone()
            .unwrap_or_else(|| env::panic_str("nobody has been credited with this refusal yet"));
        require!(
            account == who,
            "this original belongs to the account credited with the first refusal of its kind"
        );
        require!(!claimed, "this original has been claimed");
        self.s9.sticker_firsts[slot] = Some((account, round, true));
        self.start_claim(
            who,
            format!("original:{}", code.as_str()),
            format!("First of its kind: {}", code.as_str()),
            format!(
                "The first {} the Intern was refused for, in round {round}. One of sixteen.",
                code.as_str()
            ),
            Some(json!({"code": code, "round_id": round}).to_string()),
            true,
            KIND_ORIGINAL,
            slot as u64,
        )
    }

    /// A goal sticker, by an account eligible for that goal fill (section 9.5). 0.02 NEAR.
    #[payable]
    pub fn claim_goal_sticker(&mut self, fill_id: u64) -> Promise {
        let who = env::predecessor_account_id();
        self.tick();
        self.materialize(&who);
        require!(
            self.goal_eligible(fill_id, &who),
            "this account is not eligible for that goal's sticker"
        );
        require!(
            self.goal_claims.insert((fill_id, who.clone())),
            "already claimed"
        );
        let f = self.goal_fills.get(&fill_id).cloned().expect("fill");
        let name = goals::goal_name(f.goal);
        self.start_claim(
            who.clone(),
            format!("goal:{fill_id}:{who}"),
            format!("Goal filled: {name} level {}", f.level),
            format!(
                "{who} helped fill the {name} goal (level {}) in round {}.",
                f.level, f.round_id
            ),
            Some(
                json!({"fill_id": fill_id, "goal": name, "level": f.level, "round_id": f.round_id})
                    .to_string(),
            ),
            true,
            KIND_GOAL,
            fill_id,
        )
    }

    /// Callback of a mint. Failure: the right comes back and the deposit is refunded.
    #[private]
    pub fn on_claimed(
        &mut self,
        account_id: AccountId,
        token_id: String,
        kind: u8,
        key: u64,
    ) -> bool {
        if !matches!(
            env::promise_result_checked(0, 64),
            Err(PromiseError::Failed)
        ) {
            self.feed.push(
                EventName::StickerClaimed,
                json!({"account_id": account_id, "token_id": token_id}),
            );
            return true;
        }
        match kind {
            KIND_BADGE => {
                self.badges.remove(&account_id);
            }
            KIND_ORIGINAL => {
                if let Some(s) = self.s9.sticker_firsts[key as usize].as_mut() {
                    s.2 = false;
                }
            }
            KIND_GOLDEN | crate::earn::KIND_GOLDEN_MT => {
                self.rw_golden_restore(&account_id, (key >> 16) as u8, (key & 0xffff) as u16)
            }
            // 1.7: a playbook NFT that failed to mint can be claimed again; a career card number is simply skipped.
            crate::earn::KIND_PLAYBOOK => {
                env::storage_remove(&[b"e7p".as_slice(), &key.to_le_bytes()].concat());
            }
            crate::earn::KIND_CAREER => {}
            _ => {
                self.goal_claims.remove(&(key, account_id.clone()));
            }
        }
        Promise::new(account_id.clone())
            .transfer(CLAIM_DEPOSIT)
            .detach();
        env::log_str(&format!(
            "minting {token_id} failed: the claim is open again and the deposit is refunded"
        ));
        false
    }

    /// All sixteen codes in check order: who may claim each original, and whether it has been.
    pub fn get_sticker_firsts(&self) -> Vec<wire::StickerFirst> {
        Refusal::ALL
            .into_iter()
            .map(|code| {
                let s = self.s9.sticker_firsts[code as usize].clone();
                wire::StickerFirst {
                    code,
                    account_id: s.as_ref().map(|x| x.0.clone()),
                    round_id: s.as_ref().map(|x| x.1),
                    claimed: s.is_some_and(|x| x.2),
                }
            })
            .collect()
    }

    /// What `account_id` may claim right now (the last 100 goal fills are looked at).
    pub fn get_claimable(&self, account_id: AccountId) -> wire::Claimable {
        let (_, _, joined) = self.projected_account(&account_id);
        let originals = Refusal::ALL
            .into_iter()
            .filter(|c| matches!(&self.s9.sticker_firsts[*c as usize], Some((a, _, false)) if *a == account_id))
            .collect();
        let last = self.s9.next_fill_id - 1;
        let goal_fills = (last.saturating_sub(99).max(1)..=last)
            .filter(|f| {
                self.goal_eligible(*f, &account_id)
                    && !self.goal_claims.contains(&(*f, account_id.clone()))
            })
            .collect();
        wire::Claimable {
            badge: joined.is_some() && !self.badges.contains(&account_id),
            originals,
            goal_fills,
        }
    }
}
