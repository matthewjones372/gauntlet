import { describe, expect, it } from "vitest"
import { add, isPositive, money } from "../../src/domain/money.ts"

describe("money", () => {
  it("adds", () => {
    expect(add(money(100n, "EUR"), money(200n, "EUR"))).toEqual(money(300n, "EUR"))
  })

  it("refuses mixed currencies", () => {
    expect(() => add(money(1n, "EUR"), money(1n, "USD"))).toThrow("currency mismatch")
  })

  it("knows when positive", () => {
    expect(isPositive(money(1n, "EUR"))).toBe(true)
    expect(isPositive(money(0n, "EUR"))).toBe(false)
  })
})
