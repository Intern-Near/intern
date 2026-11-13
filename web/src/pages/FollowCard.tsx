import { useEffect, useRef, useState } from "react";
import "./v17-mine.css";
import type { FeedItem } from "../chain/types";
import type { Agent, Driver } from "../lib/tailfadeDriver";
import { checkRule, nextFollow, type FollowRule } from "../tailfade/follow.ts";
import { HL_NAME, liquidationMovePct, TAIL_OR_FADE, type FeedItem as LibFeedItem } from "../tailfade/tailfade.ts";

type Kept = { rule: FollowRule; on: boolean; done: number[]; placedAt: number[]; log: string[] };
const START: Kept = { rule: { choice: "TAIL", chipUsd: 10, leverage: 2, maxPerDay: 3 }, on: false, done: [], placedAt: [], log: [] };
const keyFor = (accountId: string) => `intern-follow:${accountId}`;

function read(accountId: string): Kept {
  try {
    const raw = window.localStorage.getItem(keyFor(accountId));
    if (raw) {
      const k = { ...START, ...(JSON.parse(raw) as Partial<Kept>) };
      if (checkRule(k.rule) === null) return k;
    }
  } catch {
    /* start fresh */
  }
  return START;
}

const hhmm = (at: number) => new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

/**
 * Copy trading with one rule (interface 1.7, section 9.15): while this page is open and the rule is on, each time
 * one of the Intern's bets opens a Tail or Fade window, the visitor's own approved trading key places one chip on
 * the visitor's own Hyperliquid account. Engine 1's follow.ts decides when; nothing of ours holds money or keys.
 */
