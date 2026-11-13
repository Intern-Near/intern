//! The reward ladder (05-REWARDS-LATER.md, interface 1.4), owner's decisions of 2026-11-13:
//! - R1 the free guess: each round, before `guess_close_ms`, a registered account may guess the Intern's first
//!   ruling of the round: YES, NOPE or SKIP. A right guess is a point and adds to the streak; a wrong one resets
//!   the streak; a round with no ruling at all counts for nothing; a round not guessed pauses the streak.
//! - R2 golden stickers: each guess has a 1 in 50 chance of a golden sticker of one of the sixteen codes, at most
//!   100 of each code ever; claimed like the other stickers (0.02 NEAR), and transferable.
//! - R3 the streak jackpot: seven right guesses in a row win it, split equally between everyone who completes a
//!   streak in the same round, but only bosses who held at least $10 and became bosses at least 7 rounds earlier.
//!   It is filled by half of every tip and by direct additions (the team's seed and gifts); it rolls over.
//! - R4 the payday draw: every 7 rounds, the interest the pool collected in those rounds is drawn: 70% to one
//!   winner, 30% shared by up to 10 runners-up. Bosses join once (and may leave); a boss's tickets are the smaller
//!   of the dollars held when the period began (or when joining) and at the draw, times the rounds in the draw.
//!   Nobody's deposit is touched: only interest is paid out.
//!
//! Every prize comes from a named source (tips, gifts, interest); no coin is minted for it. Prizes wait in
//! `prizes` until claimed. Nothing here loops over all accounts: guesses resolve lazily per account, jackpot
//! candidates are kept per round, and the draw walks the entrants (at most `MAX_ENTRANTS`).
//! Randomness is NEAR's per-block `random_seed`, hashed with what is being drawn: fine for testnet prizes; a
//! block producer could in principle bias a single draw (stated in 01 §14).

use crate::*;
use near_sdk::store::IterableSet;

pub const GOLDEN_ODDS: u32 = 50;
pub const GOLDEN_CAP: u32 = 100;
pub const JACKPOT_STREAK: u8 = 7;
pub const MIN_BOSS_USD: u128 = 10_000_000;
pub const MIN_BOSS_ROUNDS: u64 = 7;
pub const TIP_TO_JACKPOT_BPS: u128 = 5_000;
pub const DRAW_ROUNDS: u64 = 7;
pub const DRAW_TOP_BPS: u128 = 7_000;
pub const DRAW_RUNNERS: usize = 10;
pub const MAX_ENTRANTS: u32 = 200;
/// Jackpot candidates kept per round (accounts with six right in a row that guessed it).
pub const MAX_CANDIDATES: usize = 100;
/// Closed rounds `rewards_tick` settles per call (jackpots), so it always fits in its gas.
const ROUNDS_PER_TICK: u64 = 20;
const GAS_PRIZE: Gas = Gas::from_tgas(15);
const GAS_ON_PRIZE: Gas = Gas::from_tgas(15);

/// A guess or a ruling: 0 YES, 1 NOPE, 2 SKIP.
pub const YES: u8 = 0;
pub const NOPE: u8 = 1;
pub const SKIP: u8 = 2;

#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Verdict3 {
    Yes,
    Nope,
    Skip,
}
impl Verdict3 {
    fn code(self) -> u8 {
        match self {
            Verdict3::Yes => YES,
            Verdict3::Nope => NOPE,
            Verdict3::Skip => SKIP,
        }
    }
    fn of(c: u8) -> Self {
        match c {
            YES => Verdict3::Yes,
            NOPE => Verdict3::Nope,
            _ => Verdict3::Skip,
        }
    }
}

/// One player's guessing record. Lives in `players`.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PlayerRec {
    pub points: u32,
    pub right: u32,
    pub wrong: u32,
    pub streak: u8,
    pub best: u8,
    /// (round, guess) not yet resolved.
    pub last: Option<(u64, u8)>,
    /// Golden stickers won and not yet claimed: (code index, serial).
    pub goldens: Vec<(u8, u16)>,
}

