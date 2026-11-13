import { useCallback, useEffect, useMemo, useState } from "react";
import "./pages.css";
import "./people.css";
import "./live.css";
import deployments from "../../../interface/deployments.json";
import { Intern } from "../cast/Intern";
import { signIn, useSession } from "../chain/session";
import { getSource, useDesk } from "../chain/store";
import type { FeedItem } from "../chain/types";
import { liveDriver, pretendDriver, type Account, type Chip, type Choice, type Driver, type Leverage, type FaucetStatus, type Fill } from "../lib/tailfadeDriver";
import { HL_NAME, liquidationMovePct, openWindow, TAIL_OR_FADE, type FeedItem as LibFeedItem, type Window as BetWindow } from "../tailfade/tailfade.ts";
import { clock, usd } from "../lib/format";
import { href } from "../lib/nav";
import { FollowCard } from "./FollowCard";
import { useNow } from "../lib/useNow";
import { TopBar } from "../ui/TopBar";
import { Waiting } from "../ui/Waiting";

let driver: Driver | undefined;
function getDriver(): Driver {
  if (driver) return driver;
  const net = deployments.testnet as { rpc: string; tailfade_faucet?: string };
  driver = getSource().name === "sample" ? pretendDriver() : liveDriver(net.rpc, net.tailfade_faucet);
  return driver;
}

const money = (n: number) => `${n < 0 ? "−" : ""}$${Math.abs(n).toFixed(2)}`;
const signed = (n: number) => `${n < 0 ? "−" : "+"}$${Math.abs(n).toFixed(2)}`;
const hhmm = (at: number) => `${new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC`;

