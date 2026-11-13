//! Step 9 (01-SHARED-INTERFACE.md 1.3, section 9.5): tips and the goal bars (boss goal, tip jar,
//! hype train). Bars the whole audience fills together. A goal never moves money and never changes
//! what the Intern may trade; filling one makes a sticker claimable (claims.rs) and is a stream event.

use crate::*;

/// 1.3, `PROPOSED` numbers (also in `get_constants().goals`).
pub const BOSS_LADDER: [u64; 7] = [10, 25, 50, 100, 250, 500, 1000];
pub const TIP_JAR_TARGET: u128 = 100_000_000;
pub const MIN_TIP: u128 = 1_000_000;
pub const HYPE_WINDOW_MS: u64 = 300_000;
pub const HYPE_LEVELS: [u32; 5] = [3, 6, 10, 15, 25];

pub const BOSS: u8 = 0;
pub const TIP_JAR: u8 = 1;
pub const HYPE: u8 = 2;

pub fn goal_name(g: u8) -> &'static str {
    match g {
        BOSS => "BOSS",
        TIP_JAR => "TIP_JAR",
        _ => "HYPE",
    }
}

fn goal_kind(g: u8) -> wire::GoalKind {
    match g {
        BOSS => wire::GoalKind::Boss,
        TIP_JAR => wire::GoalKind::TipJar,
        _ => wire::GoalKind::Hype,
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GoalFillRec {
    pub id: u64,
    pub goal: u8,
    pub level: u32,
    pub at: u64,
    pub round_id: u64,
    /// The jar number (tip jar) or the train number (hype); 0 for the boss goal.
    pub key: u64,
}

impl Coin {
    pub(crate) fn bosses_now(&self) -> u64 {
        (self.books.holders + self.books.newcomers_converted) as u64
    }

    fn fill(&mut self, goal: u8, level: u32, key: u64) -> u64 {
        let id = self.s9.next_fill_id;
        self.s9.next_fill_id += 1;
        let round_id = self.current.expect("round").id;
        self.goal_fills.insert(
            id,
            GoalFillRec {
                id,
                goal,
                level,
                at: Self::now(),
                round_id,
                key,
            },
        );
        self.feed.push(
            EventName::GoalFilled,
            json!({"fill_id": id, "goal": goal_kind(goal), "level": level, "round_id": round_id}),
        );
        id
    }

    /// Fills every boss-goal level the number of bosses has reached. Called after anything that can
    /// change that number.
    pub(crate) fn check_boss_goal(&mut self) {
        while let Some(target) = BOSS_LADDER.get(self.s9.boss_level as usize).copied() {
            if self.bosses_now() < target {
                break;
            }
            self.s9.boss_level += 1;
            self.fill(BOSS, self.s9.boss_level, 0);
        }
    }

    /// One hype point for `who` (a tip, or a BRAVE pay-in of at least `min_notional`). One per account
    /// per train; a train ends `HYPE_WINDOW_MS` after its latest point.
    pub(crate) fn hype_point(&mut self, who: &AccountId) {
        let now = Self::now();
        let running = self.s9.train > 0 && now <= self.s9.train_last + HYPE_WINDOW_MS;
        if !running {
            self.s9.train += 1;
            self.s9.train_level = 0;
            self.s9.train_points = 0;
        }
        let train = self.s9.train;
        if !self.hype_riders.insert((train, who.clone())) {
            return; // already on this train
        }
        self.s9.train_points += 1;
        self.s9.train_last = now;
        while let Some(need) = HYPE_LEVELS.get(self.s9.train_level as usize).copied() {
            if self.s9.train_points < need {
                break;
            }
            self.s9.train_level += 1;
            self.feed.push(
                EventName::HypeLevel,
                json!({"train": train, "level": self.s9.train_level, "points": self.s9.train_points}),
            );
            self.fill(HYPE, self.s9.train_level, train);
        }
    }

    /// A tip: a gift to the BRAVE pool. Like all outside income (step 8) it is credited at the next
    /// round's opening. It fills the tip jar and adds a hype point. The caller checked the minimum.
    pub(crate) fn take_tip(&mut self, who: &AccountId, amount: u128) {
        // 1.4: half of every tip goes to the streak jackpot; the rest to the pool, as before.
        let to_pool = self.rw_tip(amount);
        self.s9.income_waiting += to_pool;
        self.s9.outside_income_total += to_pool;
        self.feed.push(
            EventName::Tipped,
            json!({"account_id": who, "amount": U128(amount)}),
        );
        let mut left = amount;
        loop {
            self.jar_tippers.insert((self.s9.jar, who.clone()));
            let room = TIP_JAR_TARGET - self.s9.jar_now;
            if left < room {
                self.s9.jar_now += left;
                break;
            }
            // This jar is full; any rest starts the next one.
            left -= room;
            let jar = self.s9.jar;
            self.fill(TIP_JAR, jar as u32, jar);
            self.s9.jar += 1;
            self.s9.jar_now = 0;
            if left == 0 {
                break;
            }
        }
        self.hype_point(who);
    }
}

#[near]
impl Coin {
    /// The three bars, as they stand now.
    pub fn get_goals(&self) -> wire::Goals {
        let now = Self::now();
        let (_, b, _, _) = self.projected();
        let running = self.s9.train > 0 && now <= self.s9.train_last + HYPE_WINDOW_MS;
        wire::Goals {
            boss: wire::BossGoal {
                level: self.s9.boss_level,
                target: BOSS_LADDER.get(self.s9.boss_level as usize).copied(),
                now: (b.holders + b.newcomers_converted) as u64,
            },
            tip_jar: wire::TipJar {
                jar: self.s9.jar,
                target: U128(TIP_JAR_TARGET),
                now: U128(self.s9.jar_now),
            },
            hype: if running {
                wire::Hype {
                    train: self.s9.train,
                    level: self.s9.train_level,
                    points: self.s9.train_points,
                    ends_at: Some(self.s9.train_last + HYPE_WINDOW_MS),
                }
            } else {
                wire::Hype {
                    train: self.s9.train,
                    level: 0,
                    points: 0,
                    ends_at: None,
                }
            },
        }
    }

    /// Newest first; `from` is the highest id to return.
    pub fn get_goal_fills(&self, from: Option<u64>, limit: Option<u32>) -> Vec<wire::GoalFill> {
        let last = self.s9.next_fill_id - 1;
        let start = from.map_or(last, |f| f.min(last));
        let n = limit.map_or(50, |l| l.clamp(1, 100)) as u64;
        (start.saturating_sub(n - 1).max(1)..=start)
            .rev()
            .filter_map(|i| self.goal_fills.get(&i))
            .map(|f| wire::GoalFill {
                id: f.id,
                goal: goal_kind(f.goal),
                level: f.level,
                at: f.at,
                round_id: f.round_id,
            })
            .collect()
    }
}
