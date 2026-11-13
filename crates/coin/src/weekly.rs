//! Interface 1.6, owner's decisions of 2026-11-13: leagues and the weekly review.
//!
//! A week is `WEEK_ROUNDS` (7) rounds by round id: week `w` covers rounds `w*7+1 ..= (w+1)*7`, the same periods as
//! the payday draw. On testnet a round is 30 minutes, so a week is 3.5 hours; in the product a round is a day.
//!
//! **Leagues.** An account's first guess of a week places it in that week's league, in group `n / GROUP_SIZE` in
//! order of joining (at most `MAX_GROUPS` groups; later guessers still play for points but have no group that
//! week). A group is ranked on that week's guesses only: points (right guesses), then the best run of right
//! guesses, then fewer wrong, then who joined first. A guess counts once its round has a ruling; a round that ends
//! without one counts for nothing. Points have no cash value and a league has no prize. When the week is over,
//! `rewards_tick` keeps each group's top three and frees the rest of the week's storage.
//!
//! **The weekly review.** When a week is over, `rewards_tick` writes the week's record from the rounds themselves:
//! bets, verdicts, refusals by code, the result, the best and worst bet, the rank and the pool at the start and at
//! the end. During the following week every registered account may stamp it once; `REVIEW_BAR` stamps fill the
//! shared bar. Weeks that ended before the 1.6 upgrade get their review too, written from the rounds on chain and
//! marked `backfilled` (no feed event for those).
//!
//! All of it lives under its own storage keys (prefix `w6`), outside the `Coin` struct: the 1.5 state is untouched
//! and the upgrade needs no migration.

use crate::*;
use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};

pub const WEEK_ROUNDS: u64 = 7;
pub const GROUP_SIZE: u32 = 20;
pub const MAX_GROUPS: u32 = 25;
/// Stamps that fill a review's shared bar.
pub const REVIEW_BAR: u32 = 5;
/// Stamps a review can take (each is kept to refuse a second one from the same account).
pub const MAX_STAMPS: u32 = 100;
/// League groups closed per `rewards_tick`, and reviews written per call, so a tick always fits in its gas.
const GROUPS_PER_TICK: u32 = 4;
const REVIEWS_PER_TICK: u32 = 4;
/// Refusals read once, at the first 1.6 call that writes, to count the codes of the rounds before it.
const BACKFILL_REFUSALS: u64 = 500;

/// The week a round belongs to.
pub fn week_of(round_id: u64) -> u64 {
    round_id.saturating_sub(1) / WEEK_ROUNDS
}
pub fn first_round(week: u64) -> u64 {
    week * WEEK_ROUNDS + 1
}
pub fn last_round(week: u64) -> u64 {
    (week + 1) * WEEK_ROUNDS
}

// ----- storage: own keys, Borsh ---------------------------------------------------------------------

fn key(tag: &[u8], parts: &[&[u8]]) -> Vec<u8> {
    let mut k = b"w6".to_vec();
    k.extend_from_slice(tag);
    for p in parts {
        k.extend_from_slice(p);
    }
    k
}
fn read<T: BorshDeserialize>(k: &[u8]) -> Option<T> {
    env::storage_read(k).map(|b| borsh::from_slice(&b).unwrap_or_else(|_| env::panic_str("weekly state")))
}
fn write<T: BorshSerialize>(k: &[u8], v: &T) {
    env::storage_write(k, &borsh::to_vec(v).unwrap_or_else(|_| env::panic_str("weekly state")));
}
fn state_key() -> Vec<u8> {
    key(b"s", &[])
}
fn week_key(w: u64) -> Vec<u8> {
    key(b"w", &[&w.to_le_bytes()])
}
fn member_key(w: u64, who: &AccountId) -> Vec<u8> {
    key(b"m", &[&w.to_le_bytes(), who.as_bytes()])
}
fn group_key(w: u64, g: u32) -> Vec<u8> {
    key(b"g", &[&w.to_le_bytes(), &g.to_le_bytes()])
}
fn result_key(w: u64, g: u32) -> Vec<u8> {
    key(b"r", &[&w.to_le_bytes(), &g.to_le_bytes()])
}
fn review_key(w: u64) -> Vec<u8> {
    key(b"v", &[&w.to_le_bytes()])
}
fn codes_key(w: u64) -> Vec<u8> {
    key(b"c", &[&w.to_le_bytes()])
}

