import type { EventRow, RoundRow, SupplyReport } from "./supply-log.ts";
import { six } from "./view-fields.ts";

/** supply-log's report as text (every mint and burn, round by round, the total against ft_total_supply) and CSV. */

const amt = (e6: string | null, width = 13): string =>
  (e6 === null ? "unknown" : six(BigInt(e6))).padStart(width);
const blank = (e6: string | null, width = 13): string => (e6 === null ? "" : six(BigInt(e6))).padStart(width);
const minute = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const neg = (e6: string): string => (-BigInt(e6)).toString();

export const LEGEND =
  "MINT: coins created at a round's opening from BRAVE money, worked out with the contract's rule. BURN: coins " +
  "burned at a cash-out or by the dial to SAFE. WRITE: an opening's coins written to one account (coins_minted; " +
  "the supply does not change). WAIT, TAKEN BACK: dollars waiting for the next opening.";

function eventLine(e: EventRow): string {
  const coins = e.kind === "BURN" && e.coins_e6 !== null ? neg(e.coins_e6) : e.coins_e6;
  return [
    (e.seq === null ? "due" : String(e.seq)).padStart(5),
    minute(e.at),
    (e.round_id === null ? "-" : String(e.round_id)).padStart(5),
    e.kind.padEnd(10),
    (e.account_id ?? "").padEnd(30),
    blank(e.dollars_e6),
    e.kind === "WAIT" || e.kind === "TAKEN BACK" ? "".padStart(13) : amt(coins),
    amt(e.supply_after_e6),
    e.note,
  ].join("  ");
}

function changed(r: RoundRow): boolean {
  return r.seq === null || r.minted_e6 !== "0" || r.burned_e6 !== "0" || r.written_e6 !== "0";
}

function roundLine(r: RoundRow): string {
  return [
    String(r.round_id).padStart(5),
    r.seq === null ? "due, not yet written".padEnd(19) : minute(r.opened_at),
    amt(r.converted_e6),
    amt(r.minted_e6),
    blank(r.dollars_per_coin_e6, 9),
    amt(r.written_e6),
    amt(r.not_written_e6),
    amt(r.burned_e6 === "0" ? "0" : neg(r.burned_e6)),
    amt(r.supply_end_e6),
  ].join("  ");
}

export function renderSupply(r: SupplyReport): string[] {
  const f = r.feed;
  const span = f.first_seq === null ? "empty" : `seq ${f.first_seq} to ${f.last_seq}`;
  const out: string[] = [
    `supply-log: ${r.coin}, read-only, at block ${r.block.height} (${r.block.at})`,
    `The feed: ${span}, ${f.complete ? "all of it" : "NOT all of it"} (the contract keeps its latest ${f.keeps} ` +
      `events). Every page and view read at that block (${r.rpc}).`,
    `Coins and dollars with 6 decimals. ${LEGEND}`,
    "",
    "Every mint and burn, event by event",
    [
      "  seq",
      "time (UTC)".padEnd(19),
      "round",
      "kind".padEnd(10),
      "account".padEnd(30),
      "dollars".padStart(13),
      "coins".padStart(13),
      "supply after".padStart(13),
      "note",
    ].join("  "),
  ];
  for (const e of r.events) out.push(eventLine(e));
  if (r.events.length === 0) out.push("  (none)");

  const shown = r.rounds.filter(changed);
  out.push(
    "",
    "Round by round: the rounds where coins were minted, written or burned",
    [
      "round",
      "opened (UTC)".padEnd(19),
      "dollars in".padStart(13),
      "coins minted".padStart(13),
      "$ a coin".padStart(9),
      "written".padStart(13),
      "not written".padStart(13),
      "burned".padStart(13),
      "supply after".padStart(13),
    ].join("  "),
  );
  for (const row of shown) out.push(roundLine(row));
  const quiet = r.rounds.length - shown.length;
  if (quiet > 0) out.push(`  ${quiet} other round(s): no coin minted, written or burned.`);

  const t = r.totals;
  const line = (name: string, e6: string | null): string => `${name.padEnd(46)}${amt(e6, 14)}`;
  out.push(
    "",
    "The supply now",
    line("  minted at round openings", t.minted_e6),
    line("    locked for ever (the coin contract's own)", t.locked_e6),
    line("    written to accounts (coins_minted)", t.written_e6),
    line("    not written to an account yet", t.not_written_e6),
    line("    rounding dust (belongs to nobody)", t.dust_e6),
    line("  burned at cash-out", neg(t.burned_cash_out_e6)),
    line("  burned by the dial to SAFE", neg(t.burned_dial_e6)),
    line("  rebuilt from the feed", t.rebuilt_e6),
    line("  ft_total_supply now", r.now.ft_total_supply_e6),
    r.difference_e6 === null
      ? `${"  difference".padEnd(46)}${"not possible".padStart(14)}`
      : line("  difference", r.difference_e6),
    "",
    "Checks",
  );
  for (const c of r.checks)
    out.push(`  ${c.ok === null ? "--  " : c.ok ? "OK  " : "FAIL"}  ${c.rule}: ${c.detail}`);

  if (r.not_written.length > 0) {
    out.push("", "Coins not written to an account yet (the owner has not acted since that opening; 01 §5)");
    for (const n of r.not_written)
      out.push(
        `  round ${String(n.round_id).padStart(3)}  ${n.account_id.padEnd(30)}  $${six(BigInt(n.dollars_e6))} in, ` +
          `${six(BigInt(n.coins_e6))} coins`,
      );
  }
  out.push("", "What the feed cannot account for");
  if (r.gaps.length === 0) out.push("  nothing: the feed accounts for every coin in ft_total_supply.");
  for (const g of r.gaps) out.push(`  - ${g}`);
  if (r.findings.length > 0) {
    out.push("", "For the owner");
    for (const g of r.findings) out.push(`  - ${g}`);
  }
  out.push(
    "",
    r.ok && r.totals.rebuilt_e6 !== null
      ? `result: THE FEED ACCOUNTS FOR EVERY COIN: rebuilt ${six(BigInt(r.totals.rebuilt_e6))} = ft_total_supply ` +
          `${six(BigInt(r.now.ft_total_supply_e6))}.`
      : 'result: THE FEED DOES NOT ACCOUNT FOR EVERY COIN: the lines under "What the feed cannot account for" say what is missing.',
  );
  return out;
}

// ---------------------------------------------------------------- CSV

const CSV_HEAD = [
  "seq",
  "at_utc",
  "round",
  "event",
  "kind",
  "account",
  "dollars",
  "coins",
  "supply_change",
  "supply_after",
  "note",
];

/** RFC 4180 quoting: a field with a comma, a quote or a line break is quoted, its quotes doubled. */
export function csvField(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
}

const dec = (e6: string | null): string => (e6 === null ? "" : six(BigInt(e6)));

/** One row per event of the log, amounts with 6 decimals; an empty cell is "not known" or "not applicable". */
export function renderCsv(r: SupplyReport): string {
  const rows = r.events.map((e) =>
    [
      e.seq === null ? "" : String(e.seq),
      new Date(e.at).toISOString(),
      e.round_id === null ? "" : String(e.round_id),
      e.event,
      e.kind,
      e.account_id ?? "",
      dec(e.dollars_e6),
      dec(e.coins_e6),
      dec(e.supply_change_e6),
      dec(e.supply_after_e6),
      e.note,
    ]
      .map(csvField)
      .join(","),
  );
  return `${[CSV_HEAD.join(","), ...rows].join("\r\n")}\r\n`;
}
