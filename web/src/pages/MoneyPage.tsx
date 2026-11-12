import { useState } from "react";
import "./pages.css";
import "./people.css";
import { signIn, toE6, useDoing, useMe, useSession, type Doing, type Me } from "../chain/session";
import { useDesk, type Desk } from "../chain/store";
import type { Actions, Pool } from "../chain/types";
import { Intern } from "../cast/Intern";
import { Tin } from "../cast/Tin";
import { limitsOf } from "../home/Home";
import { amount, clock, pct, titleCase, usd } from "../lib/format";
import { nextMoment } from "../lib/round";
import { useNow } from "../lib/useNow";
import { TopBar } from "../ui/TopBar";
import { Usd } from "../ui/Usd";
import { Waiting } from "../ui/Waiting";

const plain = (e6: bigint) => (Number(e6) / 1e6).toFixed(2);

function PoolPick({ value, onPick, label }: { value: Pool; onPick: (p: Pool) => void; label: string }) {
  return (
    <div className="pool-pick" role="group" aria-label={label}>
      {(["SAFE", "BRAVE"] as const).map((p) => (
        <button key={p} className={`pick pick-${p.toLowerCase()}`} aria-pressed={value === p} onClick={() => onPick(p)}>
          {p}
        </button>
      ))}
    </div>
  );
}

function PayIn({ me, actions, doing }: { me: NonNullable<Me>; actions: Actions; doing: Doing }) {
  const [pool, setPool] = useState<Pool>("BRAVE");
  const [text, setText] = useState("50");
  const have = BigInt(me.dollars);
  const v = toE6(text);
  const tooMuch = v !== null && BigInt(v) > have;
  return (
    <section className="card money-form" aria-labelledby="in-h">
      <h2 id="in-h">Pay in</h2>
      <PoolPick value={pool} onPick={setPool} label="Pay into" />
      <label htmlFor="in-amt">Test dollars</label>
      <input id="in-amt" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} aria-describedby="in-note" />
      <div className="chips">
        {["10", "50", "100"].map((c) => (
          <button key={c} className="chip-btn" onClick={() => setText(c)}>
            ${c}
          </button>
        ))}
        <button className="chip-btn" onClick={() => setText(plain(have))}>
          All of it
        </button>
      </div>
      <p id="in-note" className="fine">
        {tooMuch
          ? `You have ${usd(me.dollars)} in your wallet.`
          : pool === "BRAVE"
            ? "BRAVE money waits until the next shift opens, then becomes INTERN coins. You can take it back while it waits."
            : "SAFE money is credited at once. The Intern can never touch it, and it carries no vote."}
      </p>
      <button className="btn btn-wide" disabled={!v || tooMuch || !!doing.busy} onClick={() => v && doing.run("payin", () => actions.payIn(pool, v), `Paid ${usd(v)} into ${pool}.`)}>
        {doing.busy === "payin" ? "Paying in…" : v ? `Pay ${usd(v)} into ${pool}` : "Enter an amount"}
      </button>
    </section>
  );
}

function CashOut({ me, desk, actions, doing }: { me: NonNullable<Me>; desk: Desk; actions: Actions; doing: Doing }) {
  const [pool, setPool] = useState<Pool>("BRAVE");
  const [text, setText] = useState("");
  const free = BigInt(me.account.coin) - BigInt(me.account.locked);
  const safe = BigInt(me.account.safe);
  const pending = BigInt(me.account.pending_brave);
  const max = pool === "BRAVE" ? free : safe;
  const v = toE6(text);
  const tooMuch = v !== null && BigInt(v) > max;
  const betOpen = BigInt(desk.pot.brave.in_play) > 0n;
  const worth = v && pool === "BRAVE" ? ((BigInt(v) * BigInt(desk.pot.coin_price_e6)) / 1_000_000n).toString() : v;
  return (
    <section className="card money-form" aria-labelledby="out-h">
      <h2 id="out-h">Cash out</h2>
      <PoolPick value={pool} onPick={setPool} label="Cash out of" />
      <label htmlFor="out-amt">{pool === "BRAVE" ? "INTERN coins" : "Dollars"}</label>
      <input id="out-amt" inputMode="decimal" placeholder="0.00" value={text} onChange={(e) => setText(e.target.value)} aria-describedby="out-note" />
      <div className="chips">
        <button className="chip-btn" onClick={() => setText(plain(max / 2n))}>
          Half
        </button>
        <button className="chip-btn" onClick={() => setText(plain(max))}>
          All of it
        </button>
      </div>
      <p id="out-note" className="fine">
        {tooMuch
          ? pool === "BRAVE"
            ? `You have ${amount(free.toString())} free coins. Locked coins can't be cashed out.`
            : `You have ${usd(me.account.safe)} in SAFE.`
          : "Cash-out is never blocked. You get your share of what the pool holds."}
      </p>
      {pool === "BRAVE" && betOpen && (
        <p className="warn">
          A bet is open right now. If you leave during it, you give up your share of that bet, win or lose: the {usd(desk.pot.brave.in_play)} on it is not paid out.
        </p>
      )}
      <button
        className="btn btn-wide btn-quiet"
        disabled={!v || tooMuch || !!doing.busy}
        onClick={() => v && doing.run("cashout", () => actions.cashOut(pool, v), `Cashed out. About ${usd(worth ?? "0")} is back in your wallet.`)}
      >
        {doing.busy === "cashout" ? "Cashing out…" : v ? `Cash out ${pool === "BRAVE" ? `${text} INTERN, about ${usd(worth ?? "0")}` : usd(v)}` : "Enter an amount"}
      </button>
      {pending > 0n && (
        <button
          className="btn btn-wide btn-quiet"
          disabled={!!doing.busy}
          onClick={() => doing.run("takeback", () => actions.cashOut("BRAVE", pending.toString(), true), `Took back ${usd(pending.toString())}.`)}
        >
          {doing.busy === "takeback" ? "Taking it back…" : `Take back the ${usd(pending.toString())} still waiting`}
        </button>
      )}
    </section>
  );
}