/// Where the closing work stands. Created at the first 1.6 call.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WeeklyState {
    /// The next week whose league is to be closed, and how many of its groups are done.
    pub next_league: u64,
    pub groups_done: u32,
    /// The next week whose review is to be written.
    pub next_review: u64,
    /// The week current when 1.6 started: reviews of earlier weeks are backfilled.
    pub first_week: u64,
    /// The refusals stored before 1.6 have been counted by week (at the first 1.6 call that writes).
    pub codes_backfilled: bool,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LeagueWeek {
    pub players: u32,
    pub closed: bool,
}

/// One account's guesses in one week's league: (round, guess), in the order made.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Member {
    pub group: u32,
    pub guesses: Vec<(u64, u8)>,
}

/// A place in a group.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Standing {
    pub place: u32,
    pub account_id: AccountId,
    /// Right guesses this week.
    pub points: u32,
    pub wrong: u32,
    /// The longest run of right guesses this week (a round not guessed pauses it, a wrong guess ends it).
    pub best_run: u32,
    /// Guesses whose round has no ruling yet.
    pub waiting: u32,
}

/// The week's record, written once the week is over.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReviewRec {
    pub week: u64,
    pub written_at: u64,
    pub backfilled: bool,
    pub rounds: u32,
    pub settled: u32,
    pub bets: u32,
    pub refused: u32,
    pub skipped: u32,
    pub result: i128,
    /// (position id, result) of the best and the worst settled bet.
    pub best: Option<(u64, i128)>,
    pub worst: Option<(u64, i128)>,
    pub codes: Vec<u32>,
    pub rank_start: u8,
    pub rank_end: u8,
    pub status_end: u8,
    pub pool_start: u128,
    pub pool_end: u128,
    pub long_shot: bool,
    pub league_players: u32,
    pub stamps: u32,
    pub stampers: Vec<AccountId>,
}

// ----- views ----------------------------------------------------------------------------------------

#[near(serializers = [json])]
pub struct LeagueView {
    pub week: u64,
    pub first_round: u64,
    pub last_round: u64,
    pub players: u32,
    pub groups: u32,
    /// The group shown, if any.
    pub group: Option<u32>,
    pub closed: bool,
    /// The whole group while the week runs; its top three once the week is closed.
    pub standings: Vec<Standing>,
    pub group_size: u32,
    pub max_groups: u32,
}

#[near(serializers = [json])]
pub struct GroupResult {
    pub group: u32,
    pub top: Vec<Standing>,
}

#[near(serializers = [json])]
pub struct BetLine {
    pub position_id: u64,
    pub round_id: u64,
    pub market: shared::Market,
    pub side: shared::Side,
    pub margin: U128,
    pub leverage: u32,
    pub result: wire::I128,
}

#[near(serializers = [json])]
pub struct CodeCount {
    pub code: Refusal,
    pub count: u32,
}

#[near(serializers = [json])]
pub struct ReviewView {
    pub week: u64,
    pub first_round: u64,
    pub last_round: u64,
    pub written_at: u64,
    /// Written at the 1.6 upgrade, after the fact, from the rounds already on chain.
    pub backfilled: bool,
    /// Rounds of the week that opened, and of those, settled.
    pub rounds: u32,
    pub settled: u32,
    /// Verdicts: approved bets (the long-shot ticket included), NOPEs, SKIPs.
    pub bets: u32,
    pub refused: u32,
    pub skipped: u32,
    /// Dollars back minus dollars out over the week's settled rounds.
    pub result: wire::I128,
    pub best_bet: Option<BetLine>,
    pub worst_bet: Option<BetLine>,
    pub refusals: Vec<CodeCount>,
    pub rank_start: Rank,
    pub rank_end: Rank,
    pub status_end: Status,
    /// The BRAVE pool at the week's first round's opening, and at the next week's (or the last known).
    pub pool_start: U128,
    pub pool_end: U128,
    pub long_shot: bool,
    pub league_players: u32,
    pub stamps: u32,
    pub bar: u32,
    pub bar_filled: bool,
    /// Stamping is open now (only last week's review, during this week).
    pub stamping_open: bool,
}