/// A draw entrant: the round they joined, and the dollars their tickets count for this period.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EntryRec {
    pub since_round: u64,
    pub base_usd: u128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DrawResult {
    pub period: u64,
    pub held_at: u64,
    pub held_in_round: u64,
    pub prize: U128,
    pub winner: Option<AccountId>,
    pub winner_prize: U128,
    pub runners_up: Vec<(AccountId, U128)>,
    pub tickets_total: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JackpotWin {
    pub round_id: u64,
    pub winners: Vec<AccountId>,
    pub each: U128,
}

/// 1.5 (R6): the long shot. `round` is the round a passed LONG_SHOT vote allows one ticket in; `used` once it is
/// approved. A new LONG_SHOT vote can open only seven rounds after the last ticket's round. One field of `Coin` (`ls`).
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LongShot {
    pub round: Option<u64>,
    pub used: bool,
}

/// All reward state. One field of `Coin` (`rw`), added by `migrate_rewards`.
#[near(serializers = [borsh])]
pub struct Rewards {
    /// round -> its first ruling (YES/NOPE/SKIP)
    pub round_verdict: LookupMap<u64, u8>,
    /// round -> guesses [YES, NOPE, SKIP]
    pub round_counts: LookupMap<u64, [u32; 3]>,
    pub players: LookupMap<AccountId, PlayerRec>,
    /// round -> accounts that had six right in a row (and were eligible) when they guessed it, with their guess
    pub candidates: LookupMap<u64, Vec<(AccountId, u8)>>,
    pub prizes: LookupMap<AccountId, u128>,
    pub entries: LookupMap<AccountId, EntryRec>,
    pub entrants: IterableSet<AccountId>,
    pub draws: LookupMap<u64, DrawResult>,
    pub jackpot_wins: LookupMap<u64, JackpotWin>,
    /// USDC held for the jackpot, and how much of it came from direct additions (the team's seed, gifts).
    pub jackpot: u128,
    pub jackpot_added: u128,
    pub jackpot_from_tips: u128,
    pub jackpot_last_won: Option<u64>,
    /// The last round whose jackpot candidates were settled.
    pub jackpot_done_round: u64,
    /// Interest held for the current draw period.
    pub draw_pot: u128,
    pub draw_period: u64,
    /// Prizes won and not yet claimed.
    pub prizes_owed: u128,
    pub golden_minted: Vec<u32>,
    pub golden_odds: u32,
}

impl Rewards {
    pub fn new(start_round: u64) -> Self {
        Rewards {
            round_verdict: LookupMap::new(Key::RwRoundVerdict),
            round_counts: LookupMap::new(Key::RwRoundCounts),
            players: LookupMap::new(Key::RwPlayers),
            candidates: LookupMap::new(Key::RwCandidates),
            prizes: LookupMap::new(Key::RwPrizes),
            entries: LookupMap::new(Key::RwEntries),
            entrants: IterableSet::new(Key::RwEntrants),
            draws: LookupMap::new(Key::RwDraws),
            jackpot_wins: LookupMap::new(Key::RwJackpotWins),
            jackpot: 0,
            jackpot_added: 0,
            jackpot_from_tips: 0,
            jackpot_last_won: None,
            jackpot_done_round: start_round,
            draw_pot: 0,
            // The period the next draw covers: rounds period*7+1 ..= period*7+7.
            draw_period: start_round / DRAW_ROUNDS,
            prizes_owed: 0,
            golden_minted: vec![0; 16],
            golden_odds: GOLDEN_ODDS,
        }
    }

    /// USDC the rewards hold: part of what the contract holds, outside both pools.
    pub fn held(&self) -> u128 {
        self.jackpot + self.draw_pot + self.prizes_owed
    }
}

/// Bytes of randomness for `tag`: NEAR's block seed hashed with what is being drawn.
fn random(tag: &[u8]) -> [u8; 32] {
    let mut b = env::random_seed();
    b.extend_from_slice(tag);
    env::sha256_array(&b)
}

fn u128_of(h: &[u8; 32]) -> u128 {
    u128::from_le_bytes(h[..16].try_into().expect("16 bytes"))
}

// ===== the program's own hooks ==========================================================================

impl Coin {
    /// propose: the round's first ruling decides its guesses (01 1.4 §9.7).
    pub(crate) fn rw_ruling(&mut self, round_id: u64, verdict: u8) {
        if self.rw.round_verdict.contains_key(&round_id) {
            return;
        }
        self.rw.round_verdict.insert(round_id, verdict);
        let counts = self.rw.round_counts.get(&round_id).copied().unwrap_or_default();
        let total: u32 = counts.iter().sum();
        if total > 0 {
            let right = counts[verdict as usize];
            self.feed.push(
                EventName::GuessSettled,
                json!({"round_id": round_id, "verdict": Verdict3::of(verdict), "right": right, "wrong": total - right}),
            );
        }
    }

    /// take_tip: half of every tip goes to the jackpot. Returns what is left for the pool.
    pub(crate) fn rw_tip(&mut self, amount: u128) -> u128 {
        let jackpot = amount * TIP_TO_JACKPOT_BPS / 10_000;
        if jackpot > 0 {
            self.rw.jackpot += jackpot;
            self.rw.jackpot_from_tips += jackpot;
            self.feed.push(
                EventName::JackpotGrew,
                json!({"amount": U128(jackpot), "source": "tips", "jackpot": U128(self.rw.jackpot)}),
            );
        }
        amount - jackpot
    }

    /// ft_on_transfer with `{"jackpot":{}}`: a direct addition (the team's seed, a gift).
    pub(crate) fn rw_add(&mut self, who: &AccountId, amount: u128) {
        self.rw.jackpot += amount;
        self.rw.jackpot_added += amount;
        self.feed.push(
            EventName::JackpotGrew,
            json!({"amount": U128(amount), "source": "added", "by": who, "jackpot": U128(self.rw.jackpot)}),
        );
    }

    /// Dollars an account holds now: BRAVE (coins at today's value, pending money) and SAFE.
    pub(crate) fn usd_of(&self, who: &AccountId) -> u128 {
        let (coins, pending, _) = self.projected_account(who);
        let (_, b, _, supply) = self.projected();
        shares::brave_value(coins, b.brave_total, b.in_play, supply)
            + pending
            + self.safe.get(who).copied().unwrap_or(0)
    }

    /// 1.7: dollars an account holds in BRAVE only (its coins at today's value), the money the Intern's bets put at
    /// risk. The draw and the jackpot count this, not SAFE: money parked in SAFE risks nothing, so it was the cheap
    /// way to farm both with many accounts (Engine 2's simulation).
    pub(crate) fn brave_usd_of(&self, who: &AccountId) -> u128 {
        let (coins, _, _) = self.projected_account(who);
        let (_, b, _, supply) = self.projected();
        shares::brave_value(coins, b.brave_total, b.in_play, supply)
    }

    pub(crate) fn jackpot_eligible(&self, who: &AccountId, round_id: u64) -> bool {
        let (_, _, joined) = self.projected_account(who);
        joined.is_some_and(|j| j + MIN_BOSS_ROUNDS <= round_id) && self.brave_usd_of(who) >= MIN_BOSS_USD
    }

    /// The player's record with any guess whose round has a ruling (or is over without one) resolved.
    fn resolved(&self, who: &AccountId, current_round: u64) -> PlayerRec {
        let mut p = self.rw.players.get(who).cloned().unwrap_or_default();
        if let Some((round, guess)) = p.last {
            // 1.7: points wagered on this guess (already taken from the player's points when guessing).
            let wager = read_wager(who).filter(|w| w.0 == round).map_or(0, |w| w.1);
            match self.rw.round_verdict.get(&round) {
                Some(&v) => {
                    p.last = None;
                    if v == guess {
                        // Winners share the losers' wagered points in proportion to their own wagers.
                        let pool = read_pool(round);
                        let total: u64 = pool.iter().sum();
                        let side = pool[v as usize];
                        if wager > 0 && side > 0 {
                            p.points = p.points.saturating_add((wager as u64 * total / side) as u32);
                        }
                        p.points += 1;
                        p.right += 1;
                        p.streak += 1;
                        p.best = p.best.max(p.streak);
                        // A completed streak is judged for the jackpot from the round's candidates; it starts again.
                        if p.streak >= JACKPOT_STREAK {
                            p.streak = 0;
                        }
                    } else {
                        p.wrong += 1;
                        p.streak = 0;
                    }
                }
                // The round ended with no ruling at all: the guess counts for nothing (its wager comes back).
                None if round < current_round => {
                    p.last = None;
                    p.points = p.points.saturating_add(wager);
                }
                None => {}
            }
        }
        p
    }

    pub(crate) fn rw_credit_prize(&mut self, who: &AccountId, amount: u128) {
        if amount == 0 {
            return;
        }
        let owed = self.rw.prizes.get(who).copied().unwrap_or(0);
        self.rw.prizes.insert(who.clone(), owed + amount);
        self.rw.prizes_owed += amount;
    }

    /// Jackpots of closed rounds, oldest first, at most `ROUNDS_PER_TICK` per call.
    fn rw_jackpots(&mut self, current: u64) {
        let mut r = self.rw.jackpot_done_round + 1;
        let last = (current.saturating_sub(1)).min(self.rw.jackpot_done_round + ROUNDS_PER_TICK);
        while r <= last {
            if let (Some(list), Some(&v)) = (self.rw.candidates.remove(&r), self.rw.round_verdict.get(&r)) {
                let winners: Vec<AccountId> = list.into_iter().filter(|(_, g)| *g == v).map(|(a, _)| a).collect();
                if !winners.is_empty() {
                    // 1.7: several winners split it by the BRAVE dollars each holds (at least $10 each counts), not
                    // equally, so many small accounts do not out-share one real boss. `each` is the equal-split
                    // figure, kept for the event's shape; `paid` is what was paid in all.
                    let jackpot = self.rw.jackpot;
                    let weights: Vec<u128> =
                        winners.iter().map(|w| self.brave_usd_of(w).max(MIN_BOSS_USD)).collect();
                    let total: u128 = weights.iter().sum();
                    let mut paid = 0u128;
                    for (w, wt) in winners.iter().zip(&weights) {
                        let share = jackpot.saturating_mul(*wt) / total;
                        self.rw_credit_prize(w, share);
                        paid += share;
                    }
                    let each = jackpot / winners.len() as u128;
                    self.rw.jackpot -= paid;
                    self.rw.jackpot_last_won = Some(r);
                    self.rw.jackpot_wins.insert(
                        r,
                        JackpotWin { round_id: r, winners: winners.clone(), each: U128(each) },
                    );
                    self.feed.push(
                        EventName::JackpotWon,
                        json!({"round_id": r, "winners": winners, "each": U128(each)}),
                    );
                }
            }
            self.rw.jackpot_done_round = r;
            r += 1;
        }
    }

    /// The draw for `draw_period`, once its rounds are all closed. One period per call.
    fn rw_draw(&mut self, current: u64) {
        let p = self.rw.draw_period;
        let (start, end) = (p * DRAW_ROUNDS + 1, (p + 1) * DRAW_ROUNDS);
        if current <= end {
            return;
        }
        // 1.7 (item 22): two steps. When the period is over, the tickets are fixed and a drand round about a minute
        // in the future is chosen; the winners are drawn once that beacon is verified (`submit_drand`), or from the
        // block seed after `DRAND_WAIT_ROUNDS` of our rounds without it.
        let Some(pending) = read_pending(p) else {
            let weights = self.rw_draw_tickets(start, end);
            // Nothing left to luck (nobody in it, one entrant, or no interest yet): held at once.
            if weights.len() <= 1 || self.rw.draw_pot == 0 {
                let seed = random(&[b"draw".as_slice(), &p.to_le_bytes()].concat());
                keep_tickets(p, &weights);
                self.rw_draw_hold(p, current, weights, seed, "none", 0);
                return;
            }
            let target = crate::drand::drand_round_at(Self::now() + 60_000);
            write_pending(
                p,
                &PendingDraw {
                    weights,
                    drand_round: target,
                    due_round: current,
                },
            );
            self.feed.push(
                EventName::DrawPending,
                json!({"period": p, "drand_round": target}),
            );
            return;
        };
        let (seed, source) = match crate::drand::drand_randomness(pending.drand_round) {
            Some(r) => (r, "drand"),
            None if current >= pending.due_round + crate::drand::DRAND_WAIT_ROUNDS => (
                random(&[b"draw".as_slice(), &p.to_le_bytes()].concat()),
                "block",
            ),
            None => return,
        };
        clear_pending(p);
        keep_tickets(p, &pending.weights);
        let weights = pending.weights;
        self.rw_draw_hold(p, current, weights, seed, source, pending.drand_round);
    }

    /// Tickets: the smaller of the period's base dollars and the dollars now, times the rounds in the period.
    fn rw_draw_tickets(&mut self, start: u64, end: u64) -> Vec<(AccountId, u128)> {
        let mut weights: Vec<(AccountId, u128)> = Vec::new();
        let mut gone: Vec<AccountId> = Vec::new();
        let entrants: Vec<AccountId> = self.rw.entrants.iter().cloned().collect();
        for who in entrants {
            let Some(mut e) = self.rw.entries.get(&who).copied() else { continue };
            let now_usd = self.brave_usd_of(&who); // 1.7: BRAVE dollars only
            let rounds = (end + 1).saturating_sub(start.max(e.since_round)) as u128;
            let w = e.base_usd.min(now_usd).saturating_mul(rounds);
            if w > 0 {
                weights.push((who.clone(), w));
            }
            if now_usd == 0 {
                gone.push(who);
            } else {
                e.base_usd = now_usd; // next period counts from what is held now
                self.rw.entries.insert(who, e);
            }
        }
        for who in gone {
            self.rw.entrants.remove(&who);
            self.rw.entries.remove(&who);
        }
        weights
    }

    fn rw_draw_hold(
        &mut self,
        p: u64,
        current: u64,
        mut weights: Vec<(AccountId, u128)>,
        seed0: [u8; 32],
        source: &str,
        drand_round: u64,
    ) {
        let prize = self.rw.draw_pot;
        let total: u128 = weights.iter().map(|(_, w)| *w).sum();
        let mut result = DrawResult {
            period: p,
            held_at: Self::now(),
            held_in_round: current,
            prize: U128(prize),
            winner: None,
            winner_prize: U128(0),
            runners_up: vec![],
            tickets_total: U128(total),
        };
        if total > 0 && prize > 0 {
            let mut seed = seed0;
            let pick = |weights: &mut Vec<(AccountId, u128)>, seed: &mut [u8; 32]| -> Option<AccountId> {
                let t: u128 = weights.iter().map(|(_, w)| *w).sum();
                if t == 0 {
                    return None;
                }
                let mut x = u128_of(seed) % t;
                let next = env::sha256_array(&seed[..]);
                *seed = next;
                // 1.7 (Engine 2's f3): drawn with replacement, so an account's expected prize is its share of the
                // tickets however its money is split across accounts.
                let i = weights.iter().position(|(_, w)| {
                    if x < *w {
                        true
                    } else {
                        x -= *w;
                        false
                    }
                })?;
                Some(weights[i].0.clone())
            };
            let top = prize * DRAW_TOP_BPS / 10_000;
            let winner = pick(&mut weights, &mut seed).expect("total > 0");
            let mut runners: Vec<AccountId> = Vec::new();
            // Alone in the draw, the winner takes all (no runner-up shares, no dust).
            let alone = weights.len() == 1;
            while !alone && runners.len() < DRAW_RUNNERS {
                match pick(&mut weights, &mut seed) {
                    Some(a) => runners.push(a),
                    None => break,
                }
            }
            // With no runner-up, the winner takes all; otherwise 30% is shared equally, dust rolls over.
            let (winner_prize, each) = if runners.is_empty() {
                (prize, 0)
            } else {
                (top, (prize - top) / runners.len() as u128)
            };
            self.rw_credit_prize(&winner, winner_prize);
            for r in &runners {
                self.rw_credit_prize(r, each);
            }
            let paid = winner_prize + each * runners.len() as u128;
            self.rw.draw_pot -= paid;
            result.winner = Some(winner.clone());
            result.winner_prize = U128(winner_prize);
            result.runners_up = runners.iter().map(|a| (a.clone(), U128(each))).collect();
            self.feed.push(
                EventName::DrawHeld,
                json!({"period": p, "winner": winner, "prize": U128(winner_prize),
                       "runners_up": runners, "each": U128(each), "tickets_total": U128(total),
                       "randomness": source, "drand_round": drand_round}),
            );
        } else {
            // Nobody in it, or no interest yet: the pot rolls over to the next period.
            self.feed.push(
                EventName::DrawHeld,
                json!({"period": p, "winner": null, "prize": U128(0), "runners_up": [], "each": U128(0),
                       "tickets_total": U128(total), "rolled_over": U128(prize),
                       "randomness": source, "drand_round": drand_round}),
            );
        }
        self.rw.draws.insert(p, result);
        crate::drand::note_draw_source(p, drand_round, source);
        self.rw.draw_period = p + 1;
    }

    /// R6: a ticket waits, or the last ticket's round was less than seven rounds ago.
    pub(crate) fn long_shot_blocked(&self) -> bool {
        let now = self.current.map_or(0, |r| r.id);
        self.ls.round.is_some_and(|r| now < r + DRAW_ROUNDS)
    }

    /// R6: the ticket of round `r`, if a passed LONG_SHOT vote allows one there and it is unused: (margin, leverage cap).
    /// The margin is 0.5% of the pool at round open, so the rulebook can state it and it never moves.
    pub(crate) fn ticket_for(&self, r: &RoundRec) -> Option<(u128, u32)> {
        (self.ls.round == Some(r.id) && !self.ls.used)
            .then(|| (rules::limits::long_shot_margin(r.brave_at_open), rules::limits::LONG_SHOT_LEVERAGE))
    }

    /// Takes a won golden sticker out of the player's record (to be minted somewhere); panics if they have none.
    pub(crate) fn take_golden(&mut self, who: &AccountId, code: Refusal, serial: u16) {
        let mut p = self.rw.players.get(who).cloned().unwrap_or_default();
        let at = p
            .goldens
            .iter()
            .position(|&(c, s)| c == code as u8 && s == serial)
            .unwrap_or_else(|| env::panic_str("you have no such golden sticker to claim"));
        p.goldens.remove(at);
        self.rw.players.insert(who.clone(), p);
    }

    pub(crate) fn rw_golden_restore(&mut self, who: &AccountId, code: u8, serial: u16) {
        let mut p = self.rw.players.get(who).cloned().unwrap_or_default();
        p.goldens.push((code, serial));
        self.rw.players.insert(who.clone(), p);
    }
}

// ===== actions and views ==================================================================================

#[near(serializers = [json])]
pub struct PlayerView {
    pub account_id: AccountId,
    pub points: u32,
    pub right: u32,
    pub wrong: u32,
    pub streak: u8,
    pub best: u8,
    /// This round's guess (or the last one, still waiting for its round's ruling).
    pub guess: Option<GuessView>,
    pub jackpot_eligible: bool,
    pub prize_owed: U128,
    pub goldens: Vec<GoldenView>,
    pub draw: Option<DrawEntryView>,
}

#[near(serializers = [json])]
pub struct GuessView {
    pub round_id: u64,
    pub verdict: Verdict3,
    /// 1.7: points wagered on it (0: none).
    pub wager: u32,
}

#[near(serializers = [json])]
pub struct GoldenView {
    pub code: Refusal,
    pub serial: u16,
}

#[near(serializers = [json])]
pub struct DrawEntryView {
    pub since_round: u64,
    pub base_usd: U128,
    pub usd_now: U128,
    /// Tickets if the draw were held now.
    pub tickets: U128,
}

#[near(serializers = [json])]
pub struct RewardsView {
    pub round_id: u64,
    pub guess_closes_at: u64,
    pub guesses_this_round: [u32; 3],
    /// 1.7: points wagered this round on YES, NOPE, SKIP.
    pub wagers_this_round: [near_sdk::json_types::U64; 3],
    pub jackpot: U128,
    /// Of the jackpot's history: added directly (the team's seed, gifts) and from tips.
    pub jackpot_added_total: U128,
    pub jackpot_from_tips_total: U128,
    pub jackpot_last_won_round: Option<u64>,
    pub draw_pot: U128,
    pub draw_period: u64,
    /// The draw for `draw_period` can be held from this round on (`rewards_tick`).
    pub draw_from_round: u64,
    pub entrants: u32,
    pub prizes_owed: U128,
    pub golden_minted: Vec<u32>,
    /// 1.5 (R6).
    pub long_shot: LongShotView,
    pub constants: RewardConstants,
}

#[near(serializers = [json])]
pub struct LongShotView {
    /// The round the passed vote allows the ticket in, if any.
    pub ticket_round: Option<u64>,
    pub used: bool,
    /// When that round is the current one and the ticket is unused: its exact margin and leverage cap.
    pub margin: Option<U128>,
    pub max_leverage: u32,
    /// The first round a new LONG_SHOT vote may open in.
    pub vote_from_round: u64,
}

#[near(serializers = [json])]
pub struct RewardConstants {
    pub golden_odds: u32,
    pub golden_cap: u32,
    pub jackpot_streak: u8,
    pub min_boss_usd: U128,
    pub min_boss_rounds: u64,
    pub tip_to_jackpot_bps: u32,
    pub draw_rounds: u64,
    pub draw_top_bps: u32,
    pub draw_runners: u32,
    pub max_entrants: u32,
}

#[near]
impl Coin {
    /// R1. Free; registered accounts only; once per round, before the guess closes (`guess_close_ms`).
    /// 1.7: `wager` (optional) is points staked on this guess, at most the points held; winners of the round share
    /// the losers' wagered points in proportion to their wagers. Points have no cash value.
    pub fn guess(&mut self, verdict: Verdict3, wager: Option<u32>) -> PlayerView {
        let who = env::predecessor_account_id();
        require!(self.registered(&who), "register first (storage_deposit): a guess is stored for you");
        self.tick();
        let r = self.current.expect("a round is always open");
        require!(
            Self::now() < r.started_at + self.cfg.guess_close_ms,
            "guessing for this round has closed; try the next round"
        );
        let mut p = self.resolved(&who, r.id);
        require!(p.last.is_none(), "you have already guessed this round");
        let g = verdict.code();
        // Six right in a row and eligible: if this one is right too, the jackpot is theirs (rewards_tick).
        if p.streak == JACKPOT_STREAK - 1 && self.jackpot_eligible(&who, r.id) {
            let mut list = self.rw.candidates.get(&r.id).cloned().unwrap_or_default();
            if list.len() < MAX_CANDIDATES {
                list.push((who.clone(), g));
                self.rw.candidates.insert(r.id, list);
            }
        }
        p.last = Some((r.id, g));
        let wager = wager.unwrap_or(0);
        require!(wager <= p.points, "you cannot wager more points than you hold");
        if wager > 0 {
            p.points -= wager;
            write_wager(&who, (r.id, wager));
            let mut pool = read_pool(r.id);
            pool[g as usize] += wager as u64;
            write_pool(r.id, &pool);
        } else {
            clear_wager(&who);
        }
        let mut counts = self.rw.round_counts.get(&r.id).copied().unwrap_or_default();
        counts[g as usize] += 1;
        self.rw.round_counts.insert(r.id, counts);
        self.feed.push(EventName::Guessed, json!({"round_id": r.id, "account_id": who}));
        self.wk_guess(&who, r.id, g); // 1.6: this week's league
        // R2: a golden sticker, 1 in `golden_odds`, of a code chosen by the same draw, while that code has some left.
        let h = random(&[b"golden".as_slice(), who.as_bytes(), &r.id.to_le_bytes()].concat());
        let roll = u128_of(&h);
        if self.rw.golden_odds > 0 && roll.is_multiple_of(self.rw.golden_odds as u128) {
            let code = ((roll >> 64) % 16) as usize;
            if self.rw.golden_minted[code] < GOLDEN_CAP {
                self.rw.golden_minted[code] += 1;
                let serial = self.rw.golden_minted[code] as u16;
                p.goldens.push((code as u8, serial));
                self.feed.push(
                    EventName::GoldenDropped,
                    json!({"account_id": who, "code": Refusal::ALL[code], "serial": serial}),
                );
            }
        }
        self.rw.players.insert(who.clone(), p);
        self.get_player(who)
    }

    /// R2. Mints a golden sticker won by guessing. 0.02 NEAR, the rest refunded. Transferable.
    #[payable]
    pub fn claim_golden(&mut self, code: Refusal, serial: u16) -> Promise {
        let who = env::predecessor_account_id();
        self.tick();
        self.take_golden(&who, code, serial);
        self.start_claim(
            who.clone(),
            format!("golden:{}:{serial}", code.as_str()),
            format!("Golden {} #{serial}", code.as_str()),
            format!(
                "A golden {} sticker, number {serial} of at most {GOLDEN_CAP}, dropped by a free guess.",
                code.as_str()
            ),
            Some(json!({"code": code, "serial": serial}).to_string()),
            true,
            claims::KIND_GOLDEN,
            (code as u64) << 16 | serial as u64,
        )
    }

    /// R4. Joins the payday draw (registered, holding money). Stays in until `leave_draw` or holding nothing.
    pub fn enter_draw(&mut self) -> DrawEntryView {
        let who = env::predecessor_account_id();
        require!(self.registered(&who), "register first (storage_deposit)");
        self.tick();
        require!(!self.rw.entrants.contains(&who), "you are already in the draw");
        // 1.7: tickets come from BRAVE dollars only (SAFE risks nothing).
        let usd = self.brave_usd_of(&who);
        require!(usd > 0, "hold some BRAVE first: tickets come from the dollars you hold in BRAVE");
        if self.rw.entrants.len() >= MAX_ENTRANTS {
            // 1.7 (Engine 2's f3): a full draw keeps its places for the biggest holders: a newcomer holding more takes
            // the place of the entrant holding least (at most `MAX_ENTRANTS` reads).
            let smallest = self
                .rw
                .entrants
                .iter()
                .map(|a| (self.brave_usd_of(a), a.clone()))
                .min_by(|x, y| x.0.cmp(&y.0))
                .expect("the draw is full, so not empty");
            require!(usd > smallest.0, "the draw is full and everyone in it holds at least as much in BRAVE as you");
            self.rw.entrants.remove(&smallest.1);
            self.rw.entries.remove(&smallest.1);
        }
        let e = EntryRec { since_round: self.current.expect("round").id, base_usd: usd };
        self.rw.entries.insert(who.clone(), e);
        self.rw.entrants.insert(who.clone());
        self.entry_view(&who, e)
    }

    pub fn leave_draw(&mut self) {
        let who = env::predecessor_account_id();
        self.tick();
        require!(self.rw.entrants.remove(&who), "you are not in the draw");
        self.rw.entries.remove(&who);
    }

    /// Anyone (the runner does it each round): settles the jackpots of closed rounds, holds a draw that is due, and
    /// (1.6) closes the leagues and writes the reviews of weeks that are over.
    pub fn rewards_tick(&mut self) {
        self.tick();
        let current = self.current.expect("round").id;
        self.rw_jackpots(current);
        self.rw_draw(current);
        self.wk_tick(current); // 1.6: leagues and the weekly review
    }

    /// Pays every prize owed to the caller (jackpot shares, draw prizes). 1 yocto, at least 40 TGas.
    #[payable]
    pub fn claim_prizes(&mut self) -> Promise {
        assert_one_yocto();
        require!(env::prepaid_gas() >= Gas::from_tgas(40), "attach at least 40 TGas");
        let who = env::predecessor_account_id();
        let owed = self.rw.prizes.remove(&who).unwrap_or(0);
        require!(owed > 0, "no prize to claim");
        self.rw.prizes_owed -= owed;
        ext_ft_core::ext(self.cfg.usdc_token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_PRIZE)
            .ft_transfer(who.clone(), U128(owed), Some("$INTERN prize".to_string()))
            .then(Self::ext(Self::me()).with_static_gas(GAS_ON_PRIZE).on_prize_paid(who, U128(owed)))
    }

    #[private]
    pub fn on_prize_paid(&mut self, who: AccountId, amount: U128) -> bool {
        if matches!(env::promise_result_checked(0, 64), Err(PromiseError::Failed)) {
            self.rw_credit_prize(&who, amount.0);
            env::log_str("the prize could not be paid; it is owed again: call claim_prizes again");
            return false;
        }
        self.feed.push(EventName::PrizePaid, json!({"account_id": who, "amount": amount}));
        true
    }

    // ----- views

    pub fn get_rewards(&self) -> RewardsView {
        let (r, ..) = self.projected();
        let rw = &self.rw;
        RewardsView {
            round_id: r.id,
            guess_closes_at: r.started_at + self.cfg.guess_close_ms,
            guesses_this_round: rw.round_counts.get(&r.id).copied().unwrap_or_default(),
            wagers_this_round: read_pool(r.id).map(near_sdk::json_types::U64),
            jackpot: U128(rw.jackpot),
            jackpot_added_total: U128(rw.jackpot_added),
            jackpot_from_tips_total: U128(rw.jackpot_from_tips),
            jackpot_last_won_round: rw.jackpot_last_won,
            draw_pot: U128(rw.draw_pot),
            draw_period: rw.draw_period,
            draw_from_round: (rw.draw_period + 1) * DRAW_ROUNDS + 1,
            entrants: rw.entrants.len(),
            prizes_owed: U128(rw.prizes_owed),
            golden_minted: rw.golden_minted.clone(),
            long_shot: LongShotView {
                ticket_round: self.ls.round,
                used: self.ls.used,
                margin: self.ticket_for(&r).map(|(m, _)| U128(m)),
                max_leverage: rules::limits::LONG_SHOT_LEVERAGE,
                vote_from_round: self.ls.round.map_or(0, |t| t + DRAW_ROUNDS),
            },
            constants: RewardConstants {
                golden_odds: rw.golden_odds,
                golden_cap: GOLDEN_CAP,
                jackpot_streak: JACKPOT_STREAK,
                min_boss_usd: U128(MIN_BOSS_USD),
                min_boss_rounds: MIN_BOSS_ROUNDS,
                tip_to_jackpot_bps: TIP_TO_JACKPOT_BPS as u32,
                draw_rounds: DRAW_ROUNDS,
                draw_top_bps: DRAW_TOP_BPS as u32,
                draw_runners: DRAW_RUNNERS as u32,
                max_entrants: MAX_ENTRANTS,
            },
        }
    }

    pub fn get_player(&self, account_id: AccountId) -> PlayerView {
        let (r, ..) = self.projected();
        let p = self.resolved(&account_id, r.id);
        let draw = self.rw.entries.get(&account_id).map(|e| self.entry_view(&account_id, *e));
        PlayerView {
            points: p.points,
            right: p.right,
            wrong: p.wrong,
            streak: p.streak,
            best: p.best,
            guess: p.last.map(|(round_id, g)| GuessView {
                round_id,
                verdict: Verdict3::of(g),
                wager: read_wager(&account_id).filter(|w| w.0 == round_id).map_or(0, |w| w.1),
            }),
            jackpot_eligible: self.jackpot_eligible(&account_id, r.id),
            prize_owed: U128(self.rw.prizes.get(&account_id).copied().unwrap_or(0)),
            goldens: p
                .goldens
                .iter()
                .map(|&(c, s)| GoldenView { code: Refusal::ALL[c as usize], serial: s })
                .collect(),
            draw,
            account_id,
        }
    }

    /// The draws held, newest first.
    pub fn get_draw_results(&self, from: Option<u64>, limit: Option<u64>) -> Vec<DrawResult> {
        let last = self.rw.draw_period;
        let from = from.unwrap_or(last).min(last);
        (0..from).rev().take(limit.unwrap_or(10).min(50) as usize).filter_map(|p| self.rw.draws.get(&p).cloned()).collect()
    }

    /// Jackpot wins, newest first, from the rounds settled so far.
    pub fn get_jackpot_wins(&self, limit: Option<u64>) -> Vec<JackpotWin> {
        let mut out = Vec::new();
        let mut r = self.rw.jackpot_done_round;
        while r > 0 && out.len() < limit.unwrap_or(10).min(50) as usize {
            if let Some(w) = self.rw.jackpot_wins.get(&r) {
                out.push(w.clone());
            }
            r -= 1;
            if self.rw.jackpot_done_round - r > 1_000 {
                break;
            }
        }
        out
    }

    fn entry_view(&self, who: &AccountId, e: EntryRec) -> DrawEntryView {
        let usd = self.usd_of(who);
        let p = self.rw.draw_period;
        let (start, end) = (p * DRAW_ROUNDS + 1, (p + 1) * DRAW_ROUNDS);
        let rounds = (end + 1).saturating_sub(start.max(e.since_round)) as u128;
        DrawEntryView {
            since_round: e.since_round,
            base_usd: U128(e.base_usd),
            usd_now: U128(usd),
            tickets: U128(e.base_usd.min(usd).saturating_mul(rounds)),
        }
    }
}

// ----- test hook: only in the sandbox build (feature `test-hooks`), never deployed ---------------------------

#[cfg(feature = "test-hooks")]
#[near]
impl Coin {
    /// TEST ONLY. The golden sticker odds (1 drops one on every guess).
    pub fn test_set_golden_odds(&mut self, odds: u32) {
        self.rw.golden_odds = odds;
    }
}

// ----- 1.7: point wagers and banking a streak (own storage keys, no migration) ------------------------------

fn wager_key(who: &AccountId) -> Vec<u8> {
    [b"g7w".as_slice(), who.as_bytes()].concat()
}
fn pool_key(round: u64) -> Vec<u8> {
    [b"g7p".as_slice(), &round.to_le_bytes()].concat()
}
/// (round, points wagered) of an account's last wagered guess.
fn read_wager(who: &AccountId) -> Option<(u64, u32)> {
    env::storage_read(&wager_key(who)).and_then(|b| near_sdk::borsh::from_slice(&b).ok())
}
fn write_wager(who: &AccountId, w: (u64, u32)) {
    env::storage_write(&wager_key(who), &near_sdk::borsh::to_vec(&w).expect("wager"));
}
fn clear_wager(who: &AccountId) {
    env::storage_remove(&wager_key(who));
}
/// Points wagered in a round on YES, NOPE, SKIP.
fn read_pool(round: u64) -> [u64; 3] {
    env::storage_read(&pool_key(round)).and_then(|b| near_sdk::borsh::from_slice(&b).ok()).unwrap_or_default()
}
fn write_pool(round: u64, p: &[u64; 3]) {
    env::storage_write(&pool_key(round), &near_sdk::borsh::to_vec(p).expect("pool"));
}

#[near]
impl Coin {
    /// 1.7. Turns the current streak into points (streak × streak) and starts it again: sure points now instead of
    /// the jackpot's seven in a row. Not while a guess waits for its ruling.
    pub fn bank_streak(&mut self) -> PlayerView {
        let who = env::predecessor_account_id();
        require!(self.registered(&who), "register first (storage_deposit)");
        self.tick();
        let r = self.current.expect("a round is always open");
        let mut p = self.resolved(&who, r.id);
        require!(p.last.is_none(), "wait for your guess's ruling before banking");
        require!(p.streak > 0, "there is no streak to bank");
        let streak = p.streak as u32;
        let points = streak * streak;
        p.points = p.points.saturating_add(points);
        p.streak = 0;
        self.rw.players.insert(who.clone(), p);
        self.feed.push(EventName::StreakBanked, json!({"account_id": who, "streak": streak, "points": points}));
        self.get_player(who)
    }
}

// ----- 1.7 (item 22): a draw waiting for its drand beacon ----------------------------------------------------

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingDraw {
    pub weights: Vec<(AccountId, u128)>,
    pub drand_round: u64,
    pub due_round: u64,
}
fn pending_key(p: u64) -> Vec<u8> {
    [b"d7p".as_slice(), &p.to_le_bytes()].concat()
}
pub(crate) fn read_pending(p: u64) -> Option<PendingDraw> {
    env::storage_read(&pending_key(p)).and_then(|b| near_sdk::borsh::from_slice(&b).ok())
}
fn write_pending(p: u64, d: &PendingDraw) {
    env::storage_write(
        &pending_key(p),
        &near_sdk::borsh::to_vec(d).expect("pending draw"),
    );
}
fn clear_pending(p: u64) {
    env::storage_remove(&pending_key(p));
}

/// Draws whose frozen tickets are kept after the draw, so anyone can replay them (`get_drand`).
pub const TICKETS_KEPT: u64 = 4;
fn tickets_key(p: u64) -> Vec<u8> {
    [b"d7t".as_slice(), &p.to_le_bytes()].concat()
}
/// Keeps a held draw's tickets (in the order they were drawn from) and drops those of older periods.
fn keep_tickets(p: u64, weights: &Vec<(AccountId, u128)>) {
    env::storage_write(&tickets_key(p), &near_sdk::borsh::to_vec(weights).expect("tickets"));
    if p >= TICKETS_KEPT {
        env::storage_remove(&tickets_key(p - TICKETS_KEPT));
    }
}
/// A draw's frozen tickets: while it waits for its beacon, or after it for the last `TICKETS_KEPT` periods.
pub(crate) fn draw_tickets(p: u64) -> Option<Vec<(AccountId, u128)>> {
    read_pending(p).map(|d| d.weights).or_else(|| {
        env::storage_read(&tickets_key(p)).and_then(|b| near_sdk::borsh::from_slice(&b).ok())
    })
}
