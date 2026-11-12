//! Section 5: the round clock. Every moment of a round is an offset from its start.
//!
//! Round *ids* are the contract's own counter: rounds start on a grid of slots
//! (`genesis_ms + k × round_ms`), but a stuck round can swallow slots and skipped slots get no
//! round, so an id is not a slot number. This module works in slots and times; the contract
//! numbers the rounds.

/// The four phases of section 5.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Phase {
    Open,
    Propose,
    Hold,
    Close,
}

impl Phase {
    pub const fn as_str(self) -> &'static str {
        match self {
            Phase::Open => "OPEN",
            Phase::Propose => "PROPOSE",
            Phase::Hold => "HOLD",
            Phase::Close => "CLOSE",
        }
    }
}

/// The offsets of section 5, in ms from the round's start.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Offsets {
    pub round_ms: u64,
    pub guess_close_ms: u64,
    pub propose_from_ms: u64,
    pub propose_until_ms: u64,
    pub close_from_ms: u64,
    pub tail_fade_ms: u64,
}

/// The real product: one round a day from 00:00 UTC.
pub const REAL: Offsets = Offsets {
    round_ms: 86_400_000,
    guess_close_ms: 42_900_000,
    propose_from_ms: 43_200_000,
    propose_until_ms: 46_800_000,
    close_from_ms: 79_200_000,
    tail_fade_ms: 600_000,
};

/// The demo deployment: a 30-minute round (`PROPOSED`).
pub const DEMO: Offsets = Offsets {
    round_ms: 1_800_000,
    guess_close_ms: 840_000,
    propose_from_ms: 900_000,
    propose_until_ms: 1_200_000,
    close_from_ms: 1_500_000,
    tail_fade_ms: 600_000,
};

impl Offsets {
    /// The offsets are in order and inside the round.
    pub const fn is_valid(&self) -> bool {
        self.guess_close_ms <= self.propose_from_ms
            && self.propose_from_ms < self.propose_until_ms
            && self.propose_until_ms <= self.close_from_ms
            && self.close_from_ms < self.round_ms
    }
}

/// The phase at `ms_into_round` ms after the round's start. Each phase starts at its offset:
/// exactly `propose_from_ms` is PROPOSE, exactly `propose_until_ms` is HOLD. A round running past
/// its end (stuck) stays in CLOSE.
pub fn phase_at(o: &Offsets, ms_into_round: u64) -> Phase {
    if ms_into_round < o.propose_from_ms {
        Phase::Open
    } else if ms_into_round < o.propose_until_ms {
        Phase::Propose
    } else if ms_into_round < o.close_from_ms {
        Phase::Hold
    } else {
        Phase::Close
    }
}

/// The boundary times of a round that started at `started_at` (the interface's `Round` times).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Times {
    pub started_at: u64,
    pub guess_closes_at: u64,
    pub propose_from: u64,
    pub propose_until: u64,
    pub close_from: u64,
    pub ends_at: u64,
}

/// `None` only if a time would overflow `u64`.
pub fn times(o: &Offsets, started_at: u64) -> Option<Times> {
    Some(Times {
        started_at,
        guess_closes_at: started_at.checked_add(o.guess_close_ms)?,
        propose_from: started_at.checked_add(o.propose_from_ms)?,
        propose_until: started_at.checked_add(o.propose_until_ms)?,
        close_from: started_at.checked_add(o.close_from_ms)?,
        ends_at: started_at.checked_add(o.round_ms)?,
    })
}

/// A place on the grid: slot `index` starts at `genesis_ms + index × round_ms`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Slot {
    pub index: u64,
    pub started_at: u64,
}

/// The slot running at `now`. `None` before `genesis_ms`, or if `round_ms` is 0.
pub fn slot_at(genesis_ms: u64, round_ms: u64, now: u64) -> Option<Slot> {
    if round_ms == 0 || now < genesis_ms {
        return None;
    }
    let index = (now - genesis_ms) / round_ms;
    Some(Slot {
        index,
        started_at: genesis_ms + index * round_ms,
    })
}

