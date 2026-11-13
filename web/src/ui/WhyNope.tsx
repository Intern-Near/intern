import { useState } from "react";
import codes from "../../../interface/refusal-codes.json";
import type { Desk } from "../chain/store";
import type { RefusalCode, Rewards } from "../chain/types";
import { explain, RULES, type Explanation, type RankCode } from "../explain/explain.ts";
import { windowAndStatus, type RoundState } from "../explain/rules.ts";
import { toE6 } from "../chain/session";
import { phaseAt } from "../lib/round";
import { refusalSentence } from "../lib/refusals";

/**
 * "Why NOPE?" The rule behind a refusal in plain words, and a box that says whether a bet would pass right now.
 * The verdicts and the rule texts come from src/explain, copied unchanged from runner/src (Engine 2: Atharva);
 * a test checks the copy byte for byte. Nothing here decides anything: the program does.
 */

const ROWS = codes.codes as { check: number; code: string; fails_when: string }[];

/** What a refusal does NOT mean, where people tend to read too much into it (interface section 14, items 17 and the live refusal). */
const CAVEAT: Partial<Record<RefusalCode, string>> = {
  MALFORMED_DECISION:
    "This is a refusal for the form of the answer, not for a bet. The AI was not fooled into breaking a limit: its answer was not the exact one-line format, so the program would not read it.",
  OVER_TRADE_LIMIT:
    "The limit follows the pool. If someone cashes out between the shift's opening and the proposal, a bet of exactly the old maximum is refused too. The rule held either way.",
  OUTSIDE_WINDOW: "The answer arrived after the betting window. A pushy message can make the AI think for minutes.",
};

export function WhyNope({ code, asked, limit }: { code: RefusalCode; asked: string | null; limit: string | null }) {
  const row = ROWS.find((r) => r.code === code);
  const rank = (RULES as Partial<Record<string, { rule: string; section: string }>>)[code];
  return (
    <div className="why">
      <h3>Why NOPE?</h3>
      <p>
        <strong>Check {row?.check ?? "?"} of 16.</strong> {rank?.rule ?? `${row?.fails_when ?? "The program refused it"}.`}
      </p>
      <p>{refusalSentence(code, { asked, limit })}</p>
      {CAVEAT[code] && <p className="why-note">{CAVEAT[code]}</p>}
      <p className="fine">
        The program runs its sixteen checks in order and stops at the first one that fails, so one proposal gets one reason.
        {rank ? ` Where the rule is written: ${rank.section.replace(/01 /g, "the shared interface, ")}.` : ""}
      </p>
    </div>
  );
}

/** The round as the checks see it right now. */
export function stateNow(desk: Desk, now: number, rewards: Rewards | null): RoundState {
  const r = desk.round;
  const ticket = rewards && rewards.long_shot.ticket_round === r.id && !rewards.long_shot.used && rewards.long_shot.margin ? { margin_e6: BigInt(rewards.long_shot.margin), max_leverage: rewards.long_shot.max_leverage } : undefined;
  return {
    phase: phaseAt(r, now),
    status: desk.rank.status,
    rank: desk.rank.rank,
    brave_at_open_e6: BigInt(r.brave_at_open),
    brave_now_e6: BigInt(desk.pot.brave.total),
    bets_used: r.bets_used,
    at_risk_e6: BigInt(r.at_risk),
    ms_into_round: now - r.started_at,
    propose_from_ms: r.propose_from - r.started_at,
    propose_until_ms: r.propose_until - r.started_at,
    min_notional_e6: BigInt(desk.constants.min_notional),
    ...(ticket ? { ticket } : {}),
  };
}

const OUTCOME: Record<string, string> = { pass: "passes", fail: "fails", "not reached": "not reached", "not applied": "does not apply" };

/** Try any bet against the rank's checks, as the program would judge it this minute. */
export function WouldPass({ desk, now, rewards }: { desk: Desk; now: number; rewards: Rewards | null }) {
  const [market, setMarket] = useState(desk.constants.markets[0]?.market ?? "DOGE");
  const [side, setSide] = useState<"LONG" | "SHORT">("LONG");
  const [margin, setMargin] = useState("450");
  const [leverage, setLeverage] = useState("1");
  const state = stateNow(desk, now, rewards);
  const m = toE6(margin);
  const lev = Number(leverage);
  let e: Explanation | null = null;
  let broke: string | null = null;
  if (m && Number.isInteger(lev) && lev >= 1) {
    try {
      e = explain(state, { action: "BET", market, side, margin_e6: BigInt(m), leverage: lev } as never);
    } catch (err) {
      broke = err instanceof Error ? err.message : String(err);
    }
  }
  const early = windowAndStatus(state);
  return (
    <section className="card money-form would" aria-labelledby="would-h">
      <h2 id="would-h">Would this bet pass?</h2>
      <p>Make up a bet. This runs the same rank checks the program runs (checks 6 to 12), on the pool and the shift as they are this minute. Nothing is sent.</p>
      <div className="would-form">
        <label>
          Coin
          <select value={market} onChange={(ev) => setMarket(ev.target.value as typeof market)}>
            {desk.constants.markets.map((x) => (
              <option key={x.market} value={x.market}>
                {x.market}
              </option>
            ))}
          </select>
        </label>
        <label>
          Direction
          <select value={side} onChange={(ev) => setSide(ev.target.value as "LONG" | "SHORT")}>
            <option value="LONG">Up</option>
            <option value="SHORT">Down</option>
          </select>
        </label>
        <label>
          Dollars
          <input inputMode="decimal" value={margin} onChange={(ev) => setMargin(ev.target.value)} />
        </label>
        <label>
          Leverage
          <input inputMode="numeric" value={leverage} onChange={(ev) => setLeverage(ev.target.value)} />
        </label>
      </div>
      <div aria-live="polite">
        {!e ? (
          <p className="pencil">{broke ?? "Enter dollars and a whole-number leverage."}</p>
        ) : (
          <>
            <p className="would-verdict">
              <span className={`vchip vchip-${e.verdict === "NOPE" ? "nope" : "yes"}`}>{e.verdict}</span>
              {e.verdict === "NOPE" ? (
                <span>
                  <span className="mono">{e.code}</span> (check {e.check}). {refusalSentence(e.code as RefusalCode, { asked: e.asked, limit: e.limit })}
                </span>
              ) : (
                <span>It fits every rank check{e.long_shot ? ", as this shift's long-shot ticket" : ""}.</span>
              )}
            </p>
            <p>{e.rule}</p>
            <ol className="would-steps">
              {e.steps.map((s) => (
                <li key={s.code} className={`is-${s.outcome.replace(" ", "-")}`}>
                  <span className="mono">
                    {s.check} {s.code}
                  </span>
                  <span>
                    {OUTCOME[s.outcome]}
                    {s.outcome === "not reached" && s.would ? ` (alone, it ${OUTCOME[s.would] ?? s.would})` : ""}
                  </span>
                </li>
              ))}
            </ol>
          </>
        )}
        {early && (
          <p className="warn">
            Right now it would stop earlier, at {early.verdict === "NOPE" ? (early.code === "FIRED" ? "check 2: the Intern is fired" : "check 1: it is outside betting hours") : "an earlier check"}.
            The verdict above is what the rank checks alone would say.
          </p>
        )}
      </div>
      <p className="fine">
        This box does not check that the answer really came from the AI (checks 3 to 5) or the funding quote (13 to 16). The rule code is Engine 2's, the same file
        the runner uses.
      </p>
    </section>
  );
}

export type { RankCode };
