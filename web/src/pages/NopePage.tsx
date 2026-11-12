import { useState } from "react";
import "./pages.css";
import { getChain, useDesk } from "../chain/store";
import type { Decision, Refusal, Round } from "../chain/types";
import { Intern } from "../cast/Intern";
import { amount, titleCase } from "../lib/format";
import { day, href } from "../lib/nav";
import { LIGHTS, lightFor, refusalParts, refusalSentence } from "../lib/refusals";
import { useAsync } from "../lib/useAsync";
import { TopBar } from "../ui/TopBar";
import { saveCard } from "./shareCard";

function asked(d: Decision | null): string {
  if (!d) return "The answer could not be read as a bet.";
  if (d.action === "SKIP") return "The Intern asked to sit the day out.";
  return `The Intern asked to go ${d.side.toLowerCase()} on ${d.market} with $${amount(d.margin)} at ${d.leverage}x.`;
}

const utc = (at: number) =>
  `${day(at)}, ${new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC`;

type Found = { refusal: Refusal; round: Round | null };

export function NopePage() {
  const snap = useDesk();
  const id = Number(new URLSearchParams(window.location.search).get("id"));
  const [saving, setSaving] = useState<"idle" | "busy" | "failed">("idle");
  const [copied, setCopied] = useState(false);

  const found = useAsync<Found | null>(async () => {
    if (!Number.isInteger(id) || id < 1) return null;
    const chain = getChain();
    const [refusal] = await chain.getRefusals(id, 1);
    if (!refusal || refusal.id !== id) return null;
    return { refusal, round: await chain.getRoundById(refusal.round_id) };
  }, `nope-${id}`);

  const r = found.data?.refusal;
  const rank = found.data?.round?.rank;
  const failing = r ? lightFor(r.code) : -1;
  const parts = r ? refusalParts(r.code, r) : null;

  async function onSave() {
    if (!r) return;
    setSaving("busy");
    try {
      await saveCard({ id: r.id, code: r.code, sentence: refusalSentence(r.code, r), asked: asked(r.decision), meta: `${rank ? titleCase(rank) : "Rank ?"} · shift ${r.round_id} · ${utc(r.at)}` });
      setSaving("idle");
    } catch {
      setSaving("failed");
    }
  }
  async function onCopy() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="home">
      <TopBar source={snap.source} scene={snap.scene} />
      <main className="nope-page">
        {found.loading && <p className="pencil">Finding that NOPE…</p>}
        {found.error && <p role="alert">Couldn't load this NOPE. {found.error}</p>}
        {!found.loading && !found.error && !r && (
          <section className="card missing">
            <Intern mood="thinking" size={180} />
            <h1>No NOPE with that number.</h1>
            <p>Either it hasn't happened yet, or the link is wrong.</p>
            <a className="btn" href={href("desk")}>
              Back to the desk
            </a>
          </section>
        )}
        {r && parts && (
          <>
            <article className="nope-card" aria-labelledby="nope-h">
              <div className="nope-art">
                <Intern mood="refused" size={300} />
              </div>
              <div className="nope-body">
                <p className="mono">
                  NOPE No. {r.id} · SHIFT {r.round_id}
                  {r.is_first ? " · FIRST OF ITS KIND" : ""}
                </p>
                <span className="mark mark-nope nope-stamp" aria-hidden="true">
                  NOPE
                </span>
                <h1 id="nope-h">
                  {parts.before}
                  {parts.asked && <strong>{parts.asked}</strong>}
                  {parts.after}
                </h1>
                <p className="mono nope-code">{r.code}</p>
                <dl className="nope-facts">
                  <div>
                    <dt>What was asked</dt>
                    <dd>{asked(r.decision)}</dd>
                  </div>
                  {(r.asked !== null || r.limit !== null) && (
                    <div>
                      <dt>The program's numbers</dt>
                      <dd className="mono">
                        asked {r.asked ?? "–"} · limit {r.limit ?? "–"}
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt>Rank at the time</dt>
                    <dd>{rank ? titleCase(rank) : "Unknown"}</dd>
                  </div>
                  {r.credited_to && (
                    <div>
                      <dt>Talked into it by</dt>
                      <dd>
                        {r.credited_to} <span className="pencil">(named by the runner; the program can't check this)</span>
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt>When</dt>
                    <dd>
                      <time dateTime={new Date(r.at).toISOString()}>{utc(r.at)}</time>
                    </dd>
                  </div>
                </dl>
              </div>
            </article>

            <section className="screen panel-dark" aria-labelledby="checks-h">
              <h2 id="checks-h">Where it stopped</h2>
              <p className="panel-sub">The program runs its sixteen checks in a fixed order and stops at the first one that fails. Nothing after that is checked, and no money moves.</p>
              <ol className="check-list">
                {LIGHTS.map((l, i) => (
                  <li key={l.name} className={i < failing ? "is-ok" : i === failing ? "is-fail" : "is-off"}>
                    <span className="check-mark" aria-hidden="true">
                      {i < failing ? "✓" : i === failing ? "✕" : "·"}
                    </span>
                    <span>
                      {l.name}
                      <span className="sr-only">{i < failing ? ": passed" : i === failing ? ": failed" : ": not reached"}</span>
                      {i === failing && <span className="mono check-code">{r.code}</span>}
                    </span>
                  </li>
                ))}
              </ol>
            </section>

            <div className="row nope-actions">
              <button className="btn" onClick={onSave} disabled={saving === "busy"}>
                {saving === "busy" ? "Making the card…" : "Save as a card"}
              </button>
              <button className="btn btn-quiet" onClick={onCopy}>
                {copied ? "Link copied" : "Copy link"}
              </button>
              <a className="btn btn-quiet" href={href("intern")}>
                The Intern's file
              </a>
              {saving === "failed" && <p role="alert">Couldn't make the image in this browser.</p>}
            </div>
            <p className="fine">
              Test network. This NOPE is a record kept by the program; the Intern's bets are small and it is allowed to be wrong.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
