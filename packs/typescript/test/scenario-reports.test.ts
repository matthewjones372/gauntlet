import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { convertJestJson, parseStryker } from "../src/reports.ts"

// Spec 0012: what Stryker put in the code's place and what the killing test said,
// for the scenarios report; and Jest's skipped tests, which didn't run.

describe("Stryker's mutant evidence", () => {
  test("the replacement and the status reason are read", () => {
    const json = JSON.stringify({ files: { "/repo/src/fx.ts": { mutants: [
      { status: "Killed", mutatorName: "ArithmeticOperator", replacement: "a * b", statusReason: "expected 110 to be 1100\n  at fx.test.ts", location: { start: { line: 3, column: 1 } } },
      { status: "Survived", location: { start: { line: 4 } } },
    ] } } })
    const [killed, survived] = Option.getOrThrow(parseStryker(json, "/repo"))
    expect(killed).toMatchObject({ replacement: "a * b", statusReason: "expected 110 to be 1100\n  at fx.test.ts" })
    expect(survived).not.toHaveProperty("replacement")
  })
})

describe("Jest's skipped tests", () => {
  test("are named, so a scenario bound only to them didn't run", () => {
    const json = JSON.stringify({ testResults: [{ name: "/repo/test/a.test.ts", assertionResults: [{ fullName: "FX-1 works", status: "passed" }, { fullName: "FX-2 later", status: "pending" }] }] })
    expect(Option.getOrThrow(convertJestJson("unit", json, "/repo")).skipped).toEqual(["test/a.test.ts > FX-2 later"])
  })
})