/// The slot a new round may open in, at `now`.
///
/// Section 5: the next round starts only when the current one is settled; rounds start on the
/// grid; a round that settles late is followed by the round that would be running at that moment,
/// and skipped slots get no round. So: nothing while the current round is unsettled; otherwise the
/// slot running now, if it is later than the current round's slot. `current` is the current round's
/// slot index, `None` before the first round.
pub fn next_slot(
    genesis_ms: u64,
    round_ms: u64,
    current: Option<u64>,
    current_settled: bool,
    now: u64,
) -> Option<Slot> {
    let s = slot_at(genesis_ms, round_ms, now)?;
    match current {
        None => Some(s),
        Some(_) if !current_settled => None,
        Some(i) if s.index > i => Some(s),
        Some(_) => None,
    }
}

/// Section 5 (1.1): `stuck` is true when the round is not settled and the time is past `ends_at`.
/// "Past" is taken as `now ≥ ends_at`: from that moment the next slot has begun.
pub fn is_stuck(settled: bool, now: u64, ends_at: u64) -> bool {
    !settled && now >= ends_at
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_clocks_are_valid() {
        assert!(REAL.is_valid() && DEMO.is_valid());
    }

    #[test]
    fn each_phase_starts_exactly_at_its_offset() {
        for o in [REAL, DEMO] {
            assert_eq!(phase_at(&o, 0), Phase::Open);
            assert_eq!(phase_at(&o, o.propose_from_ms - 1), Phase::Open);
            assert_eq!(phase_at(&o, o.propose_from_ms), Phase::Propose);
            assert_eq!(phase_at(&o, o.propose_until_ms - 1), Phase::Propose);
            assert_eq!(phase_at(&o, o.propose_until_ms), Phase::Hold);
            assert_eq!(phase_at(&o, o.close_from_ms), Phase::Close);
            assert_eq!(
                phase_at(&o, o.round_ms * 3),
                Phase::Close,
                "a stuck round stays in CLOSE"
            );
        }
    }

    #[test]
    fn the_section_8_2_round_times() {
        let t = times(&REAL, 1_794_355_200_000).unwrap();
        assert_eq!(
            t,
            Times {
                started_at: 1_794_355_200_000,
                guess_closes_at: 1_794_398_100_000,
                propose_from: 1_794_398_400_000,
                propose_until: 1_794_402_000_000,
                close_from: 1_794_434_400_000,
                ends_at: 1_794_441_600_000,
            }
        );
    }

    #[test]
    fn slots_and_the_next_round() {
        let (g, r) = (1_000_000, DEMO.round_ms);
        assert_eq!(slot_at(g, r, g - 1), None);
        assert_eq!(
            slot_at(g, r, g),
            Some(Slot {
                index: 0,
                started_at: g
            })
        );
        assert_eq!(slot_at(g, r, g + r - 1).unwrap().index, 0);
        assert_eq!(slot_at(g, r, g + r).unwrap().index, 1);
        // The first round opens in whatever slot is running.
        assert_eq!(
            next_slot(g, r, None, false, g + 5 * r + 7).unwrap().index,
            5
        );
        // Unsettled: no new round, even far later.
        assert_eq!(next_slot(g, r, Some(0), false, g + 9 * r), None);
        // Settled early, still inside its own slot: wait for the next slot.
        assert_eq!(next_slot(g, r, Some(0), true, g + r - 1), None);
        assert_eq!(
            next_slot(g, r, Some(0), true, g + r).unwrap(),
            Slot {
                index: 1,
                started_at: g + r
            }
        );
        // Settled late: the round that would be running now; slots 1-3 get no round.
        assert_eq!(
            next_slot(g, r, Some(0), true, g + 4 * r + 10).unwrap(),
            Slot {
                index: 4,
                started_at: g + 4 * r
            }
        );
    }

    #[test]
    fn stuck_rule() {
        assert!(!is_stuck(false, 99, 100));
        assert!(is_stuck(false, 100, 100));
        assert!(!is_stuck(true, 1_000, 100));
    }
}
