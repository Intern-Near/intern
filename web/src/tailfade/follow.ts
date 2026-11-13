// 01 1.7, owner's decision (Engine 2's list, item 18): copy trading with one rule, and nothing of ours holding money
// or keys.
//
// A visitor sets one rule (TAIL or FADE, a $10 or $25 chip, a leverage, at most N chips a day) and approves a trading
// key once (Tail or Fade's own approval: it can trade, never withdraw). Each time the Intern's bet opens a Tail or
// Fade window, their own key places the chip on their own Hyperliquid account. On the website that happens while the
// page is open; `scripts/follow.ts` does it from a terminal. Cancelling is turning it off, or revoking the key.

import type { FeedItem, Window } from "./tailfade.ts";
import { openWindow } from "./tailfade.ts";

export interface FollowRule {
  choice: "TAIL" | "FADE";
  chipUsd: 10 | 25;
  leverage: 2 | 5 | 10;
  /** At most this many chips in any 24 hours. */
  maxPerDay: number;
}

export function checkRule(r: FollowRule): string | null {
  if (r.choice !== "TAIL" && r.choice !== "FADE") return "choice must be TAIL or FADE";
  if (r.chipUsd !== 10 && r.chipUsd !== 25) return "the chip is $10 or $25";
  if (r.leverage !== 2 && r.leverage !== 5 && r.leverage !== 10) return "leverage is 2, 5 or 10";
  if (!Number.isInteger(r.maxPerDay) || r.maxPerDay < 1 || r.maxPerDay > 48) return "maxPerDay is 1 to 48";
  return null;
}

/**
 * The window to follow now, or null: an open window for a bet not followed yet, while fewer than `maxPerDay` chips
 * were placed in the last 24 hours. `done` holds the position ids already followed; `placedAt` the times of chips.
 */
export function nextFollow(
  feed: FeedItem[],
  rule: FollowRule,
  done: ReadonlySet<number>,
  placedAt: readonly number[],
  now: number,
): Window | null {
  const w = openWindow(feed, now);
  if (w === null || done.has(w.position_id)) return null;
  const today = placedAt.filter((t) => now - t < 86_400_000).length;
  if (today >= rule.maxPerDay) return null;
  return w;
}
