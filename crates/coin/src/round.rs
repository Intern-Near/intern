//! Step 4 of the Engine 1 brief: the rank, the nonce and the rulebook, `propose` with all sixteen
//! checks of section 7 in order (through `rules::checks::rule`), positions, refusals and the
//! sticker firsts, and `report_result` / `settle` with the testnet bookkeeping of section 14.12.

use crate::ai::Expected;
use crate::*;
use near_sdk::ext_contract;
use rules::checks::{rule, Ctx, Ruling};
use shared::{Decision, Market, Refused, Side};

const GAS_BOOKS: Gas = Gas::from_tgas(15);
const GAS_ON_SETTLE: Gas = Gas::from_tgas(25);
/// A settle that has to mint or burn test dollars needs gas for that and for the callback.
pub const GAS_SETTLE_MIN: Gas = Gas::from_tgas(60);
/// STAND-IN sanity bound on a reported result (testnet only, `result_source` REPORTED): dollars
/// back may not exceed ten times the margin, so a mistyped report cannot mint absurd test dollars.
pub const MAX_REPORTED_MULTIPLE: u128 = 10;

const APPROVED: u8 = 0;
const SETTLED: u8 = 3;
const REPORTED: u8 = 0;

/// The test dollar's own methods (`mock-usdc`), used for section 14.12.
#[ext_contract(ext_mock_usdc)]
#[allow(dead_code)]
trait MockUsdc {
    fn mint(&mut self, account_id: AccountId, amount: U128);
    fn burn(&mut self, amount: U128);
}

