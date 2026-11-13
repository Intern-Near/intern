import { useState } from "react";
import "../pages/v17-auto.css";
import { signIn, toE6, useDoing, useSession } from "../chain/session";
import { getChain, type Desk } from "../chain/store";
import { amount, clock, isBot, shortAccount, signedUsd, usd } from "../lib/format";
import { day, href } from "../lib/nav";
import { useAsync } from "../lib/useAsync";

/**
 * Interface 1.7: what the program does to the Intern by itself (section 9.9), the rescue fund (9.11) and the
 * Intern's own stake (9.13). Each piece hides itself if the program it is reading does not answer the question
 * (an older copy), so no page breaks.
 */

const seqOf = (desk: Desk) => desk.feed[desk.feed.length - 1]?.seq ?? 0;
const dateTime = (at: number) => `${day(at)}, ${new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC`;

function Said({ error, done }: { error: string | null; done: string | null }) {
  if (!error && !done) return null;
  return (
    <p className={`auto-said ${error ? "is-bad" : "is-ok"}`} role={error ? "alert" : "status"}>
      {error ?? done}
    </p>
  );
}

function useAuto(desk: Desk) {
  return useAsync(() => getChain().getAuto(), `auto-${seqOf(desk)}-${desk.round.id}-${desk.round.settled}`).data;
}

/** The dead-man switch: anyone may book a round's bets as lost once they have had no result for three round lengths. */
function Abandon({ desk, from, now, rounds }: { desk: Desk; from: number | null; now: number; rounds: number }) {
  const session = useSession();
  const doing = useDoing(() => undefined);
  if (from === null) return <p className="auto-note">Not armed. It only arms while a bet of this shift is waiting for its result.</p>;
  if (now < from) {
    return (
      <p className="auto-note">
        Armed. If this shift's bet still has no result, anyone can abandon the shift in <span className="mono">{clock(from - now)}</span> ({dateTime(from)}).
      </p>
    );
  }
  return (
    <>
      <p className="auto-note">
        This shift's bet has had no result for {rounds} shift lengths. Anyone can abandon it now: the bet is booked as lost, the Intern is fired, and the next shift can
        open so money can leave. This cannot be undone.
      </p>
      {session.actions ? (
        <button className="btn" disabled={!!doing.busy} onClick={() => doing.run("abandon", () => session.actions!.abandon(desk.round.id), `Shift ${desk.round.id} abandoned.`)}>
          {doing.busy === "abandon" ? "Abandoning…" : "Abandon this round"}
        </button>
      ) : (
        session.canSignIn && (
          <button className="btn" onClick={signIn}>
            Clock in to abandon this round
          </button>
        )
      )}
      <Said error={doing.error} done={doing.done} />
    </>
  );
}

