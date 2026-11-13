//! Section 9.2: voting (1.1). Numbers `PROPOSED`, served in `get_constants().vote`.
//!
//! Readings taken where the interface is silent (reported to the owner):
//! - "Full rounds since they were locked": coins locked while round `L` was running, at a vote
//!   opened while round `V` is running, count the rounds strictly between: `V − L − 1`.
//! - A vote nobody joined does not pass. A tightening vote cannot pass with no yes weight.
//! - 1.2 (owner's decision, 2026-11-12): demote and fire pass when yes is at least 34% of ALL the
//!   weight locked when the vote opened (no longer 34% of the weight that voted, which let one
//!   tiny boss fire the Intern when nobody else voted). The pass test and the early-finish test
//!   are now the same test.
//! - A loosening vote cannot be opened while a promotion or rehire is still waiting.

use crate::math::mul_wide;
use shared::{Rank, Status};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum VoteKind {
    Promote,
    Demote,
    Fire,
    Rehire,
    SetPlaybook,
    /// 1.5 (R6): one long-shot ticket, at most once every seven rounds. Appended: stored kinds keep their codes.
    LongShot,
    /// 1.7: extends the Intern's term by 30 days (the coin's `auto` module). Appended.
    Renew,
    /// 1.7: corrects a challenged result (the coin's `challenge` module); opened by a challenge, not by `open_vote`.
    Correct,
}

impl VoteKind {
    pub const ALL: [VoteKind; 8] = [
        VoteKind::Promote,
        VoteKind::Demote,
        VoteKind::Fire,
        VoteKind::Rehire,
        VoteKind::SetPlaybook,
        VoteKind::LongShot,
        VoteKind::Renew,
        VoteKind::Correct,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            VoteKind::Promote => "PROMOTE",
            VoteKind::Demote => "DEMOTE",
            VoteKind::Fire => "FIRE",
            VoteKind::Rehire => "REHIRE",
            VoteKind::SetPlaybook => "SET_PLAYBOOK",
            VoteKind::LongShot => "LONG_SHOT",
            VoteKind::Renew => "RENEW",
            VoteKind::Correct => "CORRECT",
        }
    }

    /// Demote and fire: fast, lower bar, no quorum, act at once.
    pub const fn is_tightening(self) -> bool {
        matches!(self, VoteKind::Demote | VoteKind::Fire)
    }
}

/// `get_constants().vote`, without `vote_ms` (a time, kept with the clock).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VoteRules {
    pub promote_pass_bps: u32,
    pub promote_quorum_bps: u32,
    pub tighten_pass_bps: u32,
    pub weight_full_rounds: u32,
}

/// The `PROPOSED` numbers of section 9.2.
pub const RULES: VoteRules = VoteRules {
    promote_pass_bps: 5_000,
    promote_quorum_bps: 2_000,
    tighten_pass_bps: 3_400,
    weight_full_rounds: 7,
};

/// Rounds strictly between the lock and the vote: `V − L − 1`, never below 0.
pub fn full_rounds(locked_in_round: u64, vote_round: u64) -> u64 {
    vote_round.saturating_sub(locked_in_round).saturating_sub(1)
}

/// One lot's weight: `amount × min(full rounds, 7) / 7`, rounded down.
pub fn lot_weight(amount: u128, locked_in_round: u64, vote_round: u64, r: &VoteRules) -> u128 {
    weight(core::iter::once((amount, locked_in_round)), vote_round, r)
}

/// The weight of a set of lots `(amount, locked_in_round)` for a vote opened in `vote_round`,
/// rounded down once at the end. The caller passes only lots that were locked before the vote
/// opened and are still locked (1.1).
pub fn weight(lots: impl IntoIterator<Item = (u128, u64)>, vote_round: u64, r: &VoteRules) -> u128 {
    let full = r.weight_full_rounds.max(1) as u128;
    let mut whole: u128 = 0; // Σ amount for lots at full weight
    let mut parts: u128 = 0; // Σ amount × rounds, for lots still growing
    for (amount, locked) in lots {
        let k = (full_rounds(locked, vote_round) as u128).min(full);
        if k == full {
            whole = whole.saturating_add(amount);
        } else {
            parts = parts.saturating_add(amount.saturating_mul(k));
        }
    }
    whole.saturating_add(parts / full)
}

/// The tally of a vote.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Tally {
    pub yes: u128,
    pub no: u128,
    pub locked_weight_at_open: u128,
}

/// Compares `a × 10,000` with `b × bps` in 256 bits, so it is exact for every input.
fn cmp_bps(a: u128, bps: u32, b: u128) -> core::cmp::Ordering {
    mul_wide(a, 10_000).cmp(&mul_wide(b, bps as u128))
}