#[near(serializers = [json])]
pub struct WeekView {
    pub round_id: u64,
    pub week: u64,
    pub first_round: u64,
    pub last_round: u64,
    pub rounds_per_week: u64,
    pub league_players: u32,
    pub league_groups: u32,
    pub group_size: u32,
    pub max_groups: u32,
    /// Last week's review, if it is written: the one that can be stamped this week.
    pub review_to_stamp: Option<u64>,
    pub review_bar: u32,
    pub max_stamps: u32,
}

fn groups_of(players: u32) -> u32 {
    players.div_ceil(GROUP_SIZE).min(MAX_GROUPS)
}

impl Coin {
    /// The round in progress, as `get_round` shows it (a view cannot open the next round; this projects it).
    fn wk_current(&self) -> u64 {
        self.projected().0.id
    }

    fn wk_state(&self) -> WeeklyState {
        read(&state_key()).unwrap_or_else(|| {
            let w = week_of(self.wk_current());
            WeeklyState { next_league: w, groups_done: 0, next_review: 0, first_week: w, codes_backfilled: false }
        })
    }

    /// The state, created at the first 1.6 call that writes: then the refusals already on chain are counted by
    /// week, once, so no refusal is missed or counted twice. Returns whether it was created now.
    fn wk_init(&mut self) -> (WeeklyState, bool) {
        if let Some(st) = read::<WeeklyState>(&state_key()) {
            return (st, false);
        }
        let mut st = self.wk_state();
        let start = self.next_refusal_id.saturating_sub(BACKFILL_REFUSALS).max(1);
        for id in start..self.next_refusal_id {
            if let Some(r) = self.refusals.get(&id) {
                let (round, code) = (r.round_id, r.code);
                self.wk_count(round, code);
            }
        }
        st.codes_backfilled = true;
        write(&state_key(), &st);
        (st, true)
    }

    fn wk_count(&mut self, round_id: u64, code: u8) {
        let ck = codes_key(week_of(round_id));
        let mut c: Vec<u32> = read(&ck).unwrap_or_else(|| vec![0; Refusal::ALL.len()]);
        if let Some(n) = c.get_mut(code as usize) {
            *n += 1;
        }
        write(&ck, &c);
    }

    /// guess: the account's first guess of the week places it in a group.
    pub(crate) fn wk_guess(&mut self, who: &AccountId, round_id: u64, guess: u8) {
        let w = week_of(round_id);
        let mk = member_key(w, who);
        if let Some(mut m) = read::<Member>(&mk) {
            m.guesses.push((round_id, guess));
            write(&mk, &m);
            return;
        }
        let wk = week_key(w);
        let mut lw: LeagueWeek = read(&wk).unwrap_or_default();
        let group = lw.players / GROUP_SIZE;
        if group >= MAX_GROUPS || lw.closed {
            return; // the league is full this week: the guess still counts for points and the streak
        }
        lw.players += 1;
        write(&wk, &lw);
        let gk = group_key(w, group);
        let mut list: Vec<AccountId> = read(&gk).unwrap_or_default();
        list.push(who.clone());
        write(&gk, &list);
        write(&mk, &Member { group, guesses: vec![(round_id, guess)] });
    }

    /// propose, after the refusal is stored: a NOPE counts for its week's review. (At the very first 1.6 call the
    /// count of every stored refusal, this one included, is made by `wk_init`.)
    pub(crate) fn wk_refusal(&mut self, round_id: u64, code: u8) {
        if !self.wk_init().1 {
            self.wk_count(round_id, code);
        }
    }

    fn standing(&self, who: &AccountId, m: &Member, current: u64) -> Standing {
        let (mut points, mut wrong, mut run, mut best, mut waiting) = (0u32, 0u32, 0u32, 0u32, 0u32);
        for &(round, g) in &m.guesses {
            match self.rw.round_verdict.get(&round) {
                Some(&v) if v == g => {
                    points += 1;
                    run += 1;
                    best = best.max(run);
                }
                Some(_) => {
                    wrong += 1;
                    run = 0;
                }
                None if round < current => {}
                None => waiting += 1,
            }
        }
        Standing { place: 0, account_id: who.clone(), points, wrong, best_run: best, waiting }
    }

