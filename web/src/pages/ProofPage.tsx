import { useState } from "react";
import "./pages.css";
import "./people.css";
import "./live.css";
import { Stamp } from "../cast/Stamp";
import { useDesk } from "../chain/store";
import { useAsync } from "../lib/useAsync";
import { TopBar } from "../ui/TopBar";

/**
 * The Proof page. It shows SAVED results of the runner's read-only checks (Engine 2's tools in runner/),
 * written to public/proof/ before each deploy. Nothing here is live: every block says when it was checked.
 */

type Status = "ok" | "warn" | "fail";
type Section = { id: string; title: string; status: Status; sentence: string; error: string | null; data: unknown };
type Bundle = { generated_at: string; git?: { commit?: string }; coin: string; summary: { ok: number; warn: number; fail: number; sentence: string }; sections: Section[] };
type Money = { returned_e6: string; result_e6: string } | null;
type FillBet = { round_id: number; position_id: number; market: string; side: string; margin_e6: string; leverage: number; reported: Money; status: string; reason: string };
type Fills = { checked_at: string; rule: string; hl: { address: string }; summary: { bets: number; by_status: Record<string, number> }; bets: FillBet[] };
type Books = { block: { at: string; height: number }; rule: string; owed_total_e6: string; held_total_e6: string; difference_e6: string; verdict: string; ok: boolean; held: { name: string; amount_e6: string }[]; checks: { ok: boolean; rule: string; detail: string }[] };
type CodeRow = { check: number; code: string; fails_when: string; count: number; first: { refusal_id: number; round_id: number; at_iso: string; tx: { tx_hash: string; link: string; confirmed: boolean } | null } | null };
type Refusals = { checked_at: string; coins: { coin: string; refusals: number; codes: CodeRow[] }[] };

const WORD: Record<Status, string> = { ok: "OK", warn: "Caveat", fail: "Failed" };
const CLASS: Record<Status, string> = { ok: "state-real", warn: "state-standin", fail: "state-failed" };

async function saved<T>(name: string): Promise<T | null> {
  const res = await fetch(`/proof/${name}`);
  // A missing file comes back as the site's own page, not as JSON
  if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return null;
  return (await res.json()) as T;
}

const when = (iso: string) => `${new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC`;
const dollars = (e6: string) => {
  const v = BigInt(e6);
  const a = v < 0n ? -v : v;
  return `${v < 0n ? "−" : ""}$${(a / 1_000_000n).toLocaleString("en-US")}.${(a % 1_000_000n).toString().padStart(6, "0")}`;
};

function Detail({ s }: { s: Section }) {
  if (s.id === "verify-round" && Array.isArray(s.data)) {
    const txs = s.data as { tx_hash: string; link: string; at: string; result: string; lines: string[] }[];
    return (
      <>
        <ul className="proof-list">
          {txs.map((t) => (
            <li key={t.tx_hash}>
              <a href={t.link} target="_blank" rel="noreferrer" className="mono">
                {t.tx_hash.slice(0, 12)}…
              </a>{" "}
              <span className="pencil">{when(t.at)}</span>
              <details>
                <summary>Every step of this re-check</summary>
                <pre className="mono">{t.lines.join("\n")}</pre>
              </details>
            </li>
          ))}
        </ul>
        <p className="fine">
          Check one yourself, with no key: <span className="mono">cd runner && npm ci && npm run verify-round -- &lt;transaction hash&gt;</span>
        </p>
      </>
    );
  }
  if (s.id === "attestation" && s.data && typeof s.data === "object") {
    const d = s.data as { unverified_parts?: string[]; lines?: string[] };
    return (
      <>
        {d.unverified_parts && d.unverified_parts.length > 0 && (
          <details>
            <summary>What stays unverified ({d.unverified_parts.length})</summary>
            <ul className="proof-list">
              {d.unverified_parts.map((u) => (
                <li key={u}>{u}</li>
              ))}
            </ul>
          </details>
        )}
        {d.lines && (
          <details>
            <summary>The full output</summary>
            <pre className="mono">{d.lines.join("\n")}</pre>
          </details>
        )}
      </>
    );
  }
  return null;
}

