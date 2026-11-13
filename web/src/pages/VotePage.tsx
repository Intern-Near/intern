import { useState } from "react";
import "./pages.css";
import "./people.css";
import { signIn, toE6, useDoing, useMe, useSession, type Doing } from "../chain/session";
import { useDesk, type Desk } from "../chain/store";
import type { Actions, Limits, RankName, Vote, VoteKind } from "../chain/types";
import { BossMug } from "../cast/BossMug";
import { Intern } from "../cast/Intern";
import { amount, clock, pct, shortAccount, titleCase } from "../lib/format";
import { day, href } from "../lib/nav";
import { useAsync } from "../lib/useAsync";
import { getChain } from "../chain/store";
import { useNow } from "../lib/useNow";
import { RescuePanel } from "../ui/Auto17";
import { TopBar } from "../ui/TopBar";
import { Waiting } from "../ui/Waiting";
import { Notice } from "../ui/Notice";

const ORDER: RankName[] = ["INTERN", "ANALYST", "TRADER"];
const KIND_WORD: Record<VoteKind, string> = { PROMOTE: "Promote", DEMOTE: "Demote", FIRE: "Fire", REHIRE: "Rehire", LONG_SHOT: "Allow a long shot", SET_PLAYBOOK: "Change playbook", RENEW: "Renew the term", CORRECT: "Correct a result" };
const TIGHTEN = (k: VoteKind) => k === "DEMOTE" || k === "FIRE";

const share = (part: bigint, whole: bigint) => (whole === 0n ? 0 : Number((part * 1000n) / whole) / 10);

function limitsLine(l: Limits): string {
  return `${pct(l.per_bet_bps)} a bet, ${l.max_bets} ${l.max_bets === 1 ? "bet" : "bets"} a shift, ${l.sides.includes("SHORT") ? `up or down, up to ${l.max_leverage}x` : "up only"}`;
}

/** What happens if this vote holds, in one plain sentence. */
function verdict(v: Vote, desk: Desk, now: number): string {
  const c = desk.constants.vote;
  const yes = BigInt(v.yes);
  const cast = yes + BigInt(v.no);
  const open = BigInt(v.locked_weight_at_open);
  const left = v.closes_at - now;
  const word = KIND_WORD[v.kind];
  if (cast === 0n) return `Nobody has voted yet. ${left > 0 ? `${clock(left)} left.` : "Time is up."}`;
  if (TIGHTEN(v.kind)) {
    // Interface 1.2: yes is counted against ALL locked coins, so "no" votes and low turnout can't change it
    const need = c.tighten_pass_bps / 100;
    const have = share(yes, open);
    if (yes * 10_000n >= open * BigInt(c.tighten_pass_bps)) return `${word} has yes from ${have}% of all locked coins. That is enough to pass right now. Anyone can finish it.`;
    return `${word} has yes from ${have}% of all locked coins. It needs ${need}%. Voting no doesn't cancel a yes. ${left > 0 ? `${clock(left)} left.` : "Time is up; as it stands, it fails."}`;
  }
  const yesPct = share(yes, cast);
  const turnout = share(cast, open);
  const quorum = c.promote_quorum_bps / 100;
  const passing = yesPct > c.promote_pass_bps / 100 && turnout >= quorum;
  if (v.kind === "SET_PLAYBOOK") {
    const what = v.playbook_id ? `playbook ${v.playbook_id} goes on the desk` : "the playbook comes off the desk";
    return `This has ${yesPct}% of votes cast, with ${turnout}% turnout (it needs more than half, and ${quorum}% turnout). ${left > 0 ? `${clock(left)} left. ` : "Time is up. "}${passing ? `If this holds, ${what} two shifts after it passes.` : "As it stands, it fails."}`;
  }
  const tail = `${left > 0 ? `${clock(left)} left. ` : "Time is up. "}`;
  const count = `${yesPct}% of votes cast, with ${turnout}% turnout (it needs more than half, and ${quorum}% turnout)`;
  if (v.kind === "RENEW") return `Renewing has ${count}. ${tail}${passing ? "If this holds, 30 days are added to the Intern's term the moment the vote is finished." : "As it stands, it fails, and the term ends when it ends."}`;
  if (v.kind === "CORRECT")
    return `This has ${count}. ${tail}${passing ? "If this holds, anyone can apply the correction: the bet's result becomes the challenger's figure and their bond comes back." : "As it stands, it fails: the reported result stays and the challenger's bond goes to the BRAVE pool."}`;
  if (v.kind === "LONG_SHOT") return `This has ${count}. ${tail}${passing ? "If this holds, the Intern gets one long-shot ticket two shifts after it passes." : "As it stands, it fails."}`;
  if (v.kind === "REHIRE") return `Rehire has ${count}. ${tail}${passing ? "If this holds, the Intern comes back as an Intern after one full shift, with a new 30-day term." : "As it stands, it fails."}`;
  const after = v.kind === "PROMOTE" ? titleCase(ORDER[Math.min(2, ORDER.indexOf(desk.rank.rank) + 1)]!) : "Intern";
  return `${word} has ${yesPct}% of votes cast, with ${turnout}% turnout (it needs more than half, and ${quorum}% turnout). ${
    left > 0 ? `${clock(left)} left. ` : "Time is up. "
  }${passing ? `If this holds, the Intern becomes ${/^[AEIOU]/.test(after) ? "an" : "a"} ${after} after one full shift.` : "As it stands, it fails."}`;
}

