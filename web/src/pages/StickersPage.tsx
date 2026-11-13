import { useState } from "react";
import "./pages.css";
import "./people.css";
import "./v17-mine.css";
import deployments from "../../../interface/deployments.json";
import { signIn, useDoing, useSession } from "../chain/session";
import { getChain, getSource, useDesk } from "../chain/store";
import type { RefusalCode, StickerHl, StickerHlSigned } from "../chain/types";
import { shortAccount, signedUsd, titleCase, usd, when } from "../lib/format";
import { href } from "../lib/nav";
import { useAsync } from "../lib/useAsync";
import { useNow } from "../lib/useNow";
import { account as hlAccount, exchange } from "../tailfade/hl.ts";
import { addressFromDerivedKey, SIGNER, viewFunction } from "../tailfade/mpc.ts";
import { TopBar } from "../ui/TopBar";
import { Waiting } from "../ui/Waiting";
import { Notice } from "../ui/Notice";

const ADDRESS = /^0x[0-9a-f]{40}$/;
const KIND_WORD: Record<string, string> = { approveAgent: "Trading-key approval", APPROVE_AGENT: "Trading-key approval", usdSend: "Withdrawal", USD_SEND: "Withdrawal" };

type Original = { code: RefusalCode; creditedTo: string; claimed: boolean; holder: string | null; address: string | null; worth: number | null; hl: StickerHl };

/**
 * NFTs that do something (interface 1.7, sections 9.12 and 9.17): the career card, what stickers have earned,
 * playbook NFTs, and the Hyperliquid account each "first of its kind" original has.
 */
