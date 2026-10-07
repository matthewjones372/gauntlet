import { add, type Money, money } from "../domain/money.ts"

export const total = (entries: readonly Money[], currency: string): Money =>
  entries.filter((e) => e.currency === currency).reduce((a, b) => add(a, b), money(0n, currency))

export const debugDump = (entries: readonly Money[]): string => { var out = ""; for (const e of entries) out += `${e.minor}`; return out }

export const sameCurrency = (a: Money, b: Money): boolean => a.currency == b.currency