function VoteCard({ v, desk, now, actions, doing, weight }: { v: Vote; desk: Desk; now: number; actions: Actions | null; doing: Doing; weight: bigint }) {
  const yes = BigInt(v.yes);
  const no = BigInt(v.no);
  const cast = yes + no;
  const open = BigInt(v.locked_weight_at_open);
  const early = TIGHTEN(v.kind) && yes * 10_000n >= open * BigInt(desk.constants.vote.tighten_pass_bps);
  const canFinish = v.state === "OPEN" && (now >= v.closes_at || early);
  return (
    <article className={`card vote-card vote-${v.kind.toLowerCase()}`} aria-label={`Vote ${v.id}: ${KIND_WORD[v.kind]}`}>
      <header>
        <h3>
          {v.kind === "SET_PLAYBOOK"
            ? v.playbook_id
              ? `Put playbook ${v.playbook_id} on the desk`
              : "Take the playbook off the desk"
            : v.kind === "RENEW"
              ? "Renew the Intern's term by 30 days"
              : v.kind === "CORRECT"
                ? "Correct a bet's reported result"
                : v.kind === "LONG_SHOT"
                  ? "Allow one long shot"
                  : `${KIND_WORD[v.kind]} the Intern`}
        </h3>
        <p className="mono pencil">
          VOTE No. {v.id} · OPENED BY {shortAccount(v.opened_by, 20).toUpperCase()}
        </p>
      </header>
      <div className="tally" role="img" aria-label={`Yes ${share(yes, cast)}%, no ${share(no, cast)}%`}>
        <span className="tally-yes" style={{ flexGrow: Number(yes) || 0.0001 }}>
          YES {amount(v.yes)}
        </span>
        <span className="tally-no" style={{ flexGrow: Number(no) || 0.0001 }}>
          NO {amount(v.no)}
        </span>
      </div>
      {!TIGHTEN(v.kind) && (
        <div className="turnout">
          <div className="turnout-bar" role="img" aria-label={`Turnout ${share(cast, open)}% of locked coins`}>
            <span style={{ width: `${Math.min(100, share(cast, open))}%` }} />
            <i style={{ left: `${desk.constants.vote.promote_quorum_bps / 100}%` }} />
          </div>
          <p className="fine">Turnout {share(cast, open)}% of locked coins. The mark is the {desk.constants.vote.promote_quorum_bps / 100}% it needs.</p>
        </div>
      )}
      {v.kind === "CORRECT" && (
        <p className="fine">
          Someone put up a bond to say a bet's reported result is wrong. <a href={href("bets")}>See the challenge and its numbers on the bets page</a>, and compare with
          the fills on Hyperliquid before you vote.
        </p>
      )}
      <p className="vote-verdict">{v.state === "OPEN" ? verdict(v, desk, now) : v.state === "PASSED" ? `Passed.${v.effective_round ? ` In force from shift ${v.effective_round}.` : ""}` : "Did not pass."}</p>
      {v.state === "OPEN" && (
        <div className="row">
          {actions ? (
            <>
              <button className="btn vote-yes-btn" disabled={!!doing.busy || weight === 0n} onClick={() => doing.run(`yes-${v.id}`, () => actions.cast(v.id, true), "Your yes is in.")}>
                {doing.busy === `yes-${v.id}` ? "Voting…" : "Vote yes"}
              </button>
              <button className="btn btn-quiet" disabled={!!doing.busy || weight === 0n} onClick={() => doing.run(`no-${v.id}`, () => actions.cast(v.id, false), "Your no is in.")}>
                {doing.busy === `no-${v.id}` ? "Voting…" : "Vote no"}
              </button>
              {canFinish && (
                <button className="btn btn-quiet" disabled={!!doing.busy} onClick={() => doing.run(`fin-${v.id}`, () => actions.finishVote(v.id), "Vote finished.")}>
                  {doing.busy === `fin-${v.id}` ? "Finishing…" : "Finish the vote"}
                </button>
              )}
            </>
          ) : (
            <button className="btn" onClick={signIn}>
              Clock in to vote
            </button>
          )}
        </div>
      )}
    </article>
  );
}

