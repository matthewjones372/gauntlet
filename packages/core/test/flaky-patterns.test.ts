import { describe, expect, test } from "bun:test"
import { withoutStrings } from "../src/index.ts"

describe("finding retries and risky code in test files", () => {
  test("string contents in test code are data, not configuration", () => {
    expect(withoutStrings(`r.write({ "a.txt": "retry\\n// @RetryingTest(3)" }) // retries: 2`)).toBe(`r.write({ "": "" }) // retries: 2`)
    expect(withoutStrings("it('waits', () => Thread.sleep(10))")).toBe("it('', () => Thread.sleep(10))")
    expect(withoutStrings("const s = `a ${b} \\` c`; Math.random()")).toBe("const s = ``; Math.random()")
  })
})
