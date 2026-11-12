//! Step 9 (01-SHARED-INTERFACE.md 1.3, section 9.5): playbooks and the coach cut.
//!
//! A playbook is text the bosses vote into the rulebook's `playbook:` line (SET_PLAYBOOK, which passes
//! like a promotion and takes effect at the start of the second round after it passed). It steers
//! choices inside the rank and can never lift a limit. When a round with an active playbook settles
//! with a positive result, `COACH_CUT_BPS` of the result is sent to the authors in USDC.

use crate::*;

/// 1.3, `PROPOSED`: 10% of a winning round.
pub const COACH_CUT_BPS: u32 = 1_000;
pub const MAX_AUTHORS: usize = 5;
const GAS_COACH_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_ON_COACH: Gas = Gas::from_tgas(5);
/// What `on_settle` needs on top of its own work to send the coach cut to every author.
pub const GAS_COACH_ALL: Gas = Gas::from_tgas(15 * MAX_AUTHORS as u64);

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlaybookRec {
    pub id: u64,
    pub text: String,
    /// (author, share in bps), adding up to 10,000
    pub authors: Vec<(AccountId, u32)>,
    pub submitted_round: u64,
    pub active_from: Option<u64>,
    pub paid_total: u128,
}

impl Coin {
    /// The playbook in force in round `round_id`: a passed change counts from its effective round.
    pub(crate) fn playbook_id_at(&self, round_id: u64) -> Option<u64> {
        match self.s9.pending_playbook {
            Some((pid, eff)) if round_id >= eff => (pid != 0).then_some(pid),
            _ => self.s9.active_playbook,
        }
    }

    pub(crate) fn playbook_text_at(&self, round_id: u64) -> Option<String> {
        self.playbook_id_at(round_id)
            .and_then(|id| self.playbooks.get(&id))
            .map(|p| p.text.clone())
    }

    /// At a round's opening: a waiting change takes effect, and the round records its playbook (for
    /// the coach cut).
    pub(crate) fn open_round_playbook(&mut self, round_id: u64) {
        if let Some((pid, eff)) = self.s9.pending_playbook {
            if round_id >= eff {
                self.s9.active_playbook = (pid != 0).then_some(pid);
                self.s9.pending_playbook = None;
                if let Some(mut p) = self.playbooks.get(&pid).cloned() {
                    p.active_from.get_or_insert(round_id);
                    self.playbooks.insert(pid, p);
                }
            }
        }
        if let Some(pid) = self.s9.active_playbook {
            self.round_playbook.insert(round_id, pid);
        }
    }

    pub(crate) fn playbook_view(p: &PlaybookRec) -> wire::Playbook {
        wire::Playbook {
            id: p.id,
            text: p.text.clone(),
            authors: p
                .authors
                .iter()
                .map(|(a, s)| wire::Author {
                    account_id: a.clone(),
                    share_bps: *s,
                })
                .collect(),
            submitted_round: p.submitted_round,
            active_from: p.active_from,
            paid_total: U128(p.paid_total),
        }
    }

    /// Whether settling `round_id` with a positive result would send a coach cut.
    pub(crate) fn coach_due(&self, round_id: u64) -> bool {
        self.round_playbook.contains_key(&round_id)
    }

    /// Sends the coach cut of a winning round to the playbook's authors. Returns the dollars sent;
    /// a payment that fails comes back to the pool in `on_coach_paid`.
    pub(crate) fn pay_coach(&mut self, round_id: u64, result: u128) -> u128 {
        let Some(pid) = self.round_playbook.get(&round_id).copied() else {
            return 0;
        };
        let mut p = self
            .playbooks
            .get(&pid)
            .cloned()
            .expect("an active playbook exists");
        let cut = result.saturating_mul(COACH_CUT_BPS as u128) / 10_000;
        let mut sent = 0u128;
        let mut paid = vec![];
        for (account, share) in &p.authors {
            let amount = cut.saturating_mul(*share as u128) / 10_000;
            if amount == 0 {
                continue;
            }
            sent += amount;
            paid.push(json!({"account_id": account, "amount": U128(amount)}));
            ext_ft_core::ext(self.cfg.usdc_token.clone())
                .with_attached_deposit(NearToken::from_yoctonear(1))
                .with_static_gas(GAS_COACH_TRANSFER)
                .ft_transfer(
                    account.clone(),
                    U128(amount),
                    Some("$INTERN coach cut".to_string()),
                )
                .then(
                    Self::ext(Self::me())
                        .with_static_gas(GAS_ON_COACH)
                        .on_coach_paid(pid, account.clone(), U128(amount)),
                )
                .detach();
        }
        p.paid_total += sent;
        self.playbooks.insert(pid, p);
        self.feed.push(
            EventName::CoachPaid,
            json!({"round_id": round_id, "playbook_id": pid, "amount": U128(sent), "paid": paid}),
        );
        sent
    }
}