export function ProofPage() {
  const snap = useDesk();
  const [all, setAll] = useState(false);
  const data = useAsync(async () => {
    const [bundle, fills, books, refusals] = await Promise.all([saved<Bundle>("proof.json"), saved<Fills>("fills.json"), saved<Books>("books.json"), saved<Refusals>("refusals.json")]);
    return { bundle, fills, books, refusals };
  }, "proof");
  const d = data.data;
  const live = d?.refusals?.coins[0];
  const bets = d?.fills ? [...d.fills.bets].reverse() : [];

  return (
    <div className="home">
      <TopBar source={snap.source} scene={snap.scene} />
      <main id="main" className="people-page proof-page">
        <header className="people-head">
          <Stamp pose="landed" size={150} />
          <div>
            <h1>Proof</h1>
            <p>
              Checks that anyone can run again from public data, with no key. What you see here are <strong>saved results</strong>, not live ones: each block says when
              it was checked.
            </p>
          </div>
        </header>

        {!d ? (
          <p className="pencil">{data.error ? `Couldn't load the saved checks. ${data.error}` : "Opening the file…"}</p>
        ) : !d.bundle ? (
          <p className="people-empty">No saved check is on this copy of the site yet. Run `npm run proof` in runner/ to make one.</p>
        ) : (
          <>
            <section className="counts" aria-label="Summary">
              <p className="counts-line">
                <strong>{d.bundle.summary.ok}</strong> OK, <strong>{d.bundle.summary.warn}</strong> with a caveat, <strong>{d.bundle.summary.fail}</strong> failed.
              </p>
              <p className="pencil">
                Checked at {when(d.bundle.generated_at)}, against {d.bundle.coin}
                {d.bundle.git?.commit ? `, from commit ${d.bundle.git.commit.slice(0, 7)}` : ""}. Run it yourself: <span className="mono">cd runner && npm ci && npm run proof</span>
              </p>
            </section>

            <div className="proofs-grid">
              {d.bundle.sections.map((s) => (
                <section key={s.id} className="card proof-card" aria-labelledby={`p-${s.id}`}>
                  <h2 id={`p-${s.id}`}>
                    <span className={`state ${CLASS[s.status]}`}>{WORD[s.status]}</span> {s.title}
                  </h2>
                  <p>{s.sentence}</p>
                  {s.error && <p className="mono tf-small">{s.error}</p>}
                  <Detail s={s} />
                </section>
              ))}
            </div>

            {d.fills && (
              <section aria-labelledby="fills-h">
                <h2 id="fills-h">Every bet's reported result, against Hyperliquid's own fills</h2>
                <p className="rewards-lead">
                  The program cannot read Hyperliquid, so the runner reports each bet's result. This check works the result out again from Hyperliquid's public fills for
                  the program's address and compares. {d.fills.summary.bets} bets:{" "}
                  {Object.entries(d.fills.summary.by_status)
                    .filter(([, n]) => n > 0)
                    .map(([k, n]) => `${n} ${k}`)
                    .join(", ")}
                  . Checked at {when(d.fills.checked_at)}.
                </p>
                <div className="table-scroll">
                  <table className="judge-table">
                    <thead>
                      <tr>
                        <th scope="col">Shift</th>
                        <th scope="col">Bet</th>
                        <th scope="col" className="r">
                          Money on it
                        </th>
                        <th scope="col" className="r">
                          Reported result
                        </th>
                        <th scope="col">Against the fills</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(all ? bets : bets.slice(0, 12)).map((b) => (
                        <tr key={b.position_id}>
                          <td className="mono">{b.round_id}</td>
                          <td>
                            {b.side === "LONG" ? "Up" : "Down"} {b.market} at {b.leverage}x
                          </td>
                          <td className="mono r">{dollars(b.margin_e6)}</td>
                          <td className="mono r">{b.reported ? dollars(b.reported.result_e6) : "–"}</td>
                          <td>
                            <span className={`state ${b.status === "OK" ? "state-real" : b.status === "MISMATCH" ? "state-failed" : "state-standin"}`}>{b.status}</span>{" "}
                            <span className="proof-reason">{b.reason}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {bets.length > 12 && (
                  <button className="btn btn-quiet more" onClick={() => setAll((a) => !a)}>
                    {all ? "Show the latest 12" : `Show all ${bets.length}`}
                  </button>
                )}
                <p className="fine">
                  The one mismatch (shift 3) is our own early test report, and shift 6 had no fills because the exchange account was not funded yet. The rule:{" "}
                  {d.fills.rule}
                </p>
              </section>
            )}

            {d.books && (
              <section className="card money-form" aria-labelledby="books-h">
                <h2 id="books-h">
                  <span className={`state ${d.books.ok ? "state-real" : "state-failed"}`}>{d.books.ok ? "OK" : "Failed"}</span> The money adds up
                </h2>
                <dl className="tf-facts">
                  <div>
                    <dt>The program owes</dt>
                    <dd className="mono">{dollars(d.books.owed_total_e6)}</dd>
                  </div>
                  <div>
                    <dt>The program holds</dt>
                    <dd className="mono">{dollars(d.books.held_total_e6)}</dd>
                  </div>
                  <div>
                    <dt>Difference</dt>
                    <dd className="mono">{dollars(d.books.difference_e6)}</dd>
                  </div>
                </dl>
                <ul className="proof-list">
                  {d.books.held.map((h) => (
                    <li key={h.name}>
                      {h.name}: <span className="mono">{dollars(h.amount_e6)}</span>
                    </li>
                  ))}
                  {d.books.checks.map((c) => (
                    <li key={c.rule}>
                      {c.ok ? "Holds" : "Does not hold"}: {c.rule}
                    </li>
                  ))}
                </ul>
                <p className="fine">
                  Test dollars. Read at block {d.books.block.height}, {when(d.books.block.at)}. {d.books.rule}
                </p>
              </section>
            )}

            {live && (
              <section aria-labelledby="cat-h">
                <h2 id="cat-h">The sixteen NOPE reasons, and the first real example of each</h2>
                <p className="rewards-lead">
                  On the live program so far: {live.refusals} {live.refusals === 1 ? "refusal" : "refusals"}. A reason with no example has simply not happened yet.
                  Checked at {when(d.refusals!.checked_at)}.
                </p>
                <div className="table-scroll">
                  <table className="judge-table">
                    <thead>
                      <tr>
                        <th scope="col">Check</th>
                        <th scope="col">Reason</th>
                        <th scope="col">Refuses when</th>
                        <th scope="col" className="r">
                          Times
                        </th>
                        <th scope="col">First example</th>
                      </tr>
                    </thead>
                    <tbody>
                      {live.codes.map((c) => (
                        <tr key={c.code}>
                          <td className="mono">{c.check}</td>
                          <td className="mono">{c.code}</td>
                          <td>{c.fails_when}</td>
                          <td className="mono r">{c.count}</td>
                          <td>
                            {c.first?.tx ? (
                              <a href={c.first.tx.link} target="_blank" rel="noreferrer">
                                shift {c.first.round_id}, the transaction
                              </a>
                            ) : (
                              <span className="pencil">no example yet</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            <section aria-labelledby="more-h">
              <h2 id="more-h">Take the data</h2>
              <ul className="proof-list">
                <li>
                  <a href="/proof/supply.csv" download>
                    Every $INTERN mint and burn, as a spreadsheet file
                  </a>{" "}
                  (rebuilt from the program's feed; the feed keeps its latest 1,000 events)
                </li>
                <li>
                  <a href="/proof/proof.json">The whole proof bundle</a>, <a href="/proof/fills.json">the fills check</a>, <a href="/proof/books.json">the books</a>,{" "}
                  <a href="/proof/refusals.json">the refusal catalogue</a>, <a href="/proof/contracts.json">the contract scan</a>
                </li>
              </ul>
              <p className="fine">
                These checks are the work of Atharva (Engine 2: the runner, the AI check and the order builder). Transaction lookups use NearBlocks: Powered by
                Nearblocks.io APIs.
              </p>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
