import { Sprite } from "./Sprite";

export const TIN_POSES = ["resting", "coin"] as const;
export type TinPose = (typeof TIN_POSES)[number];
const FILES = ["tin-resting", "tin-coin"] as const;

type Props = { pose?: TinPose; size?: number; className?: string };

/** Tin holds the money. */
export function Tin({ pose = "resting", size = 180, className }: Props) {
  return (
    <Sprite
      file={`tin-${pose}`}
      preload={FILES}
      label={pose === "coin" ? "Tin, the money tin, taking a coin" : "Tin, the money tin"}
      size={size}
      idle={pose === "resting"}
      className={className}
    />
  );
}