/// `a ≥ bps/10,000 of b`, exactly.
fn at_least(a: u128, bps: u32, b: u128) -> bool {
    cmp_bps(a, bps, b) != core::cmp::Ordering::Less
}

/// `a > bps/10,000 of b`, exactly.
fn above(a: u128, bps: u32, b: u128) -> bool {
    cmp_bps(a, bps, b) == core::cmp::Ordering::Greater
}

/// Whether the vote passed, judged at `closes_at` (1.1: whatever the time `finish_vote` is called).
///
/// - Promote, rehire, set playbook: yes above `promote_pass_bps` of the weight that voted, and
///   total votes at least `promote_quorum_bps` of `locked_weight_at_open`.
/// - Demote, fire (1.2): yes at least `tighten_pass_bps` of `locked_weight_at_open`. "No" votes do
///   not change the result: a third of all locked weight can always demote or fire.
/// - Nobody voted: fails.
pub fn passed(kind: VoteKind, t: &Tally, r: &VoteRules) -> bool {
    let voted = t.yes.saturating_add(t.no);
    if voted == 0 {
        return false;
    }
    if kind.is_tightening() {
        at_least(t.yes, r.tighten_pass_bps, t.locked_weight_at_open)
    } else {
        above(t.yes, r.promote_pass_bps, voted)
            && at_least(voted, r.promote_quorum_bps, t.locked_weight_at_open)
    }
}

/// 1.1: a demote or fire vote may be finished before `closes_at` once yes reaches
/// `tighten_pass_bps` of `locked_weight_at_open`. Needs some yes weight.
pub fn can_finish_early(kind: VoteKind, t: &Tally, r: &VoteRules) -> bool {
    kind.is_tightening()
        && t.yes > 0
        && at_least(t.yes, r.tighten_pass_bps, t.locked_weight_at_open)
}

/// Why a vote cannot be opened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CannotOpen {
    /// REHIRE only while FIRED; PROMOTE, DEMOTE, FIRE only while EMPLOYED (1.1).
    WrongStatus,
    /// PROMOTE at TRADER, or DEMOTE at INTERN (1.1).
    NoRankThatWay,
    /// A promotion or rehire (or, for SET_PLAYBOOK, a playbook change) is still waiting to take effect.
    ChangeWaiting,
}

/// Section 9.2 (1.1) opening rules. `change_waiting`: a passed promotion or rehire has not taken
/// effect yet; for SET_PLAYBOOK (1.3), a passed playbook change has not. (One open vote per kind is
/// the contract's own bookkeeping.)
pub fn can_open(
    kind: VoteKind,
    rank: Rank,
    status: Status,
    change_waiting: bool,
) -> Result<(), CannotOpen> {
    match kind {
        // 1.3: in any rank or status; a playbook never changes what may be traded.
        VoteKind::SetPlaybook if change_waiting => Err(CannotOpen::ChangeWaiting),
        VoteKind::SetPlaybook => Ok(()),
        // 1.5 (R6): only while employed, and not while a ticket waits or the last one is under seven rounds old.
        VoteKind::LongShot if status != Status::Employed => Err(CannotOpen::WrongStatus),
        VoteKind::LongShot if change_waiting => Err(CannotOpen::ChangeWaiting),
        VoteKind::LongShot => Ok(()),
        // 1.7: only while employed (a fired Intern is rehired instead).
        VoteKind::Renew if status != Status::Employed => Err(CannotOpen::WrongStatus),
        VoteKind::Renew => Ok(()),
        // 1.7: in any rank or status (a correction changes a past result, not what may be traded).
        VoteKind::Correct => Ok(()),
        VoteKind::Rehire if status != Status::Fired => Err(CannotOpen::WrongStatus),
        VoteKind::Rehire if change_waiting => Err(CannotOpen::ChangeWaiting),
        VoteKind::Rehire => Ok(()),
        _ if status != Status::Employed => Err(CannotOpen::WrongStatus),
        VoteKind::Promote if rank == Rank::Trader => Err(CannotOpen::NoRankThatWay),
        VoteKind::Promote if change_waiting => Err(CannotOpen::ChangeWaiting),
        VoteKind::Demote if rank == Rank::Intern => Err(CannotOpen::NoRankThatWay),
        _ => Ok(()),
    }
}

/// The round a passed vote takes effect in. `round_at_pass` is the round running at the moment the
/// vote passed (`closes_at`, or the early finish).
/// - Loosening: the start of the second round to open after it passed, so one full round runs in
///   between: `round_at_pass + 2`.
/// - Tightening: at once, in the round running when it passed.
pub fn effective_round(kind: VoteKind, round_at_pass: u64) -> u64 {
    if kind.is_tightening() {
        round_at_pass
    } else {
        round_at_pass.saturating_add(2)
    }
}