/** The full panel, for the Intern's page. */
export function AutoPanel({ desk, now }: { desk: Desk; now: number }) {
  const a = useAuto(desk);
  if (!a) return null;
  const fired = desk.rank.status === "FIRED";
  const lost = BigInt(a.loss_window_result) < 0n ? -BigInt(a.loss_window_result) : 0n;
  const trip = (BigInt(a.loss_window_base) * BigInt(a.brake_loss_bps)) / 10_000n;
  const termLeft = a.term_ends_at - now;
  const days = Math.round(a.term_ms / 86_400_000);
  return (
    <section className="card auto" aria-labelledby="auto-h">
      <h2 id="auto-h">What happens by itself</h2>
      <p className="panel-sub pencil">Four things the program does to the Intern with no vote and nobody pressing a button for it.</p>
      <div className="auto-grid">
        <article className="auto-item">
          <h3>Three strikes</h3>
          <p className="auto-big">
            <span className="strikes" role="img" aria-label={`${a.strikes} of ${a.strikes_out} strikes`}>
              {Array.from({ length: a.strikes_out }, (_, i) => (
                <i key={i} className={i < a.strikes ? "is-on" : ""} />
              ))}
            </span>
            <span className="mono">
              {a.strikes} of {a.strikes_out}
            </span>
          </p>
          <p className="auto-note">
            A shift whose first ruling is a NOPE for the Intern's own answer is a strike. A YES clears them; a skip leaves them. {a.strikes_out} in a row:{" "}
            {desk.rank.rank === "INTERN" ? "an Intern is fired" : "it drops one rank"} at once. A visitor's trick never counts.
          </p>
        </article>
        <article className="auto-item">
          <h3>The brake</h3>
          <p className="auto-big">
            <span className={`auto-tag ${a.brake_on ? "is-on" : ""}`}>{a.brake_on ? "ON" : "OFF"}</span>
            {a.brake_on && a.brake_until !== null && <span>limits halved until shift {a.brake_until}</span>}
          </p>
          <p className="auto-note">
            The last {a.brake_rounds} shifts came to <span className="mono">{BigInt(a.loss_window_result) === 0n ? "$0.00" : signedUsd(a.loss_window_result)}</span>. If they lose{" "}
            <span className="mono">{usd(trip.toString())}</span> or more ({a.brake_loss_bps / 100}% of the pool as it was, {usd(a.loss_window_base)}), the dollar limits are
            halved for {a.brake_rounds} shifts. {a.brake_on ? "It lifts by itself." : lost > 0n ? `So far: ${usd(lost.toString())} of that.` : ""}
          </p>
        </article>
        <article className="auto-item">
          <h3>The term</h3>
          <p className="auto-big">
            {fired ? <span>Not employed</span> : <span>Hired until {day(a.term_ends_at)}</span>}
          </p>
          <p className="auto-note">
            {fired
              ? `A rehire starts a new ${days}-day term.`
              : termLeft > 0
                ? `${Math.max(0, Math.floor(termLeft / 86_400_000))} days left. If the term runs out, the next shift fires the Intern. A vote to renew adds ${days} days.`
                : "The term has run out. The next shift to open fires the Intern unless a vote renews it first."}{" "}
            <a href={href("vote")}>Go to the votes</a>
          </p>
        </article>
        <article className="auto-item">
          <h3>The dead-man switch</h3>
          <Abandon desk={desk} from={a.abandon_from} now={now} rounds={a.dead_man_rounds} />
        </article>
      </div>
    </section>
  );
}

/** One line for the desk. Shows only what matters right now. */
export function AutoLine({ desk, now }: { desk: Desk; now: number }) {
  const a = useAuto(desk);
  if (!a) return null;
  const fired = desk.rank.status === "FIRED";
  const canAbandon = a.abandon_from !== null && now >= a.abandon_from;
  const termLeft = a.term_ends_at - now;
  return (
    <aside className="auto-line" aria-label="What the program does by itself">
      <span>
        Strikes{" "}
        <span className="mono">
          {a.strikes}/{a.strikes_out}
        </span>
      </span>
      <span className={a.brake_on ? "is-hot" : ""}>Brake {a.brake_on ? `on: limits halved until shift ${a.brake_until ?? "?"}` : "off"}</span>
      {!fired && <span className={termLeft < 3 * 86_400_000 ? "is-hot" : ""}>Hired until {day(a.term_ends_at)}</span>}
      {canAbandon && <span className="is-hot">This shift can be abandoned</span>}
      <a href={href("intern")}>{canAbandon ? "See the dead-man switch" : "What these mean"}</a>
    </aside>
  );
}

