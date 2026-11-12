import { useEffect } from "react";
import "./cast.css";

type Props = {
  /** File name without extension, in /cast/ */
  file: string;
  /** Every file this character can show, fetched ahead so a pose change never flashes */
  preload: readonly string[];
  /** What a screen reader hears. Empty string hides the image from it. */
  label: string;
  /** Edge length in CSS pixels */
  size: number;
  /** Gentle breathing while nothing is happening */
  idle?: boolean;
  className?: string;
};

const src = (file: string) => `/cast/${file}.webp`;

/**
 * One character image on the shared square canvas. All poses of a character have
 * their feet on the same line, so swapping the file never moves the character.
 * A pose change plays a quick squash-and-pop from the feet.
 */
export function Sprite({ file, preload, label, size, idle = false, className }: Props) {
  useEffect(() => {
    for (const f of preload) {
      const img = new Image();
      img.src = src(f);
    }
  }, [preload]);

  return (
    <span
      className={["sprite", idle ? "sprite-idle" : "", className ?? ""].join(" ").trim()}
      style={{ width: size }}
      role={label ? "img" : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : true}
    >
      <img key={file} className="sprite-img" src={src(file)} alt="" width={size} height={size} draggable={false} />
    </span>
  );
}