function StartVote({ desk, actions, doing, canOpen }: { desk: Desk; actions: Actions | null; doing: Doing; canOpen: boolean }) {
  const [cover, setCover] = useState(false);
  const at = ORDER.indexOf(desk.rank.rank);
  const fired = desk.rank.status === "FIRED";
  const now = desk.constants.ranks[at]!;
  // (1.7) The term: 30 days, renewed by a vote. Hidden if this copy of the program has no term.
  const auto = useAsync(() => getChain().getAuto(), `auto-vote-${desk.round.id}-${desk.feed[desk.feed.length - 1]?.seq ?? 0}`).data;
  const openKinds = new Set(desk.votes.filter((v) => v.state === "OPEN").map((v) => v.kind));
  const start = (kind: VoteKind) => actions && doing.run(`open-${kind}`, () => actions.openVote(kind), `A vote to ${KIND_WORD[kind].toLowerCase()} is open.`);
  const btn = (kind: VoteKind, cls: string, off: boolean) => (
    <button className={`btn ${cls}`} disabled={!actions || !canOpen || !!doing.busy || off || openKinds.has(kind)} onClick={() => start(kind)}>
      {doing.busy === `open-${kind}` ? "Opening…" : openKinds.has(kind) ? "Already open" : `Open a vote to ${KIND_WORD[kind].toLowerCase()}`}
    </button>
  );

  if (fired) {
    return (
      <div className="start-cols">
        <div className="start-col start-promote">
          <h3>Rehire</h3>
          <p>The Intern comes back at the bottom rank. It needs more than half of the votes and 20% turnout, and takes one full shift to kick in.</p>
          <p className="mono">Intern: {limitsLine(desk.constants.ranks[0]!)}</p>
          {btn("REHIRE", "vote-yes-btn", false)}
        </div>
      </div>
    );
  }
  return (
    <div className="start-cols">
      <div className="start-col start-promote">
        <h3>Promote</h3>
        <p>Slow on purpose: more than half of the votes, 20% turnout, and one full shift before it counts.</p>
        {at < 2 ? (
          <p className="mono">
            now: {limitsLine(now)}
            <br />
            after: {limitsLine(desk.constants.ranks[at + 1]!)}
          </p>
        ) : (
          <p className="mono">Trader is the top rank.</p>
        )}
        {btn("PROMOTE", "vote-yes-btn", at === 2)}
      </div>
      <div className="start-col start-demote">
        <h3>Demote</h3>
        <p>Fast: passes as soon as yes reaches 34% of all locked coins. The smaller limits apply at once.</p>
        {at > 0 ? (
          <p className="mono">
            now: {limitsLine(now)}
            <br />
            after: {limitsLine(desk.constants.ranks[at - 1]!)}
          </p>
        ) : (
          <p className="mono">Intern is the bottom rank.</p>
        )}
        {btn("DEMOTE", "btn-quiet", at === 0)}
      </div>
      <div className="start-col start-fire">
        <h3>Fire</h3>
        <p>Fast: passes as soon as yes reaches 34% of all locked coins. No new bets from that minute. Open bets get closed. Everyone can still cash out.</p>
        {/* A real second step, shown physically: lift the cover, then press */}
        <label className={`cover${cover ? " is-up" : ""}`}>
          <input type="checkbox" checked={cover} onChange={(e) => setCover(e.target.checked)} />
          <span>{cover ? "Cover lifted" : "Lift the cover"}</span>
        </label>
        {btn("FIRE", "fire-btn", !cover)}
      </div>
      <div className="start-col start-longshot">
        <h3>Long shot</h3>
        <p>
          Allow the Intern <strong>one</strong> extra bet, two shifts after the vote passes: exactly 0.5% of the BRAVE pool, at up to 10x. It is the only thing that
          lets a bet go past the rank's leverage, and only for that one ticket. It usually loses. At most once every seven shifts.
        </p>
        <p className="mono">Passes like a promotion: more than half of the votes, 20% turnout.</p>
        {btn("LONG_SHOT", "btn-quiet", false)}
      </div>
      {auto && (
        <div className="start-col start-longshot start-renew">
          <h3>Renew the term</h3>
          <p>
            The Intern is hired for 30 days at a time. Its term ends on <strong>{day(auto.term_ends_at)}</strong>. If nobody renews it, the first shift after that fires
            it by itself. A vote to renew adds 30 days, at once when it passes.
          </p>
          <p className="mono">Passes like a promotion: more than half of the votes, 20% turnout.</p>
          {btn("RENEW", "btn-quiet", false)}
        </div>
      )}
    </div>
  );
}