    /// A group's standings while its week's storage is there.
    fn group_standings(&self, w: u64, group: u32) -> Vec<Standing> {
        let current = self.wk_current();
        let list: Vec<AccountId> = read(&group_key(w, group)).unwrap_or_default();
        let mut s: Vec<(usize, Standing)> = list
            .iter()
            .enumerate()
            .filter_map(|(i, a)| read::<Member>(&member_key(w, a)).map(|m| (i, self.standing(a, &m, current))))
            .collect();
        s.sort_by(|(ia, a), (ib, b)| {
            b.points
                .cmp(&a.points)
                .then(b.best_run.cmp(&a.best_run))
                .then(a.wrong.cmp(&b.wrong))
                .then(ia.cmp(ib))
        });
        s.into_iter()
            .enumerate()
            .map(|(k, (_, mut st))| {
                st.place = k as u32 + 1;
                st
            })
            .collect()
    }

    /// rewards_tick: closes the leagues and writes the reviews of weeks that are over, a few per call.
    pub(crate) fn wk_tick(&mut self, current: u64) {
        let cw = week_of(current);
        let (mut st, _) = self.wk_init();
        self.wk_reviews(&mut st, cw, REVIEWS_PER_TICK);
        // Leagues: a few groups per call.
        let mut budget = GROUPS_PER_TICK;
        while st.next_league < cw && budget > 0 {
            let w = st.next_league;
            let wk = week_key(w);
            let mut lw: LeagueWeek = read(&wk).unwrap_or_default();
            let groups = groups_of(lw.players);
            while st.groups_done < groups && budget > 0 {
                let g = st.groups_done;
                let all = self.group_standings(w, g);
                let top: Vec<Standing> = all.iter().take(3).cloned().collect();
                for s in &all {
                    env::storage_remove(&member_key(w, &s.account_id));
                }
                env::storage_remove(&group_key(w, g));
                write(&result_key(w, g), &top);
                st.groups_done += 1;
                budget -= 1;
            }
            if st.groups_done >= groups {
                lw.closed = true;
                write(&wk, &lw);
                if lw.players > 0 {
                    let winners: Vec<serde_json::Value> = (0..groups)
                        .filter_map(|g| {
                            read::<Vec<Standing>>(&result_key(w, g)).and_then(|t| t.into_iter().next()).map(
                                |s| json!({"group": g, "account_id": s.account_id, "points": s.points}),
                            )
                        })
                        .collect();
                    self.feed.push(
                        EventName::LeagueClosed,
                        json!({"week": w, "players": lw.players, "groups": groups, "winners": winners}),
                    );
                }
                st.next_league += 1;
                st.groups_done = 0;
            }
        }
        write(&state_key(), &st);
    }

    /// Writes the reviews of weeks that are over, at most `max`.
    fn wk_reviews(&mut self, st: &mut WeeklyState, cw: u64, max: u32) {
        let mut n = 0;
        while st.next_review < cw && n < max {
            let w = st.next_review;
            let backfilled = w < st.first_week;
            let rec = self.wk_build_review(w, backfilled);
            // Stamps of the review before it are no longer needed once its stamping week is over.
            if let Some(prev) = w.checked_sub(1) {
                if let Some(mut p) = read::<ReviewRec>(&review_key(prev)) {
                    if !p.stampers.is_empty() {
                        p.stampers.clear();
                        write(&review_key(prev), &p);
                    }
                }
            }
            write(&review_key(w), &rec);
            if !rec.backfilled && rec.rounds > 0 {
                self.feed.push(
                    EventName::ReviewWritten,
                    json!({"week": w, "bets": rec.bets, "refused": rec.refused, "skipped": rec.skipped,
                           "result": wire::I128(rec.result), "rank_end": rank_of(rec.rank_end)}),
                );
            }
            st.next_review += 1;
            n += 1;
        }
    }

