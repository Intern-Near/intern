import "./pages.css";
import "./bets.css";
import "./live.css";
import { getChain, useDesk, type Desk } from "../chain/store";
import type { MarketInfo, Position, Round, SignedAction } from "../chain/types";
import { dollarLimit, limitsOf } from "../home/Home";
import { clock, pct, signedUsd, titleCase, usd, when } from "../lib/format";
import { day, href } from "../lib/nav";
import { useBetWindow } from "./TailFadePage";
import { useRewards } from "../lib/useRewards";
import { WouldPass } from "../ui/WhyNope";
import { phaseAt } from "../lib/round";
import { useAsync } from "../lib/useAsync";
import { price, useMarks, type Marks } from "../lib/useMarks";
import { useNow } from "../lib/useNow";
import { TopBar } from "../ui/TopBar";
import { Usd } from "../ui/Usd";
import { Waiting } from "../ui/Waiting";

const short = (hex: string) => (hex.length > 14 ? `${hex.slice(0, 8)}…${hex.slice(-4)}` : hex);

/** The price the open order implies: dollars of the bet divided by its size. */
function entryOf(p: Position): number | null {
  if (!p.sz_e8 || BigInt(p.sz_e8) === 0n) return null;
  return Number(p.notional) / 1e6 / (Number(p.sz_e8) / 1e8);
}

function MarketStrip({ markets, marks, allowed }: { markets: MarketInfo[]; marks: Marks; allowed: Set<string> }) {
  return (
    <ul className="tape" aria-label="Hyperliquid prices for the Intern's six coins">
      {markets.map((m) => {
        const k = marks?.byName[m.hl_name];
        const move = k ? (k.mark / k.dayAgo - 1) * 100 : null;
        return (
          <li key={m.market} className={allowed.has(m.market) ? "" : "is-locked"}>
            <span className="tape-name">{m.market}</span>
            <span className="mono tape-px">{k ? price(k.mark) : "–"}</span>
            <span className={`mono tape-move ${move === null ? "" : move >= 0 ? "up" : "down"}`}>
              {move === null ? "" : `${move >= 0 ? "▲" : "▼"} ${Math.abs(move).toFixed(2)}%`}
            </span>
            {!allowed.has(m.market) && <span className="tape-lock">not at this rank</span>}
          </li>
        );
      })}
    </ul>
  );
}

const STEP_NAMES = { LEVERAGE: "Leverage set, isolated", OPEN: "Opening order", CLOSE: "Closing order" } as const;

function Signed({ a, now }: { a: SignedAction; now: number }) {
  const live = now < a.expires_after;
  return (
    <li className="signed">
      <div className="signed-head">
        <span className="signed-kind">{STEP_NAMES[a.kind]}</span>
        <span className="mono dim">
          signed {when(a.created_at, now)} · {live ? "can still be delivered" : "delivery window closed"}
        </span>
      </div>
      <details>
        <summary>See exactly what the program signed</summary>
        <pre className="mono">{JSON.stringify(a.action, null, 1)}</pre>
        <dl className="sig">
          <div>
            <dt>nonce</dt>
            <dd className="mono">{a.nonce}</dd>
          </div>
          <div>
            <dt>signature r</dt>
            <dd className="mono" title={a.signature.r}>
              {short(a.signature.r)}
            </dd>
          </div>
          <div>
            <dt>signature s</dt>
            <dd className="mono" title={a.signature.s}>
              {short(a.signature.s)}
            </dd>
          </div>
        </dl>
      </details>
    </li>
  );
}

