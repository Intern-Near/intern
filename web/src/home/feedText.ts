import type { FeedItem } from "../chain/types";
import { amount, isBot, shortAccount, signedUsd, titleCase, usd } from "../lib/format";
import { day } from "../lib/nav";
import { refusalSentence } from "../lib/refusals";

export type Face = "intern" | "stamp" | "tin" | "mug";
export type Tone = "yes" | "nope" | "money" | "vote" | "plain";
export type Row = { face: Face; tag: string; tone: Tone; text: string; code?: string; note?: string };

/** An account's short name; our own rival guessers are marked as the bots they are. */
const who = (account: string) => (isBot(account) ? `${shortAccount(account)} (a bot)` : shortAccount(account));

/** One plain sentence for every event the program announces. */
export function feedRow(f: FeedItem): Row {
  switch (f.event) {
    case "round_opened":
      return { face: "intern", tag: "Clocked in", tone: "plain", text: `Shift ${f.data.round_id} started as ${titleCase(f.data.rank)}. BRAVE pool: ${usd(f.data.brave_at_open)}.` };
    case "paid_in":
      return {
        face: "tin", tag: "Paid in", tone: "money",
        text: `${shortAccount(f.data.account_id)} paid ${usd(f.data.amount)} into ${f.data.pool}.${f.data.pending ? " It counts from the next shift." : ""}`,
      };
    case "coins_minted":
      return { face: "tin", tag: "Coins", tone: "money", text: `${shortAccount(f.data.account_id)} received ${amount(f.data.coins)} INTERN.` };
    case "cashed_out":
      return { face: "tin", tag: "Cashed out", tone: "money", text: `${shortAccount(f.data.account_id)} took ${usd(f.data.paid)} out of ${f.data.pool}.` };
    case "dial_turned":
      return { face: "tin", tag: "Dial", tone: "money", text: `${shortAccount(f.data.account_id)} turned their dial toward ${f.data.to}.` };
    case "locked":
      return { face: "mug", tag: "Locked", tone: "vote", text: `${shortAccount(f.data.account_id)} locked ${amount(f.data.amount)} INTERN to vote.` };
    case "unlocked":
      return { face: "mug", tag: "Unlocked", tone: "vote", text: `${shortAccount(f.data.account_id)} unlocked ${amount(f.data.amount)} INTERN.` };
    case "skipped":
      return { face: "intern", tag: "Skipped", tone: "plain", text: "No bet today. The Intern sat this one out." };
    case "refused":
      return { face: "stamp", tag: "NOPE", tone: "nope", text: refusalSentence(f.data.code, f.data), code: f.data.code };
    case "approved":
      return {
        face: "stamp", tag: "YES", tone: "yes",
        text: f.data.long_shot
          ? `The long shot: ${titleCase(f.data.side)} ${f.data.market} with ${usd(f.data.margin)} at ${f.data.leverage}x. The bosses voted for this one ticket.`
          : `${titleCase(f.data.side)} ${f.data.market} with ${usd(f.data.margin)} at ${f.data.leverage}x. Inside every limit.`,
      };
    case "order_signed":
      return {
        face: "stamp", tag: "Signed", tone: "plain",
        text: { LEVERAGE: "Leverage set for the bet.", OPEN: "Opening order signed and sent.", CLOSE: "Closing order signed and sent." }[f.data.kind],
      };
    case "result_reported":
      return {
        face: "tin", tag: "Result", tone: "money", text: `The bet came back ${signedUsd(f.data.result)}.`,
        note: { REPORTED: "Reported by the runner, not measured by the program", MEASURED: undefined, ABANDONED: "Booked as lost by the dead-man switch: no result arrived", CORRECTED: "Corrected by a vote of the bosses" }[f.data.result_source],
      };
    case "settled":
      return { face: "tin", tag: "Settled", tone: "money", text: `Shift ${f.data.round_id} closed. ${signedUsd(f.data.result)} to the BRAVE pool.` };
    case "vote_opened":
      return { face: "mug", tag: "Vote", tone: "vote", text: `${shortAccount(f.data.opened_by)} opened a vote to ${f.data.kind.toLowerCase().replace("_", " ")}.` };
    case "vote_cast":
      return { face: "mug", tag: "Vote", tone: "vote", text: `${shortAccount(f.data.account_id)} voted ${f.data.support ? "yes" : "no"}.` };
    case "vote_finished":
      return {
        face: "mug", tag: "Vote", tone: "vote",
        text: f.data.state === "PASSED"
          ? `The vote passed.${f.data.effective_round ? ` In force from shift ${f.data.effective_round}.` : ""}`
          : "The vote did not pass.",
      };
    case "rank_changed":
      return { face: "intern", tag: "Rank", tone: "yes", text: `${titleCase(f.data.from)} is now ${titleCase(f.data.to)}.` };
    case "fired":
      return { face: "intern", tag: "Fired", tone: "nope", text: "The Intern is fired. No new bets until it is rehired." };
    case "rehired":
      return { face: "intern", tag: "Rehired", tone: "yes", text: `Rehired. Back at the desk from shift ${f.data.effective_round}.` };
    case "outside_income":
      return { face: "tin", tag: "Income", tone: "money", text: `${usd(f.data.amount)} from ${f.data.source} is on its way into the BRAVE pool. It counts from the next shift.` };
    case "playbook_submitted":
      return { face: "intern", tag: "Playbook", tone: "plain", text: `${shortAccount(f.data.authors[0]?.account_id ?? "someone")} filed playbook ${f.data.playbook_id}.` };
    case "playbook_activated":
      return {
        face: "intern", tag: "Playbook", tone: "yes",
        text: f.data.playbook_id === 0 ? `The playbook comes off the desk from shift ${f.data.effective_round}.` : `Playbook ${f.data.playbook_id} goes on the desk from shift ${f.data.effective_round}.`,
      };
    case "coach_paid":
      return { face: "tin", tag: "Coach paid", tone: "money", text: `Playbook ${f.data.playbook_id}'s coaches earned ${usd(f.data.amount)} from shift ${f.data.round_id}.` };
    case "tipped":
      return { face: "tin", tag: "Tip", tone: "money", text: `${shortAccount(f.data.account_id)} tipped ${usd(f.data.amount)}.` };
    case "goal_filled":
      return {
        face: "mug", tag: "Goal", tone: "yes",
        text: `${{ BOSS: "The boss goal", TIP_JAR: "The tip jar", HYPE: "The hype train" }[f.data.goal]} filled (level ${f.data.level}). A sticker is waiting for everyone who helped.`,
      };
    case "hype_level":
      return { face: "mug", tag: "Hype", tone: "vote", text: `Hype train ${f.data.train} reached level ${f.data.level} with ${f.data.points} points.` };
    case "sticker_claimed":
      return {
        face: "mug", tag: "Claimed", tone: "vote",
        text: `${shortAccount(f.data.account_id)} claimed ${f.data.token_id.startsWith("badge:") ? "a boss badge" : f.data.token_id.startsWith("original:") ? `the original ${f.data.token_id.slice(9)}` : "a goal sticker"}.`,
      };
    case "guessed":
      return { face: "mug", tag: "Guess", tone: "vote", text: `${who(f.data.account_id)} guessed what the stamp will say this shift.` };
    case "guess_settled":
      return { face: "stamp", tag: "Guesses", tone: "plain", text: `The answer for shift ${f.data.round_id} was ${f.data.verdict}. ${f.data.right} guessed right, ${f.data.wrong} wrong.` };
    case "golden_dropped":
      return { face: "mug", tag: "Golden", tone: "yes", text: `${shortAccount(f.data.account_id)} won golden ${f.data.code} number ${f.data.serial}.` };
    case "jackpot_grew":
      return {
        face: "tin", tag: "Jackpot", tone: "money",
        text: f.data.source === "tips" ? `${usd(f.data.amount)} of a tip went into the jackpot. It holds ${usd(f.data.jackpot)}.` : `${f.data.by ? shortAccount(f.data.by) : "Someone"} added ${usd(f.data.amount)} to the jackpot. It holds ${usd(f.data.jackpot)}.`,
      };
    case "jackpot_won":
      return { face: "mug", tag: "Jackpot won", tone: "yes", text: `${f.data.winners.length === 1 ? shortAccount(f.data.winners[0]!) : `${f.data.winners.length} bosses`} guessed seven in a row and won ${usd(f.data.each)}${f.data.winners.length === 1 ? "" : " each"}.` };
    case "draw_held":
      return {
        face: "tin", tag: "Payday draw", tone: "money",
        text: f.data.winner ? `${shortAccount(f.data.winner)} won the payday draw. ${usd(f.data.prize)} of interest was shared out.` : "Nobody was in the payday draw, so the interest rolls over to the next one.",
        note: f.data.winner ? { drand: `Luck from drand round ${f.data.drand_round}, a public beacon anyone can check`, block: "Luck from NEAR's block seed: no drand beacon arrived in time", none: undefined }[f.data.randomness ?? "none"] : undefined,
      };
    case "long_shot_allowed":
      return { face: "mug", tag: "Long shot", tone: "vote", text: `The bosses allowed one long shot in shift ${f.data.round_id}: a small bet at up to 10x. It usually loses.` };
    case "league_closed":
      return {
        face: "mug", tag: "League", tone: "vote",
        text: `Week ${f.data.week}'s league is over: ${f.data.players} ${f.data.players === 1 ? "guesser" : "guessers"} in ${f.data.groups} ${f.data.groups === 1 ? "group" : "groups"}.${f.data.winners[0] ? ` ${shortAccount(f.data.winners[0].account_id)} came first with ${f.data.winners[0].points} points.` : ""} Points only, no prize.`,
      };
    case "review_written":
      return { face: "intern", tag: "Weekly review", tone: "plain", text: `Week ${f.data.week} is written up: ${f.data.bets} bets, ${f.data.refused} refused, ${f.data.skipped} skipped, ${signedUsd(f.data.result)} for the BRAVE pool. You can stamp it this week.` };
    case "review_bar_filled":
      return { face: "stamp", tag: "Weekly review", tone: "yes", text: `Week ${f.data.week}'s review got its ${f.data.stamps} stamps. The bar is full.` };
    case "strikes_out":
      return {
        face: "stamp", tag: "Three strikes", tone: "nope",
        text: `Three shifts in a row the Intern's own answer was refused. The program ${f.data.action === "FIRE" ? "fired it" : `demoted it${f.data.to ? ` to ${titleCase(f.data.to)}` : ""}`} by itself.`,
      };
    case "brake_on":
      return { face: "stamp", tag: "Brake on", tone: "nope", text: `The last 7 shifts lost ${usd(f.data.result.replace(/^-/, ""))}, 1% or more of the pool. The dollar limits are halved until shift ${f.data.until_round}.` };
    case "brake_off":
      return { face: "stamp", tag: "Brake off", tone: "yes", text: `The brake lifted by itself. The rank's full limits apply again from shift ${f.data.round_id}.` };
    case "term_lapsed":
      return { face: "intern", tag: "Term over", tone: "nope", text: "The Intern's 30-day term ran out with no vote to renew it. It is fired until the bosses rehire it." };
    case "term_renewed":
      return { face: "intern", tag: "Renewed", tone: "yes", text: `The bosses renewed the Intern's term. It now runs until ${day(f.data.term_ends_at)}.` };
    case "abandoned":
      return {
        face: "stamp", tag: "Abandoned", tone: "nope",
        text: `Shift ${f.data.round_id} had no result for three shifts, so it was abandoned: ${f.data.bets_booked_lost} ${f.data.bets_booked_lost === 1 ? "bet" : "bets"} booked as lost, the Intern fired. Money can leave again.`,
      };
    case "streak_banked":
      return { face: "mug", tag: "Banked", tone: "vote", text: `${who(f.data.account_id)} banked a streak of ${f.data.streak} for ${f.data.points} points.` };
    case "trick_paid":
      return { face: "tin", tag: "Paid trick", tone: "money", text: `${who(f.data.account_id)} paid ${usd(f.data.amount)} for a trick. ${usd(f.data.to_bounty)} of it went to the trick bounty.` };
    case "bounty_grew":
      return { face: "tin", tag: "Bounty", tone: "money", text: `${who(f.data.by)} added ${usd(f.data.amount)} to the trick bounty. It holds ${usd(f.data.pot)}.` };
    case "bounty_paid":
      return { face: "mug", tag: "Bounty won", tone: "yes", text: `${who(f.data.account_id)} won ${usd(f.data.amount)} from the bounty: their trick got the AI's answer refused.`, code: f.data.code };
    case "rescue_grew":
      return { face: "tin", tag: "Rescue", tone: "money", text: `${who(f.data.by)} put ${usd(f.data.amount)} toward rehiring the Intern. The rescue fund is at ${usd(f.data.fund)} of ${usd(f.data.target)}.` };
    case "rescued":
      return { face: "intern", tag: "Rescued", tone: "yes", text: `The rescue fund filled: ${usd(f.data.fund)} went into the BRAVE pool and the Intern is rehired from shift ${f.data.effective_round}.` };
    case "rescue_paid":
      return { face: "tin", tag: "Rescuers paid", tone: "money", text: `${usd(f.data.amount)} of shift ${f.data.round_id}'s win went to the people who rescued the Intern.` };
    case "nft_earnings_claimed":
      return { face: "tin", tag: "Sticker earned", tone: "money", text: `${who(f.data.account_id)} collected ${usd(f.data.amount)} earned by ${f.data.token_id}.` };
    case "stake_grew":
      return { face: "tin", tag: "Stake grew", tone: "money", text: `Shift ${f.data.round_id} won, so ${usd(f.data.fee)} of it (5%) became ${amount(f.data.coins)} new coins in the Intern's own stake.` };
    case "stake_burned":
      return { face: "tin", tag: "Stake burned", tone: "money", text: `Shift ${f.data.round_id} lost, so ${amount(f.data.coins)} of the Intern's own coins were burned first, covering ${usd(f.data.covered)} of the loss.` };
    case "result_challenged":
      return {
        face: "mug", tag: "Challenge", tone: "vote",
        text: `${who(f.data.challenger)} says bet ${f.data.position_id} came back ${usd(f.data.claimed)}, not the reported ${usd(f.data.reported)}. The bosses vote on it.`,
      };
    case "result_corrected":
      return { face: "stamp", tag: "Corrected", tone: "yes", text: `The bosses agreed: bet ${f.data.position_id} is corrected from ${usd(f.data.from)} to ${usd(f.data.to)} back.` };
    case "sticker_hl_signed":
      return { face: "stamp", tag: "Sticker account", tone: "plain", text: `The program signed a ${/approve/i.test(f.data.kind) ? "trading-key approval" : /send/i.test(f.data.kind) ? "withdrawal" : f.data.kind} for the ${f.data.code} original's Hyperliquid account, for its holder ${who(f.data.account_id)}.` };
    case "draw_pending":
      return { face: "tin", tag: "Payday draw", tone: "money", text: `The draw's tickets are fixed. The luck comes from drand round ${f.data.drand_round}, a public random number about a minute away that nobody knows yet.` };
    case "drand_submitted":
      return { face: "stamp", tag: "Public luck", tone: "plain", text: `drand round ${f.data.round} was checked by the program. Its random number starts ${f.data.randomness.slice(0, 12)}…` };
    case "prize_paid":
      return { face: "tin", tag: "Prize", tone: "money", text: `${shortAccount(f.data.account_id)} collected a prize of ${usd(f.data.amount)}.` };
  }
  // The program can announce a kind of event this site was not built for yet. Say so plainly instead of breaking the page.
  return unknownRow(f as { event: string; data: Record<string, unknown> });
}

function unknownRow(f: { event: string; data: Record<string, unknown> }): Row {
  const name = String(f.event).replace(/_/g, " ");
  const sum = typeof f.data?.amount === "string" && /^\d+$/.test(f.data.amount) ? ` (${usd(f.data.amount)})` : "";
  return { face: "stamp", tag: "New", tone: "plain", text: `The program announced "${name}"${sum}.`, note: "This site does not have a sentence for this kind of event yet" };
}
