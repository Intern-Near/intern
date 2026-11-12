//! Section 10: every change is logged in the NEP-297 form and kept in a ring of the latest 1,000
//! events, served by `get_feed`. `seq` only goes up.

use near_sdk::serde_json::{self, Value};
use near_sdk::store::LookupMap;
use near_sdk::{env, near, IntoStorageKey};
use wire::{event_log, EventName, FeedItem};

/// The feed keeps this many items.
pub const FEED_KEEP: u64 = 1_000;
const DEFAULT_LIMIT: u64 = 50;
const MAX_LIMIT: u64 = 100;

#[near(serializers = [borsh])]
pub struct Feed {
    items: LookupMap<u64, String>,
    first: u64,
    next: u64,
}

impl Feed {
    pub fn new<S: IntoStorageKey>(prefix: S) -> Self {
        Feed {
            items: LookupMap::new(prefix),
            first: 1,
            next: 1,
        }
    }

    /// Logs the event and keeps it. Drops the oldest beyond 1,000.
    pub fn push(&mut self, event: EventName, data: Value) {
        env::log_str(&event_log(event, &data));
        let item = FeedItem {
            seq: self.next,
            at: env::block_timestamp_ms(),
            event,
            data,
        };
        self.items.insert(
            self.next,
            serde_json::to_string(&item).expect("an event always serializes"),
        );
        self.next += 1;
        while self.next - self.first > FEED_KEEP {
            self.items.remove(&self.first);
            self.first += 1;
        }
    }

    /// Oldest first. No `after_seq`: the latest `limit` items. Behind the oldest kept item: starts
    /// at the oldest kept item. `limit` defaults to 50 and is capped at 100 (section 8, 1.1).
    pub fn page(&self, after_seq: Option<u64>, limit: Option<u32>) -> Vec<FeedItem> {
        let n = limit.map_or(DEFAULT_LIMIT, |l| (l as u64).clamp(1, MAX_LIMIT));
        let start = match after_seq {
            None => self.next.saturating_sub(n).max(self.first),
            Some(a) => a.saturating_add(1).max(self.first),
        };
        let end = start.saturating_add(n).min(self.next);
        (start..end)
            .filter_map(|seq| self.items.get(&seq))
            .map(|t| serde_json::from_str(t).expect("stored items are valid"))
            .collect()
    }

    pub fn last_seq(&self) -> u64 {
        self.next - 1
    }

    pub fn first_seq(&self) -> u64 {
        self.first
    }
}
