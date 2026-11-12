import { Sprite } from "./Sprite";

export const SHREDDER_POSES = ["asleep", "awake"] as const;
export type ShredderPose = (typeof SHREDDER_POSES)[number];
const FILES = ["shredder-asleep", "shredder-awake"] as const;

type Props = { pose?: ShredderPose; size?: number; className?: string };

/** Shredder sleeps until something is burned. */
export function Shredder({ pose = "asleep", size = 180, className }: Props) {
  return (
    <Sprite
      file={`shredder-${pose}`}
      preload={FILES}
      label={pose === "awake" ? "Shredder, wide awake and shredding" : "Shredder, asleep"}
      size={size}
      idle={pose === "asleep"}
      className={className}
    />
  );
}
