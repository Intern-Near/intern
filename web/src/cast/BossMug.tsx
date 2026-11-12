import type { CSSProperties } from "react";
import "./cast.css";

/** The room's colours a mug may take. Ink text stays readable on all of them. */
const MUG_COLOURS = ["#FFD23F", "#19C37D", "#FF5A47", "#6BB8FF", "#FFB8C6", "#FFFFFF"] as const;

/** The same account always gets the same colour. */
export function mugColour(accountId: string): string {
  let h = 0;
  for (let i = 0; i < accountId.length; i++) h = (h * 31 + accountId.charCodeAt(i)) >>> 0;
  return MUG_COLOURS[h % MUG_COLOURS.length]!;
}

type Props = { accountId: string; size?: number; className?: string };

/** One coffee mug per boss, tinted from the account name. */
export function BossMug({ accountId, size = 56, className }: Props) {
  const style = {
    width: size,
    height: size,
    "--mug-src": 'url("/cast/mug-mug.webp")',
  } as CSSProperties;
  return (
    <span className={["mug", className ?? ""].join(" ").trim()} style={style} role="img" aria-label={`Mug of ${accountId}`}>
      <img src="/cast/mug-mug.webp" alt="" width={size} height={size} draggable={false} />
      <span className="mug-tint" style={{ background: mugColour(accountId) }} />
    </span>
  );
}
