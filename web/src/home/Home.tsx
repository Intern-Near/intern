import { useEffect } from "react";
import "./home.css";
import { useDesk, type Desk } from "../chain/store";
import type { Decision, FeedItem, Limits, Position, RankName } from "../chain/types";
import { REFUSAL_CODES } from "../chain/types";
import { Intern, type InternMood } from "../cast/Intern";
import { Stamp, type StampPose } from "../cast/Stamp";
import { Tin } from "../cast/Tin";
import { amount, clock, pct, share, signedUsd, titleCase, usd, when } from "../lib/format";
import { LIGHTS, refusalParts } from "../lib/refusals";
import { nextMoment, phaseAt, shiftStep } from "../lib/round";
import { useNow } from "../lib/useNow";
import { feedRow } from "./feedText";
import { useMoment, type Moment } from "./moment";
import { TopBar } from "../ui/TopBar";
import { Usd } from "../ui/Usd";
import { Waiting } from "../ui/Waiting";
import { href } from "../lib/nav";
import { useRewards } from "../lib/useRewards";

const RANK_ORDER: RankName[] = ["INTERN", "ANALYST", "TRADER"];
const FRESH_MS = 9_000;

export function limitsOf(desk: Desk): Limits {
  return desk.constants.ranks.find((l) => l.rank === desk.rank.rank)!;
}

/** The smaller of the pool at open and the pool now (interface 1.1), times the rank's share. */
export function dollarLimit(desk: Desk, bps: number): string {
  const open = BigInt(desk.round.brave_at_open);
  const nowPool = BigInt(desk.pot.brave.total);
  const base = open < nowPool ? open : nowPool;
  return ((base * BigInt(bps)) / 10_000n).toString();
}

export function rankLine(l: Limits): string {
  const sides = l.sides.includes("SHORT") ? "a coin going up or down" : "a coin going up";
  const bets = l.max_bets === 1 ? "once a shift" : `${l.max_bets} times a shift`;
  const lev = l.max_leverage > 1 ? `, with up to ${l.max_leverage}x` : "";
  return `It may bet up to ${pct(l.per_bet_bps)} of the BRAVE pool, ${bets}, on ${sides}${lev}.`;
}

function mood(desk: Desk, fresh: FeedItem | null, now: number, moment: Moment | null): { intern: InternMood; stamp: StampPose } {
  if (moment) {
    if (moment.stage === "slip") return { intern: "proposing", stamp: "watching" };
    if (moment.stage === "lights") return { intern: "waiting", stamp: "watching" };
    if (moment.stage === "leap") return { intern: "waiting", stamp: "slamming" };
    return moment.kind === "nope" ? { intern: "refused", stamp: "landed" } : { intern: "happy", stamp: "watching" };
  }
  if (desk.rank.status === "FIRED") return { intern: "fired", stamp: "watching" };
  if (fresh && now - fresh.at < FRESH_MS && fresh.event === "rank_changed") return { intern: "promoted", stamp: "watching" };
  const r = desk.round;
  if (r.settled && r.result !== null) return { intern: BigInt(r.result) >= 0n ? "happy" : "refused", stamp: "watching" };
  if (desk.positions.length) return { intern: "proposing", stamp: "watching" };
  const phase = phaseAt(r, now);
  if (phase === "PROPOSE") return { intern: "thinking", stamp: "watching" };
  if (!r.settled && now > r.ends_at) return { intern: "waiting", stamp: "watching" };
  return { intern: "idle", stamp: "watching" };
}

