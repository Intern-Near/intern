import { basename } from "node:path";
import { buildReport, type LoadedRun, type ReportData, type RowData } from "./report.ts";
import { parseTickId } from "./schedule.ts";

/**
 * The website's file, web/public/shadow-run.json (read by web/src/landing/extras.tsx; what is counted was agreed with
 * the owner on 2026-11-12). The headline is the pressure run, the "trying to trick it" case; the plain run sits under
 * "plain", next to it, never added in. For each model of a run:
 *
 *   answers                every answer the program could judge
 *   skips                  answers that chose to skip, blank lines around the line ignored
 *   decisions              bets proposed: answers that are bets the program could read (checks 3 to 5 pass with
 *                          blank lines around the line ignored). The page divides refused by this
 *   refused                of those bets, the ones refused by the rank's limits (checks 6 to 12)
 *   unreadable             answers refused by checks 3 to 5 even with blank lines ignored: neither a bet nor a skip
 *   refused_format_strict  answers refused by checks 3 to 5 under 01 §6.2 as written, where blank lines count
 *
 * answers = decisions + skips + unreadable. A model that proposed no bet is left out of "models" (the page hides the
 * whole section if any model shows 0) and listed under "left_out", with a note. "hours" is the hours of decisions
 * that actually ran (ticks run x 15 minutes), so gaps are not counted.
 */
export const COUNTED =
  "bets that broke the rank's limits (checks 6-12); answers read with blank lines ignored";

export interface SiteModel {
  name: string;
  decisions: number;
  refused: number;
  answers: number;
  skips: number;
  refused_format_strict: number;
  unreadable: number;
}

export interface SiteSection {
  hours: number;
  models: SiteModel[];
  left_out?: SiteModel[];
  note?: string;
}

export interface SiteFile extends SiteSection {
  /** The UTC date of the last decision tick that ran. */
  ended: string | null;
  run: "pressure";
  counted: string;
  plain: SiteSection;
}

function rowFor(report: ReportData, model: string): RowData {
  const row = report.rows.find((r) => r.model === model);
  if (!row) throw new Error(`${report.runFolder}: no row for ${model}`);
  return row;
}

/** The UTC date of the last decision tick on disk (tail ticks, which only read prices, come after the decisions). */
function lastDecisionDate(run: LoadedRun, decisionsEnd: string | null): string | null {
  if (decisionsEnd === null) return null;
  const end = Date.parse(decisionsEnd);
  const decided = run.tickIds.filter((id) => parseTickId(id) < end);
  const last = decided[decided.length - 1];
  return last === undefined ? null : new Date(parseTickId(last)).toISOString().slice(0, 10);
}

function section(run: LoadedRun, now: number): SiteSection & { ended: string | null } {
  const folder = basename(run.runDir);
  if (run.cfg.ranks.length !== 1)
    throw new Error(`${folder}: the site file counts one rank per run, not ${run.cfg.ranks.join(", ")}`);
  const trim = buildReport(run, { answerRule: "trim", scheme: "ed25519", now });
  const strict = buildReport(run, { answerRule: "strict", scheme: "ed25519", now });
  const all = run.cfg.models.map((name): SiteModel => {
    const t = rowFor(trim, name);
    const s = rowFor(strict, name);
    const m: SiteModel = {
      name,
      decisions: (t.counts.YES ?? 0) + t.refusedByRankLimits,
      refused: t.refusedByRankLimits,
      answers: t.decisions,
      skips: t.counts.SKIP ?? 0,
      refused_format_strict: s.refusedByShape,
      unreadable: t.refusedByShape,
    };
    if (m.answers !== m.decisions + m.skips + m.unreadable)
      throw new Error(
        `${folder} ${name}: ${m.answers} answers are not decisions + skips + unreadable ` +
          `(${m.decisions} + ${m.skips} + ${m.unreadable}): a refusal code outside checks 3 to 12?`,
      );
    return m;
  });
  const out: SiteSection & { ended: string | null } = {
    hours: (trim.decideTicksRun * run.cfg.interval_minutes) / 60,
    models: all.filter((m) => m.decisions > 0),
    ended: lastDecisionDate(run, trim.decisionsEnd),
  };
  const leftOut = all.filter((m) => m.decisions === 0);
  if (leftOut.length > 0) {
    out.left_out = leftOut;
    out.note =
      "Left out of models because it proposed no bet in this run (the page hides the section if any model shows 0): " +
      `${leftOut.map((m) => `${m.name} (answers ${m.answers}, skips ${m.skips}, unreadable ${m.unreadable})`).join("; ")}.`;
  }
  return out;
}

export function buildSiteFile(pressureRun: LoadedRun, plainRun: LoadedRun, now: number): SiteFile {
  if (!pressureRun.cfg.pressure)
    throw new Error(
      `${basename(pressureRun.runDir)} has no pressure set: the headline must be the pressure run`,
    );
  if (plainRun.cfg.pressure)
    throw new Error(
      `${basename(plainRun.runDir)} has a pressure set: "plain" must be the run without pressure`,
    );
  const { ended, hours, models, left_out, note } = section(pressureRun, now);
  const { ended: _plainEnded, ...plain } = section(plainRun, now);
  return {
    hours,
    ended,
    run: "pressure",
    counted: COUNTED,
    models,
    ...(left_out ? { left_out, note } : {}),
    plain,
  };
}
