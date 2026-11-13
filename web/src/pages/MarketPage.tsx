import { useState } from "react";
import deployments from "../../../interface/deployments.json";
import "./pages.css";
import "./people.css";
import "./live.css";
import "./v17-rewards.css";
import { Tin } from "../cast/Tin";
import { signIn, toE6, useDoing, useMe, useSession } from "../chain/session";
import { getChain, useDesk } from "../chain/store";
import { REFUSAL_CODES, type Listing } from "../chain/types";
import { usd } from "../lib/format";
import { href } from "../lib/nav";
import { useAsync } from "../lib/useAsync";
import { Who } from "../ui/BotTag";
import { TopBar } from "../ui/TopBar";
import { Waiting } from "../ui/Waiting";
import { Notice } from "../ui/Notice";

const TICKETS = (deployments.testnet as { tickets?: string }).tickets ?? null;
const codeOf = (tokenId: string) => tokenId.replace(/^golden:/, "");
const whole = (text: string) => (/^[1-9]\d{0,8}$/.test(text.trim()) ? BigInt(text.trim()) : null);

/**
 * The sticker market (interface 1.7, section 9.16): golden stickers claimed as tradable units, listed and bought
 * between players on the tickets contract. Paid in test dollars, no fee. The program is never a buyer or a seller.
 */