function LockForm({ actions, doing, coin, locked, weight }: { actions: Actions; doing: Doing; coin: bigint; locked: bigint; weight: bigint }) {
  const [text, setText] = useState("");
  const v = toE6(text);
  return (
    <div className="lock-form">
      <label htmlFor="lock-amt">Coins</label>
      <input id="lock-amt" inputMode="decimal" placeholder="0.00" value={text} onChange={(e) => setText(e.target.value)} />
      <button className="btn" disabled={!v || !!doing.busy} onClick={() => v && doing.run("lock", () => actions.lock(v), `Locked ${text} INTERN.`)}>
        {doing.busy === "lock" ? "Locking…" : "Lock"}
      </button>
      <button className="btn btn-quiet" disabled={!v || !!doing.busy} onClick={() => v && doing.run("unlock", () => actions.unlock(v), `Unlocked ${text} INTERN.`)}>
        {doing.busy === "unlock" ? "Unlocking…" : "Unlock"}
      </button>
      <p className="fine">
        {amount((coin - locked).toString())} free, {amount(locked.toString())} locked, counting as {amount(weight.toString())} votes. Locked coins can't be moved or
        cashed out. Their weight grows over seven shifts, so nobody can buy a vote for a day.
      </p>
    </div>
  );
}

export function VotePage() {
  const snap = useDesk();
  const now = useNow();
  const session = useSession();
  const { desk } = snap;
  const { me, reload } = useMe(session.accountId, session.actions, desk?.feed[desk.feed.length - 1]?.seq ?? 0);
  const doing = useDoing(reload);

  if (!desk) {
    return (
      <div className="home">
        <TopBar source={snap.source} scene={snap.scene} />
        <Waiting error={snap.error} line="Counting the mugs…" />
      </div>
    );
  }
  const fired = desk.rank.status === "FIRED";
  const open = desk.votes.filter((v) => v.state === "OPEN");
  const past = desk.votes.filter((v) => v.state !== "OPEN");
  const weight = me ? BigInt(me.account.vote_weight) : 0n;
  const voters = [...new Set(desk.feed.filter((f) => f.event === "vote_cast").map((f) => (f.event === "vote_cast" ? f.data.account_id : "")))];

  return (
    <div className="home">
      <TopBar source={snap.source} scene={snap.scene} />
      <main id="main" className="people-page">
        <header className="people-head">
          <Intern mood={fired ? "fired" : open.length ? "waiting" : "idle"} rank={desk.rank.rank} size={200} />
          <div>
            <h1>{fired ? "The Intern is fired." : `The Intern is ${/^[AEIOU]/.test(desk.rank.rank) ? "an" : "a"} ${titleCase(desk.rank.rank)}.`}</h1>
            <p>
              {fired ? "No new bets until the bosses vote to rehire, or a rescue fund fills." : `That means ${limitsLine(desk.constants.ranks[ORDER.indexOf(desk.rank.rank)]!)}.`} Bosses can move it
              up or down one rank, or fire it. They can't change the numbers.
            </p>
            {desk.rank.pending && (
              <p className="pending">
                Voted in: {titleCase(desk.rank.pending.rank)} from shift {desk.rank.pending.effective_round}.
              </p>
            )}
            {voters.length > 0 && (
              <p className="voters">
                {voters.slice(0, 8).map((a) => (
                  <BossMug key={a} accountId={a} size={36} />
                ))}
                <span>
                  {voters.length} {voters.length === 1 ? "boss has" : "bosses have"} voted lately
                </span>
              </p>
            )}
          </div>
        </header>

        {(doing.error || doing.done) && (
          <Notice error={doing.error} done={doing.done} onClose={doing.clear} />
        )}

        {fired && <RescuePanel desk={desk} />}

        <section aria-labelledby="open-h">
          <h2 id="open-h">Open votes</h2>
          {open.length === 0 ? (
            <p className="people-empty">No vote is open. The Intern keeps its rank until a boss opens one.</p>
          ) : (
            <div className="vote-list">
              {open.map((v) => (
                <VoteCard key={v.id} v={v} desk={desk} now={now} actions={session.actions} doing={doing} weight={weight} />
              ))}
            </div>
          )}
        </section>

        <section aria-labelledby="say-h">
          <h2 id="say-h">Your say</h2>
          {!session.accountId || !session.actions ? (
            <div className="card say-card">
              <p>Only BRAVE holders vote, with coins they have locked. Clock in to see your votes.</p>
              {session.canSignIn ? (
                <button className="btn" onClick={signIn}>
                  {session.pretend ? "Clock in with a pretend account" : "Clock in with a NEAR wallet"}
                </button>
              ) : (
                <p className="fine">Signing in isn't available here.</p>
              )}
            </div>
          ) : !me ? (
            <p className="pencil">Looking you up…</p>
          ) : (
            <div className="card say-card">
              <dl className="say-nums">
                <div>
                  <dt>Your coins</dt>
                  <dd>{amount(me.account.coin)}</dd>
                </div>
                <div>
                  <dt>Locked</dt>
                  <dd>{amount(me.account.locked)}</dd>
                </div>
                <div>
                  <dt>Your votes</dt>
                  <dd>{amount(me.account.vote_weight)}</dd>
                </div>
              </dl>
              <LockForm actions={session.actions} doing={doing} coin={BigInt(me.account.coin)} locked={BigInt(me.account.locked)} weight={weight} />
            </div>
          )}
        </section>

        <section aria-labelledby="start-h">
          <h2 id="start-h">Start a vote</h2>
          {!session.actions && <p className="fine">Clock in and lock some coins to open a vote.</p>}
          {session.actions && weight === 0n && (
            <p className="warn">
              {me && BigInt(me.account.locked) > 0n
                ? "Your locked coins don't count yet. They start counting after one full shift locked, so you can open a vote or cast one from the shift after next."
                : "Lock some coins first. They start counting after one full shift locked; only then can you open a vote."}
            </p>
          )}
          <StartVote desk={desk} actions={session.actions} doing={doing} canOpen={weight > 0n} />
        </section>

        {past.length > 0 && (
          <section aria-labelledby="past-h">
            <h2 id="past-h">Earlier votes</h2>
            <div className="vote-list">
              {past.map((v) => (
                <VoteCard key={v.id} v={v} desk={desk} now={now} actions={null} doing={doing} weight={0n} />
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