function Dial({ me, desk, actions, doing }: { me: NonNullable<Me>; desk: Desk; actions: Actions; doing: Doing }) {
  const brave = BigInt(me.account.brave_value);
  const safe = BigInt(me.account.safe);
  const total = brave + safe;
  const nowPct = total === 0n ? 0 : Number((brave * 100n) / total);
  const [want, setWant] = useState<number | null>(null);
  const target = want ?? nowPct;
  const wantBrave = (total * BigInt(target)) / 100n;
  const delta = wantBrave - brave;
  const price = BigInt(desk.pot.coin_price_e6);
  const coins = price === 0n ? 0n : (-delta * 1_000_000n) / price;
  const lockedValue = (BigInt(me.account.locked) * price) / 1_000_000n;
  const blocked = delta < 0n && brave + delta < lockedValue;

  return (
    <section className="card money-form dial-form" aria-labelledby="dial-h">
      <h2 id="dial-h">Your dial</h2>
      {total === 0n ? (
        <p className="pencil">Pay something in first. Then the dial splits it between SAFE and BRAVE.</p>
      ) : (
        <>
          <div className="dial my-dial" style={{ "--brave": target } as React.CSSProperties}>
            <div className="dial-track" aria-hidden="true">
              <span className="dial-fill-safe">SAFE {100 - target}%</span>
              <span className="dial-fill-brave">BRAVE {target}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={target}
              onChange={(e) => setWant(Number(e.target.value))}
              aria-label="Share of your money in BRAVE"
              aria-valuetext={`${target}% BRAVE, ${100 - target}% SAFE`}
            />
          </div>
          <p className="fine">
            {delta === 0n
              ? "Drag to change your split. Nothing moves until you press the button."
              : delta > 0n
                ? `That moves ${usd(delta.toString())} from SAFE to BRAVE. It counts from the next shift.`
                : blocked
                  ? "Some of your BRAVE coins are locked for voting. Unlock them before moving that much."
                  : `That moves about ${usd((-delta).toString())} from BRAVE to SAFE, at once.`}
          </p>
          <button
            className="btn btn-wide"
            disabled={delta === 0n || blocked || !!doing.busy}
            onClick={() =>
              doing.run("dial", () => (delta > 0n ? actions.turnDial("BRAVE", delta.toString()) : actions.turnDial("SAFE", coins.toString())), "Dial turned.").then(() => setWant(null))
            }
          >
            {doing.busy === "dial" ? "Turning…" : delta === 0n ? "Dial is where you left it" : `Turn the dial to ${target}% BRAVE`}
          </button>
        </>
      )}
    </section>
  );
}

