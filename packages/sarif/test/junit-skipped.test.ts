import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { convertJUnit, skippedOf } from "../src/index.ts"

// Spec 0012: a suite's record names its skipped tests, so a scenario bound only to them is not-run.

describe("skipped tests from JUnit XML", () => {
  test("are named, and absent when none was skipped", async () => {
    const xml = `<testsuite name="u"><testcase classname="svc.FxTest" name="FX-1 converts"/><testcase classname="svc.FxTest" name="FX-2 later"><skipped/></testcase></testsuite>`
    const r = await Effect.runPromise(convertJUnit("unit", [{ path: "a.xml", content: xml }]))
    expect(skippedOf(r.tests)).toEqual({ skipped: ["svc.FxTest.FX-2 later"] })
    expect(skippedOf(r.tests.filter((t) => t.status !== "skipped"))).toEqual({})
  })
})