/// The rank and status a passed vote leads to. Promote and demote move one step and stop at the
/// ends; fire keeps the rank and sets FIRED; rehire returns at INTERN, EMPLOYED.
pub fn outcome(kind: VoteKind, rank: Rank, status: Status) -> (Rank, Status) {
    match kind {
        VoteKind::Promote => (
            match rank {
                Rank::Intern => Rank::Analyst,
                Rank::Analyst | Rank::Trader => Rank::Trader,
            },
            status,
        ),
        VoteKind::Demote => (
            match rank {
                Rank::Trader => Rank::Analyst,
                Rank::Analyst | Rank::Intern => Rank::Intern,
            },
            status,
        ),
        VoteKind::Fire => (rank, Status::Fired),
        VoteKind::Rehire => (Rank::Intern, Status::Employed),
        VoteKind::SetPlaybook | VoteKind::LongShot | VoteKind::Renew | VoteKind::Correct => (rank, status),
    }
}

/// 1.1: a demotion or a firing cancels a promotion that is still waiting.
pub fn cancels_waiting_promotion(kind: VoteKind) -> bool {
    kind.is_tightening()
}

#[cfg(test)]
mod tests {
    use super::*;

    const R: VoteRules = RULES;

    #[test]
    fn long_shot_passes_like_a_promotion_and_opens_only_when_allowed() {
        let k = VoteKind::LongShot;
        assert_eq!(k.as_str(), "LONG_SHOT");
        assert_eq!(kind_index(k), 5, "appended: stored kinds keep their codes");
        assert!(!k.is_tightening());
        assert_eq!(effective_round(k, 10), 12);
        assert_eq!(outcome(k, Rank::Intern, Status::Employed), (Rank::Intern, Status::Employed));
        assert_eq!(can_open(k, Rank::Intern, Status::Employed, false), Ok(()));
        assert_eq!(can_open(k, Rank::Intern, Status::Fired, false), Err(CannotOpen::WrongStatus));
        assert_eq!(can_open(k, Rank::Trader, Status::Employed, true), Err(CannotOpen::ChangeWaiting));
        // More than half of the weight that voted, and 20% turnout.
        let t = |yes, no| Tally { yes, no, locked_weight_at_open: 1_000 };
        assert!(passed(k, &t(151, 50), &R));
        assert!(!passed(k, &t(100, 100), &R), "half is not more than half");
        assert!(!passed(k, &t(150, 0), &R), "150 of 1,000 is under the 20% turnout");
        assert!(passed(k, &t(200, 0), &R), "200 of 1,000 is 20% turnout");
    }

    fn kind_index(k: VoteKind) -> usize {
        VoteKind::ALL.iter().position(|x| *x == k).unwrap()
    }

    #[test]
    fn coins_locked_in_or_after_the_vote_round_count_zero() {
        assert_eq!(lot_weight(700, 10, 10, &R), 0);
        assert_eq!(lot_weight(700, 11, 10, &R), 0);
        assert_eq!(
            lot_weight(700, 9, 10, &R),
            0,
            "round 9 has not finished a full round by round 10"
        );
    }

    #[test]
    fn weight_grows_one_seventh_per_full_round_then_stops() {
        let w = |rounds_before: u64| lot_weight(700, 100 - rounds_before - 1, 100, &R);
        assert_eq!((w(1), w(2), w(7), w(8), w(50)), (100, 200, 700, 700, 700));
        // A one-round holder has one seventh of a seven-round holder's weight.
        assert_eq!(w(7), 7 * w(1));
    }

    #[test]
    fn weight_rounds_down_once() {
        // 3 lots of 1 unit at one full round: 3/7 → 0 per lot, but counted together still 0.
        assert_eq!(weight([(1, 8), (1, 8), (1, 8)], 10, &R), 0);
        assert_eq!(weight([(4, 8), (4, 8)], 10, &R), 1, "8/7 rounds down to 1");
    }

    #[test]
    fn a_demotion_passes_at_34_percent_of_all_locked_weight_with_no_quorum() {
        let t = |yes, no| Tally {
            yes,
            no,
            locked_weight_at_open: 1_000,
        };
        assert!(passed(VoteKind::Demote, &t(340, 0), &R));
        assert!(!passed(VoteKind::Demote, &t(339, 0), &R));
        assert!(
            passed(VoteKind::Fire, &t(340, 660), &R),
            "no votes do not block: a third of all locked weight is enough"
        );
    }