/** The open window, if any. On sample data `&tf=open` opens one on the latest bet so the screen can be seen. */
export function useBetWindow(feed: FeedItem[] | undefined, now: number): BetWindow | null {
  return useMemo(() => {
    if (!feed) return null;
    const real = openWindow(feed as unknown as LibFeedItem[], now);
    if (real || getSource().name !== "sample" || new URLSearchParams(window.location.search).get("tf") !== "open") return real;
    const bet = [...feed].reverse().find((f) => f.event === "approved");
    if (!bet || bet.event !== "approved") return null;
    const at = Math.floor(now / TAIL_OR_FADE.windowMs) * TAIL_OR_FADE.windowMs;
    return { position_id: bet.data.position_id, round_id: bet.data.round_id, market: bet.data.market, side: bet.data.side, opens_at: at, closes_at: at + TAIL_OR_FADE.windowMs };
    // The window only changes when the feed grows or a 10-second tick passes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feed, Math.floor(now / 10_000)]);
}

type Step = { n: number; name: string; state: "done" | "now" | "later" };

export function TailFadePage() {
  const snap = useDesk();
  const now = useNow();
  const session = useSession();
  const d = getDriver();
  const { desk } = snap;
  const me = session.accountId;

  const [address, setAddress] = useState<string | null>(null);
  const [acct, setAcct] = useState<Account | null>(null);
  const [faucet, setFaucet] = useState<FaucetStatus | null>(null);
  const [approved, setApproved] = useState<boolean | null>(null);
  const [chip, setChip] = useState<Chip>(10);
  const [lev, setLev] = useState<Leverage>(TAIL_OR_FADE.leverage);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);

  const agent = useMemo(() => (me ? d.agent(me) : null), [d, me]);
  const win = useBetWindow(desk?.feed, now);

  // Who you are on Hyperliquid, and whether the trading key is approved
  useEffect(() => {
    let alive = true;
    setAddress(null);
    setAcct(null);
    setApproved(null);
    setSetupError(null);
    d.faucetStatus().then((f) => alive && setFaucet(f), () => undefined);
    if (!me || !agent) return;
    d.address(me)
      .then(async (a) => {
        const [ac, ok] = await Promise.all([d.account(a), d.approved(a, agent)]);
        if (!alive) return;
        setAddress(a);
        setAcct(ac);
        setApproved(ok);
      })
      .catch((e: unknown) => alive && setSetupError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [d, me, agent]);

  const refresh = useCallback(async () => {
    if (!address) return;
    try {
      setAcct(await d.account(address));
    } catch {
      /* the last numbers stay on screen */
    }
  }, [d, address]);

  // Your position moves with the price: re-read it every few seconds
  useEffect(() => {
    if (!address) return;
    const id = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(id);
  }, [address, refresh]);

  async function run(name: string, what: () => Promise<string>) {
    if (busy) return;
    setBusy(name);
    setError(null);
    setSaid(null);
    try {
      setSaid(await what());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      void refresh();
      d.faucetStatus().then(setFaucet, () => undefined);
    }
  }

  if (!desk) {
    return (
      <div className="home">
        <TopBar source={snap.source} scene={snap.scene} />
        <Waiting error={snap.error} line="Looking for the Intern's latest bet…" />
      </div>
    );
  }

  const funded = acct !== null && acct.accountValue > 0;
  const ready = !!me && !!address && funded && approved === true;
  const steps: Step[] = [
    { n: 1, name: "Clock in", state: me ? "done" : "now" },
    { n: 2, name: "Get test dollars", state: !me ? "later" : funded ? "done" : "now" },
    { n: 3, name: "Approve a trading key", state: !me || !funded ? "later" : approved ? "done" : "now" },
    { n: 4, name: "Tail or fade", state: ready ? "now" : "later" },
  ];
  const faucetLeft = faucet ? Math.max(0, faucet.max - faucet.granted) : null;
  const faucetEmpty = faucet !== null && (!faucet.configured || faucetLeft === 0 || faucet.balance_usd < faucet.amount_usd);
  const bet = win ? desk.feed.find((f) => f.event === "approved" && f.data.position_id === win.position_id) : undefined;
  const internMargin = bet && bet.event === "approved" ? bet.data.margin : null;
  const left = win ? win.closes_at - now : 0;
  const tooPoor = acct !== null && acct.withdrawable < chip;
  const sideWord = (s: "LONG" | "SHORT") => (s === "LONG" ? "a rise" : "a fall");
  const other = (s: "LONG" | "SHORT") => (s === "LONG" ? "SHORT" : "LONG");
  const nextWindow = desk.round.propose_from > now ? desk.round.propose_from : null;

  const place = (choice: Choice) =>
    run(choice, async () => {
      const r: Fill = await d.chip({ agent: agent!, market: win!.market, choice, internSide: win!.side, chipUsd: chip, leverage: lev });
      if (!r.ok) throw new Error(`Your chip did not go in: ${r.why} Nothing was bet. You can try again while the window is open.`);
      return `Your $${chip} chip is in at ${lev}x: ${r.sz} ${HL_NAME[win!.market] ?? win!.market} at ${r.px}.`;
    });

  return (
    <div className="home">
      <TopBar source={snap.source} scene={snap.scene} />
      <main id="main" className="people-page tf-page">
        <header className="people-head">
          <Intern mood="proposing" size={170} />
          <div>
            <h1>Tail or Fade</h1>
            <p>
              When the Intern's bet opens, you have ten minutes to put a $10 or $25 chip on the same coin, at 2x, 5x or 10x: <strong>tail</strong> it (bet the same way) or{" "}
              <strong>fade</strong> it (bet against it).
            </p>
          </div>
        </header>

        <ul className="tf-warnings">
          <li>
            <strong>This is not an edge.</strong> Betting against the Intern is a bet, not a strategy. Leverage can wipe out the chip quickly: at 10x, a move of about 9% does it.
          </li>
          <li>
            <strong>No contract checks this.</strong> The chip is placed by a key in your browser, in your own Hyperliquid account. This page sets the size; nothing
            on chain enforces it.
          </li>
          <li>
            <strong>Test network.</strong> Test dollars from a faucet. Nothing here is worth money.
            {d.pretend && " This is sample data: every step below is pretend and nothing leaves your browser."}
          </li>
        </ul>

        <ol className="tf-steps" aria-label="Steps">
          {steps.map((s) => (
            <li key={s.n} className={`is-${s.state}`} aria-current={s.state === "now" ? "step" : undefined}>
              <span className="mono">{s.state === "done" ? "✓" : s.n}</span>
              {s.name}
              <span className="sr-only">{s.state === "done" ? " (done)" : s.state === "now" ? " (next)" : ""}</span>
            </li>
          ))}
        </ol>

        {(error || said) && (
          <p className={`notice ${error ? "notice-bad" : "notice-ok"}`} role={error ? "alert" : "status"}>
            {error ?? said}
          </p>
        )}

        <div className="money-grid">
          <section className="card money-form" aria-labelledby="tf-acct">
            <h2 id="tf-acct">Your betting account</h2>
            {!me ? (
              <>
                <p>Clock in with your NEAR account. Your betting account on Hyperliquid's test network is worked out from it; only you can sign for it.</p>
                {session.canSignIn && (
                  <button className="btn" onClick={signIn}>
                    {session.pretend ? "Clock in with a pretend account" : "Clock in with a NEAR wallet"}
                  </button>
                )}
              </>
            ) : setupError ? (
              <p role="alert">Couldn't work out your betting account. Nothing was sent. Reload the page to try again. <span className="mono tf-small">{setupError}</span></p>
            ) : !address || !acct ? (
              <p className="pencil">Working out your betting account…</p>
            ) : (
              <>
                <dl className="tf-facts">
                  <div>
                    <dt>Address</dt>
                    <dd className="mono tf-small" title={address}>
                      {address.slice(0, 10)}…{address.slice(-6)}
                    </dd>
                  </div>
                  <div>
                    <dt>Worth</dt>
                    <dd className="mono">{money(acct.accountValue)}</dd>
                  </div>
                  <div>
                    <dt>Free to bet</dt>
                    <dd className="mono">{money(acct.withdrawable)}</dd>
                  </div>
                </dl>

                {!funded && (
                  <>
                    <button className="btn btn-wide" disabled={!!busy || faucetEmpty} onClick={() => run("faucet", async () => (await d.faucet(me), "Test dollars are on their way. They show up here within a few seconds."))}>
                      {busy === "faucet" ? "Asking the faucet…" : faucetEmpty ? "The faucet is empty" : `Get $${faucet?.amount_usd ?? 30} of test dollars`}
                    </button>
                    <p className="fine">
                      {faucet === null
                        ? "Checking the faucet…"
                        : faucetEmpty
                          ? "The faucet has given out everything it had. Without test dollars in this account you can't place a chip here."
                          : `Once per NEAR account. The faucet has room for ${faucetLeft} more ${faucetLeft === 1 ? "visitor" : "visitors"}. Hyperliquid keeps $1 the first time an account is funded.`}
                    </p>
                  </>
                )}

                {funded && approved === false && (
                  <>
                    <button className="btn btn-wide" disabled={!!busy} onClick={() => run("approve", async () => (await d.approve(me, agent!), setApproved(true), "The trading key is approved. You can place chips without any more popups."))}>
                      {busy === "approve" ? "Waiting for your wallet (about 10 seconds)…" : "Approve the trading key"}
                    </button>
                    <p className="fine">
                      One wallet popup, once. Your wallet asks NEAR's signing network to approve a key that lives in this browser. The key can place and close bets. It
                      can never withdraw. The popup attaches 1 yoctoNEAR, the smallest amount there is.
                    </p>
                  </>
                )}
                {ready && <p className="tf-ready">You're set. Chips go in with one tap, no popups.</p>}
              </>
            )}
          </section>

          <section className={`card money-form tf-window${win ? " is-open" : ""}`} aria-labelledby="tf-win">
            <h2 id="tf-win">{win ? "The window is open" : "The window is closed"}</h2>
            {win ? (
              <>
                <p className="tf-call">
                  The Intern bet on <strong>{sideWord(win.side)}</strong> in <strong>{win.market}</strong>
                  {internMargin ? <> with {usd(internMargin)}</> : null}.
                </p>
                <p className="tf-clock" role="timer" aria-label={`Window closes in ${clock(left).slice(3)}`}>
                  <span className="mono">{clock(left).slice(3)}</span> left
                </p>
                <fieldset className="tf-chips">
                  <legend>Your chip</legend>
                  {TAIL_OR_FADE.chipsUsd.map((c) => (
                    <label key={c} className={chip === c ? "is-on" : ""}>
                      <input type="radio" name="chip" checked={chip === c} onChange={() => setChip(c)} />${c}
                    </label>
                  ))}
                </fieldset>
                <fieldset className="tf-chips">
                  <legend>Leverage</legend>
                  {TAIL_OR_FADE.leverages.map((l) => (
                    <label key={l} className={lev === l ? "is-on" : ""}>
                      <input type="radio" name="lev" checked={lev === l} onChange={() => setLev(l)} />
                      {l}x
                    </label>
                  ))}
                </fieldset>
                <p className={lev > 2 ? "warn" : "tf-risk"}>
                  At {lev}x, a move of about {liquidationMovePct(lev)}% against you ends this chip.
                  {lev > 2 ? " Some coins stop at 5x; if this one does, the chip is refused and nothing is bet." : ""}
                </p>
                <div className="tf-pick">
                  <button className="btn tf-tail" disabled={!ready || !!busy || tooPoor} onClick={() => void place("TAIL")}>
                    {busy === "TAIL" ? "Placing…" : `Tail: bet on ${sideWord(win.side)}`}
                  </button>
                  <button className="btn tf-fade" disabled={!ready || !!busy || tooPoor} onClick={() => void place("FADE")}>
                    {busy === "FADE" ? "Placing…" : `Fade: bet on ${sideWord(other(win.side))}`}
                  </button>
                </div>
                <p className="fine">
                  {!ready
                    ? "Finish the steps on the left first."
                    : tooPoor
                      ? `You have ${money(acct!.withdrawable)} free, which is less than a $${chip} chip.`
                      : `A $${chip} chip at ${lev}x controls $${chip * lev} of ${win.market}. The order fills right away or not at all.`}
                </p>
              </>
            ) : (
              <>
                <p>It opens for ten minutes each time one of the Intern's bets opens.</p>
                <p className="pencil">
                  {desk.rank.status === "FIRED"
                    ? "The Intern is fired, so no bets are coming until the bosses rehire it."
                    : nextWindow
                      ? `The Intern next decides at ${hhmm(nextWindow)}, in ${clock(nextWindow - now)}. It may bet, or it may skip.`
                      : "The Intern has decided for this shift. The next chance is next shift."}
                </p>
                <a className="btn btn-quiet" href={href("desk")}>
                  Watch the desk
                </a>
              </>
            )}
          </section>
        </div>

        {me && <FollowCard accountId={me} agent={agent} driver={d} feed={desk.feed} now={now} ready={ready} />}

        {acct && acct.positions.filter((p) => p.szi !== 0).length > 0 && (
          <section aria-labelledby="tf-pos">
            <h2 id="tf-pos">Your open chips</h2>
            <ul className="tf-positions">
              {acct.positions
                .filter((p) => p.szi !== 0)
                .map((p) => {
                  const market = Object.entries(HL_NAME).find(([, hl]) => hl === p.coin)?.[0] ?? p.coin;
                  return (
                    <li key={p.coin}>
                      <span>
                        <strong>{p.coin}</strong>, betting on {p.szi > 0 ? "a rise" : "a fall"}
                      </span>
                      <span className="mono">
                        {Math.abs(p.szi)} at {p.entryPx ?? "?"}
                      </span>
                      <span className={`mono ${p.unrealizedPnl >= 0 ? "tf-up" : "tf-down"}`}>
                        {p.unrealizedPnl >= 0 ? "▲" : "▼"} {signed(p.unrealizedPnl)} so far
                      </span>
                      <button
                        className="btn"
                        disabled={!!busy || !agent || !address}
                        onClick={() =>
                          run(`close-${p.coin}`, async () => {
                            const r = await d.close({ agent: agent!, user: address!, market });
                            if (r === null) return "There was nothing left to close.";
                            if (!r.ok) throw new Error(`The close did not go through: ${r.why} Your chip is still open. Try again.`);
                            return `Closed: ${r.sz} ${p.coin} at ${r.px}.`;
                          })
                        }
                      >
                        {busy === `close-${p.coin}` ? "Closing…" : "Close it"}
                      </button>
                    </li>
                  );
                })}
            </ul>
            <p className="fine">A chip stays open until you close it. The result so far moves with the price and is re-read every five seconds.</p>
          </section>
        )}
      </main>
    </div>
  );
}
