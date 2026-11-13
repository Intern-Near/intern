//! Interface 1.7, owner's decisions (Engine 2's list, items 10 and 11): consequences the program applies by itself,
//! with no vote and no runner.
//!
//! - **Three strikes.** A round's first ruling that is a NOPE for the Intern's own answer (checks 3 to 12: the
//!   signature, the rulebook, the format and the rank's limits; not OUTSIDE_WINDOW, FIRED or a funding quote) is a
//!   strike. A YES clears them; a SKIP leaves them. `STRIKES_OUT` (3) in a row: the Intern is demoted one rank at
//!   once, or fired if it is an INTERN. (The runner asks the Intern's own question first each round, so the first
//!   ruling is normally its own; a visitor's trick is asked after it.)
//! - **The drawdown brake.** At each round's opening: if the settled results of the last `BRAKE_ROUNDS` (7) rounds
//!   lost `BRAKE_LOSS_BPS` (1%) or more of the pool as it was seven rounds ago, the rank's dollar limits are halved
//!   for the next 7 rounds, and the rulebook says so. It lifts by itself (Engine 2's simulation: a brake that waits
//!   for a vote may never lift).
//! - **The term.** The Intern is hired for `TERM_MS` (30 days). A `RENEW` vote that passes extends it by 30 days;
//!   a rehire starts a new term. When a round opens after the term has run out, the Intern is fired. (In days, not
//!   rounds, so the demo's 30-minute rounds do not make it lapse in a day.)
//! - **The dead-man switch.** If a round's bets have no result `DEAD_MAN_ROUNDS` (3) round lengths after the round's
//!   close time, anyone may `abandon` it: every bet without a result is booked as lost (`result_source`
//!   `ABANDONED`), the round settles so the next one can open and money can leave, and the Intern is fired until
//!   holders rehire it. Timed steps that anyone may already trigger: `settle`, `close`, `rewards_tick`, `rebalance`,
//!   `finish_vote`.
//!
//! State lives under its own storage keys (prefix `a7`), outside the `Coin` struct: no migration.

use crate::*;
use near_sdk::borsh;
use rules::vote::VoteKind;

pub const STRIKES_OUT: u8 = 3;
pub const BRAKE_ROUNDS: u64 = 7;
pub const BRAKE_LOSS_BPS: u128 = 100;
pub const TERM_MS: u64 = 30 * 86_400_000;
pub const DEAD_MAN_ROUNDS: u64 = 3;
/// `result_source` code of a bet booked as lost by `abandon`.
pub const ABANDONED: u8 = 2;

