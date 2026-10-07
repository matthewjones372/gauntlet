import { expect, it } from "vitest"
import { money } from "../../src/domain/money.ts"
import { convert } from "../../src/settlement/fx.ts"

it("converts", () => {
  expect(convert(money(100n, "EUR"), 11_000n, "USD")).toEqual(money(110n, "USD"))
})
