import { useState } from "react";
import "./pages.css";
import "./people.css";
import { signIn, useDoing, useSession } from "../chain/session";
import { getChain, useDesk } from "../chain/store";
import type { Playbook } from "../chain/types";
import { Intern } from "../cast/Intern";
import { pct, shortAccount, usd } from "../lib/format";
import { href } from "../lib/nav";
import { useAsync } from "../lib/useAsync";
import { TopBar } from "../ui/TopBar";
import { Waiting } from "../ui/Waiting";

const MAX_BYTES = 2000;

function Authors({ p }: { p: Playbook }) {
  return (
    <p className="pb-authors">
      Coached by{" "}
      {p.authors.map((a, i) => (
        <span key={a.account_id}>
          {i > 0 && ", "}
          {shortAccount(a.account_id, 24)}
          {p.authors.length > 1 && <span className="pencil"> ({pct(a.share_bps)})</span>}
        </span>
      ))}
    </p>
  );
}

/** Playbooks: written instructions for the Intern. Bosses vote on which one it follows; its coaches earn a cut of winning shifts. */
export function CoachPage() {
  const snap = useDesk();
  const session = useSession();
  const { desk } = snap;
  const [bump, setBump] = useState(0);
  const doing = useDoing(() => setBump((b) => b + 1));
  const [text, setText] = useState("");
  const seq = desk?.feed[desk.feed.length - 1]?.seq ?? 0;
  const books = useAsync(async () => {
    const chain = getChain();
    const [all, active] = await Promise.all([chain.getPlaybooks(undefined, 50), chain.getActivePlaybook()]);
    return { all, active };
  }, `books-${seq}-${bump}`);

  if (!desk) {
    return (
      <div className="home">
        <TopBar source={snap.source} scene={snap.scene} />
        <Waiting error={snap.error} line="Fetching the binder of playbooks…" />
      </div>
    );
  }
  const cut = desk.constants.coach_cut_bps;
  const active = books.data?.active ?? null;
  const filed = (books.data?.all ?? []).filter((p) => p.id !== active?.id);
  const openVote = desk.votes.find((v) => v.state === "OPEN" && v.kind === "SET_PLAYBOOK");
  const bytes = new TextEncoder().encode(text.trim()).length;
  const actions = session.actions;
  const propose = (id: number) => actions && doing.run(`vote-${id}`, () => actions.openVote("SET_PLAYBOOK", id), id === 0 ? "A vote to clear the playbook is open." : `A vote to put playbook ${id} on the desk is open.`);

  return (
    <div className="home">
      <TopBar source={snap.source} scene={snap.scene} />
      <main id="main" className="people-page">
        <header className="people-head">
          <Intern mood="thinking" rank={desk.rank.rank} size={190} />
          <div>
            <h1>Playbooks</h1>
            <p>
              A playbook is a short set of instructions for the Intern. Anyone can write one. The bosses vote on which one it follows, and when a shift using it ends
              in profit, its coaches get {pct(cut)} of that profit.
            </p>
            <p className="warn">A playbook can steer what the Intern picks inside its rank. It can never lift a limit: the stamp still checks every bet.</p>
          </div>
        </header>

        {(doing.error || doing.done) && (
          <p className={`notice ${doing.error ? "notice-bad" : "notice-ok"}`} role={doing.error ? "alert" : "status"}>
            {doing.error ?? doing.done}
          </p>
        )}

        <section aria-labelledby="desk-h">
          <h2 id="desk-h">On the desk</h2>
          {books.loading && !books.data ? (
            <p className="pencil">Looking…</p>
          ) : active ? (
            <article className="card pb pb-active">
              <p className="pb-text">“{active.text}”</p>
              <Authors p={active} />
              <p className="mono pencil">
                PLAYBOOK No. {active.id} · ON THE DESK SINCE SHIFT {active.active_from ?? "?"} · COACHES PAID {usd(active.paid_total)}
              </p>
              {actions && (
                <button className="btn btn-quiet" disabled={!!doing.busy || !!openVote} onClick={() => propose(0)}>
                  {openVote ? "A playbook vote is already open" : "Open a vote to take it off the desk"}
                </button>
              )}
            </article>
          ) : (
            <p className="people-empty">No playbook is on the desk. The Intern is working from its own judgement.</p>
          )}
          {openVote && (
            <p className="fine">
              A vote is open to {openVote.playbook_id ? `put playbook ${openVote.playbook_id} on the desk` : "clear the playbook"}. <a href={href("vote")}>Go and vote</a>
            </p>
          )}
        </section>

        <section aria-labelledby="filed-h">
          <h2 id="filed-h">Filed</h2>
          {filed.length === 0 ? (
            <p className="people-empty">Nothing else is filed. Write the first one below.</p>
          ) : (
            <div className="vote-list">
              {filed.map((p) => (
                <article key={p.id} className="card pb">
                  <p className="pb-text">“{p.text}”</p>
                  <Authors p={p} />
                  <p className="mono pencil">
                    PLAYBOOK No. {p.id} · FILED IN SHIFT {p.submitted_round}
                    {p.active_from ? ` · WAS ON THE DESK FROM SHIFT ${p.active_from}` : ""}
                    {BigInt(p.paid_total) > 0n ? ` · COACHES PAID ${usd(p.paid_total)}` : ""}
                  </p>
                  {actions ? (
                    <button className="btn" disabled={!!doing.busy || !!openVote} onClick={() => propose(p.id)}>
                      {doing.busy === `vote-${p.id}` ? "Opening…" : openVote ? "A playbook vote is already open" : "Open a vote to put this on the desk"}
                    </button>
                  ) : null}
                </article>
              ))}
            </div>
          )}
          <p className="fine">A playbook vote passes like a promotion: more than half of the votes and 20% turnout. It takes effect two shifts after it passes.</p>
        </section>

        <section className="card money-form" aria-labelledby="write-h">
          <h2 id="write-h">Write one</h2>
          <label htmlFor="pb-text">What should the Intern do?</label>
          <textarea
            id="pb-text"
            rows={4}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="For example: Prefer DOGE. Sit out a shift after a loss. Never bet in the last hour before close."
            aria-describedby="pb-note"
          />
          <ul className="cannot">
            <li>It cannot raise how much the Intern may bet.</li>
            <li>It cannot add a coin that isn't on the rank's list.</li>
            <li>It cannot unlock leverage or betting on a fall.</li>
          </ul>
          <p id="pb-note" className="fine">
            {bytes} of {MAX_BYTES} bytes. Line breaks become spaces. Filing costs about 0.05 test NEAR for storage; what isn't used comes back. You are its coach, with
            the whole cut.
          </p>
          {actions ? (
            <button
              className="btn btn-wide"
              disabled={bytes < 1 || bytes > MAX_BYTES || !!doing.busy}
              onClick={() => doing.run("file", () => actions.submitPlaybook(text.trim()), "Playbook filed. Now it needs a vote.").then(() => setText(""))}
            >
              {doing.busy === "file" ? "Filing…" : bytes > MAX_BYTES ? "Too long" : "File this playbook"}
            </button>
          ) : (
            <button className="btn" onClick={signIn}>
              {session.pretend ? "Clock in with a pretend account" : "Clock in with a NEAR wallet"} to file it
            </button>
          )}
        </section>
      </main>
    </div>
  );
}