    #[test]
    fn one_tiny_boss_cannot_fire_the_intern_alone() {
        // 1.2: the case that made the owner change the rule. 1 unit of yes, nobody else voted.
        let t = Tally {
            yes: 1,
            no: 0,
            locked_weight_at_open: 1_000_000,
        };
        assert!(!passed(VoteKind::Fire, &t, &R));
        assert!(!passed(VoteKind::Demote, &t, &R));
        assert!(!can_finish_early(VoteKind::Fire, &t, &R));
    }

    #[test]
    fn a_promotion_needs_a_majority_and_the_quorum() {
        let t = |yes, no| Tally {
            yes,
            no,
            locked_weight_at_open: 1_000,
        };
        assert!(
            passed(VoteKind::Promote, &t(101, 99), &R),
            "200 of 1,000 voted: quorum met"
        );
        assert!(
            !passed(VoteKind::Promote, &t(100, 100), &R),
            "a tie is not above half"
        );
        assert!(
            !passed(VoteKind::Promote, &t(199, 0), &R),
            "199 of 1,000 voted: under the 20% quorum"
        );
        assert!(passed(VoteKind::Rehire, &t(200, 0), &R));
    }

    #[test]
    fn a_vote_nobody_joined_fails() {
        let t = Tally {
            yes: 0,
            no: 0,
            locked_weight_at_open: 0,
        };
        for k in VoteKind::ALL {
            assert!(!passed(k, &t, &R), "{}", k.as_str());
            assert!(!can_finish_early(k, &t, &R));
        }
    }

    #[test]
    fn early_finish_only_for_tightening() {
        let t = Tally {
            yes: 340,
            no: 0,
            locked_weight_at_open: 1_000,
        };
        assert!(can_finish_early(VoteKind::Fire, &t, &R));
        assert!(can_finish_early(VoteKind::Demote, &t, &R));
        assert!(!can_finish_early(VoteKind::Promote, &t, &R));
        assert!(!can_finish_early(
            VoteKind::Fire,
            &Tally { yes: 339, ..t },
            &R
        ));
    }

    #[test]
    fn opening_rules() {
        use CannotOpen::*;
        let e = Status::Employed;
        let f = Status::Fired;
        assert_eq!(
            can_open(VoteKind::Rehire, Rank::Intern, e, false),
            Err(WrongStatus)
        );
        assert_eq!(can_open(VoteKind::Rehire, Rank::Analyst, f, false), Ok(()));
        assert_eq!(
            can_open(VoteKind::Fire, Rank::Intern, f, false),
            Err(WrongStatus)
        );
        assert_eq!(
            can_open(VoteKind::Promote, Rank::Trader, e, false),
            Err(NoRankThatWay)
        );
        assert_eq!(
            can_open(VoteKind::Demote, Rank::Intern, e, false),
            Err(NoRankThatWay)
        );
        assert_eq!(
            can_open(VoteKind::Promote, Rank::Intern, e, true),
            Err(ChangeWaiting)
        );
        assert_eq!(
            can_open(VoteKind::Demote, Rank::Analyst, e, true),
            Ok(()),
            "tightening can always be opened"
        );
        assert_eq!(
            can_open(VoteKind::SetPlaybook, Rank::Intern, e, false),
            Ok(())
        );
        assert_eq!(
            can_open(VoteKind::SetPlaybook, Rank::Trader, Status::Fired, false),
            Ok(()),
            "1.3: any rank or status"
        );
        assert_eq!(
            can_open(VoteKind::SetPlaybook, Rank::Intern, e, true),
            Err(ChangeWaiting)
        );
    }

    #[test]
    fn effects() {
        assert_eq!(effective_round(VoteKind::Promote, 43), 45);
        assert_eq!(effective_round(VoteKind::Fire, 43), 43);
        assert_eq!(
            outcome(VoteKind::Promote, Rank::Intern, Status::Employed),
            (Rank::Analyst, Status::Employed)
        );
        assert_eq!(
            outcome(VoteKind::Demote, Rank::Trader, Status::Employed),
            (Rank::Analyst, Status::Employed)
        );
        assert_eq!(
            outcome(VoteKind::Fire, Rank::Trader, Status::Employed),
            (Rank::Trader, Status::Fired)
        );
        assert_eq!(
            outcome(VoteKind::Rehire, Rank::Trader, Status::Fired),
            (Rank::Intern, Status::Employed)
        );
        assert!(
            cancels_waiting_promotion(VoteKind::Fire)
                && !cancels_waiting_promotion(VoteKind::Rehire)
        );
    }
}
