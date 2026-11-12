import { useState } from "react";
import "./pages.css";
import "./people.css";
import { signIn, toE6, useDoing, useMe, useSession } from "../chain/session";
import { getChain, useDesk } from "../chain/store";
import type { Launch, LaunchInfo } from "../chain/types";
import { Intern } from "../cast/Intern";
import { amount, pct, shortAccount, usd } from "../lib/format";
import { day } from "../lib/nav";
import { useAsync } from "../lib/useAsync";
import { TopBar } from "../ui/TopBar";
import { Waiting } from "../ui/Waiting";

/** Dollars per whole token right now, from the curve: (virtual + raised) / (supply - sold). */
function priceOf(l: Launch, info: LaunchInfo): number {
  const usdc = Number(BigInt(info.virtual_usdc) + BigInt(l.usdc_reserve));
  const left = Number(BigInt(info.supply) - BigInt(l.sold));
  return left === 0 ? 0 : usdc / left;
}
const tiny = (n: number) => (n === 0 ? "$0" : `$${n.toFixed(Math.max(2, 3 - Math.floor(Math.log10(n))))}`);
/** Accept 2% less than the quote before calling the trade off. */
const withSlack = (out: string) => ((BigInt(out) * 98n) / 100n).toString();

function Trade({ l, bump }: { l: Launch; bump: () => void }) {
  const session = useSession();
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [text, setText] = useState("10");
  const [n, setN] = useState(0);
  const { me, reload } = useMe(session.accountId, session.actions, n);
  const doing = useDoing(() => {
    setN((x) => x + 1);
    reload();
    bump();
  });
  const v = toE6(text);
  const held = useAsync(async () => (session.accountId ? getChain().getLaunchBalance(l.id, session.accountId) : "0"), `held-${l.id}-${session.accountId}-${n}`);
  const q = useAsync(async () => (v ? getChain().getLaunchQuote(l.id, side, v) : null), `q-${l.id}-${side}-${v}-${n}`);
  const actions = session.actions;
  const tooMuch = v !== null && (side === "BUY" ? me !== null && BigInt(v) > BigInt(me.dollars) : BigInt(v) > BigInt(held.data ?? "0"));

  return (
    <section className="card money-form" aria-label={`Trade ${l.symbol}`}>
      <h3>
        Trade {l.symbol} <span className="pencil">· {l.name}</span>
      </h3>
      <div className="pool-pick" role="group" aria-label="Buy or sell">
        <button className="pick pick-brave" aria-pressed={side === "BUY"} onClick={() => setSide("BUY")}>
          Buy
        </button>
        <button className="pick pick-safe" aria-pressed={side === "SELL"} onClick={() => setSide("SELL")}>
          Sell
        </button>
      </div>
      <label htmlFor={`amt-${l.id}`}>{side === "BUY" ? "Test dollars to spend" : `${l.symbol} to sell`}</label>
      <input id={`amt-${l.id}`} inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} />
      <p className="fine">
        {session.accountId ? `You hold ${amount(held.data ?? "0")} ${l.symbol}${me ? ` and ${usd(me.dollars)} in your wallet` : ""}. ` : ""}
        {tooMuch
          ? "That's more than you have."
          : q.data
            ? side === "BUY"
              ? `You'd get about ${amount(q.data.out)} ${l.symbol}. Fee to the BRAVE pool: ${usd(q.data.fee)}.`
              : `You'd get about ${usd(q.data.out)}. Fee to the BRAVE pool: ${usd(q.data.fee)}.`
            : "Enter an amount to see a quote."}
      </p>
      {actions ? (
        <button
          className="btn btn-wide"
          disabled={!v || !q.data || tooMuch || !!doing.busy}
          onClick={() =>
            v &&
            q.data &&
            doing.run(
              "trade",
              () => (side === "BUY" ? actions.buyLaunch(l.id, v, withSlack(q.data!.out)) : actions.sellLaunch(l.id, v, withSlack(q.data!.out))),
              side === "BUY" ? `Bought ${l.symbol}.` : `Sold ${l.symbol}.`,
            )
          }
        >
          {doing.busy === "trade" ? "Trading…" : side === "BUY" ? `Buy ${l.symbol}${v ? ` with ${usd(v)}` : ""}` : `Sell ${v ? text : ""} ${l.symbol}`}
        </button>
      ) : (
        <button className="btn" onClick={signIn}>
          {session.pretend ? "Clock in with a pretend account" : "Clock in with a NEAR wallet"} to trade
        </button>
      )}
      {(doing.error || doing.done) && (
        <p className={`notice ${doing.error ? "notice-bad" : "notice-ok"}`} role={doing.error ? "alert" : "status"}>
          {doing.error ?? doing.done}
        </p>
      )}
    </section>
  );
}

