import NumberFlow from "@number-flow/react";
import type { Signed, U128 } from "../chain/types";

const FORMAT = { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 } as const;

/**
 * A dollar figure that rolls to its new value when it changes, and is simply there on first
 * paint (no counting up from zero). The exact whole-number value stays in the title.
 */
export function Usd({ e6, signed = false }: { e6: U128 | Signed; signed?: boolean }) {
  const value = Number(BigInt(e6)) / 1_000_000;
  return (
    <NumberFlow
      value={value}
      format={signed ? { ...FORMAT, signDisplay: "always" } : FORMAT}
      locales="en-US"
      title={`${e6} (6 decimals)`}
    />
  );
}
