/** An amount in minor units (cents), so money never goes through floating point. */
export interface Money {
  readonly minor: bigint
  readonly currency: string
}

export const money = (minor: bigint, currency: string): Money => ({ minor, currency })

export const add = (a: Money, b: Money): Money => {
  if (a.currency !== b.currency) throw new Error(`currency mismatch: ${a.currency} vs ${b.currency}`)
  return money(a.minor + b.minor, a.currency)
}

export const isPositive = (m: Money): boolean => m.minor > 0n