    fn wk_build_review(&self, w: u64, backfilled: bool) -> ReviewRec {
        let (first, last) = (first_round(w), last_round(w));
        let mut rec = ReviewRec {
            week: w,
            written_at: Self::now(),
            backfilled,
            rounds: 0,
            settled: 0,
            bets: 0,
            refused: 0,
            skipped: 0,
            result: 0,
            best: None,
            worst: None,
            codes: read(&codes_key(w)).unwrap_or_else(|| vec![0; Refusal::ALL.len()]),
            rank_start: 0,
            rank_end: 0,
            status_end: 0,
            pool_start: 0,
            pool_end: 0,
            long_shot: self.ls.round.is_some_and(|t| (first..=last).contains(&t)) && self.ls.used,
            league_players: read::<LeagueWeek>(&week_key(w)).map_or(0, |l| l.players),
            stamps: 0,
            stampers: Vec::new(),
        };
        let mut seen_first = false;
        for id in first..=last {
            let Some(r) = self.rounds.get(&id) else { continue };
            if !seen_first {
                rec.rank_start = r.rank;
                rec.pool_start = r.brave_at_open;
                seen_first = true;
            }
            rec.rank_end = r.rank;
            rec.status_end = r.status;
            rec.pool_end = r.brave_at_open;
            rec.rounds += 1;
            rec.refused += r.refused;
            rec.skipped += r.skipped;
            if r.settled {
                rec.settled += 1;
                rec.result += r.result;
            }
            for pid in self.round_positions.get(&id).cloned().unwrap_or_default() {
                rec.bets += 1;
                let Some(p) = self.positions.get(&pid) else { continue };
                let Some(back) = p.returned else { continue };
                let res = back as i128 - p.margin as i128;
                if rec.best.is_none_or(|(_, b)| res > b) {
                    rec.best = Some((pid, res));
                }
                if rec.worst.is_none_or(|(_, b)| res < b) {
                    rec.worst = Some((pid, res));
                }
            }
        }
        // The pool at the end: the next week's first round's opening, if it has opened.
        if let Some(next) = self.rounds.get(&(last + 1)) {
            rec.pool_end = next.brave_at_open;
        }
        rec
    }

    fn bet_line(&self, b: Option<(u64, i128)>) -> Option<BetLine> {
        let (pid, res) = b?;
        let p = self.positions.get(&pid)?;
        Some(BetLine {
            position_id: pid,
            round_id: p.round_id,
            market: crate::round::market_of(p.market),
            side: crate::round::side_of(p.side),
            margin: U128(p.margin),
            leverage: p.leverage,
            result: wire::I128(res),
        })
    }

    fn review_view(&self, r: &ReviewRec) -> ReviewView {
        let cw = week_of(self.wk_current());
        ReviewView {
            week: r.week,
            first_round: first_round(r.week),
            last_round: last_round(r.week),
            written_at: r.written_at,
            backfilled: r.backfilled,
            rounds: r.rounds,
            settled: r.settled,
            bets: r.bets,
            refused: r.refused,
            skipped: r.skipped,
            result: wire::I128(r.result),
            best_bet: self.bet_line(r.best),
            worst_bet: self.bet_line(r.worst),
            refusals: r
                .codes
                .iter()
                .enumerate()
                .filter(|(_, &n)| n > 0)
                .map(|(i, &n)| CodeCount { code: Refusal::ALL[i], count: n })
                .collect(),
            rank_start: rank_of(r.rank_start),
            rank_end: rank_of(r.rank_end),
            status_end: status_of(r.status_end),
            pool_start: U128(r.pool_start),
            pool_end: U128(r.pool_end),
            long_shot: r.long_shot,
            league_players: r.league_players,
            stamps: r.stamps,
            bar: REVIEW_BAR,
            bar_filled: r.stamps >= REVIEW_BAR,
            stamping_open: r.week + 1 == cw,
        }
    }
}

#[near]
impl Coin {
    /// 1.6. Stamps last week's review, once per account, during this week. Registered accounts only. The review is
    /// written first if `rewards_tick` has not yet run this week.
    pub fn stamp_review(&mut self, week: u64) -> ReviewView {
        let who = env::predecessor_account_id();
        require!(self.registered(&who), "register first (storage_deposit)");
        self.tick();
        let cw = week_of(self.wk_current());
        require!(week + 1 == cw, "only last week's review can be stamped, during this week");
        let (mut st, _) = self.wk_init();
        self.wk_reviews(&mut st, cw, REVIEWS_PER_TICK);
        write(&state_key(), &st);
        let rk = review_key(week);
        let mut rec: ReviewRec =
            read(&rk).unwrap_or_else(|| env::panic_str("last week's review is not written yet: try again shortly"));
        require!(!rec.stampers.contains(&who), "you have already stamped this review");
        require!(rec.stamps < MAX_STAMPS, "this review has all the stamps it can take");
        rec.stampers.push(who);
        rec.stamps += 1;
        if rec.stamps == REVIEW_BAR {
            self.feed.push(EventName::ReviewBarFilled, json!({"week": week, "stamps": rec.stamps}));
        }
        write(&rk, &rec);
        self.review_view(&rec)
    }