#[near]
impl Coin {
    /// Anyone, with a NEAR deposit covering the playbook's storage (the rest is refunded). `text`: 1 to
    /// 2,000 bytes, newlines become spaces. `authors`: 1 to 5, shares adding up to 10,000. Returns its id.
    #[payable]
    pub fn submit_playbook(&mut self, text: String, authors: Vec<wire::Author>) -> u64 {
        let text = rules::rulebook::clean_playbook(&text).unwrap_or_else(|e| {
            env::panic_str(match e {
                rules::rulebook::PlaybookError::TooLong => "a playbook is at most 2,000 bytes",
                rules::rulebook::PlaybookError::Empty => "a playbook cannot be empty",
            })
        });
        require!((1..=MAX_AUTHORS).contains(&authors.len()), "1 to 5 authors");
        require!(
            authors.iter().all(|a| a.share_bps > 0),
            "every author's share must be above 0"
        );
        require!(
            authors.iter().map(|a| a.share_bps as u64).sum::<u64>() == 10_000,
            "the shares must add up to 10,000"
        );
        for (i, a) in authors.iter().enumerate() {
            require!(
                !authors[..i].iter().any(|b| b.account_id == a.account_id),
                "an author is listed twice"
            );
        }
        self.tick();
        let before = env::storage_usage();
        let id = self.s9.next_playbook_id;
        self.s9.next_playbook_id += 1;
        let round = self.current.expect("round").id;
        let rec = PlaybookRec {
            id,
            text,
            authors: authors
                .iter()
                .map(|a| (a.account_id.clone(), a.share_bps))
                .collect(),
            submitted_round: round,
            active_from: None,
            paid_total: 0,
        };
        self.playbooks.insert(id, rec);
        self.playbooks.flush();
        let cost = env::storage_byte_cost().saturating_mul((env::storage_usage() - before) as u128);
        let paid = env::attached_deposit();
        require!(
            paid >= cost,
            format!(
                "attach at least {} yoctoNEAR for the playbook's storage",
                cost.as_yoctonear()
            )
        );
        if paid > cost {
            Promise::new(env::predecessor_account_id())
                .transfer(paid.saturating_sub(cost))
                .detach();
        }
        self.feed.push(
            EventName::PlaybookSubmitted,
            json!({"playbook_id": id, "authors": authors, "submitted_round": round}),
        );
        id
    }

    /// Callback of one author's coach cut. A failed payment goes back to the BRAVE pool.
    #[private]
    pub fn on_coach_paid(&mut self, playbook_id: u64, account_id: AccountId, amount: U128) -> bool {
        if !matches!(
            env::promise_result_checked(0, 64),
            Err(PromiseError::Failed)
        ) {
            return true;
        }
        self.books.brave_total += amount.0;
        if let Some(mut p) = self.playbooks.get(&playbook_id).cloned() {
            p.paid_total = p.paid_total.saturating_sub(amount.0);
            self.playbooks.insert(playbook_id, p);
        }
        env::log_str(&format!("coach cut of {} to {account_id} failed (not registered on the USDC token?): back to the pool", amount.0));
        false
    }

    /// Newest first; `from` is the highest id to return.
    pub fn get_playbooks(&self, from: Option<u64>, limit: Option<u32>) -> Vec<wire::Playbook> {
        let last = self.s9.next_playbook_id - 1;
        let start = from.map_or(last, |f| f.min(last));
        let n = limit.map_or(50, |l| l.clamp(1, 100)) as u64;
        (start.saturating_sub(n - 1).max(1)..=start)
            .rev()
            .filter_map(|i| self.playbooks.get(&i))
            .map(Self::playbook_view)
            .collect()
    }

    /// The playbook in force in the current round, as the views show it.
    pub fn get_active_playbook(&self) -> Option<wire::Playbook> {
        let id = self.projected().0.id;
        self.playbook_id_at(id)
            .and_then(|p| self.playbooks.get(&p))
            .map(Self::playbook_view)
    }
}