/** The launchpad: anyone can launch a memecoin; each trade pays a small fee into the BRAVE pool. */
export function LaunchPage() {
  const snap = useDesk();
  const session = useSession();
  const { desk } = snap;
  const [bump, setBump] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const doing = useDoing(() => setBump((b) => b + 1));
  const data = useAsync(async () => {
    const chain = getChain();
    const [launches, info] = await Promise.all([chain.getLaunches(), chain.getLaunchInfo()]);
    return { launches, info };
  }, `launches-${bump}`);

  if (!desk) {
    return (
      <div className="home">
        <TopBar source={snap.source} scene={snap.scene} />
        <Waiting error={snap.error} line="Rolling out the launchpad…" />
      </div>
    );
  }
  const launches = data.data?.launches ?? [];
  const info = data.data?.info;
  const open = launches.find((l) => l.id === picked) ?? launches[0];
  const actions = session.actions;
  const sym = symbol.trim().toUpperCase();
  const okLaunch = name.trim().length >= 2 && /^[A-Z0-9]{2,8}$/.test(sym);

  return (
    <div className="home">
      <TopBar source={snap.source} scene={snap.scene} />
      <main id="main" className="people-page">
        <header className="people-head">
          <Intern mood="happy" rank={desk.rank.rank} size={190} />
          <div>
            <h1>Launch with the Intern</h1>
            <p>
              Launch your own memecoin here. Anyone can buy and sell it against a price curve, and {info ? pct(info.fee_bps) : "a small share"} of every trade goes to
              the BRAVE pool.
            </p>
            <p className="warn">
              The Intern never buys a launched coin with pool money. A coin being listed here is not advice. New memecoins usually go to zero. Test network: these are
              test dollars.
            </p>
          </div>
        </header>

        {(doing.error || doing.done) && (
          <p className={`notice ${doing.error ? "notice-bad" : "notice-ok"}`} role={doing.error ? "alert" : "status"}>
            {doing.error ?? doing.done}
          </p>
        )}

        {info && (
          <dl className="balances launch-stats">
            <div className="bal-wallet">
              <dt>Coins launched</dt>
              <dd>{info.launches}</dd>
            </div>
            <div className="bal-brave">
              <dt>Fees sent to the BRAVE pool</dt>
              <dd>{usd(info.fees_sent)}</dd>
            </div>
          </dl>
        )}

        <section aria-labelledby="list-h">
          <h2 id="list-h">Launched here</h2>
          {data.loading && !data.data ? (
            <p className="pencil">Looking…</p>
          ) : data.error ? (
            <p role="alert">Couldn't reach the launchpad. {data.error}</p>
          ) : launches.length === 0 || !info ? (
            <p className="people-empty">Nothing has been launched yet. Be the first, below.</p>
          ) : (
            <div className="launch-grid">
              <ul className="launches">
                {launches.map((l) => (
                  <li key={l.id}>
                    <button className={`launch${open?.id === l.id ? " is-open" : ""}`} aria-pressed={open?.id === l.id} onClick={() => setPicked(l.id)}>
                      <span className="launch-sym">{l.symbol}</span>
                      <span className="launch-name">
                        {l.name}
                        <span className="pencil">
                          by {shortAccount(l.creator, 22)} · {day(l.created_at)}
                        </span>
                      </span>
                      <span className="launch-nums mono">
                        <span>{tiny(priceOf(l, info))} each</span>
                        <span>{usd(l.usdc_reserve)} put in</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {open && <Trade key={open.id} l={open} bump={() => setBump((b) => b + 1)} />}
            </div>
          )}
        </section>

        <section className="card money-form" aria-labelledby="new-h">
          <h2 id="new-h">Launch a coin</h2>
          <div className="launch-form">
            <div>
              <label htmlFor="l-name">Name</label>
              <input id="l-name" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} placeholder="Shredder Coin" />
            </div>
            <div>
              <label htmlFor="l-sym">Symbol</label>
              <input id="l-sym" value={symbol} maxLength={8} onChange={(e) => setSymbol(e.target.value)} placeholder="SHRED" />
            </div>
          </div>
          <p className="fine">
            A billion coins, all sold along the same curve; you get none for free. The first time you use the launchpad it asks for a one-time registration of 0.05
            test NEAR.
          </p>
          {actions ? (
            <button className="btn btn-wide" disabled={!okLaunch || !!doing.busy} onClick={() => doing.run("launch", () => actions.launch(name.trim(), sym), `${sym} is launched.`)}>
              {doing.busy === "launch" ? "Launching…" : okLaunch ? `Launch ${sym}` : "Give it a name and a 2 to 8 letter symbol"}
            </button>
          ) : (
            <button className="btn" onClick={signIn}>
              {session.pretend ? "Clock in with a pretend account" : "Clock in with a NEAR wallet"} to launch
            </button>
          )}
        </section>
      </main>
    </div>
  );
}
