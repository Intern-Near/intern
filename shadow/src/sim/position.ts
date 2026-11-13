import type { Move } from "./prices.ts";
import { BPS, PPM } from "./rules01.ts";
import type { Position } from "./world.ts";

/**
 * What a bet returns at the close: its margin plus the price move on its notional, less the round-trip cost; nothing
 * if at the hold's worst price the loss reached the margin (the shadow run's rule, shadow/src/paper.ts, applied to
 * the candles' highs and lows). In a losing round the bet is set on the side that lost the real move. With no price,
 * it closes flat and pays the cost. Pure.
 */
export function positionResult(
  p: Position,
  move: Move | null,
  costBps: number,
  losing: boolean,
): { returned: bigint; liquidated: boolean; noPrice: boolean } {
  const notional = p.margin * BigInt(p.leverage);
  const cost = (notional * BigInt(costBps)) / BPS;
  if (move === null)
    return { returned: p.margin > cost ? p.margin - cost : 0n, liquidated: false, noPrice: true };
  const side = losing ? (move.exit_ppm >= PPM ? "SHORT" : "LONG") : p.side;
  const dir = side === "LONG" ? 1n : -1n;
  const worst = side === "LONG" ? move.low_ppm : move.high_ppm;
  if (dir * BigInt(worst - PPM) * BigInt(p.leverage) <= -BigInt(PPM)) {
    return { returned: 0n, liquidated: true, noPrice: false };
  }
  const back = p.margin + (notional * dir * BigInt(move.exit_ppm - PPM)) / BigInt(PPM) - cost;
  return { returned: back > 0n ? back : 0n, liquidated: false, noPrice: false };
}
