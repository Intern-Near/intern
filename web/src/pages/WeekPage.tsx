import { useState } from "react";
import "./pages.css";
import "./people.css";
import "./live.css";
import { BossMug } from "../cast/BossMug";
import { Stamp } from "../cast/Stamp";
import { signIn, useDoing, useSession } from "../chain/session";
import { getChain, useDesk } from "../chain/store";
import type { ReviewView } from "../chain/types";
import { shortAccount, signedUsd, titleCase, usd } from "../lib/format";
import { day, href } from "../lib/nav";
import { useAsync } from "../lib/useAsync";
import { TopBar } from "../ui/TopBar";
import { Waiting } from "../ui/Waiting";

/** One week's record, written by the program from its own rounds. */
function Review({ r, stamp, busy, canStamp }: { r: ReviewView; stamp: (() => void) | null; busy: boolean; canStamp: boolean }) {
  const up = BigInt(r.result) >= 0n;
  return (
    <article className={`card review${r.stamping_open ? " is-open" : ""}`} aria-labelledby={`rev-${r.week}`}>
      <header className="review-head">
        <h3 id={`rev-${r.week}`}>
          Week {r.week} <span>· shifts {r.first_round} to {r.last_round}</span>
        </h3>
        <p className={`review-result mono ${up ? "tf-up" : "tf-down"}`}>
          {up ? "▲" : "▼"} {signedUsd(r.result)}
        </p>
      </header>
      <dl className="review-facts">
        <div>
          <dt>Bets</dt>
          <dd className="mono">{r.bets}</dd>
        </div>
        <div>
          <dt>Refused</dt>
          <dd className="mono">{r.refused}</dd>
        </div>
        <div>
          <dt>Skipped</dt>
          <dd className="mono">{r.skipped}</dd>
        </div>
        <div>
          <dt>BRAVE pool</dt>
          <dd className="mono">
            {usd(r.pool_start)} → {usd(r.pool_end)}
          </dd>
        </div>
        <div>
          <dt>Rank</dt>
          <dd>
            {r.status_end === "FIRED" ? "Fired" : r.rank_start === r.rank_end ? titleCase(r.rank_end) : `${titleCase(r.rank_start)} → ${titleCase(r.rank_end)}`}
          </dd>
        </div>
      </dl>
      <ul className="review-lines">
        {r.best_bet && (
          <li>
            Best bet: {titleCase(r.best_bet.side)} {r.best_bet.market} with {usd(r.best_bet.margin)} at {r.best_bet.leverage}x, shift {r.best_bet.round_id}:{" "}
            <span className="mono">{signedUsd(r.best_bet.result)}</span>
          </li>
        )}
        {r.worst_bet && r.worst_bet.position_id !== r.best_bet?.position_id && (
          <li>
            Worst bet: {titleCase(r.worst_bet.side)} {r.worst_bet.market} with {usd(r.worst_bet.margin)} at {r.worst_bet.leverage}x, shift {r.worst_bet.round_id}:{" "}
            <span className="mono">{signedUsd(r.worst_bet.result)}</span>
          </li>
        )}
        {r.refusals.length > 0 && (
          <li>
            Refusals:{" "}
            {r.refusals.map((x, i) => (
              <span key={x.code}>
                {i > 0 && ", "}
                <span className="mono">{x.code}</span> × {x.count}
              </span>
            ))}
          </li>
        )}
        {r.long_shot && <li>This week had a long-shot ticket.</li>}
        {r.settled < r.rounds && (
          <li>
            {r.settled} of {r.rounds} shifts were settled when this was written.
          </li>
        )}
      </ul>
      <div className="review-foot">
        <div className="review-bar" role="img" aria-label={`${r.stamps} of ${r.bar} stamps`}>
          {Array.from({ length: r.bar }, (_, i) => (
            <span key={i} className={i < r.stamps ? "is-on" : ""} />
          ))}
        </div>
        <p className="review-count">
          <strong className="mono">{r.stamps}</strong> {r.stamps === 1 ? "stamp" : "stamps"}
          {r.bar_filled ? ". The bar is full." : r.stamping_open ? `. ${Math.max(0, r.bar - r.stamps)} more fill the bar.` : "."}
        </p>
        {r.stamping_open && stamp && (
          <button className="btn" disabled={busy || !canStamp} onClick={stamp}>
            {busy ? "Stamping…" : "Stamp it"}
          </button>
        )}
      </div>
      <p className="fine">
        Written by the program from its own rounds on {day(r.written_at)}
        {r.backfilled ? ", after the fact: this week ended before weekly reviews existed" : ""}. A stamp says "I read this". It is free, changes nothing the Intern may
        do, and is open only during the week after.
      </p>
    </article>
  );
}