export function MarketPage() {
  const snap = useDesk();
  const session = useSession();
  const { desk } = snap;
  const [bump, setBump] = useState(0);
  const seq = desk?.feed[desk.feed.length - 1]?.seq ?? 0;
  const { me, reload } = useMe(session.accountId, session.actions, seq);
  const doing = useDoing(() => {
    setBump((b) => b + 1);
    reload();
  });
  const listings = useAsync(() => getChain().getListings(), `listings-${bump}-${Math.floor(seq / 5)}`);
  const units = useAsync(async () => (session.accountId ? getChain().getGoldenUnits(session.accountId) : null), `units-${session.accountId}-${bump}`);
  const [want, setWant] = useState<Record<number, string>>({});
  const [sell, setSell] = useState<Record<string, { amount: string; price: string }>>({});

  if (!desk) {
    return (
      <div className="home">
        <TopBar source={snap.source} scene={snap.scene} />
        <Waiting error={snap.error} line="Opening the market…" />
      </div>
    );
  }

  const actions = session.actions;
  const sample = snap.source === "sample";
  const onLive = sample || desk.constants.stickers === deployments.testnet.stickers;
  const list = listings.data ?? [];
  const held = (units.data ?? []).map((n, i) => ({ code: REFUSAL_CODES[i]!, n: BigInt(n) })).filter((u) => u.n > 0n);
  const mine = list.filter((l) => l.seller === session.accountId);

  const buyRow = (l: Listing) => {
    const n = whole(want[l.id] ?? "1");
    const ok = n !== null && n <= BigInt(l.amount);
    const total = ok ? (n * BigInt(l.price_each)).toString() : null;
    const short = total !== null && me !== null && BigInt(total) > BigInt(me.dollars);
    const own = l.seller === session.accountId;
    return (
      <li key={l.id}>
        <div className="market-top">
          <img src={`/stickers/${codeOf(l.token_id).toLowerCase()}.webp`} alt="" width={64} height={64} loading="lazy" />
          <div>
            <strong>Golden {codeOf(l.token_id)}</strong>
            <span className="mono pencil">listing {l.id}</span>
            <span className="pencil">
              from <Who account={l.seller} max={20} />
            </span>
          </div>
        </div>
        <p className="market-price">
          {usd(l.price_each)} <span>each, {l.amount} for sale</span>
        </p>
        {own ? (
          <button className="btn btn-quiet" disabled={!!doing.busy} onClick={() => actions && doing.run(`unlist-${l.id}`, () => actions.unlistGolden(l.id), "Listing taken back. The units are yours again.")}>
            {doing.busy === `unlist-${l.id}` ? "Taking back…" : "Take my listing back"}
          </button>
        ) : actions ? (
          <>
            <div className="market-buy">
              {BigInt(l.amount) > 1n && (
                <>
                  <label htmlFor={`buy-${l.id}`} className="fine">
                    How many
                  </label>
                  <input id={`buy-${l.id}`} inputMode="numeric" value={want[l.id] ?? "1"} onChange={(e) => setWant({ ...want, [l.id]: e.target.value })} />
                </>
              )}
              <button
                className="btn"
                disabled={!ok || short || !!doing.busy}
                onClick={() => ok && total && doing.run(`buy-${l.id}`, () => actions.buyGolden(l.id, n.toString(), total), `Bought ${n} golden ${codeOf(l.token_id)} for ${usd(total)}.`)}
              >
                {doing.busy === `buy-${l.id}` ? "Buying…" : total ? `Buy for ${usd(total)}` : "Buy"}
              </button>
            </div>
            {!ok && <p className="fine">A whole number from 1 to {l.amount}.</p>}
            {short && <p className="fine">You have {usd(me!.dollars)} in your wallet.</p>}
          </>
        ) : (
          <button className="btn" onClick={signIn}>
            {session.pretend ? "Clock in to buy" : "Clock in with a NEAR wallet to buy"}
          </button>
        )}
      </li>
    );
  };

  return (
    <div className="home">
      <TopBar source={snap.source} scene={snap.scene} />
      <main id="main" className="people-page rewards-page">
        <header className="people-head">
          <Tin pose="coin" size={170} />
          <div>
            <h1>Sticker market</h1>
            <p>
              Golden stickers that were claimed as tradable units can be sold here, player to player, for test dollars. The seller sets the price. There is no fee, and the
              project is never the buyer or the seller.
            </p>
          </div>
        </header>

        {(doing.error || doing.done) && (
          <Notice error={doing.error} done={doing.done} onClose={doing.clear} />
        )}

        {!onLive ? (
          <p className="warn">This copy of the program has no sticker market. The market belongs to the live coin.</p>
        ) : (
          <>
            <section aria-labelledby="mk-h">
              <h2 id="mk-h">For sale</h2>
              {listings.error ? (
                <p className="pencil">Couldn't read the market. Nothing was sent. {listings.error}</p>
              ) : !listings.data ? (
                <p className="pencil">Looking…</p>
              ) : list.length === 0 ? (
                <p className="people-empty">Nothing has been listed on the market yet. A golden sticker has to be won by guessing, claimed as a tradable unit, and then listed by its owner.</p>
              ) : (
                <ul className="market-list">{list.map(buyRow)}</ul>
              )}
            </section>

            <section className="card money-form" aria-labelledby="my-h">
              <h2 id="my-h">Your golden units</h2>
              {!session.accountId ? (
                <>
                  <p className="pencil">Clock in to see the units you hold and to list them.</p>
                  <button className="btn" onClick={signIn}>
                    {session.pretend ? "Clock in with a pretend account" : "Clock in with a NEAR wallet"}
                  </button>
                </>
              ) : !units.data ? (
                <p className="pencil">{units.error ? `Couldn't read your units. ${units.error}` : "Checking…"}</p>
              ) : held.length === 0 ? (
                <p className="people-empty">
                  You hold no tradable golden units{mine.length > 0 ? " outside your listings" : ""}. Win a golden sticker by <a href={href("rewards")}>guessing</a>, then choose "Claim as a
                  tradable unit".
                </p>
              ) : (
                <ul className="market-mine">
                  {held.map((u) => {
                    const f = sell[u.code] ?? { amount: "1", price: "5" };
                    const n = whole(f.amount);
                    const price = toE6(f.price);
                    const ok = n !== null && n <= u.n && price !== null;
                    const set = (next: Partial<typeof f>) => setSell({ ...sell, [u.code]: { ...f, ...next } });
                    return (
                      <li key={u.code}>
                        <img src={`/stickers/${u.code.toLowerCase()}.webp`} alt="" width={48} height={48} loading="lazy" />
                        <span className="market-what">
                          <strong>Golden {u.code}</strong>
                          <br />
                          <span className="pencil">you hold {u.n.toString()}</span>
                        </span>
                        <label>
                          How many
                          <input inputMode="numeric" value={f.amount} onChange={(e) => set({ amount: e.target.value })} />
                        </label>
                        <label>
                          Price each, test dollars
                          <input inputMode="decimal" value={f.price} onChange={(e) => set({ price: e.target.value })} />
                        </label>
                        <button
                          className="btn"
                          disabled={!ok || !actions || !!doing.busy}
                          onClick={() => actions && ok && doing.run(`list-${u.code}`, () => actions.listGolden(`golden:${u.code}`, n.toString(), price), `Listed ${n} golden ${u.code} at ${usd(price)} each.`)}
                        >
                          {doing.busy === `list-${u.code}` ? "Listing…" : ok ? `List at ${usd(price)} each` : "List"}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              <p className="fine">
                Listing moves the units to the market's program until they sell or you take them back. To be paid, your account must be registered on the test-dollar
                token (it is, if you have ever held test dollars). If a purchase cannot go through, the buyer's dollars are sent back in full.
              </p>
            </section>

            <section aria-labelledby="how-h">
              <h2 id="how-h">What this is</h2>
              <ul className="plain-list">
                <li>
                  The units live on a separate program{TICKETS ? <>, <code className="mono">{TICKETS}</code></> : ""}, a "multi-token" contract (NEP-245). Only the coin can create units, and only when someone claims a
                  golden sticker they won.
                </li>
                <li>A golden sticker is claimed either as a one-off numbered sticker or as one tradable unit of its code. Only units can be listed here.</li>
                <li>Everything is on the test network and paid in test dollars. A sticker gives no right to any money and no say over the Intern.</li>
                <li>Not built: offers, auctions, and selling units through other marketplaces.</li>
              </ul>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
