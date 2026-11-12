import { Sprite } from "./Sprite";

export const STAMP_POSES = ["watching", "slamming", "landed"] as const;
export type StampPose = (typeof STAMP_POSES)[number];

const FILES = ["stamp-watching", "stamp-slamming", "stamp-landed"] as const;
const WORDS: Record<StampPose, string> = {
  watching: "watching",
  slamming: "in the air, about to come down",
  landed: "just landed",
};

type Props = { pose?: StampPose; size?: number; className?: string };

/** Stamp is the program. It says only YES or NOPE. */
export function Stamp({ pose = "watching", size = 200, className }: Props) {
  return (
    <Sprite
      file={`stamp-${pose}`}
      preload={FILES}
      label={`Stamp, the program, ${WORDS[pose]}`}
      size={size}
      idle={pose === "watching"}
      className={className}
    />
  );
}
