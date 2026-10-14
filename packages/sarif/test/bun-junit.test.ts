import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { convertJUnit, legacyBunIds, migrateTestIds } from "../src/index.ts"

// Bun's tests are named after their files (ADR 0027), and a baseline that
// names them the way older versions did still matches.

/** What `bun test --reporter=junit` (bun 1.4.2) wrote for two files, hostname aside. */
const BUN_JUNIT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="8" assertions="7" failures="1" skipped="1" time="0.032182">
  <testsuite name="test/a.test.ts" file="test/a.test.ts" tests="6" assertions="5" failures="1" skipped="1" time="0.013537" hostname="host">
    <testcase name="top" classname="" time="0.000053" file="test/a.test.ts" line="2" assertions="1" />
    <testcase name="a.b dotted" classname="" time="0.000004" file="test/a.test.ts" line="3" assertions="1" />
    <testsuite name="grp" file="test/a.test.ts" line="4" tests="4" assertions="3" failures="1" skipped="1" time="0" hostname="host">
      <testcase name="x" classname="grp" time="0.000003" file="test/a.test.ts" line="5" assertions="1" />
      <testsuite name="inner" file="test/a.test.ts" line="6" tests="3" assertions="2" failures="1" skipped="1" time="0.004" hostname="host">
        <testcase name="x" classname="inner &gt; grp" time="0.000002" file="test/a.test.ts" line="7" assertions="1" />
        <testcase name="fails" classname="inner &gt; grp" time="0.004456" file="test/a.test.ts" line="8" assertions="1">
          <failure type="AssertionError" message="expect(received).toBe(expected)&#10;&#10;Expected: 2&#10;Received: 1&#10;">AssertionError</failure>
        </testcase>
        <testcase name="skipped" classname="inner &gt; grp" time="0" file="test/a.test.ts" line="9" assertions="0">
          <skipped />
        </testcase>
      </testsuite>
    </testsuite>
  </testsuite>
  <testsuite name="test/sub/b.test.ts" file="test/sub/b.test.ts" tests="2" assertions="2" failures="0" skipped="0" time="0.000488" hostname="host">
    <testcase name="top" classname="" time="0.000003" file="test/sub/b.test.ts" line="2" assertions="1" />
    <testsuite name="grp" file="test/sub/b.test.ts" line="3" tests="1" assertions="1" failures="0" skipped="0" time="0" hostname="host">
      <testcase name="x" classname="grp" time="0.000002" file="test/sub/b.test.ts" line="3" assertions="1" />
    </testsuite>
  </testsuite>