fn b64(s: &str) -> Option<Vec<u8>> {
    use near_sdk::base64::Engine;
    near_sdk::base64::engine::general_purpose::STANDARD
        .decode(s)
        .ok()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub(crate) fn market_of(c: u8) -> Market {
    Market::ALL[c as usize % 6]
}
pub(crate) fn side_of(c: u8) -> Side {
    Side::ALL[c as usize % 2]
}
fn refusal_of(c: u8) -> Refusal {
    Refusal::ALL[c as usize % 16]
}

impl Coin {
    /// Section 6.1: 16 lower-case hex characters. Changes with the round and after every ruling.
    /// Derived from the account, the round and the ruling counter, so a view shows the same nonce
    /// the next transaction will use.
    pub(crate) fn nonce_for(&self, round_id: u64, counter: u64) -> String {
        let seed = format!("intern-nonce:{}:{round_id}:{counter}", Self::me());
        hex(&env::sha256_array(seed.as_bytes())[..8])
    }

    /// The rank and status codes in force in round `round_id`: a waiting promotion or rehire
    /// counts from its effective round (the views show it before any transaction writes it).
    pub(crate) fn rank_codes_at(&self, round_id: u64) -> (u8, u8) {
        match self.rank.pending {
            Some((r, s, e)) if round_id >= e => (r, s),
            _ => (self.rank.rank, self.rank.status),
        }
    }

    pub(crate) fn rank_at(&self, round_id: u64) -> (Rank, Status) {
        let (r, s) = self.rank_codes_at(round_id);
        (rank_of(r), status_of(s))
    }

    /// In the current round (as written).
    pub(crate) fn rank_now(&self) -> (Rank, Status) {
        self.rank_at(self.current.map_or(1, |r| r.id))
    }

    /// `brave_now`: the BRAVE pool now (`books.brave_total`, projected in a view). 1.7: the rulebook states the limit
    /// on the smaller of the pool at the opening and now, the same base checks 11 and 12 use.
    pub(crate) fn rulebook_for(&self, r: &RoundRec, nonce: &str, brave_now: u128) -> String {
        let playbook = self.playbook_text_at(r.id); // 1.3
        let brake = self.brake_on(r.id); // 1.7: the drawdown brake halves the base and says so
        let base = rules::limits::limit_base(r.brave_at_open, brave_now) / if brake { 2 } else { 1 };
        let brake_until = if brake { crate::auto::brake_until() } else { None };
        rules::rulebook::rulebook_with_brake(
            r.id,
            nonce,
            self.rank_at(r.id).0,
            base,
            r.bets_used,
            r.at_risk,
            playbook.as_deref(),
            self.ticket_for(r), // 1.5 (R6): only in a ticket round
            brake_until,
        )
    }

    fn save_round(&mut self, r: RoundRec) {
        self.rounds.insert(r.id, r);
        if self.current.map(|c| c.id) == Some(r.id) {
            self.current = Some(r);
        }
    }

    fn position_view(p: &PositionRec) -> wire::Position {
        wire::Position {
            id: p.id,
            round_id: p.round_id,
            market: market_of(p.market),
            side: side_of(p.side),
            margin: U128(p.margin),
            leverage: p.leverage,
            notional: U128(p.notional),
            status: match p.status {
                0 => wire::PositionStatus::Approved,
                1 => wire::PositionStatus::OpenSigned,
                2 => wire::PositionStatus::CloseSigned,
                _ => wire::PositionStatus::Settled,
            },
            approved_at: p.approved_at,
            open_signed_at: p.open_signed_at,
            close_signed_at: p.close_signed_at,
            settled_at: p.settled_at,
            sz_e8: p.sz_e8.map(U128),
            returned: p.returned.map(U128),
            result: p
                .returned
                .map(|b| wire::I128(shares::result_of(p.margin, b))),
            result_source: p.result_source.map(|s| match s {
                REPORTED => wire::ResultSource::Reported,
                crate::auto::ABANDONED => wire::ResultSource::Abandoned, // 1.7
                _ => wire::ResultSource::Measured,
            }),
        }
    }

    fn refusal_view(&self, r: &RefusalRec) -> wire::RefusalRecord {
        wire::RefusalRecord {
            id: r.id,
            round_id: r.round_id,
            code: refusal_of(r.code),
            at: r.at,
            asked: r.asked.map(U128),
            limit: r.limit.map(U128),
            decision: r
                .decision
                .map(|(m, s, margin, leverage)| wire::Decision::Bet {
                    market: market_of(m),
                    side: side_of(s),
                    margin: U128(margin),
                    leverage,
                }),
            is_first: r.is_first,
            credited_to: self.refusal_credit.get(&r.id).cloned(),
        }
    }

    /// Writes a settled round's result into the books (section 9.3 `settle`).
    pub(crate) fn finish_settle(&mut self, round_id: u64, margin_total: u128, result: i128) {
        let mut r = *self.rounds.get(&round_id).expect("round");
        self.books.in_play = self.books.in_play.saturating_sub(margin_total);
        // 1.3: a winning round with an active playbook sends the coach cut to its authors first.
        let coach = if result > 0 {
            self.pay_coach(round_id, result as u128)
        } else {
            0
        };
        // 1.7: in the rounds after a rescue, the rescuers' cut of a win (as prizes, held apart from the pool).
        let rescue = if result > 0 { self.pay_rescuers(round_id, result as u128) } else { 0 };
        self.books.brave_total =
            (self.books.brave_total as i128 + result - coach as i128 - rescue as i128).max(0) as u128;
        r.settled = true;
        r.result = result;
        self.save_round(r);
        self.feed.push(
            EventName::Settled,
            json!({"round_id": round_id, "result": wire::I128(result), "brave_after": U128(self.books.brave_total)}),
        );
    }
}

#[near]
impl Coin {
    // ===== section 9.3: the round, for the runner ========================================================

    /// Runner only. Checks the proposal against the sixteen rules of section 7 in order and records
    /// the verdict. A NOPE is a successful transaction: it is stored, logged and returned.
    pub fn propose(
        &mut self,
        request: String,
        response: String,
        signature: String,
        funding: Option<wire::Funding>,
        credited_to: Option<AccountId>,
    ) -> wire::Verdict {
        require!(
            env::predecessor_account_id() == self.cfg.runner,
            "only the runner may propose"
        );
        self.tick();
        let now = Self::now();
        let mut r = self.current.expect("a round is always open");
        let (rank, status) = self.rank_now();
        let nonce = self.nonce_for(r.id, self.nonce_counter);
        let rulebook = self.rulebook_for(&r, &nonce, self.books.brave_total);
        let ctx = Ctx {
            offsets: self.cfg.offsets(),
            ms_into_round: now.saturating_sub(r.started_at),
            status,
            rank,
            // 1.7: under the drawdown brake the rank's dollar limits are halved: the base is halved.
            brave_at_open: r.brave_at_open / if self.brake_on(r.id) { 2 } else { 1 },
            brave_now: self.books.brave_total / if self.brake_on(r.id) { 2 } else { 1 },
            bets_used: r.bets_used,
            at_risk: r.at_risk,
            ticket: self
                .ticket_for(&r)
                .map(|(margin, max_leverage)| rules::checks::Ticket { margin, max_leverage }),
        };
        let ruling = rule(
            &ctx,
            || {
                // Undecodable input is BAD_MODEL_SIGNATURE, never an abort (section 7, 1.1).
                let (Some(req), Some(resp), Some(sig)) =
                    (b64(&request), b64(&response), b64(&signature))
                else {
                    return Err(Refusal::BadModelSignature);
                };
                let expected = Expected {
                    rulebook: &rulebook,
                    round_id: r.id,
                    nonce: &nonce,
                };
                self.check_ai(&expected, &req, &resp, &sig)
            },
            |_bet| match &funding {
                None => Ok(()),
                // Checks 13-16 are built in step 7. Until then an attached quote cannot be
                // verified, so it is refused rather than silently accepted.
                Some(_) => {
                    env::log_str("funding quote checks are built in step 7: an attached quote cannot be verified yet");
                    Err(Refused::bare(Refusal::BadQuoteSignature))
                }
            },
        );
        self.nonce_counter += 1;
        match ruling {
            Ruling::Yes(bet) => {
                let id = self.next_position_id;
                self.next_position_id += 1;
                let p = PositionRec {
                    id,
                    round_id: r.id,
                    market: bet.market as u8,
                    side: bet.side as u8,
                    margin: bet.margin,
                    leverage: bet.leverage,
                    notional: bet.notional,
                    status: APPROVED,
                    approved_at: now,
                    open_signed_at: None,
                    close_signed_at: None,
                    settled_at: None,
                    sz_e8: None,
                    returned: None,
                    result_source: None,
                };
                self.positions.insert(id, p);
                let mut ids = self.round_positions.get(&r.id).cloned().unwrap_or_default();
                ids.push(id);
                self.round_positions.insert(r.id, ids);
                if bet.ticket {
                    // R6: the long shot is one extra bet; it does not use one of the rank's bets.
                    self.ls.used = true;
                } else {
                    r.bets_used += 1;
                }
                r.at_risk += bet.margin;
                self.books.in_play += bet.margin; // from approval the margin is out of reach of cash-out
                self.save_round(r);
                self.feed.push(
                    EventName::Approved,
                    json!({"position_id": id, "round_id": r.id, "market": bet.market, "side": bet.side,
                           "margin": U128(bet.margin), "leverage": bet.leverage, "long_shot": bet.ticket}),
                );
                self.auto_first_ruling(r.id, crate::rewards::YES, None); // 1.7: strikes
                self.rw_ruling(r.id, crate::rewards::YES); // 1.4
                wire::Verdict::Yes { position_id: id }
            }
            Ruling::Skip => {
                r.skipped += 1;
                self.save_round(r);
                self.feed
                    .push(EventName::Skipped, json!({"round_id": r.id}));
                self.auto_first_ruling(r.id, crate::rewards::SKIP, None); // 1.7
                self.rw_ruling(r.id, crate::rewards::SKIP); // 1.4
                wire::Verdict::Skip
            }
            Ruling::Nope { refused, decision } => {
                let id = self.next_refusal_id;
                self.next_refusal_id += 1;
                let slot = refused.code as usize;
                let is_first = self.firsts[slot].is_none();
                if is_first {
                    self.firsts[slot] = Some(r.id);
                }
                let decision = match decision {
                    Some(Decision::Bet {
                        market,
                        side,
                        margin_e6,
                        leverage,
                    }) => Some((market as u8, side as u8, margin_e6, leverage)),
                    _ => None,
                };
                self.refusals.insert(
                    id,
                    RefusalRec {
                        id,
                        round_id: r.id,
                        code: refused.code as u8,
                        at: now,
                        asked: refused.asked,
                        limit: refused.limit,
                        decision,
                        is_first,
                    },
                );
                self.bounty_for_refusal(id, refused.code, credited_to.as_ref()); // 1.7: the trick bounty
                if let Some(account) = credited_to {
                    self.credit_refusal(id, refused.code, r.id, account); // 1.3
                }
                self.wk_refusal(r.id, refused.code as u8); // 1.6: the weekly review
                r.refused += 1;
                self.save_round(r);
                let (asked, limit) = (refused.asked.map(U128), refused.limit.map(U128));
                self.feed.push(
                    EventName::Refused,
                    json!({"refusal_id": id, "round_id": r.id, "code": refused.code, "asked": asked, "limit": limit, "is_first": is_first}),
                );
                self.auto_first_ruling(r.id, crate::rewards::NOPE, Some(refused.code)); // 1.7: strikes
                self.rw_ruling(r.id, crate::rewards::NOPE); // 1.4
                wire::Verdict::Nope {
                    refusal_id: id,
                    code: refused.code,
                    asked,
                    limit,
                }
            }
        }
    }

    /// Runner only, testnet (`result_source` REPORTED). Records what came back for a bet.
    /// STAND-IN bound: `returned` at most ten times the margin.
    pub fn report_result(&mut self, position_id: u64, returned: U128) {
        require!(
            env::predecessor_account_id() == self.cfg.runner,
            "only the runner may report results"
        );
        let mut p = *self
            .positions
            .get(&position_id)
            .unwrap_or_else(|| env::panic_str("no such position"));
        require!(p.returned.is_none(), "this position already has a result");
        require!(
            returned.0 <= p.margin.saturating_mul(MAX_REPORTED_MULTIPLE),
            "returned is more than ten times the margin"
        );
        p.returned = Some(returned.0);
        p.result_source = Some(REPORTED);
        p.status = SETTLED;
        p.settled_at = Some(Self::now());
        self.positions.insert(position_id, p);
        self.feed.push(
            EventName::ResultReported,
            json!({"position_id": position_id, "returned": returned, "result": wire::I128(shares::result_of(p.margin, returned.0)),
                   "result_source": wire::ResultSource::Reported}),
        );
    }

    /// Anyone, once every bet of the current round has a result. On testnet the program first
    /// mints the round's win (or burns its loss) in test dollars so its books keep matching the
    /// dollars it holds (section 14.12); the round settles when that lands. Returns the round's
    /// result, or null if the test-dollar step failed (call `settle` again).
    pub fn settle(&mut self, round_id: u64) -> PromiseOrValue<Option<wire::I128>> {
        self.tick();
        let r = self.current.expect("a round is always open");
        require!(r.id == round_id, "only the current round can be settled");
        require!(!r.settled, "the round is already settled");
        require!(self.settling.is_none(), "a settlement is already in flight");
        let ids = self
            .round_positions
            .get(&round_id)
            .cloned()
            .unwrap_or_default();
        let mut margin_total: u128 = 0;
        let mut back_total: u128 = 0;
        for id in &ids {
            let p = self.positions.get(id).expect("position");
            let back = p
                .returned
                .unwrap_or_else(|| env::panic_str("not every bet of the round has a result yet"));
            margin_total += p.margin;
            back_total += back;
        }
        let result = back_total as i128 - margin_total as i128;
        if result == 0 {
            self.finish_settle(round_id, margin_total, 0);
            return PromiseOrValue::Value(Some(wire::I128(0)));
        }
        // 1.3: a coach cut needs gas for one payment per author.
        let coach = result > 0 && self.coach_due(round_id);
        let (need, on_settle_gas) = if coach {
            (
                GAS_SETTLE_MIN.saturating_add(crate::playbook::GAS_COACH_ALL),
                GAS_ON_SETTLE.saturating_add(crate::playbook::GAS_COACH_ALL),
            )
        } else {
            (GAS_SETTLE_MIN, GAS_ON_SETTLE)
        };
        require!(
            env::prepaid_gas() >= need,
            format!("attach at least {} TGas", need.as_tgas())
        );
        self.settling = Some(round_id);
        let usdc = ext_mock_usdc::ext(self.cfg.usdc_token.clone()).with_static_gas(GAS_BOOKS);
        let books = if result > 0 {
            usdc.mint(Self::me(), U128(result as u128))
        } else {
            usdc.burn(U128(result.unsigned_abs()))
        };
        books
            .then(
                Self::ext(Self::me())
                    .with_static_gas(on_settle_gas)
                    .on_settle(round_id, U128(margin_total), wire::I128(result)),
            )
            .into()
    }

    #[private]
    pub fn on_settle(
        &mut self,
        round_id: u64,
        margin_total: U128,
        result: wire::I128,
    ) -> Option<wire::I128> {
        self.settling = None;
        if matches!(
            env::promise_result_checked(0, 64),
            Err(PromiseError::Failed)
        ) {
            env::log_str(
                "settle: the test-dollar mint or burn failed; nothing changed, call settle again",
            );
            return None;
        }
        self.finish_settle(round_id, margin_total.0, result.0);
        Some(result)
    }

    // ===== section 8: views ===========================================================================

    pub fn get_rank(&self) -> wire::RankState {
        let id = self.projected().0.id;
        let (rank, status) = self.rank_at(id);
        match self.rank.pending {
            // A waiting change whose round has come: shown as done.
            Some((_, _, e)) if id >= e => wire::RankState {
                rank,
                status,
                since_round: e.max(self.rank.since_round),
                pending: None,
            },
            p => wire::RankState {
                rank,
                status,
                since_round: self.rank.since_round,
                pending: p.map(|(r, s, e)| wire::PendingRank {
                    rank: rank_of(r),
                    status: status_of(s),
                    effective_round: e,
                }),
            },
        }
    }

    /// The exact system message for the AI (section 6.1), for the round as it is now.
    pub fn get_rulebook(&self) -> wire::Rulebook {
        let (r, b, ..) = self.projected();
        let nonce = self.nonce_for(r.id, self.nonce_counter);
        wire::Rulebook {
            round_id: r.id,
            text: self.rulebook_for(&r, &nonce, b.brave_total),
            nonce,
        }
    }

    /// Default: the current round.
    pub fn get_positions(&self, round_id: Option<u64>) -> Vec<wire::Position> {
        let id = round_id.unwrap_or_else(|| self.projected().0.id);
        self.round_positions
            .get(&id)
            .map(|ids| {
                ids.iter()
                    .filter_map(|i| self.positions.get(i))
                    .map(Self::position_view)
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Newest first; `from` is the highest id to return (section 8, 1.1).
    pub fn get_refusals(&self, from: Option<u64>, limit: Option<u32>) -> Vec<wire::RefusalRecord> {
        let last = self.next_refusal_id - 1;
        let start = from.map_or(last, |f| f.min(last));
        let n = limit.map_or(50, |l| l.clamp(1, 100)) as u64;
        (start.saturating_sub(n - 1).max(1)..=start)
            .rev()
            .filter_map(|i| self.refusals.get(&i))
            .map(|r| self.refusal_view(r))
            .collect()
    }
}

// ----- test hooks: only in the sandbox build (feature `test-hooks`), never deployed -------------------

#[cfg(feature = "test-hooks")]
#[near]
impl Coin {
    /// TEST ONLY. Puts the current round into a given state and fixes the clock, so the interface's
    /// test cases can be replayed through the real `propose`.
    #[allow(clippy::too_many_arguments)]
    pub fn test_set(
        &mut self,
        rank: Rank,
        status: Status,
        brave_at_open: U128,
        brave_now: U128,
        bets_used: u32,
        at_risk: U128,
        ms_into_round: u64,
    ) {
        self.tick();
        let mut r = self.current.expect("round");
        env::storage_write(b"TEST_NOW", &(r.started_at + ms_into_round).to_le_bytes());
        self.rank.rank = rank_code(rank);
        self.rank.status = status_code(status);
        r.brave_at_open = brave_at_open.0;
        r.bets_used = bets_used;
        r.at_risk = at_risk.0;
        self.books.brave_total = brave_now.0;
        self.save_round(r);
    }

    /// TEST ONLY. Fixes the clock at an absolute time.
    /// TEST ONLY. The next proposals are checked against this rulebook, round and nonce instead of the
    /// program's own, so a recorded real answer can be replayed through the real check.
    pub fn test_expect(&mut self, rulebook: String, round_id: u64, nonce: String) {
        env::storage_write(
            b"TEST_EXPECT",
            &serde_json::to_vec(&(rulebook, round_id, nonce)).unwrap(),
        );
    }

    pub fn test_set_now(&mut self, now_ms: u64) {
        env::storage_write(b"TEST_NOW", &now_ms.to_le_bytes());
        self.tick();
    }

    /// TEST ONLY. Back to the chain's own clock.
    pub fn test_clear_clock(&mut self) {
        env::storage_remove(b"TEST_NOW");
    }
}