export function RankLadder({ current, pending }: { current: RankName; pending: RankName | null }) {
  const at = RANK_ORDER.indexOf(current);
  const faces = ["intern-idle", "intern-analyst", "intern-trader"];
  return (
    <ol className="ladder" aria-label="Rank ladder">
      {RANK_ORDER.map((r, i) => (
        <li key={r} className={i === at ? "is-current" : i < at ? "is-past" : "is-ahead"} aria-current={i === at ? "step" : undefined}>
          <span className="medal">
            <img src={`/cast/${faces[i]}.webp`} alt="" width={84} height={84} />
          </span>
          <span className="medal-name">
            {titleCase(r)}
            {pending === r && <span className="sr-only"> (voted in, not in force yet)</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

function CountdownPanel({ desk, now }: { desk: Desk; now: number }) {
  const next = nextMoment(desk.round, now, desk.rank.status);
  const left = next.at === null ? null : next.at - now;
  const l = limitsOf(desk);
  const urgent = left !== null && left <= 10_000;

  useEffect(() => {
    document.title = left === null ? "$INTERN" : `${clock(left)} · $INTERN`;
  }, [left]);

  // Screen readers hear the countdown at ten minutes, one minute and zero, not every second
  const secs = left === null ? null : Math.floor(left / 1000);
  const spoken = secs === null ? "" : secs <= 0 ? `${next.label}: now.` : secs <= 60 ? `${next.label} under one minute.` : secs <= 600 ? `${next.label} under ten minutes.` : "";

  return (
    <section className="screen countdown" aria-label="Today's numbers">
      <p className="mono dim">{next.label.toUpperCase()}</p>
      <p className={`big-clock${urgent ? " is-urgent" : ""}`} role="timer" aria-live="off">
        {left === null ? "--:--:--" : clock(left)}
      </p>
      <p className="sr-only" role="status" aria-live="polite">
        {spoken}
      </p>
      <dl className="stat-rows">
        <div>
          <dt>BRAVE pool</dt>
          <dd className="up">
            <Usd e6={desk.pot.brave.total} />
          </dd>
        </div>
        <div>
          <dt>At risk today</dt>
          <dd>
            <Usd e6={desk.round.at_risk} /> <span className="dim">of {usd(dollarLimit(desk, l.per_round_bps))}</span>
          </dd>
        </div>
        <div>
          <dt>NOPEs today</dt>
          <dd>{desk.round.refused}</dd>
        </div>
      </dl>
    </section>
  );
}

const SHIFT = ["Clock in", "Propose", "Hold", "Clock out"];

function ShiftStrip({ desk, now }: { desk: Desk; now: number }) {
  const step = shiftStep(desk.round, now);
  return (
    <ol className="shift" aria-label="Today's shift">
      {SHIFT.map((name, i) => (
        <li key={name} className={i < step ? "is-done" : i === step ? "is-now" : ""} aria-current={i === step ? "step" : undefined}>
          <span className="shift-dot" aria-hidden="true">
            {i < step ? "✓" : i + 1}
          </span>
          {name}
        </li>
      ))}
    </ol>
  );
}

function slipLines(p: Position): [string, string] {
  return [`${p.side} ${p.market}`, `$${amount(p.margin)} · ${p.leverage}x`];
}

function askLines(d: Decision | null): [string, string] {
  if (!d) return ["???", "unreadable"];
  if (d.action === "SKIP") return ["NO BET", "today"];
  return [`${d.side} ${d.market}`, `$${amount(d.margin)} · ${d.leverage}x`];
}

const LIGHT_WORDS = { off: "not checked yet", ok: "passed", fail: "failed", skipped: "not needed on the test network" } as const;

/** The five lights for the sixteen checks, in the program's own order. */
function CheckLights({ moment }: { moment: Moment }) {
  return (
    <ol className="lights" aria-label="The program's checks">
      {LIGHTS.map((l, i) => (
        <li key={l.name} className={`light light-${moment.lights[i]}`} title={l.name}>
          <span className="lamp" aria-hidden="true" />
          <span className="sr-only">
            {l.name}: {LIGHT_WORDS[moment.lights[i] ?? "off"]}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** A circle drawn by hand around the number that broke the rule. */
function Circled({ children }: { children: string }) {
  return (
    <span className="circled">
      {children}
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
        <path d="M6 22 C4 8, 32 3, 54 4 C80 5, 97 11, 95 22 C93 34, 66 38, 44 37 C20 36, 5 32, 7 18 C9 9, 22 5, 34 5" pathLength="1" />
      </svg>
    </span>
  );
}

function VerdictSlot({ desk, moment, now }: { desk: Desk; moment: Moment | null; now: number }) {
  const lastNope = desk.refusals[0];
  const live = moment?.stage === "verdict" ? moment : null;

  if (live?.kind === "yes") {
    return (
      <p className="last-nope is-moment" key={`yes-${live.seq}`}>
        <span className="yes-chip">YES</span>
        <span>
          {titleCase(live.data.side)} {live.data.market} with {usd(live.data.margin)} at {live.data.leverage}x. Inside every limit.
        </span>
      </p>
    );
  }
  if (!lastNope) return null;
  const parts = refusalParts(lastNope.code, lastNope);
  const isLive = live?.kind === "nope";
  return (
    <p className={`last-nope${isLive ? " is-moment" : ""}`} key={`${lastNope.id}-${isLive}`}>
      <span className="nope-chip">NOPE</span>
      <span>
        {parts.before}
        {parts.asked && (isLive ? <Circled>{parts.asked}</Circled> : parts.asked)}
        {parts.after}{" "}
        <span className={`mono${isLive ? " typed" : ""}`} style={{ "--n": lastNope.code.length } as React.CSSProperties}>
          {lastNope.code}
        </span>
      </span>
      {isLive && lastNope.is_first ? (
        <span className="new-sticker">
          <img src={`/stickers/${lastNope.code.toLowerCase()}.webp`} alt="" width={56} height={56} />
          <span>New sticker!</span>
        </span>
      ) : (
        <time className="mono" dateTime={new Date(lastNope.at).toISOString()}>
          {when(lastNope.at, now)}
        </time>
      )}
      <a className="see" href={href("nope", { id: lastNope.id })}>
        See it<span className="sr-only">: the page for this NOPE</span>
      </a>
    </p>
  );
}

function DeskScene({ desk, fresh, now, moment }: { desk: Desk; fresh: FeedItem | null; now: number; moment: Moment | null }) {
  const m = mood(desk, fresh, now, moment);
  const l = limitsOf(desk);
  const bet = desk.positions[desk.positions.length - 1];
  const fired = desk.rank.status === "FIRED";
  const landed = moment?.stage === "verdict";
  const slip: [string, string] | null =
    moment?.stage === "slip"
      ? moment.kind === "nope"
        ? askLines(moment.decision)
        : askLines({ action: "BET", ...moment.data })
      : !moment && m.intern === "proposing" && bet
        ? slipLines(bet)
        : null;

  return (
    <section className={`scene${landed && moment.kind === "nope" ? " is-shaking" : ""}`} aria-label="The desk">
      <div className="stage">
        <Tin pose={landed && moment.kind === "yes" ? "coin" : "resting"} size={210} className="stage-tin" />
        <div className="intern-wrap">
          <Intern mood={m.intern} rank={desk.rank.rank} size={400} />
          {slip && (
            <p className="slip mono" key={slip.join()} aria-label={`Bet slip: ${slip.join(", ")}`}>
              <span>{slip[0]}</span>
              <span>{slip[1]}</span>
            </p>
          )}
        </div>
        <div className={`stamp-wrap${moment?.stage === "leap" ? " is-up" : ""}${landed ? (moment.kind === "nope" ? " is-down" : " is-hop") : ""}`}>
          <Stamp pose={m.stamp} size={270} className="stage-stamp" />
        </div>

        {moment && (
          <div className="verdict-zone">
            <CheckLights moment={moment} />
            {landed && <span className={`mark mark-${moment.kind}`}>{moment.kind === "nope" ? "NOPE" : "YES"}</span>}
          </div>
        )}
      </div>

      <div className="scene-info">
        <div className="rank-block">
          <p className="mono">RANK {RANK_ORDER.indexOf(desk.rank.rank) + 1} OF 3{fired ? " · FIRED" : ""}</p>
          <h1>{titleCase(desk.rank.rank)}</h1>
          <p className="rank-line">{fired ? "Fired by the bosses. No new bets until they vote to rehire." : rankLine(l)}</p>
          <RankLadder current={desk.rank.rank} pending={desk.rank.pending?.rank ?? null} />
        </div>
        <CountdownPanel desk={desk} now={now} />
      </div>

      <VerdictSlot desk={desk} moment={moment} now={now} />
    </section>
  );
}

function FeedPanel({ desk, fresh, now }: { desk: Desk; fresh: FeedItem | null; now: number }) {
  const rows = [...desk.feed].reverse().slice(0, 9);
  return (
    <section className="screen panel-dark" aria-labelledby="feed-h">
      <h2 id="feed-h">
        Live feed <a href={href("feed")}>See everything</a>
      </h2>
      {rows.length === 0 ? (
        <p className="empty">Nothing has happened yet. The Intern is still finding its desk.</p>
      ) : (
        <ul className="feed">
          {rows.map((f) => {
            const row = feedRow(f);
            return (
              <li key={f.seq} className={fresh?.seq === f.seq ? "is-fresh" : ""}>
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
                  {when(f.at, now)}
                </time>
              </li>
            );
          })}
        </ul>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {fresh ? feedRow(fresh).text : ""}
      </p>
    </section>
  );
}

function BetSteps({ p }: { p: Position }) {
  const steps = [
    { name: "Stamp said YES", done: true },
    { name: "Order signed and sent", done: p.open_signed_at !== null },
    { name: "Closing order signed", done: p.close_signed_at !== null },
    { name: "Result in", done: p.result !== null },
  ];
  return (
    <ol className="bet-steps">
      {steps.map((s) => (
        <li key={s.name} className={s.done ? "is-done" : ""}>
          <span aria-hidden="true">{s.done ? "✓" : "·"}</span> {s.name}
          <span className="sr-only">{s.done ? " (done)" : " (not yet)"}</span>
        </li>
      ))}
    </ol>
  );
}

function TodayPanel({ desk, now, moment }: { desk: Desk; now: number; moment: Moment | null }) {
  const newSticker = moment?.kind === "nope" && moment.stage === "verdict" && moment.data.is_first ? moment.code : null;
  const bet = desk.positions[desk.positions.length - 1];
  const phase = phaseAt(desk.round, now);
  const earned = new Set([...desk.refusals.map((r) => r.code), ...desk.firsts.filter((f) => f.round_id !== null).map((f) => f.code)]);
  const unlocked = earned.size;
  const empty =
    desk.rank.status === "FIRED"
      ? "The Intern is fired, so there is no bet today."
      : desk.round.skipped > 0
        ? "No bet today. The Intern sat this one out."
        : phase === "OPEN"
          ? "No bet yet. The Intern proposes when the countdown hits zero."
          : phase === "PROPOSE"
            ? "The Intern is deciding. Stamp is watching."
            : "No bet was placed this shift.";

  return (
    <section className="screen panel-dark" aria-labelledby="today-h">
      <h2 id="today-h">
        Today's bet <a href={href("bets")}>Open the bets page</a>
      </h2>
      {bet ? (
        <div className="bet">
          <p className="bet-line">
            {bet.side} {bet.market} <span className="dim">·</span> {usd(bet.margin)} <span className="dim">·</span> {bet.leverage}x
          </p>
          {bet.result !== null ? (
            <p className={`bet-result ${BigInt(bet.result) >= 0n ? "up" : "down"}`}>
              {signedUsd(bet.result)}
              {bet.result_source === "REPORTED" && <span className="feed-note">Reported by the runner, not measured by the program</span>}
            </p>
          ) : (
            <p className="bet-sub">
              {share(bet.margin, desk.round.brave_at_open) < 1 ? "Less than 1%" : pct(share(bet.margin, desk.round.brave_at_open) * 100)} of the BRAVE pool is on
              this bet.
            </p>
          )}
          <BetSteps p={bet} />
        </div>
      ) : (
        <p className="empty">{empty}</p>
      )}

      <h3 className="book-h">
        Sticker book{" "}
        <span className="mono dim">
          {unlocked} / {REFUSAL_CODES.length}
        </span>
      </h3>
      <p className="book-sub">One sticker for each kind of NOPE the Intern has earned.</p>
      <ul className="book">
        {desk.firsts.map((f) => (
          <li key={f.code} className={`${earned.has(f.code) ? "is-got" : ""}${newSticker === f.code ? " is-new" : ""}`} title={f.code}>
            {earned.has(f.code) ? (
              <img src={`/stickers/${f.code.toLowerCase()}.webp`} alt={`Sticker: ${f.code}`} width={64} height={64} loading="lazy" />
            ) : (
              <span className="sr-only">Not earned yet: {f.code}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function PoolCard({ desk }: { desk: Desk }) {
  const { brave, safe } = desk.pot;
  const total = (BigInt(brave.total) + BigInt(safe.total)).toString();
  const safeShare = share(safe.total, total);
  const lending = desk.constants.lending.mode;
  return (
    <section className="card pool" aria-labelledby="pool-h">
      <h2 id="pool-h">The pool</h2>
      <div className="dial-bar" role="img" aria-label={`SAFE ${safeShare}%, BRAVE ${100 - safeShare}%`}>
        <span className="dial-safe" style={{ flexGrow: Math.max(safeShare, 12) }}>
          SAFE {safeShare}%
        </span>
        <span className="dial-brave" style={{ flexGrow: Math.max(100 - safeShare, 12) }}>
          BRAVE {100 - safeShare}%
        </span>
      </div>
      <dl className="pool-rows">
        <div>
          <dt>SAFE · the Intern can never touch it</dt>
          <dd>
            <Usd e6={safe.total} />
          </dd>
        </div>
        <div>
          <dt>BRAVE · the Intern may use a slice</dt>
          <dd>
            <Usd e6={brave.total} />
          </dd>
        </div>
        {lending !== "NONE" && (
          <div className="sub">
            <dt>lent out{lending === "STANDIN" ? " (stand-in lender)" : ""}</dt>
            <dd>
              <Usd e6={brave.lent} />
            </dd>
          </div>
        )}
        {(lending === "NONE" || BigInt(brave.idle) > 0n) && (
          <div className="sub">
            <dt>{lending === "NONE" ? "sitting in the program (lending isn't built yet)" : "sitting idle"}</dt>
            <dd>
              <Usd e6={brave.idle} />
            </dd>
          </div>
        )}
        <div className="sub">
          <dt>on the Intern's bet</dt>
          <dd>
            <Usd e6={brave.in_play} />
          </dd>
        </div>
        <div className="sub">
          <dt>waiting for the next shift</dt>
          <dd>
            <Usd e6={brave.pending} />
          </dd>
        </div>
        {lending !== "NONE" && (
          <div>
            <dt>Interest so far, paid out through the payday draw{lending === "STANDIN" ? " (stand-in: worth nothing)" : ""}</dt>
            <dd>
              <Usd e6={brave.interest} />
            </dd>
          </div>
        )}
        {BigInt(brave.income_waiting) > 0n && (
          <div>
            <dt>Tips (the pool's half) and fees arriving next shift</dt>
            <dd>
              <Usd e6={brave.income_waiting} />
            </dd>
          </div>
        )}
        <div>
          <dt>Bosses</dt>
          <dd>{desk.pot.bosses.toLocaleString("en-US")}</dd>
        </div>
        <div>
          <dt>One INTERN is worth</dt>
          <dd>${(Number(desk.pot.coin_price_e6) / 1e6).toFixed(4)}</dd>
        </div>
      </dl>
      <p className="fine">
        Test network. Test dollars. Nothing here is real money. You can lose what you put in BRAVE. No profit is promised.
      </p>
    </section>
  );
}

/** The streak jackpot and the free guess, one tap from the desk. */
function JackpotStrip({ now }: { now: number }) {
  const r = useRewards();
  if (!r) return null;
  const open = r.guess_closes_at > now;
  return (
    <aside className="desk-jackpot" aria-label="The streak jackpot">
      <p>
        Jackpot{" "}
        <span className="mono">
          <Usd e6={r.jackpot} />
        </span>{" "}
        {BigInt(r.jackpot_added_total) > 0n && <small>seeded by the team</small>}
      </p>
      <p className="desk-jackpot-how">
        Guess the stamp right {r.constants.jackpot_streak} shifts in a row. {open ? `Guessing closes in ${clock(r.guess_closes_at - now)}.` : "Guessing is closed for this shift."}
      </p>
      <a className="btn" href={href("rewards")}>
        {open ? "Make your guess" : "See the rewards"}
      </a>
    </aside>
  );
}

export function Home() {
  const snap = useDesk();
  const now = useNow();
  const { desk } = snap;
  const moment = useMoment(snap.fresh, desk);

  return (
    <div className="home">
      <TopBar source={snap.source} scene={snap.scene} />
      {snap.error && desk && (
        <p className="banner" role="alert">
          Can't reach the program right now. Showing the last numbers we got; nothing was sent from your side. Trying again every few seconds.{" "}
          <span className="mono">{snap.error}</span>
        </p>
      )}
      {!desk ? (
        <Waiting error={snap.error} line="Finding the desk…" />
      ) : (
        <main id="main">
          <DeskScene desk={desk} fresh={snap.fresh} now={now} moment={moment} />
          <ShiftStrip desk={desk} now={now} />
          <JackpotStrip now={now} />
          <div className="panels">
            <FeedPanel desk={desk} fresh={snap.fresh} now={now} />
            <TodayPanel desk={desk} now={now} moment={moment} />
            <PoolCard desk={desk} />
          </div>
        </main>
      )}
    </div>
  );
}
