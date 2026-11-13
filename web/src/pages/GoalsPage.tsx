import { useState } from "react";
import "./pages.css";
import "./people.css";
import { signIn, toE6, useDoing, useMe, useSession } from "../chain/session";
import { getChain, useDesk } from "../chain/store";
import type { GoalKind } from "../chain/types";
import { BossMug } from "../cast/BossMug";
import { Tin } from "../cast/Tin";
import { clock, share, usd } from "../lib/format";
import { day } from "../lib/nav";
import { useAsync } from "../lib/useAsync";
import { useNow } from "../lib/useNow";
import { TopBar } from "../ui/TopBar";
import { Waiting } from "../ui/Waiting";
import { Notice } from "../ui/Notice";

const GOAL_NAME: Record<GoalKind, string> = { BOSS: "Boss goal", TIP_JAR: "Tip jar", HYPE: "Hype train" };

function Bar({ value, label }: { value: number; label: string }) {
  return (
    <div className="goal-bar" role="img" aria-label={label}>
      <span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

/** The three bars the audience fills together, the tip jar, and what is waiting to be claimed. */
export function GoalsPage() {
  const snap = useDesk();
  const now = useNow();
  const session = useSession();
  const { desk } = snap;
  const [bump, setBump] = useState(0);
  const seq = desk?.feed[desk.feed.length - 1]?.seq ?? 0;
  const { me, reload } = useMe(session.accountId, session.actions, seq);
  const doing = useDoing(() => {
    setBump((b) => b + 1);
    reload();
  });
  const [tip, setTip] = useState("5");
  const data = useAsync(async () => {
    const chain = getChain();
    const [goals, fills] = await Promise.all([chain.getGoals(), chain.getGoalFills(undefined, 20)]);
    return { goals, fills };
  }, `goals-${seq}-${bump}`);
  const mine = useAsync(async () => {
    if (!session.accountId) return null;
    const chain = getChain();
    const [claimable, owned] = await Promise.all([chain.getClaimable(session.accountId), chain.getOwned(session.accountId)]);
    return { claimable, owned };
  }, `mine-${session.accountId}-${seq}-${bump}`);

  if (!desk) {
    return (
      <div className="home">
        <TopBar source={snap.source} scene={snap.scene} />
        <Waiting error={snap.error} line="Counting the tip jar…" />
      </div>
    );
  }
  const g = data.data?.goals;
  const c = desk.constants.goals;
  const actions = session.actions;
  const v = toE6(tip);
  const tooSmall = v !== null && BigInt(v) < BigInt(c.min_tip);
  const tooMuch = v !== null && me !== null && BigInt(v) > BigInt(me.dollars);
  const nextHype = g ? c.hype_levels[g.hype.level] : undefined;
  const nothing = mine.data && !mine.data.claimable.badge && mine.data.claimable.originals.length === 0 && mine.data.claimable.goal_fills.length === 0;

  return (
    <div className="home">
      <TopBar source={snap.source} scene={snap.scene} />
      <main id="main" className="people-page">
        <header className="people-head">
          <Tin pose="coin" size={170} />
          <div>
            <h1>Goals</h1>
            <p>Three bars that everyone fills together. When one fills, everybody who helped can claim a sticker. Filling a goal never changes what the Intern may bet.</p>
          </div>
        </header>

        {(doing.error || doing.done) && (
          <Notice error={doing.error} done={doing.done} onClose={doing.clear} />
        )}

        {!g ? (
          <p className="pencil">{data.error ? `Couldn't load the goals. ${data.error}` : "Looking…"}</p>
        ) : (
          <div className="goals">
            <section className="goal goal-boss" aria-labelledby="g-boss">
              <h2 id="g-boss">Boss goal</h2>
              <p className="goal-big">
                {g.boss.now} <span>{g.boss.target === null ? "bosses. The ladder is finished." : `of ${g.boss.target} bosses`}</span>
              </p>
              {g.boss.target !== null && <Bar value={(g.boss.now / g.boss.target) * 100} label={`${g.boss.now} of ${g.boss.target} bosses`} />}
              <p className="fine">Fills when the number of people holding the coin reaches the next step. Everyone who was already a boss can claim.</p>
            </section>
            <section className="goal goal-jar" aria-labelledby="g-jar">
              <h2 id="g-jar">Tip jar {g.tip_jar.jar}</h2>
              <p className="goal-big">
                {usd(g.tip_jar.now)} <span>of {usd(g.tip_jar.target)}</span>
              </p>
              <Bar value={share(g.tip_jar.now, g.tip_jar.target)} label={`${usd(g.tip_jar.now)} of ${usd(g.tip_jar.target)}`} />
              <p className="fine">Fills as tips come in. Everyone who tipped into this jar can claim.</p>
            </section>
            <section className="goal goal-hype" aria-labelledby="g-hype">
              <h2 id="g-hype">Hype train</h2>
              <p className="goal-big">
                {g.hype.ends_at && g.hype.ends_at > now ? (
                  <>
                    Level {g.hype.level} <span>· {g.hype.points} points{nextHype ? `, ${nextHype} for the next level` : ""}</span>
                  </>
                ) : (
                  <span>No train is running.</span>
                )}
              </p>
              {g.hype.ends_at && g.hype.ends_at > now ? (
                <>
                  <Bar value={nextHype ? (g.hype.points / nextHype) * 100 : 100} label={`${g.hype.points} points`} />
                  <p className="fine">This train ends in {clock(g.hype.ends_at - now)} unless someone adds a point.</p>
                </>
              ) : (
                <p className="fine">A train starts with the next tip or BRAVE pay-in, and ends five minutes after its last one. One point per person per train.</p>
              )}
            </section>
          </div>
        )}

        <div className="money-grid">
          <section className="card money-form" aria-labelledby="tip-h">
            <h2 id="tip-h">Leave a tip</h2>
            <label htmlFor="tip-amt">Test dollars</label>
            <input id="tip-amt" inputMode="decimal" value={tip} onChange={(e) => setTip(e.target.value)} aria-describedby="tip-note" />
            <div className="chips">
              {["1", "5", "10"].map((t) => (
                <button key={t} className="chip-btn" onClick={() => setTip(t)}>
                  ${t}
                </button>
              ))}
            </div>
            <p id="tip-note" className="fine">
              {tooSmall
                ? `The smallest tip is ${usd(c.min_tip)}.`
                : tooMuch
                  ? `You have ${usd(me!.dollars)} in your wallet.`
                  : "A tip is a gift. Half goes to the streak jackpot, half to the BRAVE pool from the next shift. It buys no say over the Intern's bets."}
            </p>
            {actions ? (
              <button className="btn btn-wide" disabled={!v || tooSmall || tooMuch || !!doing.busy} onClick={() => v && doing.run("tip", () => actions.tip(v), `Tipped ${usd(v)}. Thank you.`)}>
                {doing.busy === "tip" ? "Dropping it in…" : v ? `Tip ${usd(v)}` : "Enter an amount"}
              </button>
            ) : (
              <button className="btn" onClick={signIn}>
                {session.pretend ? "Clock in with a pretend account" : "Clock in with a NEAR wallet"} to tip
              </button>
            )}
          </section>

          <section className="card money-form" aria-labelledby="claim-h">
            <h2 id="claim-h">Waiting for you</h2>
            {!session.accountId || !actions ? (
              <p className="pencil">Clock in to see what you can claim.</p>
            ) : !mine.data ? (
              <p className="pencil">{mine.error ? `Couldn't check. ${mine.error}` : "Checking…"}</p>
            ) : nothing ? (
              <p className="pencil">Nothing right now. Tip into a jar, or be a boss when the boss goal fills.</p>
            ) : (
              <ul className="claims">
                {mine.data.claimable.badge && (
                  <li>
                    <span>
                      <strong>Your boss badge.</strong> It records when you joined. It can't be sold or given away.
                    </span>
                    <button className="btn" disabled={!!doing.busy} onClick={() => doing.run("badge", () => actions.claimBadge(), "Your boss badge is yours.")}>
                      {doing.busy === "badge" ? "Claiming…" : "Claim"}
                    </button>
                  </li>
                )}
                {mine.data.claimable.originals.map((code) => (
                  <li key={code}>
                    <span>
                      <strong>The original {code}.</strong> You talked the Intern into the first one. Only one exists.
                    </span>
                    <button className="btn" disabled={!!doing.busy} onClick={() => doing.run(`o-${code}`, () => actions.claimOriginal(code), `The original ${code} is yours.`)}>
                      {doing.busy === `o-${code}` ? "Claiming…" : "Claim"}
                    </button>
                  </li>
                ))}
                {mine.data.claimable.goal_fills.map((id) => (
                  <li key={id}>
                    <span>
                      <strong>A goal sticker.</strong> You helped fill goal number {id}.
                    </span>
                    <button className="btn" disabled={!!doing.busy} onClick={() => doing.run(`g-${id}`, () => actions.claimGoalSticker(id), "Goal sticker claimed.")}>
                      {doing.busy === `g-${id}` ? "Claiming…" : "Claim"}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="fine">Each claim attaches about 0.02 test NEAR for storage; what isn't used comes back.</p>
          </section>
        </div>

        {mine.data && mine.data.owned.length > 0 && (
          <section aria-labelledby="own-h">
            <h2 id="own-h">Your collection</h2>
            <ul className="owned">
              {mine.data.owned.map((t) => (
                <li key={t.token_id} className={t.token_id.startsWith("badge:") ? "is-badge" : ""}>
                  <BossMug accountId={t.owner_id} size={48} />
                  <span>
                    <strong>{t.metadata.title ?? t.token_id}</strong>
                    <span className="owned-note">{t.metadata.description}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section aria-labelledby="fills-h">
          <h2 id="fills-h">Goals filled so far</h2>
          {!data.data || data.data.fills.length === 0 ? (
            <p className="people-empty">None yet. The first one is still filling.</p>
          ) : (
            <ul className="fills">
              {data.data.fills.map((f) => (
                <li key={f.id}>
                  <span className="mono pencil">No. {f.id}</span>
                  <span>
                    {GOAL_NAME[f.goal]}, level {f.level}
                  </span>
                  <span className="pencil">
                    {day(f.at)}, shift {f.round_id}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