export function MoneyPage() {
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
        <Waiting error={snap.error} line="Opening the tin…" />
      </div>
    );
  }
  const l = limitsOf(desk);
  const next = nextMoment(desk.round, now, desk.rank.status);
  const actions = session.actions;
  const myRisk = me ? ((BigInt(me.account.brave_value) * BigInt(l.per_round_bps)) / 10_000n).toString() : "0";

  return (
    <div className="home">
      <TopBar source={snap.source} scene={snap.scene} />
      <main id="main" className="people-page">
        <header className="people-head">
          <Tin pose={me && BigInt(me.account.pending_brave) > 0n ? "coin" : "resting"} size={170} />
          <div>
            <h1>Your money</h1>
            <p>
              Put dollars in SAFE, where the Intern can never touch them, or in BRAVE, where it may bet a small slice and you get a vote. Take them out whenever you
              like.
            </p>
            <p className="warn">Test network. Test dollars. Nothing here is real money. You can lose what you put in BRAVE, and no profit is promised.</p>
          </div>
        </header>

        {(doing.error || doing.done) && (
          <p className={`notice ${doing.error ? "notice-bad" : "notice-ok"}`} role={doing.error ? "alert" : "status"}>
            {doing.error ?? doing.done}
          </p>
        )}

        {!session.accountId || !actions ? (
          <div className="card say-card">
            <p>Clock in to pay in, cash out or turn your dial.</p>
            {snap.source === "stub" && <p className="fine">This is the stub contract: it answers questions with canned data and holds no money, so actions sent to it only leave a note in its feed.</p>}
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
          <>
            <dl className="balances">
              <div className="bal-wallet">
                <dt>In your wallet</dt>
                <dd>
                  <Usd e6={me.dollars} />
                </dd>
                <p>Test dollars, not paid in yet.</p>
                <button className="chip-btn" disabled={!!doing.busy} onClick={() => doing.run("tap", () => actions.getTestDollars("100000000"), "100 test dollars added to your wallet.")}>
                  {doing.busy === "tap" ? "Pouring…" : "Get 100 test dollars"}
                </button>
              </div>
              <div className="bal-safe">
                <dt>SAFE</dt>
                <dd>
                  <Usd e6={me.account.safe} />
                </dd>
                <p>The Intern can never touch it.</p>
              </div>
              <div className="bal-brave">
                <dt>BRAVE</dt>
                <dd>
                  <Usd e6={me.account.brave_value} />
                </dd>
                <p>
                  {amount(me.account.coin)} INTERN{BigInt(me.account.locked) > 0n ? `, ${amount(me.account.locked)} locked for voting` : ""}.
                </p>
              </div>
              <div className="bal-wait">
                <dt>Waiting for the next shift</dt>
                <dd>
                  <Usd e6={me.account.pending_brave} />
                </dd>
                <p>{next.at ? `Next shift in ${clock(next.at - now)}.` : "Becomes coins when the next shift opens."}</p>
              </div>
            </dl>

            {!me.account.registered ? (
              <section className="card money-form">
                <h2>One step first</h2>
                <p>Register once so the program can keep a balance for you. It costs a tiny amount of test NEAR for storage.</p>
                <button className="btn" disabled={!!doing.busy} onClick={() => doing.run("register", () => actions.register(), "Registered.")}>
                  {doing.busy === "register" ? "Registering…" : "Register"}
                </button>
              </section>
            ) : (
              <div className="money-grid">
                <PayIn me={me} actions={actions} doing={doing} />
                <CashOut me={me} desk={desk} actions={actions} doing={doing} />
                <Dial me={me} desk={desk} actions={actions} doing={doing} />
                <aside className="screen panel-dark rule-now" aria-labelledby="rule-h">
                  <h2 id="rule-h">The rule in force</h2>
                  <div className="rule-intern">
                    <Intern mood={desk.rank.status === "FIRED" ? "fired" : "idle"} rank={desk.rank.rank} size={130} />
                    <p>
                      The Intern is {desk.rank.status === "FIRED" ? "fired" : `${/^[AEIOU]/.test(desk.rank.rank) ? "an" : "a"} ${titleCase(desk.rank.rank)}`}.
                    </p>
                  </div>
                  <dl className="stat-rows">
                    <div>
                      <dt>Most of BRAVE it can risk in a shift</dt>
                      <dd>{desk.rank.status === "FIRED" ? "0%" : pct(l.per_round_bps)}</dd>
                    </div>
                    <div>
                      <dt>Most of yours, at today's prices</dt>
                      <dd>{desk.rank.status === "FIRED" ? "$0.00" : usd(myRisk)}</dd>
                    </div>
                    <div>
                      <dt>On the Intern's bet right now</dt>
                      <dd>{usd(desk.pot.brave.in_play)}</dd>
                    </div>
                  </dl>
                  <p className="fine">That limit is fixed in the program. A vote can move the Intern between ranks; it can't change a rank's numbers.</p>
                </aside>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