    /// 1.6. A week's league. `week` defaults to the current week; `account_id` picks that account's group;
    /// otherwise `group` (default 0). While the week runs, the whole group; once it is closed, its top three.
    pub fn get_league(&self, week: Option<u64>, group: Option<u32>, account_id: Option<AccountId>) -> LeagueView {
        let w = week.unwrap_or_else(|| week_of(self.wk_current()));
        let lw: LeagueWeek = read(&week_key(w)).unwrap_or_default();
        let groups = groups_of(lw.players);
        let group = match (&account_id, group) {
            (Some(a), _) => read::<Member>(&member_key(w, a)).map(|m| m.group).or_else(|| {
                (0..groups).find(|&g| {
                    read::<Vec<Standing>>(&result_key(w, g)).is_some_and(|t| t.iter().any(|s| &s.account_id == a))
                })
            }),
            (None, Some(g)) => Some(g).filter(|&g| g < groups),
            (None, None) => Some(0).filter(|_| groups > 0),
        };
        let standings = match group {
            Some(g) if lw.closed => read::<Vec<Standing>>(&result_key(w, g)).unwrap_or_default(),
            Some(g) => self.group_standings(w, g),
            None => Vec::new(),
        };
        LeagueView {
            week: w,
            first_round: first_round(w),
            last_round: last_round(w),
            players: lw.players,
            groups,
            group,
            closed: lw.closed,
            standings,
            group_size: GROUP_SIZE,
            max_groups: MAX_GROUPS,
        }
    }

    /// 1.6. Each group's top three of a closed week (empty while the week runs).
    pub fn get_league_results(&self, week: u64) -> Vec<GroupResult> {
        let lw: LeagueWeek = read(&week_key(week)).unwrap_or_default();
        if !lw.closed {
            return Vec::new();
        }
        (0..groups_of(lw.players))
            .map(|g| GroupResult { group: g, top: read(&result_key(week, g)).unwrap_or_default() })
            .collect()
    }

    /// 1.6. A week's review, once written.
    pub fn get_review(&self, week: u64) -> Option<ReviewView> {
        read::<ReviewRec>(&review_key(week)).map(|r| self.review_view(&r))
    }

    /// 1.6. Written reviews, newest first. `from` is the highest week to return.
    pub fn get_reviews(&self, from: Option<u64>, limit: Option<u32>) -> Vec<ReviewView> {
        let st = self.wk_state();
        let Some(newest) = st.next_review.checked_sub(1) else { return Vec::new() };
        let top = from.map_or(newest, |f| f.min(newest));
        let n = limit.unwrap_or(10).clamp(1, 50) as u64;
        (0..=top)
            .rev()
            .take(n as usize)
            .filter_map(|w| read::<ReviewRec>(&review_key(w)).map(|r| self.review_view(&r)))
            .collect()
    }

    /// 1.6. The current week, its league's size, and the review that can be stamped.
    pub fn get_week(&self) -> WeekView {
        let current = self.wk_current();
        let w = week_of(current);
        let lw: LeagueWeek = read(&week_key(w)).unwrap_or_default();
        let review_to_stamp = w.checked_sub(1).filter(|&p| env::storage_has_key(&review_key(p)));
        WeekView {
            round_id: current,
            week: w,
            first_round: first_round(w),
            last_round: last_round(w),
            rounds_per_week: WEEK_ROUNDS,
            league_players: lw.players,
            league_groups: groups_of(lw.players),
            group_size: GROUP_SIZE,
            max_groups: MAX_GROUPS,
            review_to_stamp,
            review_bar: REVIEW_BAR,
            max_stamps: MAX_STAMPS,
        }
    }
}
