import { useState } from "react";
import "./pages.css";
import { getChain, useDesk, type Desk } from "../chain/store";
import type { Limits, Position, RefusalCode, Round } from "../chain/types";
import { REFUSAL_CODES } from "../chain/types";
import { Intern } from "../cast/Intern";
import { dollarLimit, limitsOf, rankLine, RankLadder } from "../home/Home";
import { pct, signedUsd, titleCase, usd } from "../lib/format";
import { day, href } from "../lib/nav";
import { refusalSentence } from "../lib/refusals";
import { useAsync } from "../lib/useAsync";
import { useNow } from "../lib/useNow";
import { useRewards } from "../lib/useRewards";
import { AutoPanel, RescuePanel } from "../ui/Auto17";
import { TopBar } from "../ui/TopBar";
import { Waiting } from "../ui/Waiting";

const DAYS_SHOWN = 7;

/** All three ranks side by side. The numbers are constants in the program. */
function LimitsTable({ desk }: { desk: Desk }) {
  const ranks = desk.constants.ranks;
  const current = desk.rank.rank;
  const rows: { name: string; cell: (l: Limits) => React.ReactNode }[] = [
    {
      name: "Most on one bet",
      cell: (l) => (
        <>
          {pct(l.per_bet_bps)} <span className="dim">· {usd(dollarLimit(desk, l.per_bet_bps))} today</span>
        </>
      ),
    },
    { name: "Bets per shift", cell: (l) => l.max_bets },
    {
      name: "Most at risk per shift",
      cell: (l) => (
        <>
          {pct(l.per_round_bps)} <span className="dim">· {usd(dollarLimit(desk, l.per_round_bps))} today</span>
        </>
      ),
    },
    { name: "Direction", cell: (l) => (l.sides.includes("SHORT") ? "Up or down" : "Up only") },
    { name: "Leverage", cell: (l) => (l.max_leverage === 1 ? "1x" : `Up to ${l.max_leverage}x`) },
    { name: "Coins", cell: (l) => l.markets.join(" ") },
  ];
  return (
    <section className="screen panel-dark" aria-labelledby="limits-h">
      <h2 id="limits-h">The limits</h2>
      <p className="panel-sub">Fixed. No vote can change these numbers. Bosses can only move the Intern between the three columns, or fire it.</p>
      <div className="table-scroll">
        <table className="limits">
          <thead>
            <tr>
              <td />
              {ranks.map((l) => (
                <th key={l.rank} scope="col" className={l.rank === current ? "is-current" : ""}>
                  {titleCase(l.rank)}
                  {l.rank === current && <span className="now-tag">now</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name}>
                <th scope="row">{r.name}</th>
                {ranks.map((l) => (
                  <td key={l.rank} className={l.rank === current ? "is-current" : ""}>
                    {r.cell(l)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

type Shift = { round: Round; positions: Position[] };

function Record({ desk }: { desk: Desk }) {
  const cur = desk.round.id;
  const shifts = useAsync<Shift[]>(async () => {
    const ids = Array.from({ length: DAYS_SHOWN }, (_, i) => cur - i).filter((id) => id >= 1);
    const chain = getChain();
    const all = await Promise.all(ids.map(async (id) => ({ round: await chain.getRoundById(id), positions: await chain.getPositions(id) })));
    return all.filter((s): s is Shift => s.round !== null);
  }, `record-${cur}-${desk.round.settled}-${desk.positions.length}`);

  return (
    <section className="card" aria-labelledby="record-h">
      <h2 id="record-h">The record</h2>
      <p className="panel-sub pencil">The last {DAYS_SHOWN} shifts, newest first. Every line is read from the program.</p>
      {shifts.error && <p role="alert">Couldn't load the record. {shifts.error}</p>}
      {shifts.loading && <p className="pencil">Opening the filing cabinet…</p>}
      {shifts.data && shifts.data.length === 0 && <p className="pencil">No shifts yet. The first one is still running.</p>}
      {shifts.data && shifts.data.length > 0 && (
        <div className="table-scroll">
          <table className="record">
            <thead>
              <tr>
                <th scope="col">Shift</th>
                <th scope="col">Day</th>
                <th scope="col">Rank</th>
                <th scope="col">Bet</th>
                <th scope="col" className="r">
                  NOPEs
                </th>
                <th scope="col" className="r">
                  Result
                </th>
              </tr>
            </thead>
            <tbody>
              {shifts.data.map(({ round: r, positions }) => {
                const bet = positions.map((p) => `${titleCase(p.side)} ${p.market} ${usd(p.margin)}`).join(", ");
                return (
                  <tr key={r.id}>
                    <td className="mono">{r.id}</td>
                    <td>{day(r.started_at)}</td>
                    <td>{titleCase(r.rank)}</td>
                    <td>{bet || (r.skipped > 0 ? "Sat it out" : r.settled ? "No bet" : "Not yet")}</td>
                    <td className="mono r">{r.refused}</td>
                    <td className={`mono r ${r.result === null ? "" : BigInt(r.result) < 0n ? "neg" : "pos"}`}>
                      {r.result === null ? "open" : BigInt(r.result) === 0n ? "$0.00" : signedUsd(r.result)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {desk.constants.result_source === "REPORTED" && <p className="fine">Results are reported by the runner, not measured by the program.</p>}
    </section>
  );
}

function StickerBook({ desk }: { desk: Desk }) {
  const [open, setOpen] = useState<RefusalCode | null>(null);
  const firstOf = new Map(desk.firsts.map((f) => [f.code, f]));
  const history = useAsync(() => getChain().getRefusals(undefined, 100), `refusals-${desk.round.refused}-${desk.round.id}`);
  // A sticker is earned when the Intern has had that NOPE. Who owns the one original is a separate matter (1.3).
  const seen = new Set([...desk.refusals, ...(history.data ?? [])].map((r) => r.code));
  const got = REFUSAL_CODES.filter((c) => seen.has(c)).length;
  const times = (code: RefusalCode) => (history.data ?? []).filter((r) => r.code === code);
  // (1.4) Golden versions: a 1 in 50 chance per guess, at most `goldCap` of each code, ever
  const rewards = useRewards();
  const goldCap = rewards?.constants.golden_cap ?? 100;

  return (
    <section className="screen panel-dark" aria-labelledby="book-h">
      <h2 id="book-h">
        Sticker book{" "}
        <span className="mono dim">
          {got} / {REFUSAL_CODES.length}
        </span>
      </h2>
      <p className="panel-sub">
        One sticker for each kind of NOPE. A sticker is earned the first time the Intern gets that NOPE. The one original of each goes to the visitor whose message
        caused it. Golden versions drop at random to people guessing the stamp (<a href={href("rewards")}>see rewards</a>). Tap a sticker to see every time it happened.
      </p>
      <ul className="book-big">
        {REFUSAL_CODES.map((code) => {
          const f = firstOf.get(code);
          const earned = seen.has(code);
          const gold = rewards?.golden_minted[REFUSAL_CODES.indexOf(code)] ?? 0;
          return (
            <li key={code}>
              <button className={`sticker${earned ? " is-got" : ""}${gold > 0 ? " has-gold" : ""}`} aria-expanded={open === code} aria-controls="sticker-detail" onClick={() => setOpen(open === code ? null : code)}>
                {earned ? <img src={`/stickers/${code.toLowerCase()}.webp`} alt="" width={128} height={128} loading="lazy" /> : <span className="sticker-blank" aria-hidden="true">?</span>}
                <span className="mono sticker-name">{code}</span>
                <span className="sr-only">{earned ? ", earned" : ", not earned yet"}</span>
                {f?.account_id && <span className="sticker-owner">original: {f.account_id.split(".")[0]}{f.claimed ? "" : " (unclaimed)"}</span>}
                {gold > 0 && <span className="sticker-gold">golden: {gold} of {goldCap}</span>}
              </button>
            </li>
          );
        })}
      </ul>
      <div id="sticker-detail" className="sticker-detail" aria-live="polite">
        {open && (
          <>
            <h3 className="mono">{open}</h3>
            <p>{refusalSentence(open, { asked: null, limit: null }).replace(/\$?\?x?/g, "…").replace(/…\./g, "…")}</p>
            {times(open).length === 0 ? (
              <p className="dim">{history.loading ? "Looking…" : "The Intern has never been refused for this. Yet."}</p>
            ) : (
              <ul className="times">
                {times(open).map((r) => (
                  <li key={r.id}>
                    <span className="mono dim">shift {r.round_id}</span>
                    <span>{refusalSentence(r.code, r)}</span>
                    <a href={href("nope", { id: r.id })}>
                      See it<span className="sr-only">: NOPE number {r.id}</span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </section>
  );
}

export function InternPage() {
  const snap = useDesk();
  const { desk } = snap;
  const fired = desk?.rank.status === "FIRED";
  const now = useNow();
  return (
    <div className="home">
      <TopBar source={snap.source} scene={snap.scene} />
      {snap.error && desk && (
        <p className="banner" role="alert">
          Can't reach the program right now. <span className="mono">{snap.error}</span>
        </p>
      )}
      {!desk ? (
        <Waiting error={snap.error} line="Pulling the Intern's file…" />
      ) : (
        <main id="main">
          <section className="profile">
            <Intern mood={fired ? "fired" : "idle"} rank={desk.rank.rank} size={340} />
            <div className="profile-text">
              <p className="mono">
                RANK {["INTERN", "ANALYST", "TRADER"].indexOf(desk.rank.rank) + 1} OF 3{fired ? " · FIRED" : ""} · SINCE SHIFT {desk.rank.since_round}
              </p>
              <h1>{titleCase(desk.rank.rank)}</h1>
              <p className="profile-line">{fired ? "Fired. No new bets until the bosses vote to rehire it, or a rescue fund fills." : rankLine(limitsOf(desk))}</p>
              <RankLadder current={desk.rank.rank} pending={desk.rank.pending?.rank ?? null} />
              {desk.rank.pending && (
                <p className="pending">
                  Voted in: {titleCase(desk.rank.pending.rank)} from shift {desk.rank.pending.effective_round}.
                </p>
              )}
              <p className="fine">
                The Intern is an AI model. It proposes; a program decides. The proof shows which model answered, not that its bets are good. The rank is the only
                thing that limits it.
              </p>
            </div>
          </section>
          <RescuePanel desk={desk} />
          <AutoPanel desk={desk} now={now} />
          <LimitsTable desk={desk} />
          <div className="two-col">
            <Record desk={desk} />
            <StickerBook desk={desk} />
          </div>
        </main>
      )}
    </div>
  );
}