/** The week (7 rounds): this week's league of guessers, and the weekly reviews with their stamp bar. Interface 1.6, section 9.8. */
export function WeekPage() {
  const snap = useDesk();
  const session = useSession();
  const { desk } = snap;
  const [bump, setBump] = useState(0);
  const doing = useDoing(() => setBump((b) => b + 1));
  const seq = desk?.feed[desk.feed.length - 1]?.seq ?? 0;
  const me = session.accountId;
  const data = useAsync(async () => {
    const chain = getChain();
    const week = await chain.getWeek();
    const [mine, reviews, last] = await Promise.all([
      me ? chain.getLeague({ accountId: me }) : Promise.resolve(null),
      chain.getReviews(undefined, 8),
      week.week > 0 ? chain.getLeagueResults(week.week - 1) : Promise.resolve([]),
    ]);
    // Without an account, or before the visitor's first guess of the week, show the first group
    const league = mine && mine.group !== null ? mine : await chain.getLeague({});
    return { week, league, joined: !!mine && mine.group !== null, reviews, last };
  }, `week-${seq}-${bump}-${me}`);

  if (!desk) {
    return (
      <div className="home">
        <TopBar source={snap.source} scene={snap.scene} />
        <Waiting error={snap.error} line="Opening the week's file…" />
      </div>
    );
  }
  const d = data.data;
  const actions = session.actions;

  return (
    <div className="home">
      <TopBar source={snap.source} scene={snap.scene} />
      <main id="main" className="people-page week-page">
        <header className="people-head">
          <Stamp pose="watching" size={150} />
          <div>
            <h1>The week</h1>
            <p>
              A week here is seven shifts. Each week has a league for the people guessing the stamp, and at the end the program writes up what the Intern did.
              {desk.constants.network !== "mainnet" && " On the test network a shift is 30 minutes, so a week is three and a half hours."}
            </p>
          </div>
        </header>

        {(doing.error || doing.done) && (
          <p className={`notice ${doing.error ? "notice-bad" : "notice-ok"}`} role={doing.error ? "alert" : "status"}>
            {doing.error ?? doing.done}
          </p>
        )}

        {!d ? (
          <p className="pencil">{data.error ? `Couldn't load the week. Nothing was sent. ${data.error}` : "Looking…"}</p>
        ) : (
          <>
            <section className="card money-form" aria-labelledby="lg-h">
              <h2 id="lg-h">
                This week's league <span className="h2-note">week {d.week.week} · shifts {d.week.first_round} to {d.week.last_round}</span>
              </h2>
              <p>
                Your first guess of the week puts you in. You are ranked on this week's guesses only: most right guesses first, then the longest run of right guesses,
                then fewer wrong ones. <strong>Points only. There is no prize.</strong>
              </p>
              <p className={d.joined ? "tf-ready" : "warn"}>
                {d.joined
                  ? `You are in group ${(d.league.group ?? 0) + 1} of ${Math.max(1, d.league.groups)}.`
                  : me
                    ? "You haven't guessed this week. Make a guess to join this week's league."
                    : "Clock in and make a guess to join this week's league."}{" "}
                {d.week.league_players} {d.week.league_players === 1 ? "person has" : "people have"} joined so far.
              </p>
              {d.league.standings.length === 0 ? (
                <p className="people-empty">Nobody has guessed this week yet. The first guess opens the league.</p>
              ) : (
                <div className="table-scroll">
                  <table className="judge-table league-table">
                    <caption className="sr-only">
                      Standings of group {(d.league.group ?? 0) + 1}
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Place</th>
                        <th scope="col">Guesser</th>
                        <th scope="col" className="r">
                          Right
                        </th>
                        <th scope="col" className="r">
                          Wrong
                        </th>
                        <th scope="col" className="r">
                          Best run
                        </th>
                        <th scope="col" className="r">
                          Waiting
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.league.standings.map((s) => (
                        <tr key={s.account_id} className={s.account_id === me ? "is-me" : ""}>
                          <td className="mono">{s.place}</td>
                          <td>
                            <span className="league-who">
                              <BossMug accountId={s.account_id} size={28} />
                              <span title={s.account_id}>{shortAccount(s.account_id, 26)}</span>
                              {s.account_id === me && <span className="now-tag">you</span>}
                            </span>
                          </td>
                          <td className="mono r">{s.points}</td>
                          <td className="mono r">{s.wrong}</td>
                          <td className="mono r">{s.best_run}</td>
                          <td className="mono r">{s.waiting}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="fine">
                "Waiting" is a guess whose shift has no ruling yet. A shift that ends with no ruling counts for nothing. A league holds {d.league.max_groups} groups of{" "}
                {d.league.group_size}; guessers after that still earn points but have no group.
              </p>
              {me ? (
                <a className="btn" href={href("rewards")}>
                  Make this shift's guess
                </a>
              ) : (
                session.canSignIn && (
                  <button className="btn" onClick={signIn}>
                    {session.pretend ? "Clock in with a pretend account" : "Clock in with a NEAR wallet"}
                  </button>
                )
              )}
            </section>

            {d.last.length > 0 && (
              <section aria-labelledby="lw-h">
                <h2 id="lw-h">Last week's winners</h2>
                <ul className="fills">
                  {d.last.map((g) => (
                    <li key={g.group}>
                      <span className="mono pencil">group {g.group + 1}</span>
                      <span>{g.top.map((s) => `${s.place}. ${shortAccount(s.account_id, 20)} (${s.points})`).join("   ")}</span>
                      <span className="pencil">points only</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section aria-labelledby="rv-h">
              <h2 id="rv-h">Weekly reviews</h2>
              {d.reviews.length === 0 ? (
                <p className="people-empty">No week has ended yet. The first review is written when this week closes.</p>
              ) : (
                <div className="reviews">
                  {d.reviews.map((r) => (
                    <Review
                      key={r.week}
                      r={r}
                      busy={doing.busy === `stamp-${r.week}`}
                      canStamp={!doing.busy}
                      stamp={actions ? () => void doing.run(`stamp-${r.week}`, () => actions.stampReview(r.week), `You stamped week ${r.week}'s review.`) : null}
                    />
                  ))}
                </div>
              )}
              {!actions && d.reviews.some((r) => r.stamping_open) && <p className="fine">Clock in to stamp last week's review. One stamp per account.</p>}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
