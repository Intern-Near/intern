//! Step 5 of the Engine 1 brief: locks, votes and rank changes (01-SHARED-INTERFACE.md section
//! 9.2 with its 1.1 rules, and the 1.2 rule for demote and fire: yes of at least 34% of all the
//! weight locked when the vote opened).
//!
//! Readings where the interface is silent (reported to the owner):
//! - "Still OPEN" for `unlock`: a vote is open until it is finished or its `closes_at` has passed.
//!   After `closes_at` its outcome is fixed, so unlocking can no longer change it.
//! - A vote of a kind whose previous vote has run out of time but was never finished: opening the
//!   new one finishes the old one first.
//! - A vote that passes on the votes but no longer fits the Intern's state when it is finished
//!   (for example a promotion while the Intern was fired in the meantime) ends FAILED, with a log.
//! - A vote cannot be opened while no locked coin has any weight, and a cast with zero weight is
//!   refused (it would use up the boss's one cast for nothing).
//! - The weight of all locked coins (`locked_weight_at_open`) is computed from totals per lock
//!   round, rounded down once; it can exceed the sum of the bosses' own weights by a few units,
//!   which only makes a vote very slightly harder to pass.

use crate::*;
use rules::vote::{self as rv, CannotOpen, Tally, VoteKind, RULES};

/// Lock lots kept per boss (storage is paid by the registration). A fifth lock in a new round
/// first merges two lots that already have full weight; failing that, it joins the newest lot,
/// whose weight then starts again from this round.
pub const MAX_LOTS: usize = 4;

const OPEN: u8 = 0;
const PASSED: u8 = 1;
const FAILED: u8 = 2;

/// A boss's locked coins.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LockRec {
    /// (coins, the round they were locked in), oldest first. At most `MAX_LOTS`.
    pub lots: Vec<(u128, u64)>,
    pub total: u128,
    /// Ids of votes this boss cast in that may still be open (one open vote per kind, so few).
    pub cast_in: Vec<u64>,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VoteRec {
    pub id: u64,
    pub kind: u8,
    pub opened_by: AccountId,
    pub opened_at: u64,
    pub closes_at: u64,
    /// The round running when the vote opened: weights are measured against it.
    pub vote_round: u64,
    pub yes: u128,
    pub no: u128,
    pub locked_weight_at_open: u128,
    /// 0 OPEN, 1 PASSED, 2 FAILED
    pub state: u8,
    pub effective_round: Option<u64>,
}

pub(crate) fn kind_of(c: u8) -> VoteKind {
    VoteKind::ALL[c as usize % VoteKind::ALL.len()]
}
fn kind_code(k: VoteKind) -> u8 {
    VoteKind::ALL.iter().position(|x| *x == k).expect("listed") as u8
}
fn to_wire(k: VoteKind) -> wire::VoteKind {
    match k {
        VoteKind::Promote => wire::VoteKind::Promote,
        VoteKind::Demote => wire::VoteKind::Demote,
        VoteKind::Fire => wire::VoteKind::Fire,
        VoteKind::Rehire => wire::VoteKind::Rehire,
        VoteKind::SetPlaybook => wire::VoteKind::SetPlaybook,
    }
}
fn from_wire(k: wire::VoteKind) -> VoteKind {
    match k {
        wire::VoteKind::Promote => VoteKind::Promote,
        wire::VoteKind::Demote => VoteKind::Demote,
        wire::VoteKind::Fire => VoteKind::Fire,
        wire::VoteKind::Rehire => VoteKind::Rehire,
        wire::VoteKind::SetPlaybook => VoteKind::SetPlaybook,
    }
}

fn why(e: CannotOpen) -> &'static str {
    match e {
        CannotOpen::WrongStatus => "REHIRE only while the Intern is FIRED; PROMOTE, DEMOTE and FIRE only while it is EMPLOYED",
        CannotOpen::NoRankThatWay => "there is no rank that way (PROMOTE at TRADER, or DEMOTE at INTERN)",
        CannotOpen::ChangeWaiting => "a promotion, rehire or playbook change that passed is still waiting to take effect",
    }
}

