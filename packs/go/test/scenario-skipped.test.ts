import { describe, expect, test } from "bun:test"
import { convertGoTest } from "../src/reports.ts"

// Spec 0012: a skipped Go test didn't run, so a scenario bound only to it is not-run.

const events = (es: object[]) => es.map((e) => JSON.stringify(e)).join("\n")

describe("go test's skipped tests", () => {
  test("are named", () => {
    const r = convertGoTest("unit", events([
      { Action: "pass", Package: "example.com/svc/money", Test: "TestAdd" },
      { Action: "skip", Package: "example.com/svc/money", Test: "TestLater" },
    ]), "example.com/svc")
    expect(r.skipped).toEqual(["example.com/svc/money.TestLater"])
    expect(r.ids).toContain("example.com/svc/money.TestLater")
  })
})
