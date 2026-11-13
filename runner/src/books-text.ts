import type { BooksReport } from "./books-check.ts";
import { six } from "./view-fields.ts";

/** books-check's report as text: what is owed, what holds it, place by place, the checks, the gaps, the verdict. */

const amount = (e6: string | null): string => (e6 === null ? "not read" : six(BigInt(e6))).padStart(14);

export function verdictLine(r: BooksReport): string {
  const d = r.difference_e6 === null ? 0n : BigInt(r.difference_e6);
  const failed = r.checks.filter((c) => !c.ok).length;
  const also = failed > 0 ? ` And ${failed} check(s) above failed.` : "";
  switch (r.verdict) {
    case "ADD UP":
      return `result: THE BOOKS ADD UP. The coin holds and has lent exactly what it owes, to the micro-dollar.${also}`;
    case "MOVING": {
      const coin = BigInt(r.places[0]?.difference_e6 ?? "0");
      return (
        `result: the total adds up, but ${six(coin < 0n ? -coin : coin)} sits between the coin and the lender: a loan ` +
        `or a repayment in flight at this block. Run it again.${also}`
      );
    }
    case "SURPLUS":
      return (
        `result: SURPLUS of ${six(d)}: more is held and lent than the coin owes. Either dollars came in outside the ` +
        `pay-in paths, or a payment was in flight at this block (run it again).${also}`
      );
    case "SHORT":
      return (
        `result: SHORT by ${six(-d)}: less is held and lent than the coin owes. A payment in flight at this block can ` +
        `do this for a block or two (run it again); if it stays, the books do not add up.${also}`
      );
    case "NOT CHECKED":
      return `result: NOT CHECKED: money is lent and no lender was read (pass --lender <account>).${also}`;
  }
}

export function renderBooks(r: BooksReport): string[] {
  const out: string[] = [
    `books-check: ${r.coin}, read-only, at block ${r.block.height} (${r.block.at})`,
    `Every number is read at that one block (${r.rpc}). Dollars are ${r.usdc_token} test USDC, 6 decimals.`,
    `Rule: ${r.rule}.`,
    "",
    "What the coin owes, from its own views",
  ];
  for (const o of r.owed) {
    const where = o.held_at === null ? "" : `held: ${o.held_at}; `;
    const name = o.part ? `    ${o.name}` : `  ${o.name}`;
    out.push(`${name.padEnd(34)}${amount(o.amount_e6)}  ${o.source.padEnd(29)} ${where}${o.note}`);
  }
  out.push(`${"  total owed".padEnd(34)}${amount(r.owed_total_e6)}`, "", "What holds it");
  for (const h of r.held) out.push(`${`  ${h.name}`.padEnd(34)}${amount(h.amount_e6)}  ${h.source}`);
  out.push(`${"  total held and lent".padEnd(34)}${amount(r.held_total_e6)}`, "");
  out.push(
    `${"Place by place".padEnd(34)}${"should hold".padStart(14)}${"holds".padStart(14)}${"difference".padStart(14)}`,
  );
  for (const p of r.places)
    out.push(
      `${`  ${p.place}`.padEnd(34)}${amount(p.should_hold_e6)}${amount(p.holds_e6)}${amount(p.difference_e6)}`,
    );
  out.push(
    `${"  everything".padEnd(34)}${amount(r.owed_total_e6)}${amount(r.held_total_e6)}${amount(r.difference_e6)}`,
    "",
    "Checks",
  );
  for (const c of r.checks) {
    out.push(`  ${c.ok ? "OK  " : "FAIL"}  ${c.rule}`);
    if (!c.ok) out.push(`        ${c.detail}`);
  }
  out.push("", "Also read");
  for (const i of r.info) out.push(`  - ${i}`);
  out.push("", "Not in these books: stand-ins and known gaps");
  for (const g of r.gaps) out.push(`  - ${g}`);
  out.push("", verdictLine(r));
  return out;
}
