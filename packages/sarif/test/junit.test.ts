import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { convertJUnit } from "../src/index.ts"

const gradle = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="money.FxTest" tests="999" skipped="0" failures="0" errors="0">
  <testcase name="converts()" classname="money.FxTest" time="0.01"/>
  <testcase name="rounds()" classname="money.FxTest" time="0.01">
    <failure message="expected: &lt;2&gt; but was: &lt;3&gt;" type="org.opentest4j.AssertionFailedError">stack</failure>
  </testcase>
  <testcase name="explodes()" classname="money.FxTest"><error message="boom"/></testcase>
  <testcase name="later()" classname="money.FxTest"><skipped/></testcase>
</testsuite>`

const run = (files: { path: string; content: string }[]) => Effect.runSyncExit(convertJUnit("unit", files))

describe("convertJUnit", () => {
  test("counts come from test cases, not the summary attributes", () => {
    const exit = run([{ path: "TEST-money.FxTest.xml", content: gradle }])
    if (!Exit.isSuccess(exit)) throw new Error(String(exit))
    expect(exit.value.counts).toEqual({ executed: 3, passed: 1, failed: 1, errored: 1, skipped: 1 })
    expect(exit.value.run.properties?.gauntlet?.tests).toEqual(exit.value.counts)
  })

  test("failures and errors become results with decoded messages", () => {
    const exit = run([{ path: "a.xml", content: gradle }])
    if (!Exit.isSuccess(exit)) throw new Error(String(exit))
    expect(exit.value.run.results.map((r) => `${r.ruleId} ${r.message.text}`)).toEqual([
      "test/failed money.FxTest.rounds(): expected: <2> but was: <3>",
      "test/errored money.FxTest.explodes(): boom",
    ])
  })

  test("test ids are listed for deleted-test checks", () => {
    const exit = run([{ path: "a.xml", content: gradle }])
    if (!Exit.isSuccess(exit)) throw new Error(String(exit))
    expect(exit.value.tests.map((t) => t.id)).toEqual(["money.FxTest.converts()", "money.FxTest.explodes()", "money.FxTest.later()", "money.FxTest.rounds()"])
  })

  test("nested suites and several files are combined", () => {
    const nested = `<testsuites><testsuite name="outer"><testsuite name="inner"><testcase classname="a.B" name="x"/></testsuite></testsuite></testsuites>`
    const exit = run([{ path: "1.xml", content: nested }, { path: "2.xml", content: gradle }])
    if (!Exit.isSuccess(exit)) throw new Error(String(exit))
    expect(exit.value.counts.executed).toBe(4)
  })

  test("a file that isn't JUnit is JUnitInvalid", () => {
    const exit = run([{ path: "x.xml", content: "<coverage/>" }])
    expect(Exit.isFailure(exit)).toBe(true)
  })

  test("an empty report runs zero tests", () => {
    const exit = run([{ path: "x.xml", content: `<testsuite name="empty" tests="5"/>` }])
    if (!Exit.isSuccess(exit)) throw new Error(String(exit))
    expect(exit.value.counts.executed).toBe(0)
  })
})