function BetCard({ p, desk, marks, outbox, now }: { p: Position; desk: Desk; marks: Marks; outbox: SignedAction[]; now: number }) {
  const info = desk.constants.markets.find((m) => m.market === p.market)!;
  const k = marks?.byName[info.hl_name];
  const entry = entryOf(p);
  const open = p.result === null && p.open_signed_at !== null;
  const dir = p.side === "LONG" ? 1 : -1;
  const est = open && k && entry ? (Number(p.notional) / 1e6) * (k.mark / entry - 1) * dir : null;
  const mine = outbox.filter((a) => a.position_id === p.id);
  const steps = [
    { name: "Stamp said YES", at: p.approved_at },
    { name: "Order signed by NEAR's signing network", at: p.open_signed_at },
    { name: "Closing order signed", at: p.close_signed_at },
    { name: "Result in, shift settled", at: p.settled_at },
  ];
  return (
    <article className="screen panel-dark bet-card" aria-label={`Bet ${p.id}`}>
      <header className="bet-head">
        <p className="bet-title">
          <span className={`side side-${p.side.toLowerCase()}`}>{p.side === "LONG" ? "LONG ▲" : "SHORT ▼"}</span>
          {p.market}
          <span className="dim">{info.hl_name === p.market ? "perp" : `perp · trades as ${info.hl_name}`}</span>
        </p>
        <p className="mono dim">
          BET No. {p.id} · SHIFT {p.round_id}
        </p>
      </header>

      <dl className="bet-grid">
        <div>
          <dt>Money on it</dt>
          <dd>
            <Usd e6={p.margin} />
          </dd>
        </div>
        <div>
          <dt>Leverage</dt>
          <dd>
            {p.leverage}x
            {desk.feed.some((f) => f.event === "approved" && f.data.position_id === p.id && f.data.long_shot) && <span className="now-tag"> the long shot</span>}
          </dd>
        </div>
        <div>
          <dt>Position size</dt>
          <dd>
            <Usd e6={p.notional} />
          </dd>
        </div>
        <div>
          <dt>Entry price</dt>
          <dd>{entry ? price(entry) : "–"}</dd>
        </div>
        <div>
          <dt>Price now</dt>
          <dd>{k ? price(k.mark) : "–"}</dd>
        </div>
        <div className="bet-result-cell">
          <dt>{p.result !== null ? "Result" : "Right now, roughly"}</dt>
          <dd className={p.result !== null ? (BigInt(p.result) >= 0n ? "up" : "down") : est === null ? "" : est >= 0 ? "up" : "down"}>
            {p.result !== null ? signedUsd(p.result) : est === null ? "–" : `${est >= 0 ? "+" : "−"}$${Math.abs(est).toFixed(2)}`}
          </dd>
        </div>
      </dl>

      <p className="bet-caveat">
        {p.result !== null
          ? p.result_source === "REPORTED"
            ? "Result reported by the runner, not measured by the program."
            : "Result measured by the program from the dollars that came back."
          : "Entry price is what the signed order implies. Price now and the rough result come from Hyperliquid's public data, read by your browser. The program cannot read Hyperliquid, so these are not its numbers."}
      </p>

      <ol className="bet-track">
        {steps.map((s) => (
          <li key={s.name} className={s.at ? "is-done" : ""}>
            <span className="track-dot" aria-hidden="true">
              {s.at ? "✓" : ""}
            </span>
            <span>{s.name}</span>
            <span className="mono dim">{s.at ? when(s.at, now) : "not yet"}</span>
          </li>
        ))}
      </ol>

      {mine.length > 0 && (
        <>
          <h3 className="signed-h">What the program signed</h3>
          <p className="bet-caveat">
            The program builds each order itself from the checked bet and signs it. It never signs anything handed to it. Anyone may deliver a signed order to
            Hyperliquid within two minutes.
          </p>
          <ul className="signed-list">
            {mine.map((a) => (
              <Signed key={a.id} a={a} now={now} />
            ))}
          </ul>
        </>
      )}
    </article>
  );
}

type Shift = { round: Round; positions: Position[] };

