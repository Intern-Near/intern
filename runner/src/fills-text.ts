import { type Amounts, type FillGroupReport, type Report, STATUSES, usd } from "./fills-check.ts";

/** fills-check's report as text: one line per bet (and per round without one), the reasons, then the counts. */

const pad = (s: string, n: number): string => s.padEnd(n);
const padL = (s: string, n: number): string => s.padStart(n);
const at = (ms: number): string => new Date(ms).toISOString();

function resultCell(a: Partial<Amounts> | null): string {
  return a?.result_e6 === undefined ? "-" : usd(BigInt(a.result_e6));
}

function groupLine(u: FillGroupReport): string {
  const round = u.round_id === null ? "" : `, round ${u.round_id}`;
  return `oid ${u.oid}, ${u.dirs.join("/")} ${u.sz} ${u.coin} (${u.fills} fill(s)) at ${at(u.first_fill_at)}${round}`;
}

export function renderText(r: Report): string[] {
  const out: string[] = [
    `fills-check: ${r.contract}, rounds ${r.rounds.from} to ${r.rounds.to}, Hyperliquid testnet ${r.hl.address}`,
    `Read-only, ${r.checked_at}. ${r.matching}`,
    `Recomputed with the runner's rule: ${r.rule}. Results in dollars (returned - margin).`,
    "",
    [
      padL("round", 5),
      pad("market", 6),
      pad("side", 5),
      padL("margin", 11),
      padL("orders", 6),
      padL("fills", 5),
      padL("reported", 11),
      padL("recomputed", 11),
      "status",
    ].join("  "),
  ];
  for (const row of r.round_rows) {
    const bets = r.bets.filter((b) => b.round_id === row.round_id);
    if (bets.length === 0) {
      const asked = [
        row.skipped > 0 ? `skipped ${row.skipped}` : "",
        row.refused > 0 ? `refused ${row.refused}` : "",
      ].filter((x) => x !== "");
      const what =
        asked.length > 0
          ? `no bet (${asked.join(", ")})`
          : row.round_id === r.rounds.current && !row.settled
            ? `no bet yet (phase ${row.phase})`
            : "no bet (nothing proposed)";
      out.push(`${padL(String(row.round_id), 5)}  ${what}`);
    }
    for (const b of bets) {
      out.push(
        [
          padL(String(b.round_id), 5),
          pad(b.market, 6),
          pad(b.side, 5),
          padL(usd(BigInt(b.margin_e6)), 11),
          padL(b.orders_signed === null ? "?" : String(b.orders_signed), 6),
          padL(String(b.fills_matched), 5),
          padL(resultCell(b.reported), 11),
          padL(resultCell(b.recomputed), 11),
          b.status,
        ].join("  "),
      );
      if (b.status !== "OK") out.push(`       position ${b.position_id}: ${b.reason}`);
    }
    if (row.unmatched_fill_groups > 0)
      out.push(`       ${row.unmatched_fill_groups} group(s) of fills in this round match no signed order`);
  }
  if (r.rounds.missing.length > 0) out.push(`get_round_by_id had no round ${r.rounds.missing.join(", ")}`);
  out.push("");
  for (const u of r.unmatched_fills) out.push(`unmatched: ${groupLine(u)}`);
  for (const u of r.older_fills)
    out.push(`not checked (older than every order the contract keeps): ${groupLine(u)}`);
  const s = r.summary;
  const counts = STATUSES.map((k) => `${k} ${s.by_status[k]}`).join(", ");
  out.push(
    `summary: ${s.rounds} round(s), ${s.bets} bet(s), ${s.rounds_without_bet} round(s) without a bet. ${counts}. ` +
      `Fill groups that no signed order accounts for: ${s.unmatched_fill_groups}.`,
  );
  const src = r.sources;
  out.push(
    `read: ${src.outbox_actions} signed action(s) kept in get_outbox (from id ${src.outbox_first_id ?? "-"}), ` +
      `${src.feed_items} feed item(s), ${src.fills} fill(s) and ${src.funding_records} funding record(s) since ${at(src.fills_from)}`,
  );
  out.push(
    s.ok
      ? "result: every reported result checked here matches the fills"
      : "result: some reported results or fills do not match (the lines above say which)",
  );
  return out;
}