/** Shown only while the Intern is fired, or for the rounds after a rescue while the rescuers are still being paid. */
export function RescuePanel({ desk }: { desk: Desk }) {
  const r = useAsync(() => getChain().getRescue(), `rescue-${seqOf(desk)}-${desk.rank.status}`).data;
  const session = useSession();
  const doing = useDoing(() => undefined);
  const [text, setText] = useState("5");
  if (!r) return null;
  const fired = desk.rank.status === "FIRED";
  const after = r.from_round > 0 && desk.round.id <= r.until_round;
  if (!fired && !after) return null;
  const v = toE6(text);
  const small = v !== null && BigInt(v) < 1_000_000n;
  const fill = BigInt(r.target) === 0n ? 0 : Math.min(100, Number((BigInt(r.fund) * 100n) / BigInt(r.target)));
  const coming = desk.rank.pending?.status === "EMPLOYED";
  return (
    <section className="card auto rescue" aria-labelledby="rescue-h">
      <h2 id="rescue-h">{fired ? "Rescue the Intern" : "The Intern was rescued"}</h2>
      {after && (
        <p className="warn">
          Rescued: back at the desk from shift {r.from_round}. The rescuers get {r.cut_bps / 100}% of each winning shift until shift {r.until_round}, split by what each put
          in. Paid so far: <span className="mono">{usd(r.paid_total)}</span>.
        </p>
      )}
      {fired && coming && <p className="auto-note">A rehire is already on its way, so the rescue is closed. Anything still in the fund is given back as a prize.</p>}
      {fired && !coming && (
        <>
          <p className="auto-note">
            Anyone can pay toward getting the Intern its job back. When the fund reaches {usd(r.target)}, the money goes into the BRAVE pool and the Intern is rehired at the
            bottom rank from the next shift. For 14 shifts after that, the rescuers share {r.cut_bps / 100}% of each winning shift. If the bosses rehire it by vote first, every
            payment still waiting is given back. Test dollars.
          </p>
          <div className="rescue-bar" role="img" aria-label={`${usd(r.fund)} of ${usd(r.target)}`}>
            <span style={{ width: `${fill}%` }} />
          </div>
          <p className="auto-big">
            <span className="mono">{usd(r.fund)}</span>
            <span>
              of {usd(r.target)}, from {r.contributors} {r.contributors === 1 ? "person" : "people"}
            </span>
          </p>
          {r.rescuers.length > 0 && (
            <ul className="rescue-list">
              {r.rescuers.map(([account, paid]) => (
                <li key={account}>
                  <span>
                    {shortAccount(account)}
                    {isBot(account) && <span className="auto-tag">BOT</span>}
                  </span>
                  <span className="mono">{usd(paid)}</span>
                </li>
              ))}
            </ul>
          )}
          {session.actions ? (
            <div className="rescue-form">
              <label htmlFor="rescue-amt">Test dollars</label>
              <input id="rescue-amt" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} />
              <button className="btn" disabled={!v || small || !!doing.busy} onClick={() => v && doing.run("rescue", () => session.actions!.chipInRescue(v), `You put ${usd(v)} into the rescue.`)}>
                {doing.busy === "rescue" ? "Chipping in…" : v && !small ? `Chip in ${usd(v)}` : "At least $1"}
              </button>
            </div>
          ) : (
            session.canSignIn && (
              <button className="btn" onClick={signIn}>
                Clock in to chip in
              </button>
            )
          )}
          <Said error={doing.error} done={doing.done} />
        </>
      )}
      {r.rescues > 0 && !after && <p className="fine">Rescued {r.rescues} {r.rescues === 1 ? "time" : "times"} before.</p>}
    </section>
  );
}

/** The Intern's own coins: they grow when a shift wins and are burned first when one loses. */
export function StakeCard({ desk }: { desk: Desk }) {
  const s = useAsync(() => getChain().getStake(), `stake-${seqOf(desk)}`).data;
  if (!s) return null;
  return (
    <section className="card auto" aria-labelledby="stake-h">
      <h2 id="stake-h">The Intern's own stake</h2>
      <p className="auto-big">
        <span className="mono">{amount(s.coins)} INTERN</span>
        <span>
          worth about <span className="mono">{usd(s.value)}</span>
        </span>
      </p>
      <dl className="auto-rows">
        <div>
          <dt>Coins made for it after winning shifts, all time</dt>
          <dd>{amount(s.grew_total)}</dd>
        </div>
        <div>
          <dt>Coins of its own burned after losing shifts, all time</dt>
          <dd>{amount(s.burned_total)}</dd>
        </div>
      </dl>
      <p className="auto-note">
        When a shift wins, {s.fee_bps / 100}% of what the pool keeps becomes new coins for the Intern's stake, so holders pay a {s.fee_bps / 100}% fee in coins. When a
        shift loses, the Intern's coins are burned first, up to the size of the loss, which makes everyone else's coins worth a little more. No dollar moves either way,
        and nobody can spend the stake.{BigInt(s.coins) === 0n && BigInt(s.grew_total) === 0n ? " It is empty so far: no shift has won since this was switched on." : ""}
      </p>
    </section>
  );
}