function History({ desk }: { desk: Desk }) {
  const cur = desk.round.id;
  const shifts = useAsync<Shift[]>(async () => {
    const chain = getChain();
    const ids = Array.from({ length: 10 }, (_, i) => cur - 1 - i).filter((id) => id >= 1);
    const all = await Promise.all(ids.map(async (id) => ({ round: await chain.getRoundById(id), positions: await chain.getPositions(id) })));
    return all.filter((s): s is Shift => s.round !== null);
  }, `bets-history-${cur}`);
  const bets = (shifts.data ?? []).flatMap((s) => s.positions.map((p) => ({ p, r: s.round })));
  const total = bets.reduce((sum, b) => sum + (b.p.result ? BigInt(b.p.result) : 0n), 0n);
  const wins = bets.filter((b) => b.p.result && BigInt(b.p.result) > 0n).length;

  return (
    <section className="card" aria-labelledby="hist-h">
      <h2 id="hist-h">Earlier bets</h2>
      {shifts.loading && <p className="pencil">Opening the drawer…</p>}
      {shifts.error && <p role="alert">Couldn't load earlier bets. {shifts.error}</p>}
      {shifts.data && bets.length === 0 && <p className="pencil">No earlier bets. The Intern is new here.</p>}
      {bets.length > 0 && (
        <>
          <p className="panel-sub pencil">
            {bets.length} bets in the last {shifts.data!.length} shifts. {wins} came back up. Altogether: <strong>{signedUsd(total.toString())}</strong>. A short
            record says very little about what comes next.
          </p>
          <div className="table-scroll">
            <table className="record">
              <thead>
                <tr>
                  <th scope="col">Shift</th>
                  <th scope="col">Day</th>
                  <th scope="col">Bet</th>
                  <th scope="col" className="r">
                    Money on it
                  </th>
                  <th scope="col" className="r">
                    Result
                  </th>
                </tr>
              </thead>
              <tbody>
                {bets.map(({ p, r }) => (
                  <tr key={p.id}>
                    <td className="mono">{r.id}</td>
                    <td>{day(r.started_at)}</td>
                    <td>
                      {titleCase(p.side)} {p.market} at {p.leverage}x
                    </td>
                    <td className="mono r">{usd(p.margin)}</td>
                    <td className={`mono r ${p.result === null ? "" : BigInt(p.result) < 0n ? "neg" : "pos"}`}>{p.result === null ? "open" : signedUsd(p.result)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

export function BetsPage() {
  const snap = useDesk();
  const now = useNow();
  const tf = useBetWindow(snap.desk?.feed, now);
  const rewards = useRewards();
  const { desk } = snap;
  const { marks, error: marksDown } = useMarks(desk?.constants.hl.testnet ?? true);
  const outbox = useAsync(() => getChain().getOutbox(undefined, 50), `outbox-${desk?.feed[desk.feed.length - 1]?.seq ?? 0}`);

  if (!desk) {
    return (
      <div className="home">
        <TopBar source={snap.source} scene={snap.scene} />
        <Waiting error={snap.error} line="Fetching the Intern's bets…" />
      </div>
    );
  }
  const l = limitsOf(desk);
  const phase = phaseAt(desk.round, now);
  const perRound = dollarLimit(desk, l.per_round_bps);
  const used = BigInt(perRound) === 0n ? 0 : Number((BigInt(desk.round.at_risk) * 100n) / BigInt(perRound));
  const empty =
    desk.rank.status === "FIRED"
      ? "The Intern is fired, so there are no bets."
      : desk.round.skipped > 0
        ? "The Intern sat today out. No bet."
        : phase === "OPEN"
          ? "No bet yet today. The Intern proposes when betting opens."
          : phase === "PROPOSE"
            ? "The Intern is deciding. If Stamp says YES, the bet appears here."
            : "No bet was placed this shift.";

  return (
    <div className="home">
      <TopBar source={snap.source} scene={snap.scene} />
      <main id="main">
        {tf && (
          <aside className="bets-tf" aria-label="Tail or Fade">
            <p>
              Tail or Fade is open on {tf.market} for <span className="mono">{clock(tf.closes_at - now).slice(3)}</span>
            </p>
            <a className="btn" href={href("tailfade")}>
              Bet with it, or against it
            </a>
          </aside>
        )}
        <header className="bets-head">
          <h1>The Intern's bets</h1>
          <p>
            Every bet is a perp position on Hyperliquid: a bet that a coin's price goes up{l.sides.includes("SHORT") ? " or down" : ""}, sized by the Intern's rank
            and checked by the program first.
          </p>
        </header>

        <MarketStrip markets={desk.constants.markets} marks={marks} allowed={new Set(l.markets)} />
        <p className="fine tape-note">
          {marksDown
            ? "Couldn't reach Hyperliquid's public prices just now."
            : `Prices from Hyperliquid's public ${desk.constants.hl.testnet ? "test network" : "exchange"} data, refreshed every 10 seconds by your browser.`}
        </p>

        <section className="allowance" aria-label="Today's allowance">
          <div>
            <p className="allow-name">Bets today</p>
            <p className="allow-big">
              {desk.round.bets_used} <span>of {l.max_bets}</span>
            </p>
          </div>
          <div className="allow-wide">
            <p className="allow-name">At risk today</p>
            <p className="allow-big">
              <Usd e6={desk.round.at_risk} /> <span>of {usd(perRound)}</span>
            </p>
            <div className="meter" role="img" aria-label={`${used}% of today's limit used`}>
              <span style={{ width: `${Math.min(100, used)}%` }} />
            </div>
          </div>
          <div>
            <p className="allow-name">Most on one bet</p>
            <p className="allow-big">
              {usd(dollarLimit(desk, l.per_bet_bps))} <span>{pct(l.per_bet_bps)} of BRAVE</span>
            </p>
          </div>
          <div>
            <p className="allow-name">Leverage</p>
            <p className="allow-big">
              {l.max_leverage}x <span>{l.sides.includes("SHORT") ? "up or down" : "up only"}</span>
            </p>
          </div>
        </section>

        {desk.positions.length === 0 ? (
          <p className="bets-empty">{empty}</p>
        ) : (
          desk.positions.map((p) => <BetCard key={p.id} p={p} desk={desk} marks={marks} outbox={outbox.data ?? []} now={now} />)
        )}

        <p className="fine">
          The Intern's Hyperliquid address is <span className="mono">{desk.constants.hl.address}</span>, an address only the program can sign for. A perp bet can lose
          all the money on it. Test network: nothing here is real money.
        </p>

        <History desk={desk} />

        <WouldPass desk={desk} now={now} rewards={rewards} />
      </main>
    </div>
  );
}