</testsuites>`

/** The ids the same report had before (classname and name only). */
const OLD_IDS = [".a.b dotted", ".top", "grp.x", "inner > grp.fails", "inner > grp.skipped", "inner > grp.x"]

const NEW_IDS = [
  "test/a.test.ts.a.b dotted",
  "test/a.test.ts.grp.x",
  "test/a.test.ts.inner > grp.fails",
  "test/a.test.ts.inner > grp.skipped",
  "test/a.test.ts.inner > grp.x",
  "test/a.test.ts.top",
  "test/sub/b.test.ts.grp.x",
  "test/sub/b.test.ts.top",
]

const ids = (content: string) => {
  const exit = Effect.runSyncExit(convertJUnit("unit", [{ path: "junit.xml", content }]))
  if (!Exit.isSuccess(exit)) throw new Error(String(exit))
  return exit.value
}

describe("bun's test ids", () => {
  test("name the test's file, then the id it had before", () => {
    const r = ids(BUN_JUNIT)
    expect(r.tests.map((t) => t.id)).toEqual(NEW_IDS)
    expect(r.counts).toEqual({ executed: 7, passed: 6, failed: 1, errored: 0, skipped: 1 })
    expect(r.run.results[0]?.locations?.[0]?.logicalLocations?.[0]?.fullyQualifiedName).toBe("test/a.test.ts.inner > grp.fails")
  })

  test("two files' tests with the same describe path and name are two tests", () => {
    const named = ids(BUN_JUNIT).tests.map((t) => t.id)
    expect(named.filter((id) => id.endsWith(".grp.x"))).toEqual(["test/a.test.ts.grp.x", "test/sub/b.test.ts.grp.x"])
    expect(new Set(named).size).toBe(named.length)
  })

  test("paths read the same on every machine: no ./, and / as the separator", () => {
    const xml = `<testsuites name="bun test"><testsuite name="x"><testcase name="adds" classname="money" file="./test\\money.test.ts"/></testsuite></testsuites>`
    expect(ids(xml).tests.map((t) => t.id)).toEqual(["test/money.test.ts.money.adds"])
  })

  test("other runners' ids don't change, with a file attribute or without one", () => {
    const xml = `<testsuites><testsuite name="svc"><testcase classname="svc.FxTest" name="converts" file="test/fx.py"/><testcase classname="" name="top" file="a.test.ts"/></testsuite></testsuites>`
    expect(ids(xml).tests.map((t) => t.id)).toEqual([".top", "svc.FxTest.converts"])
    const noFile = `<testsuites name="bun test"><testsuite name="x"><testcase name="adds" classname="money"/></testsuite></testsuites>`
    expect(ids(noFile).tests.map((t) => t.id)).toEqual(["money.adds"])
  })
})

describe("baselines recorded before bun's tests named their files", () => {
  test("a bun id's older spellings are the id without its file, keeping a build's folder", () => {
    expect(legacyBunIds("test/a.test.ts.grp.x")).toEqual(["grp.x", ".grp.x"])
    expect(legacyBunIds("test/a.test.ts.top")).toEqual(["top", ".top"])
    expect(legacyBunIds("web:test/a.test.tsx.grp.x")).toEqual(["web:grp.x", "web:.grp.x"])
    expect(legacyBunIds("svc.FxTest.converts")).toEqual([])
  })

  test("every old id takes its new name when nothing was removed, and counts stay the same", () => {
    const migrated = migrateTestIds(OLD_IDS, NEW_IDS)
    expect(migrated).toHaveLength(OLD_IDS.length)
    expect(migrated.every((id) => NEW_IDS.includes(id))).toBe(true)
    expect(migrated.slice(2)).toEqual(["test/a.test.ts.grp.x", "test/a.test.ts.inner > grp.fails", "test/a.test.ts.inner > grp.skipped", "test/a.test.ts.inner > grp.x"])
  })

  test("an old id no new id carries stays as it was: that test is gone", () => {
    const head = NEW_IDS.filter((id) => !id.endsWith("inner > grp.fails"))
    expect(migrateTestIds(OLD_IDS, head).filter((id) => !head.includes(id))).toEqual(["inner > grp.fails"])
  })

  test("an old id shared by two files' tests still runs while either does", () => {
    // `grp.x` was one id for both files' tests: dropping one of them can't be told from the old baseline.
    const head = NEW_IDS.filter((id) => id !== "test/sub/b.test.ts.grp.x")
    expect(migrateTestIds(["grp.x", ".top"], head)).toEqual(["test/a.test.ts.grp.x", "test/a.test.ts.top"])
    expect(migrateTestIds(["grp.x"], NEW_IDS).every((id) => NEW_IDS.includes(id))).toBe(true)
  })

  test("a build's tests keep their folder, and ids already current are left alone", () => {
    expect(migrateTestIds(["web:grp.x", "api:grp.x", "svc.FxTest.converts"], ["web:test/a.test.ts.grp.x", "svc.FxTest.converts"]))
      .toEqual(["web:test/a.test.ts.grp.x", "api:grp.x", "svc.FxTest.converts"])
    expect(migrateTestIds(NEW_IDS, NEW_IDS)).toEqual(NEW_IDS)
  })
})
