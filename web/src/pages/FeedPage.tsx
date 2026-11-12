import { useState } from "react";
import "./pages.css";
import { getChain, useDesk } from "../chain/store";
import type { EventName, FeedItem } from "../chain/types";
import { feedRow } from "../home/feedText";
import { day, href } from "../lib/nav";
import { useNow } from "../lib/useNow";
import { TopBar } from "../ui/TopBar";
import { Waiting } from "../ui/Waiting";

const FILTERS: { name: string; events: EventName[] | null }[] = [
  { name: "Everything", events: null },
  { name: "Bets", events: ["approved", "order_signed", "result_reported", "settled", "skipped"] },
  { name: "NOPEs", events: ["refused"] },
  { name: "Votes", events: ["vote_opened", "vote_cast", "vote_finished", "rank_changed", "fired", "rehired", "locked", "unlocked", "playbook_submitted", "playbook_activated"] },
  { name: "Money", events: ["paid_in", "coins_minted", "cashed_out", "dial_turned", "outside_income", "tipped", "coach_paid"] },
  { name: "Goals", events: ["tipped", "goal_filled", "hype_level", "sticker_claimed"] },
];

const hhmm = (at: number) => new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

/** Everything the program has announced, newest first, with filters and older pages. */
export function FeedPage() {
  const snap = useDesk();
  const now = useNow(30_000);
  const [filter, setFilter] = useState(0);
  const [older, setOlder] = useState<FeedItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [end, setEnd] = useState(false);
  const { desk } = snap;

  if (!desk) {
    return (
      <div className="home">
        <TopBar source={snap.source} scene={snap.scene} />
        <Waiting error={snap.error} line="Unrolling the feed…" />
      </div>
    );
  }

  const all = [...older, ...desk.feed];
  const oldest = all[0]?.seq ?? 0;
  const wanted = FILTERS[filter]!.events;
  const rows = all.filter((f) => !wanted || wanted.includes(f.event)).reverse();

  // The program pages forward from a number, so "older" asks for the 50 items before the oldest one shown
  async function loadOlder() {
    setBusy(true);
    try {
      const from = Math.max(0, oldest - 51);
      const items = (await getChain().getFeed(from, 50)).filter((f) => f.seq < oldest);
      if (items.length === 0) setEnd(true);
      setOlder((o) => [...items, ...o]);
    } finally {
      setBusy(false);
    }
  }

  let lastDay = "";
  return (
    <div className="home">
      <TopBar source={snap.source} scene={snap.scene} />
      <main id="main" className="feed-page">
        <header>
          <h1>Everything that happened</h1>
          <p className="judge-sub">Each line is something the program announced. Newest first. Times are UTC.</p>
        </header>
        <div className="chips" role="group" aria-label="Show">
          {FILTERS.map((f, i) => (
            <button key={f.name} className="chip-btn" aria-pressed={i === filter} onClick={() => setFilter(i)}>
              {f.name}
            </button>
          ))}
        </div>
        <section className="screen panel-dark">
          {rows.length === 0 ? (
            <p className="empty">Nothing of that kind yet.</p>
          ) : (
            <ul className="feed feed-full">
              {rows.map((f) => {
                const row = feedRow(f);
                const d = day(f.at);
                const head = d !== lastDay;
                lastDay = d;
                return (
                  <li key={f.seq} className={head ? "has-day" : ""}>
                    {head && <span className="feed-day">{d === day(now) ? "Today" : d}</span>}
                    <img className="feed-face" src={`/cast/face-${row.face}.webp`} alt="" width={40} height={40} />
                    <span className={`tag tag-${row.tone}`}>{row.tag}</span>
                    <span className="feed-text">
                      {row.text}
                      {row.code && f.event === "refused" && (
                        <a className="mono feed-code" href={href("nope", { id: f.data.refusal_id })}>
                          {" "}
                          {row.code}
                        </a>
                      )}
                      {row.note && <span className="feed-note">{row.note}</span>}
                    </span>
                    <time className="mono dim" dateTime={new Date(f.at).toISOString()}>
                      {hhmm(f.at)}
                    </time>
                  </li>
                );
              })}
            </ul>
          )}
          {!end && oldest > 1 && (
            <button className="more" onClick={loadOlder} disabled={busy}>
              {busy ? "Fetching…" : "Show older"}
            </button>
          )}
          {end && <p className="feed-end">That's as far back as the program keeps. It holds its last 1,000 announcements.</p>}
        </section>
      </main>
    </div>
  );
}
