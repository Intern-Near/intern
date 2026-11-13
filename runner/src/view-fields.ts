import { isRecord } from "./json.ts";

/**
 * Strict readers for the view answers that `books-check` and `supply-log` read (01 §8.1). As in src/contract.ts, a
 * field that is missing or has the wrong type stops the check with the field's name: a number that cannot be read
 * is never taken as zero. Amounts (01 §2: U128, a whole number written as a decimal string) come back as bigint.
 */

export class ViewShapeError extends Error {}

export function record(v: unknown, path: string): Record<string, unknown> {
  if (!isRecord(v)) throw new ViewShapeError(`${path}: expected an object`);
  return v;
}

export function field(o: Record<string, unknown>, k: string, path: string): Record<string, unknown> {
  return record(o[k], `${path}.${k}`);
}

/** A U128 of 01 §2. A JSON number is refused: 01 says never a JSON number. */
export function u128(o: Record<string, unknown>, k: string, path: string): bigint {
  const v = o[k];
  if (typeof v !== "string" || !/^(0|[1-9][0-9]*)$/.test(v))
    throw new ViewShapeError(`${path}.${k}: expected a decimal string`);
  return BigInt(v);
}

/** A bare U128 answer, as `ft_balance_of` and `ft_total_supply` give. */
export function u128Value(v: unknown, path: string): bigint {
  return u128({ v }, "v", path);
}

export function whole(o: Record<string, unknown>, k: string, path: string): number {
  const v = o[k];
  if (typeof v !== "number" || !Number.isSafeInteger(v))
    throw new ViewShapeError(`${path}.${k}: expected a whole number`);
  return v;
}

export function text(o: Record<string, unknown>, k: string, path: string): string {
  const v = o[k];
  if (typeof v !== "string") throw new ViewShapeError(`${path}.${k}: expected a string`);
  return v;
}

export function flag(o: Record<string, unknown>, k: string, path: string): boolean {
  const v = o[k];
  if (typeof v !== "boolean") throw new ViewShapeError(`${path}.${k}: expected true or false`);
  return v;
}

/** Whole units with 6 decimals (dollars or coins, 01 §2), all six shown: "-0.028930". */
export function six(e6: bigint): string {
  const neg = e6 < 0n;
  const a = neg ? -e6 : e6;
  return `${neg ? "-" : ""}${a / 1_000_000n}.${(a % 1_000_000n).toString().padStart(6, "0")}`;
}