impl Coin {
    pub(crate) fn lock_rec(&self, who: &AccountId) -> LockRec {
        self.locks.get(who).cloned().unwrap_or_default()
    }

    fn save_lock(&mut self, who: &AccountId, l: LockRec) {
        if l == LockRec::default() {
            self.locks.remove(who);
        } else {
            self.locks.insert(who.clone(), l);
        }
    }

    pub(crate) fn locked_of(&self, who: &AccountId) -> u128 {
        self.locks.get(who).map_or(0, |l| l.total)
    }

    /// A boss's weight for a vote opened in round `v` (lots locked in `v` or later count zero).
    pub(crate) fn weight_of(&self, who: &AccountId, v: u64) -> u128 {
        rv::weight(self.lock_rec(who).lots.iter().copied(), v, &RULES)
    }

    /// The weight of all locked coins for a vote opened in round `v`.
    pub(crate) fn total_weight(&self, v: u64) -> u128 {
        let mut recent = Vec::new();
        let mut recent_sum: u128 = 0;
        for l in v.saturating_sub(RULES.weight_full_rounds as u64)..=v {
            if let Some(a) = self.locked_by_round.get(&l).copied().filter(|a| *a > 0) {
                recent.push((a, l));
                recent_sum += a;
            }
        }
        // Everything locked earlier has full weight.
        let old = self.locked_total - recent_sum;
        rv::weight(core::iter::once((old, 0)).chain(recent), v, &RULES)
    }

    fn bucket_add(&mut self, round: u64, a: u128) {
        let b = self.locked_by_round.get(&round).copied().unwrap_or(0) + a;
        self.locked_by_round.insert(round, b);
    }

    fn bucket_sub(&mut self, round: u64, a: u128) {
        let b = self.locked_by_round.get(&round).copied().unwrap_or(0) - a;
        if b == 0 {
            self.locked_by_round.remove(&round);
        } else {
            self.locked_by_round.insert(round, b);
        }
    }

    fn vote_is_open(&self, id: u64, now: u64) -> bool {
        self.votes
            .get(&id)
            .is_some_and(|v| v.state == OPEN && now < v.closes_at)
    }

