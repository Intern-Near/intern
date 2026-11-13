import { isBot, shortAccount } from "../lib/format";

/** An account's short name. Our own rival guessers (accounts named "rival-…") always carry a BOT tag. */
export function Who({ account, max }: { account: string; max?: number }) {
  return (
    <>
      {shortAccount(account, max)}
      {isBot(account) && (
        <span className="bot-tag" title="A bot run by this project's own runner">
          BOT
        </span>
      )}
    </>
  );
}

/** The one line that explains the BOT tag. */
export const BOT_LINE =
  "Accounts marked BOT are three bots run by this project's own runner. They guess once a shift like anyone else, and their points have no value.";