fn key() -> Vec<u8> {
    b"a7s".to_vec()
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AutoState {
    pub strikes: u8,
    /// The round whose first ruling was the last strike (a round counts once).
    pub last_strike_round: u64,
    /// The brake halves the limits in rounds before this one.
    pub brake_until: Option<u64>,
    /// The term ends at this time (ms); 0 until the first 1.7 call that writes.
    pub term_ends_at: u64,
}

#[near(serializers = [json])]
pub struct AutoView {
    pub strikes: u8,
    pub strikes_out: u8,
    pub brake_on: bool,
    pub brake_until: Option<u64>,
    pub brake_rounds: u64,
    pub brake_loss_bps: u32,
    /// The settled result of the last 7 rounds (signed dollars e6) and the pool it is measured against.
    pub loss_window_result: wire::I128,
    pub loss_window_base: U128,
    pub term_ends_at: u64,
    pub term_ms: u64,
    pub dead_man_rounds: u64,
    /// The current round can be abandoned from this time on (ms), if it is still unsettled with a bet.
    pub abandon_from: Option<u64>,
}

fn read() -> Option<AutoState> {
    env::storage_read(&key()).map(|b| borsh::from_slice(&b).unwrap_or_else(|_| env::panic_str("auto state")))
}
/// The round the brake lifts in, if it is on (for the rulebook line).
pub(crate) fn brake_until() -> Option<u64> {
    read().and_then(|s| s.brake_until)
}
fn write(s: &AutoState) {
    env::storage_write(&key(), &borsh::to_vec(s).unwrap_or_else(|_| env::panic_str("auto state")));
}

impl Coin {
    fn auto_state(&self) -> AutoState {
        read().unwrap_or_else(|| AutoState { term_ends_at: Self::now() + TERM_MS, ..Default::default() })
    }

    /// Whether the brake halves the limits in `round_id`.
    pub(crate) fn brake_on(&self, round_id: u64) -> bool {
        read().and_then(|s| s.brake_until).is_some_and(|u| round_id < u)
    }

    /// The last `BRAKE_ROUNDS` settled rounds before `round_id`: (sum of results, the pool at the first of them).
    fn loss_window(&self, round_id: u64) -> (i128, u128) {
        let first = round_id.saturating_sub(BRAKE_ROUNDS).max(1);
        let mut sum = 0i128;
        let mut base = None;
        for id in first..round_id {
            if let Some(r) = self.rounds.get(&id) {
                base.get_or_insert(r.brave_at_open);
                if r.settled {
                    sum += r.result;
                }
            }
        }
        (sum, base.unwrap_or(self.books.brave_total))
    }

    /// A round's first ruling (propose, before `rw_ruling`): strikes. `code` for a NOPE.
    pub(crate) fn auto_first_ruling(&mut self, round_id: u64, verdict: u8, code: Option<Refusal>) {
        if self.rw.round_verdict.contains_key(&round_id) {
            return; // not the first ruling of the round
        }
        let mut s = self.auto_state();
        match verdict {
            crate::rewards::YES => s.strikes = 0,
            crate::rewards::NOPE => {
                let own = code.is_some_and(|c| (2..=11).contains(&(c as u8)));
                if own && s.last_strike_round != round_id {
                    s.strikes += 1;
                    s.last_strike_round = round_id;
                    if s.strikes >= STRIKES_OUT {
                        s.strikes = 0;
                        self.strikes_out(round_id);
                    }
                }
            }
            _ => {}
        }
        write(&s);
    }

    fn strikes_out(&mut self, round_id: u64) {
        let (rank, status) = self.rank_now();
        if status != Status::Employed {
            return;
        }
        if rank == Rank::Intern {
            self.rank = RankRec { rank: self.rank.rank, status: status_code(Status::Fired), since_round: round_id, pending: None };
            self.feed.push(EventName::StrikesOut, json!({"round_id": round_id, "strikes": STRIKES_OUT, "action": "FIRE"}));
            self.feed.push(EventName::Fired, json!({"round_id": round_id}));
        } else {
            let (to, _) = rules::vote::outcome(VoteKind::Demote, rank, status);
            self.rank = RankRec { rank: rank_code(to), status: self.rank.status, since_round: round_id, pending: None };
            self.feed.push(
                EventName::StrikesOut,
                json!({"round_id": round_id, "strikes": STRIKES_OUT, "action": "DEMOTE", "to": to}),
            );
            self.feed.push(EventName::RankChanged, json!({"from": rank, "to": to, "effective_round": round_id}));
        }
    }

    /// tick, after a round opened: the brake and the term.
    pub(crate) fn auto_on_open(&mut self, round_id: u64) {
        let mut s = self.auto_state();
        // The brake.
        match s.brake_until {
            Some(u) if round_id >= u => {
                s.brake_until = None;
                self.feed.push(EventName::BrakeOff, json!({"round_id": round_id}));
            }
            Some(_) => {}
            None => {
                let (sum, base) = self.loss_window(round_id);
                if sum < 0 && base > 0 && (sum.unsigned_abs()).saturating_mul(10_000) >= base.saturating_mul(BRAKE_LOSS_BPS) {
                    let until = round_id + BRAKE_ROUNDS;
                    s.brake_until = Some(until);
                    self.feed.push(
                        EventName::BrakeOn,
                        json!({"round_id": round_id, "result": wire::I128(sum), "base": U128(base), "until_round": until}),
                    );
                }
            }
        }
        // The term.
        let (_, status) = self.rank_now();
        if status == Status::Employed && Self::now() >= s.term_ends_at {
            self.rank = RankRec { rank: self.rank.rank, status: status_code(Status::Fired), since_round: round_id, pending: None };
            self.feed.push(EventName::TermLapsed, json!({"round_id": round_id, "term_ended_at": s.term_ends_at}));
            self.feed.push(EventName::Fired, json!({"round_id": round_id}));
        }
        write(&s);
    }

    /// A passed RENEW vote: 30 more days from the later of now and the term's end.
    pub(crate) fn auto_renew(&mut self) {
        let mut s = self.auto_state();
        s.term_ends_at = s.term_ends_at.max(Self::now()) + TERM_MS;
        self.feed.push(EventName::TermRenewed, json!({"term_ends_at": s.term_ends_at}));
        write(&s);
    }

    /// A rehire that takes effect: a new term from now.
    pub(crate) fn auto_new_term(&mut self) {
        let mut s = self.auto_state();
        s.term_ends_at = Self::now() + TERM_MS;
        s.strikes = 0;
        write(&s);
    }

    fn abandon_from(&self, r: &RoundRec) -> Option<u64> {
        if r.settled || r.at_risk == 0 {
            return None;
        }
        let t = clock::times(&self.cfg.offsets(), r.started_at)?;
        Some(t.close_from + DEAD_MAN_ROUNDS * self.cfg.round_ms)
    }
}

#[near]
impl Coin {
    /// 1.7. The dead-man switch: anyone may abandon the current round once its bets have had no result for
    /// `DEAD_MAN_ROUNDS` round lengths after its close time. Bets without a result are booked as lost, the Intern is
    /// fired, and the round settles (attach at least 150 TGas, as for `settle`).
    pub fn abandon(&mut self, round_id: u64) -> PromiseOrValue<Option<wire::I128>> {
        self.tick();
        let r = self.current.expect("a round is always open");
        require!(r.id == round_id, "only the current round can be abandoned");
        let from = self.abandon_from(&r).unwrap_or_else(|| env::panic_str("this round has no open bet to abandon"));
        require!(Self::now() >= from, format!("too early: a round can be abandoned from {from} (ms)"));
        let ids = self.round_positions.get(&round_id).cloned().unwrap_or_default();
        let mut booked = 0u32;
        for id in &ids {
            let mut p = *self.positions.get(id).expect("position");
            if p.returned.is_none() {
                p.returned = Some(0);
                p.result_source = Some(ABANDONED);
                self.positions.insert(*id, p);
                booked += 1;
            }
        }
        let (_, status) = self.rank_now();
        self.feed.push(EventName::Abandoned, json!({"round_id": round_id, "bets_booked_lost": booked}));
        if status == Status::Employed {
            self.rank = RankRec { rank: self.rank.rank, status: status_code(Status::Fired), since_round: round_id, pending: None };
            self.feed.push(EventName::Fired, json!({"round_id": round_id}));
        }
        self.settle(round_id)
    }

    /// 1.7. Strikes, the brake, the term and the dead-man switch, as they stand.
    pub fn get_auto(&self) -> AutoView {
        let s = self.auto_state();
        let (r, ..) = self.projected();
        let (sum, base) = self.loss_window(r.id);
        AutoView {
            strikes: s.strikes,
            strikes_out: STRIKES_OUT,
            brake_on: s.brake_until.is_some_and(|u| r.id < u),
            brake_until: s.brake_until,
            brake_rounds: BRAKE_ROUNDS,
            brake_loss_bps: BRAKE_LOSS_BPS as u32,
            loss_window_result: wire::I128(sum),
            loss_window_base: U128(base),
            term_ends_at: s.term_ends_at,
            term_ms: TERM_MS,
            dead_man_rounds: DEAD_MAN_ROUNDS,
            abandon_from: self.abandon_from(&r),
        }
    }
}
