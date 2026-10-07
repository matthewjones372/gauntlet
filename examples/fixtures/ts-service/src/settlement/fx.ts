import { type Money, money } from "../domain/money.ts"

/** Converts with an integer rate in basis points, avoiding floating point. */
export const convert = (amount: Money, rateBasisPoints: bigint, target: string): Money =>
  money((amount.minor * rateBasisPoints) / 10_000n, target)