    /// The round that was running at time `t`: the highest round id whose start is not after `t`.
    pub(crate) fn round_at(&self, t: u64) -> u64 {
        let (mut lo, mut hi) = (1, self.current.expect("round").id);
        while lo < hi {
            let mid = lo + (hi - lo).div_ceil(2);
            if self
                .rounds
                .get(&mid)
                .expect("every round is kept")
                .started_at
                <= t
            {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        lo
    }

    fn vote_view(&self, v: &VoteRec) -> wire::Vote {
        wire::Vote {
            id: v.id,
            kind: to_wire(kind_of(v.kind)),
            playbook_id: self.vote_playbook.get(&v.id).copied(),
            opened_by: v.opened_by.clone(),
            opened_at: v.opened_at,
            closes_at: v.closes_at,
            yes: U128(v.yes),
            no: U128(v.no),
            locked_weight_at_open: U128(v.locked_weight_at_open),
            state: match v.state {
                OPEN => wire::VoteState::Open,
                PASSED => wire::VoteState::Passed,
                _ => wire::VoteState::Failed,
            },
            effective_round: v.effective_round,
        }
    }

    /// Decides a vote (at `now`, which is capped at `closes_at`) and applies the result.
    fn finish(&mut self, id: u64, now: u64) {
        let mut v = self.votes.get(&id).cloned().expect("vote");
        let kind = kind_of(v.kind);
        let tally = Tally {
            yes: v.yes,
            no: v.no,
            locked_weight_at_open: v.locked_weight_at_open,
        };
        v.state = FAILED;
        if rv::passed(kind, &tally, &RULES) {
            let (rank, status) = self.rank_now();
            let waiting = self.change_waiting(kind) && !kind.is_tightening();
            match rv::can_open(kind, rank, status, waiting) {
                Ok(()) => {
                    let eff = rv::effective_round(kind, self.round_at(now.min(v.closes_at)));
                    v.state = PASSED;
                    v.effective_round = Some(eff);
                    self.apply_vote(id, kind, eff, rank, status);
                }
                Err(e) => env::log_str(&format!(
                    "vote {id} passed on the votes but no longer applies: {}; it ends FAILED",
                    why(e)
                )),
            }
        }
        if self.open_by_kind[v.kind as usize] == Some(id) {
            self.open_by_kind[v.kind as usize] = None;
        }
        let (state, eff) = (v.state, v.effective_round);
        self.votes.insert(id, v);
        let state = if state == PASSED {
            wire::VoteState::Passed
        } else {
            wire::VoteState::Failed
        };
        self.feed.push(
            EventName::VoteFinished,
            json!({"vote_id": id, "state": state, "effective_round": eff}),
        );
    }

    /// Whether a passed change of this kind is still waiting (a rank change, or for SET_PLAYBOOK a playbook change).
    fn change_waiting(&self, kind: VoteKind) -> bool {
        if kind == VoteKind::SetPlaybook {
            self.s9.pending_playbook.is_some()
        } else {
            self.rank.pending.is_some()
        }
    }

    fn apply_vote(&mut self, vote_id: u64, kind: VoteKind, eff: u64, rank: Rank, status: Status) {
        let now_round = self.current.expect("round").id;
        if kind == VoteKind::SetPlaybook {
            // 1.3: from the start of the second round after it passed, the rulebook carries it.
            let pid = self.vote_playbook.get(&vote_id).copied().unwrap_or(0);
            self.s9.pending_playbook = Some((pid, eff));
            self.feed.push(
                EventName::PlaybookActivated,
                json!({"playbook_id": pid, "effective_round": eff}),
            );
            if now_round >= eff {
                self.open_round_playbook(now_round); // finished late: its round is already running
            }
            return;
        }
        let (to_rank, to_status) = rv::outcome(kind, rank, status);
        if kind.is_tightening() {
            // At once: no new bets beyond the new state from this moment. Cancels a waiting promotion.
            self.rank = RankRec {
                rank: rank_code(to_rank),
                status: status_code(to_status),
                since_round: now_round,
                pending: None,
            };
            if kind == VoteKind::Fire {
                self.feed
                    .push(EventName::Fired, json!({"round_id": now_round}));
            } else {
                self.feed.push(
                    EventName::RankChanged,
                    json!({"from": rank, "to": to_rank, "effective_round": eff}),
                );
            }
        } else {
            self.rank.pending = Some((rank_code(to_rank), status_code(to_status), eff));
            if kind == VoteKind::Rehire {
                self.feed
                    .push(EventName::Rehired, json!({"effective_round": eff}));
            } else {
                self.feed.push(
                    EventName::RankChanged,
                    json!({"from": rank, "to": to_rank, "effective_round": eff}),
                );
            }
            // Finished late: the round it waits for may already be running.
            self.apply_due_rank(now_round);
        }
    }

    /// Applies a waiting promotion or rehire once round `id` is the one it waits for.
    pub(crate) fn apply_due_rank(&mut self, id: u64) {
        if let Some((r, s, e)) = self.rank.pending {
            if id >= e {
                self.rank = RankRec {
                    rank: r,
                    status: s,
                    since_round: id,
                    pending: None,
                };
            }
        }
    }
}

#[near]
impl Coin {
    // ===== section 9.2: voting ======================================================================

    /// Locks free coins for voting. They cannot be moved or cashed out until unlocked.
    pub fn lock(&mut self, amount: U128) {
        require!(amount.0 > 0, "amount must be above 0");
        let who = env::predecessor_account_id();
        require!(self.registered(&who), "not registered");
        self.tick();
        self.materialize(&who);
        let mut l = self.lock_rec(&who);
        require!(
            amount.0 <= self.bal(&who) - l.total,
            "not that many free coins"
        );
        let round = self.current.expect("round").id;
        let mature =
            |lot_round: u64| rv::full_rounds(lot_round, round) >= RULES.weight_full_rounds as u64;
        if l.lots.last().is_none_or(|last| last.1 != round) && l.lots.len() >= MAX_LOTS {
            // Make room: merge two lots that already have full weight (they keep it for good) ...
            if let Some(i) =
                (0..l.lots.len() - 1).find(|&i| mature(l.lots[i].1) && mature(l.lots[i + 1].1))
            {
                let (a, r) = l.lots.remove(i);
                self.bucket_sub(r, a);
                let into = l.lots[i].1;
                self.bucket_add(into, a);
                l.lots[i].0 += a;
            } else {
                // ... or else the newest lot joins this round's lock and its weight starts again.
                let (a, r) = l.lots.pop().expect("full");
                self.bucket_sub(r, a);
                self.bucket_add(round, a);
                l.lots.push((a, round));
                env::log_str("four lock lots is the most: your newest lot joins this lock and its weight starts again");
            }
        }
        match l.lots.last_mut() {
            Some(last) if last.1 == round => last.0 += amount.0,
            _ => l.lots.push((amount.0, round)),
        }
        l.total += amount.0;
        self.locked_total += amount.0;
        self.bucket_add(round, amount.0);
        self.save_lock(&who, l);
        self.feed.push(
            EventName::Locked,
            json!({"account_id": who, "amount": amount}),
        );
    }

    /// Unlocks coins, newest lots first (the oldest keep their weight). Refused while the boss has
    /// voted in a vote that is still open.
    pub fn unlock(&mut self, amount: U128) {
        require!(amount.0 > 0, "amount must be above 0");
        let who = env::predecessor_account_id();
        self.tick();
        let now = Self::now();
        let mut l = self.lock_rec(&who);
        require!(amount.0 <= l.total, "not that many locked coins");
        l.cast_in.retain(|id| self.vote_is_open(*id, now));
        if let Some(id) = l.cast_in.first() {
            let closes = self.votes.get(id).expect("vote").closes_at;
            env::panic_str(&format!(
                "you voted in vote {id}, which is still open: unlock after it closes at {closes}"
            ));
        }
        let mut left = amount.0;
        while left > 0 {
            let last = l.lots.last_mut().expect("enough locked");
            let take = left.min(last.0);
            let r = last.1;
            last.0 -= take;
            if last.0 == 0 {
                l.lots.pop();
            }
            self.bucket_sub(r, take);
            left -= take;
        }
        l.total -= amount.0;
        self.locked_total -= amount.0;
        self.save_lock(&who, l);
        self.feed.push(
            EventName::Unlocked,
            json!({"account_id": who, "amount": amount}),
        );
    }

    /// Opens a vote. One open vote per kind at a time. Returns the vote id.
    pub fn open_vote(&mut self, kind: wire::VoteKind, playbook_id: Option<u64>) -> u64 {
        let who = env::predecessor_account_id();
        require!(
            self.locked_of(&who) > 0,
            "only a boss with locked coins can open a vote"
        );
        let k0 = from_wire(kind);
        if k0 == VoteKind::SetPlaybook {
            // 1.3: the playbook to activate, or 0 to clear it.
            let pid = playbook_id.unwrap_or_else(|| {
                env::panic_str("SET_PLAYBOOK needs a playbook_id (0 clears the playbook)")
            });
            require!(
                pid == 0 || self.playbooks.contains_key(&pid),
                "no such playbook"
            );
        } else {
            require!(
                playbook_id.is_none(),
                "only SET_PLAYBOOK takes a playbook_id"
            );
        }
        self.tick();
        let now = Self::now();
        let k = from_wire(kind);
        if let Some(id) = self.open_by_kind[kind_code(k) as usize] {
            let closes = self.votes.get(&id).expect("vote").closes_at;
            require!(
                now >= closes,
                format!("a {} vote is already open: vote {id}", k.as_str())
            );
            self.finish(id, now); // its time ran out but nobody finished it
        }
        let (rank, status) = self.rank_now();
        if let Err(e) = rv::can_open(k, rank, status, self.change_waiting(k)) {
            env::panic_str(why(e));
        }
        let v = self.current.expect("round").id;
        let w = self.total_weight(v);
        require!(
            w > 0,
            "no locked coin has any weight yet: coins count after one full round locked"
        );
        let id = self.next_vote_id;
        self.next_vote_id += 1;
        let closes_at = now + self.cfg.round_ms; // vote_ms: one round length
        self.votes.insert(
            id,
            VoteRec {
                id,
                kind: kind_code(k),
                opened_by: who.clone(),
                opened_at: now,
                closes_at,
                vote_round: v,
                yes: 0,
                no: 0,
                locked_weight_at_open: w,
                state: OPEN,
                effective_round: None,
            },
        );
        self.open_by_kind[kind_code(k) as usize] = Some(id);
        if k == VoteKind::SetPlaybook {
            self.vote_playbook.insert(id, playbook_id.unwrap_or(0));
        }
        self.feed.push(
            EventName::VoteOpened,
            json!({"vote_id": id, "kind": kind, "playbook_id": playbook_id, "opened_by": who, "closes_at": closes_at}),
        );
        id
    }

    /// Votes once, with the weight of the coins locked before the vote opened and still locked.
    pub fn cast(&mut self, vote_id: u64, support: bool) {
        let who = env::predecessor_account_id();
        self.tick();
        let now = Self::now();
        let mut v = self
            .votes
            .get(&vote_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("no such vote"));
        require!(v.state == OPEN && now < v.closes_at, "this vote is closed");
        let mut l = self.lock_rec(&who);
        l.cast_in.retain(|id| self.vote_is_open(*id, now));
        require!(
            !l.cast_in.contains(&vote_id),
            "you already voted in this vote"
        );
        let w = rv::weight(l.lots.iter().copied(), v.vote_round, &RULES);
        require!(w > 0, "your locked coins have no weight in this vote: coins count after one full round locked before it opened");
        if support {
            v.yes += w;
        } else {
            v.no += w;
        }
        l.cast_in.push(vote_id);
        self.save_lock(&who, l);
        self.votes.insert(vote_id, v);
        self.feed.push(
            EventName::VoteCast,
            json!({"vote_id": vote_id, "account_id": who, "support": support, "weight": U128(w)}),
        );
    }

    /// Anyone, after `closes_at`. A DEMOTE or FIRE vote may be finished earlier, the moment yes
    /// reaches 34% of the weight locked when it opened.
    pub fn finish_vote(&mut self, vote_id: u64) -> wire::Vote {
        self.tick();
        let now = Self::now();
        let v = self
            .votes
            .get(&vote_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("no such vote"));
        require!(v.state == OPEN, "this vote is already finished");
        if now < v.closes_at {
            let t = Tally {
                yes: v.yes,
                no: v.no,
                locked_weight_at_open: v.locked_weight_at_open,
            };
            require!(
                rv::can_finish_early(kind_of(v.kind), &t, &RULES),
                format!("the vote is open until {}", v.closes_at)
            );
        }
        self.finish(vote_id, now);
        self.vote_view(self.votes.get(&vote_id).expect("vote"))
    }

    /// Newest first; `from` is the highest id to return.
    pub fn get_votes(&self, from: Option<u64>, limit: Option<u32>) -> Vec<wire::Vote> {
        let last = self.next_vote_id - 1;
        let start = from.map_or(last, |f| f.min(last));
        let n = limit.map_or(50, |l| l.clamp(1, 100)) as u64;
        (start.saturating_sub(n - 1).max(1)..=start)
            .rev()
            .filter_map(|i| self.votes.get(&i))
            .map(|v| self.vote_view(v))
            .collect()
    }
}
