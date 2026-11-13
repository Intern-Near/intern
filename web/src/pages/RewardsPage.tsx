import { useState } from "react";
import "./pages.css";
import "./people.css";
import "./live.css";
import "./v17-rewards.css";
import { Tin } from "../cast/Tin";
import { signIn, toE6, useDoing, useMe, useSession } from "../chain/session";
import { getChain, useDesk } from "../chain/store";
import { REFUSAL_CODES, type Verdict3 } from "../chain/types";
import { clock, usd } from "../lib/format";
import { day, href } from "../lib/nav";
import { useAsync } from "../lib/useAsync";
import { useNow } from "../lib/useNow";
import { TopBar } from "../ui/TopBar";
import { Usd } from "../ui/Usd";
import { BOT_LINE, Who } from "../ui/BotTag";
import { Waiting } from "../ui/Waiting";
import { DrawLuck, RealDrawExample } from "./DrawLuck";
import { Notice } from "../ui/Notice";

const GUESSES: { verdict: Verdict3; say: string; means: string }[] = [
  { verdict: "YES", say: "YES", means: "the bet is allowed" },
  { verdict: "NOPE", say: "NOPE", means: "the bet is refused" },
  { verdict: "SKIP", say: "SKIP", means: "the Intern doesn't bet" },
];

