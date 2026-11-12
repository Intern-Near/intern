import { useEffect, useState } from "react";
import type { Desk } from "../chain/store";
import type { Decision, EventData, FeedItem, RefusalCode } from "../chain/types";
import { LIGHTS, lightFor } from "../lib/refusals";

/**
 * The verdict moment. The program rules on a proposal in one transaction, so the site
 * hears about the proposal and the verdict together and stages the reveal itself:
 *
 *   slip    the Intern holds up what it asked for, the line types in
 *   lights  the five check lights come on one by one, 160 ms each, until one fails
 *   leap    (NOPE only) Stamp is in the air
 *   verdict Stamp has landed: the mark, the rule, the circled number, the sticker
 *
 * A failed check never shows a tick, and with reduced motion the result is shown at once.
 */
export type Stage = "slip" | "lights" | "leap" | "verdict";
export type LightState = "off" | "ok" | "fail" | "skipped";

export type Moment =
  | { kind: "nope"; seq: number; stage: Stage; lights: LightState[]; code: RefusalCode; data: EventData["refused"]; decision: Decision | null }
  | { kind: "yes"; seq: number; stage: Stage; lights: LightState[]; data: EventData["approved"] };

const SLIP_MS = 900;
const LIGHT_MS = 160;
const LEAP_MS = 260;
const HOLD_MS = 6500;
/** Events older than this are history, not a moment (e.g. the tab was asleep). */
const STALE_MS = 15_000;

const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function lightsAt(count: number, failing: number | null, done: number, skipLast: boolean): LightState[] {
  return Array.from({ length: count }, (_, i) => {
    if (i >= done) return "off";
    if (failing === i) return "fail";
    if (skipLast && i === count - 1) return "skipped";
    return "ok";
  });
}

export function useMoment(fresh: FeedItem | null, desk: Desk | null): Moment | null {
  const [moment, setMoment] = useState<Moment | null>(null);
  const seq = fresh?.seq;

  useEffect(() => {
    if (!fresh || !desk) return;
    if (fresh.event !== "refused" && fresh.event !== "approved") return;
    if (Date.now() - fresh.at > STALE_MS) return;

    const n = LIGHTS.length;
    // On the test network a funding quote is optional, so a YES may not have run the fifth check.
    const skipLast = desk.constants.funding.mode === "RECORDED";
    const base =
      fresh.event === "refused"
        ? {
            kind: "nope" as const,
            seq: fresh.seq,
            code: fresh.data.code,
            data: fresh.data,
            decision: desk.refusals.find((r) => r.id === fresh.data.refusal_id)?.decision ?? null,
          }
        : { kind: "yes" as const, seq: fresh.seq, data: fresh.data };
    const failing = fresh.event === "refused" ? lightFor(fresh.data.code) : null;
    const steps = failing === null ? n : failing + 1;
    const at = (stage: Stage, done: number): Moment => ({ ...base, stage, lights: lightsAt(n, failing, done, skipLast && failing === null) });

    const timers: number[] = [];
    const later = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms));

    if (reduced()) {
      later(0, () => setMoment(at("verdict", steps)));
    } else {
      later(0, () => setMoment(at("slip", 0)));
      for (let i = 1; i <= steps; i++) later(SLIP_MS + LIGHT_MS * i, () => setMoment(at("lights", i)));
      const lit = SLIP_MS + LIGHT_MS * steps;
      if (failing !== null) later(lit + 40, () => setMoment(at("leap", steps)));
      later(lit + (failing !== null ? LEAP_MS : LIGHT_MS), () => setMoment(at("verdict", steps)));
    }
    later(SLIP_MS + LIGHT_MS * steps + HOLD_MS, () => setMoment(null));
    return () => timers.forEach(clearTimeout);
    // Keyed on the event's seq: the same event must never replay when other data refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq]);

  return moment;
}