export function FollowCard({ accountId, agent, driver, feed, now, ready }: { accountId: string; agent: Agent | null; driver: Driver; feed: FeedItem[]; now: number; ready: boolean }) {
  const [kept, setKept] = useState<Kept>(() => read(accountId));
  const busy = useRef(false);
  const save = (next: Kept) => {
    setKept(next);
    try {
      window.localStorage.setItem(keyFor(accountId), JSON.stringify(next));
    } catch {
      /* kept for this visit only */
    }
  };
  const keptRef = useRef(kept);
  keptRef.current = kept;

  // One look every ten seconds, and whenever the feed grows
  const tick = Math.floor(now / 10_000);
  useEffect(() => {
    const k = keptRef.current;
    if (!k.on || !ready || !agent || busy.current) return;
    const w = nextFollow(feed as unknown as LibFeedItem[], k.rule, new Set(k.done), k.placedAt, Date.now());
    if (!w) return;
    busy.current = true;
    // Marked as followed before the order goes out, so a slow answer can never place a second chip on the same bet
    const marked = { ...k, done: [...k.done, w.position_id].slice(-50) };
    save(marked);
    driver
      .chip({ agent, market: w.market, choice: k.rule.choice, internSide: w.side, chipUsd: k.rule.chipUsd, leverage: k.rule.leverage })
      .then(
        (r) => (r.ok ? `${hhmm(Date.now())} UTC: bet ${w.position_id}, ${k.rule.choice === "TAIL" ? "tailed" : "faded"} with $${k.rule.chipUsd} at ${k.rule.leverage}x: ${r.sz} ${HL_NAME[w.market] ?? w.market} at ${r.px}.` : `${hhmm(Date.now())} UTC: bet ${w.position_id}: the chip did not go in (${r.why}). Nothing was bet.`),
        (e: unknown) => `${hhmm(Date.now())} UTC: bet ${w.position_id}: the chip did not go in (${e instanceof Error ? e.message : String(e)}). Nothing was bet.`,
      )
      .then((line) => {
        const cur = keptRef.current;
        save({ ...cur, done: marked.done, placedAt: line.includes("did not go in") ? cur.placedAt : [...cur.placedAt, Date.now()].slice(-60), log: [line, ...cur.log].slice(0, 8) });
        busy.current = false;
      });
    // The rule and the lists are read from the ref at the moment of each look
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, feed.length, ready, agent, kept.on]);

  const { rule } = kept;
  const set = (patch: Partial<FollowRule>) => {
    const next = { ...rule, ...patch };
    if (checkRule(next) === null) save({ ...kept, rule: next });
  };
  const today = kept.placedAt.filter((t) => now - t < 86_400_000).length;

  return (
    <section className="card follow" aria-labelledby="follow-h">
      <h2 id="follow-h">Follow the Intern</h2>
      <p>
        Set one rule, and this page places your chip by itself each time one of the Intern's bets opens. It uses the trading key you already approved above, on your own
        Hyperliquid account.
      </p>
      <div className="follow-row">
        <fieldset className="tf-chips">
          <legend>Do what</legend>
          {(["TAIL", "FADE"] as const).map((c) => (
            <label key={c} className={rule.choice === c ? "is-on" : ""}>
              <input type="radio" name="f-choice" checked={rule.choice === c} onChange={() => set({ choice: c })} />
              {c === "TAIL" ? "Tail (same way)" : "Fade (against)"}
            </label>
          ))}
        </fieldset>
        <fieldset className="tf-chips">
          <legend>Chip</legend>
          {TAIL_OR_FADE.chipsUsd.map((c) => (
            <label key={c} className={rule.chipUsd === c ? "is-on" : ""}>
              <input type="radio" name="f-chip" checked={rule.chipUsd === c} onChange={() => set({ chipUsd: c })} />${c}
            </label>
          ))}
        </fieldset>
        <fieldset className="tf-chips">
          <legend>Leverage</legend>
          {TAIL_OR_FADE.leverages.map((l) => (
            <label key={l} className={rule.leverage === l ? "is-on" : ""}>
              <input type="radio" name="f-lev" checked={rule.leverage === l} onChange={() => set({ leverage: l })} />
              {l}x
            </label>
          ))}
        </fieldset>
        <div>
          <label className="follow-n" htmlFor="f-max">
            At most a day
          </label>
          <input id="f-max" type="number" min={1} max={48} value={rule.maxPerDay} onChange={(e) => set({ maxPerDay: Number(e.target.value) })} />
        </div>
      </div>
      <p className={rule.leverage > 2 ? "warn" : "tf-risk"}>
        Each chip is ${rule.chipUsd} at {rule.leverage}x: a move of about {liquidationMovePct(rule.leverage)}% against you ends it. At most {rule.maxPerDay} a day is up to $
        {rule.chipUsd * rule.maxPerDay} a day at risk. A chip stays open until you close it yourself.
      </p>
      <p>
        <button className="btn" disabled={!ready && !kept.on} onClick={() => save({ ...kept, on: !kept.on })} aria-pressed={kept.on}>
          {kept.on ? "Stop following" : "Start following"}
        </button>{" "}
        <span className={`follow-state${kept.on ? " is-on" : ""}`} role="status">
          {kept.on ? (ready ? `On. ${today} of ${rule.maxPerDay} chips placed in the last 24 hours.` : "On, but waiting: finish the steps above first.") : ready ? "Off." : "Finish the steps above first."}
        </span>
      </p>
      {kept.log.length > 0 && (
        <ul className="follow-log mono" aria-label="What following did">
          {kept.log.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
      <p className="fine">
        <strong>Non-custodial.</strong> Nothing of ours holds your money or your key: the key lives in this browser, can place and close bets, and can never withdraw. The
        contract does not place these orders and does not check them. It only works while this page is open in a tab. Following the Intern is a bet, not a strategy: most
        AI traders that were measured lost money. Test network, test dollars.{driver.pretend ? " Sample data: every chip here is pretend." : ""} The same rule can run from a
        terminal with <span className="mono">tailfade/scripts/follow.ts</span>.
      </p>
    </section>
  );
}