/** The reward ladder (interface 1.4, section 9.7): what you can win, and where each prize's money comes from. */
export function RewardsPage() {
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
  const [gift, setGift] = useState("5");
  const [wagerText, setWagerText] = useState("0");
  const [openDraw, setOpenDraw] = useState<number | null>(null);
  const data = useAsync(async () => {
    const chain = getChain();
    const [rewards, draws, wins] = await Promise.all([chain.getRewards(), chain.getDrawResults(undefined, 5), chain.getJackpotWins(10)]);
    return { rewards, draws, wins };
  }, `rewards-${seq}-${bump}`);
  const mine = useAsync(async () => (session.accountId ? getChain().getPlayer(session.accountId) : null), `player-${session.accountId}-${seq}-${bump}`);

  if (!desk) {
    return (
      <div className="home">
        <TopBar source={snap.source} scene={snap.scene} />
        <Waiting error={snap.error} line="Counting the jackpot…" />
      </div>
    );
  }

  const r = data.data?.rewards;
  const p = mine.data;
  const actions = session.actions;
  const k = r?.constants;
  const open = r ? r.guess_closes_at > now && desk.rank.status !== "FIRED" : false;
  const guessed = p?.guess && p.guess.round_id === desk.round.id ? p.guess.verdict : null;
  const waitingGuess = p?.guess && p.guess.round_id !== desk.round.id ? p.guess : null;
  const nextDraw = r ? (r.draw_from_round > r.round_id ? r.draw_from_round : r.draw_from_round + r.constants.draw_rounds) : null;
  // (1.7) Point wagers: a whole number of points, at most the points held
  const pots = r?.wagers_this_round ?? null;
  const wager = /^\d{1,9}$/.test(wagerText.trim()) ? Number(wagerText.trim()) : null;
  const wagerBad = wager === null || (p ? wager > p.points : wager > 0);
  const myWager = p?.guess?.wager ?? 0;
  const v = toE6(gift);
  const tooMuch = v !== null && me !== null && BigInt(v) > BigInt(me.dollars);
  const standin = desk.constants.lending.mode !== "RHEA";
  const clockIn = (why: string) => (
    <button className="btn" onClick={signIn}>
      {session.pretend ? "Clock in with a pretend account" : "Clock in with a NEAR wallet"} {why}
    </button>
  );

  return (
    <div className="home">
      <TopBar source={snap.source} scene={snap.scene} />
      <main id="main" className="people-page rewards-page">
        <header className="people-head">
          <Tin pose="coin" size={170} />
          <div>
            <h1>Rewards</h1>
            <p>
              Things you can win here, and where the money for each one comes from. No prize is paid out of anyone's deposit, and no reward changes what the Intern
              may bet.
            </p>
          </div>
        </header>

        {(doing.error || doing.done) && (
          <Notice error={doing.error} done={doing.done} onClose={doing.clear} />
        )}

        {!r || !k ? (
          <p className="pencil">{data.error ? `Couldn't load the rewards. Nothing was sent. ${data.error}` : "Looking…"}</p>
        ) : (
          <>
            <section className="jackpot" aria-labelledby="jp-h">
              <div>
                <h2 id="jp-h">The streak jackpot</h2>
                <p className="jackpot-big mono">
                  <Usd e6={r.jackpot} />
                </p>
                <p className="jackpot-how">
                  Guess the stamp right <strong>{k.jackpot_streak} shifts in a row</strong> and it is yours. If several people get there in the same shift, they split
                  it.
                </p>
              </div>
              <dl>
                {BigInt(r.jackpot_added_total) > 0n && (
                  <div>
                    <dt>Seeded by the team, and gifts</dt>
                    <dd className="mono">{usd(r.jackpot_added_total)}</dd>
                  </div>
                )}
                <div>
                  <dt>From tips (half of every tip)</dt>
                  <dd className="mono">{usd(r.jackpot_from_tips_total)}</dd>
                </div>
                <div>
                  <dt>Last won</dt>
                  <dd className="mono">{r.jackpot_last_won_round === null ? "never" : `shift ${r.jackpot_last_won_round}`}</dd>
                </div>
              </dl>
            </section>

            <div className="money-grid">
              <section className="card money-form" aria-labelledby="guess-h">
                <h2 id="guess-h">What will the stamp say this shift?</h2>
                <p>Free, once a shift. It is judged on the first thing the program rules this shift.</p>
                {pots && actions && p && !guessed && open && (
                  <div className="wager">
                    <label htmlFor="wager-n">Points to wager (optional)</label>
                    <input id="wager-n" inputMode="numeric" value={wagerText} onChange={(e) => setWagerText(e.target.value)} aria-describedby="wager-note" />
                    <p id="wager-note" className="fine">
                      {wagerBad
                        ? `A whole number from 0 to ${p.points}: you can wager at most the points you hold.`
                        : `You hold ${p.points} points. Wagered points are taken now. If you are right, you share every point wagered this shift with the others who were right, by the size of your wager. If you are wrong, yours are gone. No ruling: you get them back.`}
                    </p>
                  </div>
                )}
                <div className="guess-row" role="group" aria-label="Your guess">
                  {GUESSES.map((g, i) => (
                    <button
                      key={g.verdict}
                      className={`guess guess-${g.verdict.toLowerCase()}`}
                      aria-pressed={guessed === g.verdict}
                      disabled={!actions || !open || !!guessed || !!doing.busy || (!!pots && !!p && wagerBad)}
                      onClick={() =>
                        actions &&
                        doing.run(
                          `guess-${g.verdict}`,
                          () => (pots && wager ? actions.guessWager(g.verdict, wager) : actions.guess(g.verdict)),
                          `Your guess is in: ${g.say}${pots && wager ? `, with ${wager} ${wager === 1 ? "point" : "points"} on it` : ""}.`,
                        )
                      }
                    >
                      <strong>{doing.busy === `guess-${g.verdict}` ? "…" : g.say}</strong>
                      <span>{g.means}</span>
                      <span className="mono">{r.guesses_this_round[i]} so far</span>
                      {pots && <span className="mono guess-pot">{pots[i]} pts wagered</span>}
                    </button>
                  ))}
                </div>
                <p className="fine">
                  {desk.rank.status === "FIRED"
                    ? "The Intern is fired, so there is nothing to guess until it is rehired."
                    : guessed
                      ? `You guessed ${guessed} for shift ${desk.round.id}${myWager > 0 ? `, with ${myWager} ${myWager === 1 ? "point" : "points"} wagered` : ""}. The answer comes when the Intern proposes.`
                      : open
                        ? `Guessing closes in ${clock(r.guess_closes_at - now)}.`
                        : "Guessing is closed for this shift. It opens again when the next shift starts."}
                  {waitingGuess && ` Your guess for shift ${waitingGuess.round_id} (${waitingGuess.verdict}) is still waiting for its answer.`}
                </p>
                {pots && <p className="fine">Points wagered are only points. They have no cash value and cannot be bought or sold. {BOT_LINE}</p>}
                {!actions && clockIn("to guess")}
                {actions && !session.pretend && <p className="fine">Your first guess also registers your account with the program, which attaches a small refundable amount of test NEAR.</p>}
              </section>

              <section className="card money-form" aria-labelledby="you-h">
                <h2 id="you-h">Your score</h2>
                {!session.accountId ? (
                  <p className="pencil">Clock in to see your points and your streak.</p>
                ) : !p ? (
                  <p className="pencil">{mine.error ? `Couldn't read your score. ${mine.error}` : "Checking…"}</p>
                ) : (
                  <>
                    <dl className="tf-facts">
                      <div>
                        <dt>Streak</dt>
                        <dd className="mono">
                          {p.streak} of {k.jackpot_streak}
                        </dd>
                      </div>
                      <div>
                        <dt>Points</dt>
                        <dd className="mono">{p.points}</dd>
                      </div>
                      <div>
                        <dt>Best streak</dt>
                        <dd className="mono">{p.best}</dd>
                      </div>
                    </dl>
                    <div className="streak" role="img" aria-label={`${p.streak} right in a row, of ${k.jackpot_streak}`}>
                      {Array.from({ length: k.jackpot_streak }, (_, i) => (
                        <span key={i} className={i < p.streak ? "is-on" : ""} />
                      ))}
                    </div>
                    <p className={p.jackpot_eligible ? "tf-ready" : "warn"}>
                      {p.jackpot_eligible
                        ? "You can win the jackpot."
                        : `You are playing for points. The jackpot is for bosses who hold at least ${usd(k.min_boss_usd)} in BRAVE and became a boss at least ${k.min_boss_rounds} shifts ago.`}
                    </p>
                    {pots && (
                      <div className="bank">
                        <button
                          className="btn btn-quiet"
                          disabled={!actions || !!doing.busy || p.streak === 0 || p.guess !== null}
                          onClick={() => actions && doing.run("bank", () => actions.bankStreak(), `Banked: ${p.streak * p.streak} points. Your streak starts again from zero.`)}
                        >
                          {doing.busy === "bank" ? "Banking…" : p.streak > 0 ? `Bank my streak for ${p.streak * p.streak} points` : "Bank my streak"}
                        </button>
                        <p className="fine">
                          Banking turns a streak into streak × streak points ({p.streak} × {p.streak} = {p.streak * p.streak}) and sets it back to zero: sure points instead of
                          chasing {k.jackpot_streak} in a row.
                          {p.guess !== null ? " Not while a guess of yours is waiting for its ruling." : p.streak === 0 ? " You have no streak right now." : ""}
                        </p>
                      </div>
                    )}
                    <p className="fine">
                      {p.right} right, {p.wrong} wrong so far. A wrong guess sets the streak back to zero; a shift you don't guess pauses it. Points have no cash value.
                    </p>
                  </>
                )}
              </section>
            </div>

            {actions && p && (BigInt(p.prize_owed) > 0n || p.goldens.length > 0) && (
              <section className="card money-form" aria-labelledby="won-h">
                <h2 id="won-h">Waiting for you</h2>
                <ul className="claims">
                  {BigInt(p.prize_owed) > 0n && (
                    <li>
                      <span>
                        <strong>{usd(p.prize_owed)} in prizes.</strong> Paid to your wallet in test dollars.
                      </span>
                      <button className="btn" disabled={!!doing.busy} onClick={() => doing.run("prizes", () => actions.claimPrizes(), `${usd(p.prize_owed)} is in your wallet.`)}>
                        {doing.busy === "prizes" ? "Paying…" : "Collect"}
                      </button>
                    </li>
                  )}
                  {p.goldens.map((g) => (
                    <li key={`${g.code}-${g.serial}`}>
                      <span>
                        <strong>
                          Golden {g.code}, number {g.serial}.
                        </strong>{" "}
                        One of at most {k.golden_cap}. Yours to keep or give away.
                      </span>
                      <span className="claim-two">
                        <button className="btn" disabled={!!doing.busy} onClick={() => doing.run(`gold-${g.code}-${g.serial}`, () => actions.claimGolden(g.code, g.serial), `Golden ${g.code} is yours, as a one-off sticker.`)}>
                          {doing.busy === `gold-${g.code}-${g.serial}` ? "Claiming…" : "Claim as a one-off"}
                        </button>
                        {pots && (
                          <button
                            className="btn btn-quiet"
                            disabled={!!doing.busy}
                            onClick={() => doing.run(`goldmt-${g.code}-${g.serial}`, () => actions.claimGoldenMt(g.code, g.serial), `Golden ${g.code} is yours, as a unit you can sell on the sticker market.`)}
                          >
                            {doing.busy === `goldmt-${g.code}-${g.serial}` ? "Claiming…" : "Claim as a tradable unit"}
                          </button>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="fine">
                  Claiming a sticker attaches about 0.02 test NEAR for storage; what isn't used comes back.
                  {pots && p.goldens.length > 0 && (
                    <>
                      {" "}
                      A golden sticker can be claimed one way or the other, not both. A one-off keeps its number. A tradable unit is one of its code's kind, and can be listed
                      on the <a href={href("market")}>sticker market</a>.
                    </>
                  )}
                </p>
              </section>
            )}

            <div className="money-grid">
              <section className="card money-form" aria-labelledby="draw-h">
                <h2 id="draw-h">The payday draw</h2>
                <p className="goal-big">
                  {usd(r.draw_pot)} <span>in the pot so far</span>
                </p>
                <p>
                  Every {k.draw_rounds} shifts, the interest the lender paid in those shifts is drawn: {k.draw_top_bps / 100}% to one winner, the rest shared by up to{" "}
                  {k.draw_runners} runners-up. <strong>Nobody's deposit is touched.</strong>
                  {pots && " Each of the eleven prizes is drawn by tickets, so one account can win more than one."}
                </p>
                {standin && <p className="warn">On the test network the interest is a stand-in 5% test rate, so the prizes are cents.</p>}
                <dl className="tf-facts">
                  <div>
                    <dt>Next draw</dt>
                    <dd className="mono">shift {nextDraw}</dd>
                  </div>
                  <div>
                    <dt>In the draw</dt>
                    <dd className="mono">
                      {r.entrants} of {k.max_entrants}
                    </dd>
                  </div>
                  <div>
                    <dt>Your tickets</dt>
                    <dd className="mono">{p?.draw ? usd(p.draw.tickets).slice(1) : "–"}</dd>
                  </div>
                </dl>
                {!actions ? (
                  clockIn("to join")
                ) : p?.draw ? (
                  <button className="btn btn-quiet" disabled={!!doing.busy} onClick={() => doing.run("leave", () => actions.leaveDraw(), "You have left the draw.")}>
                    {doing.busy === "leave" ? "Leaving…" : "Leave the draw"}
                  </button>
                ) : (
                  <button className="btn btn-wide" disabled={!!doing.busy || !p} onClick={() => doing.run("enter", () => actions.enterDraw(), "You are in the draw.")}>
                    {doing.busy === "enter" ? "Joining…" : "Join the draw"}
                  </button>
                )}
                <p className="fine">
                  Only bosses can join. Tickets grow with the dollars you keep in BRAVE for the whole period, times the shifts you were in it. Money added part-way counts
                  from the next period.
                </p>
                {pots && (
                  <div className="luck-box">
                    <h3>Where the luck comes from</h3>
                    <DrawLuck sample={snap.source === "sample"} changeKey={`${seq}`} />
                    <RealDrawExample />
                  </div>
                )}
              </section>

              <section className="card money-form" aria-labelledby="gift-h">
                <h2 id="gift-h">Add to the jackpot</h2>
                <label htmlFor="gift-amt">Test dollars</label>
                <input id="gift-amt" inputMode="decimal" value={gift} onChange={(e) => setGift(e.target.value)} aria-describedby="gift-note" />
                <p id="gift-note" className="fine">
                  {v !== null && BigInt(v) < 1_000_000n
                    ? "The smallest addition is $1."
                    : tooMuch
                      ? `You have ${usd(me!.dollars)} in your wallet.`
                      : "A gift. It buys nothing and can't be taken back. Half of every tip also lands here."}
                </p>
                {actions ? (
                  <button
                    className="btn btn-wide"
                    disabled={!v || BigInt(v) < 1_000_000n || tooMuch || !!doing.busy}
                    onClick={() => v && doing.run("gift", () => actions.addToJackpot(v), `Added ${usd(v)} to the jackpot. Thank you.`)}
                  >
                    {doing.busy === "gift" ? "Adding…" : v ? `Add ${usd(v)}` : "Enter an amount"}
                  </button>
                ) : (
                  clockIn("to add")
                )}
                <p className="fine">
                  Or <a href={href("goals")}>leave a tip</a>: half goes here, half to the BRAVE pool.
                </p>
              </section>
            </div>

            <section className="card money-form longshot" aria-labelledby="ls-h">
              <h2 id="ls-h">The long shot</h2>
              <p>
                The bosses can vote to give the Intern <strong>one</strong> extra bet: exactly 0.5% of the BRAVE pool at up to {r.long_shot.max_leverage}x (5x on PENGU and
                WIF). It is the one exception to the rank's leverage, only by a vote, at most once every seven shifts. The result is shared by everyone in
                BRAVE, like any bet. <strong>It usually loses. That is what a long shot is.</strong>
              </p>
              <p className={r.long_shot.ticket_round !== null && !r.long_shot.used ? "tf-ready" : "warn"}>
                {r.long_shot.ticket_round === null
                  ? r.long_shot.vote_from_round > r.round_id
                    ? `No ticket. A new vote can be opened from shift ${r.long_shot.vote_from_round}.`
                    : "No ticket right now. Any boss can open a vote for one."
                  : r.long_shot.used
                    ? `The ticket for shift ${r.long_shot.ticket_round} has been used.`
                    : r.long_shot.ticket_round === r.round_id
                      ? `There is a ticket this shift${r.long_shot.margin ? `: ${usd(r.long_shot.margin)} at up to ${r.long_shot.max_leverage}x` : ""}. The Intern may use it or not.`
                      : `A ticket is coming in shift ${r.long_shot.ticket_round}.`}
              </p>
              <a className="btn btn-quiet" href={href("vote")}>
                Go to the votes
              </a>
            </section>

            <section aria-labelledby="gold-h">
              <h2 id="gold-h">Golden stickers</h2>
              <p className="rewards-lead">
                Every guess has a 1 in {k.golden_odds} chance of dropping a golden version of one of the sixteen stickers. At most {k.golden_cap} of each will ever exist.
              </p>
              <ul className="goldens">
                {REFUSAL_CODES.map((code, i) => {
                  const made = r.golden_minted[i] ?? 0;
                  return (
                    <li key={code} className={made > 0 ? "is-found" : ""}>
                      <img src={`/stickers/${code.toLowerCase()}.webp`} alt="" width={72} height={72} loading="lazy" />
                      <span className="mono">{code}</span>
                      <span className="mono">
                        {made} of {k.golden_cap}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>

            <div className="money-grid">
              <section aria-labelledby="wall-h">
                <h2 id="wall-h">Jackpot winners</h2>
                {data.data!.wins.length === 0 ? (
                  <p className="people-empty">Nobody has won it yet.</p>
                ) : (
                  <ul className="fills">
                    {data.data!.wins.map((w) => (
                      <li key={w.round_id}>
                        <span className="mono pencil">shift {w.round_id}</span>
                        <span>
                          {w.winners.map((a, i) => (
                            <span key={a}>
                              {i > 0 && ", "}
                              <Who account={a} max={20} />
                            </span>
                          ))}
                        </span>
                        <span className="mono">{usd(w.each)}{w.winners.length > 1 ? " each" : ""}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section aria-labelledby="draws-h">
                <h2 id="draws-h">Earlier draws</h2>
                {data.data!.draws.length === 0 ? (
                  <p className="people-empty">No draw has been held yet.</p>
                ) : (
                  <ul className="fills">
                    {data.data!.draws.map((d) => (
                      <li key={d.period}>
                        <span className="mono pencil">
                          {day(d.held_at)}, shift {d.held_in_round}
                        </span>
                        <span>
                          {d.winner ? (
                            <>
                              <Who account={d.winner} max={20} /> won {usd(d.winner_prize)}
                            </>
                          ) : (
                            "Nobody was in it. Rolled over."
                          )}
                        </span>
                        <span className="pencil">{d.runners_up.length > 0 ? `${d.runners_up.length} runner${d.runners_up.length === 1 ? "" : "s"}-up` : ""}</span>
                        {pots && (
                          <button className="pill pill-in luck-open" aria-expanded={openDraw === d.period} onClick={() => setOpenDraw(openDraw === d.period ? null : d.period)}>
                            {openDraw === d.period ? "Hide the luck" : "Its luck"}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>

            {openDraw !== null && data.data!.draws.some((d) => d.period === openDraw) && (
              <section className="card money-form" aria-labelledby="luck-h">
                <h2 id="luck-h">The luck of draw period {openDraw}</h2>
                <DrawLuck period={openDraw} result={data.data!.draws.find((d) => d.period === openDraw)} sample={snap.source === "sample"} changeKey="held" />
                <RealDrawExample />
              </section>
            )}

            <section aria-labelledby="src-h">
              <h2 id="src-h">Where each prize's money comes from</h2>
              <div className="table-scroll">
                <table className="judge-table">
                  <thead>
                    <tr>
                      <th scope="col">Reward</th>
                      <th scope="col">Paid from</th>
                      <th scope="col">On the test network</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <th scope="row">The free guess, points and streaks</th>
                      <td>Nothing. Points have no cash value.</td>
                      <td>
                        <span className="state state-real">Real</span>
                      </td>
                    </tr>
                    <tr>
                      <th scope="row">Golden stickers</th>
                      <td>No money. A 1 in {k.golden_odds} chance per guess, from NEAR's per-block random number.</td>
                      <td>
                        <span className="state state-real">Real</span>
                      </td>
                    </tr>
                    <tr>
                      <th scope="row">The streak jackpot</th>
                      <td>Half of every tip, plus gifts. It started with the team's own {usd(r.jackpot_added_total)}.</td>
                      <td>
                        <span className="state state-real">Real</span> in test dollars
                      </td>
                    </tr>
                    <tr>
                      <th scope="row">The payday draw</th>
                      <td>The interest the lender pays on the pool. Never the deposits.{pots && " Winners are picked with a public random number from drand."}</td>
                      <td>
                        <span className={`state ${standin ? "state-standin" : "state-real"}`}>{standin ? "Stand-in money" : "Real"}</span>
                        {standin && " The draw is real; the interest is a fixed test rate."}
                      </td>
                    </tr>
                    <tr>
                      <th scope="row">
                        <a href={href("tailfade")}>Tail or Fade</a> at 5x or 10x
                      </th>
                      <td>Your own test dollars, in your own Hyperliquid account. You can lose the whole chip.</td>
                      <td>
                        <span className="state state-real">Real</span> in test dollars
                      </td>
                    </tr>
                    <tr>
                      <th scope="row">The long shot</th>
                      <td>The BRAVE pool itself: one bet of 0.5% of the pool at up to 10x, only when the bosses vote for it. It can lose all of that 0.5%.</td>
                      <td>
                        <span className="state state-real">Real</span> in test dollars
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="fine">
                {pots
                  ? "The payday draw takes its luck from drand, a public random beacon: the tickets are fixed first, and the beacon used is one that does not exist yet at that moment, so nobody, the team included, can know it. The program checks drand's signature itself. If no beacon is handed in within two shifts, it falls back to NEAR's per-block random number and says so. Golden stickers still use NEAR's per-block number: nobody calling the program can choose it, but a block producer could in principle lean on a single drop. That is acceptable for stickers; a public beacon there would let a guesser know in advance whether a guess wins one."
                  : "The draw and the golden stickers use NEAR's per-block random number. Nobody calling the program can choose it, but a block producer could in principle lean on a single draw. That is acceptable for test-dollar prizes; real money would need a stronger method."}
              </p>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