export function StickersPage() {
  const snap = useDesk();
  const now = useNow();
  const session = useSession();
  const { desk } = snap;
  const [bump, setBump] = useState(0);
  const doing = useDoing(() => setBump((b) => b + 1));
  const seq = desk?.feed[desk.feed.length - 1]?.seq ?? 0;
  const me = session.accountId;
  const actions = session.actions;
  const sample = snap.source === "sample";
  const fast = !!getSource().contractId?.startsWith("coin-fast");
  const [cardNo, setCardNo] = useState("");
  const [sent, setSent] = useState<Record<string, string>>({});

  const career = useAsync(() => getChain().getCareer(), `career-${desk?.round.id ?? 0}-${bump}`);
  const earn = useAsync(async () => {
    const chain = getChain();
    const e = await chain.getNftEarnings();
    const holders = await Promise.all(e.tokens.map((t) => chain.getTokenOwner(t.token_id).catch(() => null)));
    return { e, holders };
  }, `earn-${seq}-${bump}`);
  const mine = useAsync(async () => {
    if (!me) return null;
    const chain = getChain();
    const [owned, playbooks] = await Promise.all([chain.getOwned(me), chain.getPlaybooks(undefined, 50)]);
    const authored = playbooks.filter((p) => p.authors.some((a) => a.account_id === me));
    const minted = await Promise.all(authored.map((p) => chain.getTokenOwner(`playbook:${p.id}`).catch(() => null)));
    return { owned, authored: authored.map((p, i) => ({ p, holder: minted[i] ?? null })) };
  }, `stk-mine-${me}-${seq}-${bump}`);
  const firsts = desk?.firsts;
  const originals = useAsync<Original[]>(async () => {
    const chain = getChain();
    const coin = getSource().contractId ?? deployments.testnet.coin;
    const credited = (firsts ?? []).filter((f) => f.account_id !== null);
    return Promise.all(
      credited.map(async (f) => {
        const [hl, holder] = await Promise.all([chain.getStickerHl(f.code), f.claimed ? chain.getTokenOwner(`original:${f.code}`).catch(() => null) : Promise.resolve(null)]);
        // Sample data never talks to a network: the address there is made up and says so
        let address: string | null = null;
        let worth: number | null = null;
        if (!sample) {
          try {
            address = addressFromDerivedKey(String(await viewFunction("derived_public_key", { path: hl.path, predecessor: coin, domain_id: 0 }, SIGNER, deployments.testnet.rpc)));
            worth = (await hlAccount(address)).accountValue;
          } catch {
            /* shown as unknown */
          }
        }
        return { code: f.code, creditedTo: f.account_id!, claimed: f.claimed, holder, address, worth, hl };
      }),
    );
  }, `originals-${seq}-${bump}-${firsts?.filter((f) => f.claimed).length ?? 0}`);

  if (!desk) {
    return (
      <div className="home">
        <TopBar source={snap.source} scene={snap.scene} />
        <Waiting error={snap.error} line="Opening the sticker book…" />
      </div>
    );
  }

  const c = career.data;
  const myCards = (mine.data?.owned ?? []).filter((t) => t.token_id.startsWith("career:"));
  const owns = (tokenId: string) => (mine.data?.owned ?? []).some((t) => t.token_id === tokenId);
  const clockIn = session.canSignIn && !me && (
    <button className="btn" onClick={signIn}>
      {session.pretend ? "Clock in with a pretend account" : "Clock in with a NEAR wallet"}
    </button>
  );

  async function deliver(s: StickerHlSigned) {
    const key = `${s.code}-${s.nonce}`;
    if (sample) return setSent((m) => ({ ...m, [key]: "Sample data: nothing was sent to Hyperliquid." }));
    setSent((m) => ({ ...m, [key]: "Sending…" }));
    try {
      const reply = await exchange(s.action as Parameters<typeof exchange>[0], s.nonce, { r: s.r, s: s.s, v: s.v }, { l1: false });
      setSent((m) => ({ ...m, [key]: reply.status === "ok" ? "Hyperliquid accepted it." : `Hyperliquid said no: ${typeof reply.response === "string" ? reply.response : JSON.stringify(reply.response)}` }));
    } catch (e) {
      setSent((m) => ({ ...m, [key]: `Couldn't reach Hyperliquid. Nothing was sent. ${e instanceof Error ? e.message : String(e)}` }));
    }
  }

  return (
    <div className="home">
      <TopBar source={snap.source} scene={snap.scene} />
      <main id="main" className="people-page">
        <header className="people-head">
          <div>
            <h1>Stickers and cards</h1>
            <p>
              Some of the Intern's stickers do something. The originals earn from paid tricks and each has a betting account of its own. A playbook's sticker carries its
              coach cut. A career card shows the Intern's record, drawn by the program.
            </p>
            <p className="fine">Test network. What a sticker earns is test dollars. To claim stickers, go to <a href={href("goals")}>Goals</a> and <a href={href("rewards")}>Rewards</a>.</p>
          </div>
        </header>

        {(doing.error || doing.done) && (
          <Notice error={doing.error} done={doing.done} onClose={doing.clear} />
        )}

        {c && (
          <section className="card" aria-labelledby="career-h">
            <h2 id="career-h">The career card</h2>
            <div className="card-art">
              <img src={c.svg} alt={`The Intern's career card: ${titleCase(c.rank)}, ${c.status === "FIRED" ? "fired" : "employed"}, level ${c.level}`} width={300} height={300} />
              <div>
                <p>
                  The program draws this picture itself from the Intern's record: <strong>{titleCase(c.rank)}</strong>, {c.status === "FIRED" ? "fired" : "employed"}, level{" "}
                  <span className="mono">{c.level}</span> (one level per whole week of 7 shifts), <span className="mono">{c.rounds}</span> shifts,{" "}
                  <span className="mono">{c.bets}</span> bets, <span className="mono">{c.refusals}</span> refusals, <span className="mono">{signedUsd(c.result)}</span> so far.
                </p>
                <p>Anyone can mint a copy as an NFT. A minted card keeps the record of the day it was drawn until someone redraws it.</p>
                {actions ? (
                  <>
                    <button className="btn" disabled={!!doing.busy} onClick={() => doing.run("mint-card", () => actions.mintCareerCard(), "Your career card is minted.")}>
                      {doing.busy === "mint-card" ? "Minting…" : "Mint a career card"}
                    </button>
                    <p className="fine">Attaches 0.02 test NEAR for storage. The card can be given away or sold like any NFT. It earns nothing.</p>
                    <div className="stk-act">
                      <input aria-label="Card number to redraw" inputMode="numeric" placeholder={myCards[0] ? myCards[0].token_id.slice(7) : "Card number"} value={cardNo} onChange={(e) => setCardNo(e.target.value)} />
                      <button
                        className="btn btn-quiet"
                        disabled={!!doing.busy || !/^\d+$/.test(cardNo || myCards[0]?.token_id.slice(7) || "")}
                        onClick={() => {
                          const n = Number(cardNo || myCards[0]?.token_id.slice(7));
                          void doing.run("redraw", () => actions.refreshCareerCard(n), `Card ${n} now shows today's record.`);
                        }}
                      >
                        {doing.busy === "redraw" ? "Redrawing…" : "Redraw"}
                      </button>
                    </div>
                    <p className="fine">
                      Redrawing brings any card up to today's record. Anyone may redraw any card.
                      {myCards.length > 0 && ` You hold ${myCards.map((t) => `card ${t.token_id.slice(7)}`).join(", ")}.`}
                    </p>
                  </>
                ) : (
                  clockIn || <p className="fine">Clock in to mint one.</p>
                )}
              </div>
            </div>
            {sample && <p className="fine">Sample data: this picture is a stand-in, not drawn by the program.</p>}
          </section>
        )}

        {earn.data && (
          <section className="card" aria-labelledby="earn-h">
            <h2 id="earn-h">What stickers have earned</h2>
            <p>
              A quarter of every paid trick is shared equally by the claimed originals. A playbook's NFT collects that playbook's coach cut (10% of a winning shift while it
              is on the desk). The money waits in the program until the sticker's holder collects it.
            </p>
            <dl className="stk-facts">
              <div>
                <dt>Waiting to be collected</dt>
                <dd className="mono">{usd(earn.data.e.owed_total)}</dd>
              </div>
              <div>
                <dt>Collected so far</dt>
                <dd className="mono">{usd(earn.data.e.paid_total)}</dd>
              </div>
              <div>
                <dt>Career cards minted</dt>
                <dd className="mono">{earn.data.e.careers_minted}</dd>
              </div>
            </dl>
            {earn.data.e.tokens.length === 0 ? (
              <p className="pencil">No sticker has anything waiting right now.{BigInt(earn.data.e.paid_total) === 0n ? " Nothing has been earned yet: no paid trick has come in since this was added." : ""}</p>
            ) : (
              <ul className="stk-list">
                {earn.data.e.tokens.map((t, i) => {
                  const holder = earn.data!.holders[i];
                  const isMine = !!me && holder === me;
                  return (
                    <li key={t.token_id}>
                      <div className="stk-head">
                        <strong className="mono">{t.token_id}</strong>
                        <span className="mono">{usd(t.owed)} waiting</span>
                      </div>
                      <p className="fine">{holder ? `Held by ${isMine ? "you" : shortAccount(holder)}.` : "Its sticker has not been claimed yet, so nobody can collect this yet."}</p>
                      {isMine && actions && (
                        <button className="btn" disabled={!!doing.busy} onClick={() => doing.run(`earn-${t.token_id}`, () => actions.claimNftEarnings(t.token_id), `${usd(t.owed)} is now a prize of yours. Collect it on the Rewards page.`)}>
                          {doing.busy === `earn-${t.token_id}` ? "Collecting…" : `Collect ${usd(t.owed)}`}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="fine">
              Collecting turns the amount into a prize; <a href={href("rewards")}>“Collect my prizes” on the Rewards page</a> then pays it out. Only the holder can collect:
              the program asks the sticker contract who holds the token.
            </p>
          </section>
        )}

        {me && mine.data && mine.data.authored.length > 0 && (
          <section className="card" aria-labelledby="pbn-h">
            <h2 id="pbn-h">Your playbooks as NFTs</h2>
            <p>
              You can mint an NFT for a playbook you wrote. <strong>From then on, that playbook's coach cut goes to whoever holds the NFT, not to the authors.</strong> Give
              it away or sell it and the cut goes with it. Once per playbook; it cannot be undone.
            </p>
            <ul className="stk-list">
              {mine.data.authored.map(({ p, holder }) => (
                <li key={p.id}>
                  <div className="stk-head">
                    <strong>Playbook {p.id}</strong>
                    <span className="mono">{usd(p.paid_total)} paid to its coaches so far</span>
                  </div>
                  {holder ? (
                    <p className="fine">Its NFT is minted and held by {holder === me ? "you" : shortAccount(holder)}.</p>
                  ) : (
                    actions && (
                      <button className="btn" disabled={!!doing.busy} onClick={() => doing.run(`pb-${p.id}`, () => actions.claimPlaybookNft(p.id), `Playbook ${p.id}'s NFT is yours.`)}>
                        {doing.busy === `pb-${p.id}` ? "Minting…" : "Mint this playbook's NFT"}
                      </button>
                    )
                  )}
                </li>
              ))}
            </ul>
            <p className="fine">Attaches 0.02 test NEAR for storage.</p>
          </section>
        )}

        <section className="card" aria-labelledby="hl-h">
          <h2 id="hl-h">The originals' betting accounts</h2>
          <p>
            Each “first of its kind” original has its own account on Hyperliquid's test network. Only the program can sign for it, and it signs only for whoever holds the
            sticker: to approve a trading key (which can place and close bets, never withdraw) or to withdraw.
          </p>
          <p className="warn">
            {fast ? (
              <>
                <strong>This is our test copy.</strong> Its <span className="mono">original:NOT_ON_LIST</span>, held by boss2.desk-lab-2026.testnet, is the real example: its
                account <span className="mono">0x8b63deeb42c2a81beb09386c64273aff3847b032</span> was funded with $4 of test dollars and has an approved trading key.
              </>
            ) : (
              <>
                <strong>No original has been claimed on the live coin yet,</strong> so none of its accounts is in use. A real example is on our test copy: its{" "}
                <span className="mono">original:NOT_ON_LIST</span> has an account funded with $4 of test dollars and an approved trading key.{" "}
                {!sample && <a href={`${href("stickers")}&contract=coin-fast.desk-lab-2026.testnet`}>See it on the test copy</a>}
              </>
            )}{" "}
            An account holds $0 until someone sends it test dollars. Anyone may.
          </p>
          {originals.loading && !originals.data ? (
            <p className="pencil">Looking up the originals…</p>
          ) : !originals.data ? (
            <p className="pencil">Couldn't read the originals' accounts{originals.error ? `. ${originals.error}` : "."}</p>
          ) : originals.data.length === 0 ? (
            <p className="pencil">No original has been earned yet. The first credited refusal of each kind earns one: <a href={href("trick")}>try to trick the Intern</a>.</p>
          ) : (
            <ul className="stk-list">
              {originals.data.map((o) => (
                <OriginalRow key={o.code} o={o} mine={o.claimed && (o.holder === me || owns(`original:${o.code}`))} sample={sample} now={now} doing={doing} actions={actions} sent={sent} deliver={deliver} />
              ))}
            </ul>
          )}
          {!me && clockIn}
          <p className="fine">
            The address is worked out from the program's account and the path <span className="mono">sticker-&lt;CODE&gt;</span> by NEAR's signing network, the same way as
            Tail or Fade's. After the program signs, the signed action is kept here for the holder to hand to Hyperliquid. Selling the sticker hands over the account: the
            next holder's approval replaces the old key.
          </p>
        </section>
      </main>
    </div>
  );
}

function OriginalRow({ o, mine, sample, now, doing, actions, sent, deliver }: {
  o: Original; mine: boolean; sample: boolean; now: number;
  doing: ReturnType<typeof useDoing>; actions: ReturnType<typeof useSession>["actions"];
  sent: Record<string, string>; deliver: (s: StickerHlSigned) => Promise<void>;
}) {
  const [agent, setAgent] = useState("");
  const [dest, setDest] = useState("");
  const [amt, setAmt] = useState("");
  const a = agent.trim().toLowerCase();
  const d = dest.trim().toLowerCase();
  return (
    <li>
      <div className="stk-head">
        <strong className="mono">original:{o.code}</strong>
        <span>{o.claimed ? `Held by ${mine ? "you" : o.holder ? shortAccount(o.holder) : "its claimer"}` : `Earned by ${shortAccount(o.creditedTo)}, not claimed yet`}</span>
      </div>
      <dl className="stk-facts">
        <div>
          <dt>Hyperliquid address</dt>
          <dd className="mono" title={o.address ?? undefined}>
            {sample ? "0x5a3b…made-up (sample data)" : o.address ? `${o.address.slice(0, 10)}…${o.address.slice(-6)}` : "couldn't be worked out just now"}
          </dd>
        </div>
        <div>
          <dt>Worth on Hyperliquid's test network</dt>
          <dd className="mono">{sample ? "$0.00 (sample)" : o.worth === null ? "unknown" : `$${o.worth.toFixed(2)}`}</dd>
        </div>
        <div>
          <dt>Signed by the program so far</dt>
          <dd className="mono">{o.hl.signed.length}</dd>
        </div>
      </dl>
      {o.hl.signed.length > 0 && (
        <ol className="stk-signed">
          {o.hl.signed.map((s) => {
            const key = `${s.code}-${s.nonce}`;
            return (
              <li key={key}>
                {KIND_WORD[s.kind] ?? s.kind}, signed {when(s.at, now)} for {shortAccount(s.for_account)}.{" "}
                {mine && (
                  <button className="btn btn-quiet" onClick={() => void deliver(s)}>
                    Send to Hyperliquid
                  </button>
                )}{" "}
                {sent[key] && <span role="status">{sent[key]}</span>}
                <details>
                  <summary>See what was signed</summary>
                  <pre className="mono">{JSON.stringify(s.action, null, 1)}</pre>
                </details>
              </li>
            );
          })}
        </ol>
      )}
      {mine && actions && (
        <>
          <div className="stk-act">
            <input aria-label="Trading key address" placeholder="Trading key: 0x and 40 hex characters" value={agent} onChange={(e) => setAgent(e.target.value)} />
            <button className="btn" disabled={!!doing.busy || !ADDRESS.test(a)} onClick={() => doing.run(`hl-a-${o.code}`, () => actions.stickerHlApprove(o.code, a), "Signed. Press “Send to Hyperliquid” on the new line to hand it over.")}>
              {doing.busy === `hl-a-${o.code}` ? "Waiting for your wallet…" : "Approve a trading key"}
            </button>
          </div>
          <div className="stk-act">
            <input aria-label="Withdraw to address" placeholder="Withdraw to: 0x and 40 hex characters" value={dest} onChange={(e) => setDest(e.target.value)} />
            <input aria-label="Amount in dollars" inputMode="decimal" placeholder="Dollars" value={amt} onChange={(e) => setAmt(e.target.value)} />
            <button className="btn" disabled={!!doing.busy || !ADDRESS.test(d) || !/^\d+(\.\d{1,6})?$/.test(amt.trim())} onClick={() => doing.run(`hl-w-${o.code}`, () => actions.stickerHlWithdraw(o.code, d, amt.trim()), "Signed. Press “Send to Hyperliquid” on the new line to hand it over.")}>
              {doing.busy === `hl-w-${o.code}` ? "Waiting for your wallet…" : "Withdraw"}
            </button>
          </div>
          <p className="fine">
            Each is one wallet popup with 1 yoctoNEAR; the program then asks NEAR's signing network to sign, which takes about ten seconds. A trading key can never
            withdraw. A withdrawal from an account holding $0 will be refused by Hyperliquid.
          </p>
        </>
      )}
    </li>
  );
}
