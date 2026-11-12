import type { RankName } from "../chain/types";
import { Sprite } from "./Sprite";

export const INTERN_MOODS = [
  "idle",
  "thinking",
  "proposing",
  "waiting",
  "happy",
  "refused",
  "promoted",
  "fired",
] as const;
export type InternMood = (typeof INTERN_MOODS)[number];

const FILES = [
  "intern-idle",
  "intern-thinking",
  "intern-proposing",
  "intern-waiting",
  "intern-happy",
  "intern-refused",
  "intern-promoted",
  "intern-fired",
  "intern-analyst",
  "intern-trader",
] as const;

const MOOD_WORDS: Record<InternMood, string> = {
  idle: "calm",
  thinking: "thinking",
  proposing: "holding up a bet slip",
  waiting: "waiting nervously",
  happy: "delighted",
  refused: "flinching",
  promoted: "celebrating",
  fired: "crumpled up next to a cardboard box",
};

const RANK_WORDS: Record<RankName, string> = {
  INTERN: "the Intern",
  ANALYST: "the Intern, now an Analyst in glasses and a tie",
  TRADER: "the Intern, now a Trader in a headset and blazer",
};

type Props = { mood?: InternMood; rank?: RankName; size?: number; className?: string };

/**
 * The Intern. The rank outfit exists as art for the calm pose only, so the outfit
 * shows while idle and the plain character plays the other moods.
 */
export function Intern({ mood = "idle", rank = "INTERN", size = 240, className }: Props) {
  const file =
    mood === "idle" && rank === "ANALYST"
      ? "intern-analyst"
      : mood === "idle" && rank === "TRADER"
        ? "intern-trader"
        : `intern-${mood}`;
  return (
    <Sprite
      file={file}
      preload={FILES}
      label={`${RANK_WORDS[rank]}, ${MOOD_WORDS[mood]}`}
      size={size}
      idle={mood === "idle" || mood === "thinking" || mood === "waiting"}
      className={className}
    />
  );
}
