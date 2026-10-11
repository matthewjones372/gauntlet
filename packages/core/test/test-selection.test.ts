import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import type { ProtectGroup } from "@gauntlet/ir"
import { emptyBaseline } from "@gauntlet/sarif"
import { Effect, Option } from "effect"
import { jvm } from "../../dsl/test/fixtures/catalog.ts"
import { deselectedBy, type DiffFacts, excusedBySelection, type Pack, runIntegrity, selectTests, type SelectionInput, suiteSelections, testPathMatcher, testsToCompare } from "../src/index.ts"
import { compiled, noFacts } from "./fixtures.ts"

// Running the tests a change affects (spec 0013): the map recorded on trunk
// says which files each test class executed; a change runs the classes that
// executed a file it touches, plus the test files it adds.

const MAP = {
  "svc.MoneyTest": ["src/main/kotlin/svc/Money.kt", "src/test/kotlin/svc/MoneyTest.kt", "src/test/kotlin/svc/Fixtures.kt"],
  "svc.FxTest": ["src/main/kotlin/svc/Fx.kt", "src/main/kotlin/svc/Money.kt", "src/test/kotlin/svc/FxTest.kt"],
  "svc.ClusterSpec": ["src/main/kotlin/svc/Cluster.kt", "src/test/kotlin/svc/ClusterSpec.kt", "src/test/kotlin/svc/Fixtures.kt"],
}
const protect: ProtectGroup[] = [
  { group: "tests", kind: "tests", globs: ["src/test/**"] },
  { group: "fixtures", kind: "fixtures", globs: ["src/test/resources/**"] },
  { group: "gauntlet", kind: "gauntlet", globs: [".gauntlet/**"] },
]
const modified = (path: string) => ({ path, status: "modified" as const })
const added = (path: string) => ({ path, status: "added" as const })
const input = (over: Partial<SelectionInput> = {}): SelectionInput => ({
  map: MAP,
  changes: [modified("src/main/kotlin/svc/Fx.kt")],
  dir: ".",
  buildDirs: ["."],
  prefixed: false,
  location: "src/test/**",
  isTestPath: (p) => p.startsWith("src/test/"),
  protect,
  buildConfig: ["**/*.gradle.kts", "gradle.properties"],
  dependencyChanges: [],
  ...over,
})

describe("selecting the tests a change affects", () => {
  test("the classes that executed a changed main file run, and the rest are left out", () => {
    expect(selectTests(input())).toEqual({ kind: "some", classes: ["svc.FxTest"], files: [], deselected: ["svc.ClusterSpec", "svc.MoneyTest"] })
    expect(selectTests(input({ changes: [modified("src/main/kotlin/svc/Money.kt")] }))).toMatchObject({ classes: ["svc.FxTest", "svc.MoneyTest"], deselected: ["svc.ClusterSpec"] })
  })

  test("a changed test helper runs every class that used it, and a new test file runs as a file", () => {
    expect(selectTests(input({ changes: [modified("src/test/kotlin/svc/Fixtures.kt"), added("src/test/kotlin/svc/NewTest.kt")] })))
      .toEqual({ kind: "some", classes: ["svc.ClusterSpec", "svc.MoneyTest"], files: ["src/test/kotlin/svc/NewTest.kt"], deselected: ["svc.FxTest"] })
  })

  test("documentation doesn't count, and a renamed file counts by both its names", () => {
    expect(selectTests(input({ changes: [modified("README.md"), { path: "src/main/kotlin/svc/Rates.kt", oldPath: "src/main/kotlin/svc/Fx.kt", status: "renamed" }] })))
      .toMatchObject({ kind: "some", classes: ["svc.FxTest"] })
  })

  test("everything runs without a map, or for a build the map has nothing of", () => {
    expect(selectTests(input({ map: undefined }))).toMatchObject({ kind: "all", reason: expect.stringContaining("no map") })
    expect(selectTests(input({ dir: "lark-bank", buildDirs: ["lark-bank", "events"], prefixed: true, changes: [modified("lark-bank/src/main/kotlin/A.kt")] })))
      .toMatchObject({ kind: "all", reason: expect.stringContaining("no map") })
    expect(selectTests(input({ changes: undefined }))).toMatchObject({ kind: "all", reason: expect.stringContaining("recorded") })
  })

  test("everything runs when the change touches build configuration, test setup or fixtures, or adds a dependency", () => {
    expect(selectTests(input({ changes: [modified("src/main/kotlin/svc/Fx.kt"), modified("build.gradle.kts")] }))).toMatchObject({ kind: "all", reason: expect.stringContaining("build.gradle.kts") })
    expect(selectTests(input({ changes: [modified("src/test/resources/rates.json")] }))).toMatchObject({ kind: "all", reason: expect.stringContaining("fixtures") })
    expect(selectTests(input({ dependencyChanges: [{ manifest: "build.gradle.kts", added: ["a:b"], removed: [], unparsed: false }] }))).toMatchObject({ kind: "all", reason: expect.stringContaining("dependency") })
  })

  test("a policy or baseline change doesn't touch what the tests run", () => {
    expect(selectTests(input({ changes: [modified("src/main/kotlin/svc/Fx.kt"), modified(".gauntlet/baseline.sarif")] }))).toMatchObject({ kind: "some" })
  })

  test("everything runs for a main file the map has never seen, or a test file it doesn't know", () => {
    expect(selectTests(input({ changes: [added("src/main/kotlin/svc/Ledger.kt")] }))).toMatchObject({ kind: "all", reason: expect.stringContaining("src/main/kotlin/svc/Ledger.kt") })
    expect(selectTests(input({ changes: [modified("src/main/resources/application.conf")] }))).toMatchObject({ kind: "all", reason: expect.stringContaining("application.conf") })
    expect(selectTests(input({ changes: [modified("src/test/kotlin/svc/Helpers.kt")] }))).toMatchObject({ kind: "all" })
  })

  test("a deleted test file selects nothing by itself: integrity catches the deletion", () => {
    expect(selectTests(input({ changes: [modified("src/main/kotlin/svc/Fx.kt"), { path: "src/test/kotlin/svc/GoneTest.kt", status: "deleted" }] })))
      .toMatchObject({ kind: "some", classes: ["svc.FxTest"] })
  })

  test("a change with nothing the map knows of in the build runs everything", () => {
    expect(selectTests(input({ changes: [modified("docs/notes.md")] }))).toMatchObject({ kind: "all" })
  })

  test("with several builds, only the build's own files and classes count, by their prefixed names", () => {
    const map = { "lark-bank:svc.FxTest": ["lark-bank/src/main/kotlin/svc/Fx.kt"], "lark-bank:svc.MoneyTest": ["lark-bank/src/main/kotlin/svc/Money.kt"], "events:e.ETest": ["lark-bank/events/src/main/kotlin/E.kt"] }
    const s = selectTests(input({
      map,
      dir: "lark-bank",
      buildDirs: ["lark-bank", "lark-bank/events"],
      prefixed: true,
      location: "**/src/test/**",
      isTestPath: (p) => p.includes("/src/test/"),
      protect: [],
      changes: [modified("lark-bank/src/main/kotlin/svc/Fx.kt"), added("lark-bank/events/src/main/kotlin/New.kt")],
    }))
    expect(s).toEqual({ kind: "some", classes: ["svc.FxTest"], files: [], deselected: ["lark-bank:svc.MoneyTest"] })
  })
})

describe("what selection excuses", () => {
  test("base tests of a class left out aren't missing; a class that ran is compared as usual", () => {
    const base = ["svc.FxTest.converts", "svc.MoneyTest.adds", "svc.MoneyTest.subtracts", "svc.Outer$Inner.x", "svc.MoneyTestable.y"]
    expect(excusedBySelection(base, ["svc.MoneyTest", "svc.Outer"])).toEqual(["svc.MoneyTest.adds", "svc.MoneyTest.subtracts", "svc.Outer$Inner.x"])
    expect(excusedBySelection(base, [])).toEqual([])
  })
})

describe("integrity with selection", () => {
  const { ir } = compiled(`gauntlet "svc"
use jvm
owners @platform
protect { tests "src/test/**" }
suites { unit "src/test/**" affected }
integrity { ratchet executed tests }
gates { verify { unit } }
`)
  const baseline = Option.some({
    ...emptyBaseline("m", "h", "0"),
    testIds: ["svc.FxTest.converts", "svc.MoneyTest.adds", "svc.MoneyTest.subtracts"],
    metrics: { "integrity/executed-tests": { value: 3, unit: "count" as const, higherIsBetter: true } },
  })
  const judged = (deselected: string[], ids = ["svc.FxTest.converts"], files: DiffFacts["files"] = []) => {
    const compared = testsToCompare(baseline, { tests: { counts: { executed: ids.length, passed: ids.length, failed: 0, errored: 0, skipped: 0 }, ids }, deselected })
    const r = Effect.runSync(runIntegrity({
      ir, facts: noFacts({ files }), readBase: () => Effect.succeed(Option.none()), readHead: () => Effect.succeed(Option.none()),
      isTestPath: testPathMatcher(ir), headFiles: [], dir: "/nonexistent", ...compared,
    }, []).pipe(Effect.provide(BunServices.layer)))
    return { compared, findings: r.findings.map((f) => `${f.kind} ${f.check}${f.path ? ` ${f.path}` : ""}`) }
  }

  test("tests of a class left out are neither missing nor counted against the ratchet", () => {
    const { compared, findings } = judged(["svc.MoneyTest"])
    expect(compared.baseTestIds).toEqual(["svc.FxTest.converts"])
    expect(compared.baselineMetrics["integrity/executed-tests"]?.value).toBe(1)
    expect(findings).toEqual([])
  })

  test("without selection the same run is missing tests", () => {
    expect(judged([]).findings).toEqual(["forbid deleted-tests", "forbid deleted-tests", "ratchet executed-tests"])
  })

  test("a test of a class that ran, gone from it, is still missing; a deleted test file is still forbidden", () => {
    expect(judged(["svc.MoneyTest"], ["svc.FxTest.other"]).findings).toEqual(["forbid deleted-tests"])
    expect(judged(["svc.MoneyTest"], ["svc.FxTest.converts"], [{ path: "src/test/kotlin/svc/MoneyTest.kt", status: "deleted", added: 0, removed: 9 }]).findings)
      .toEqual(["forbid deleted-tests src/test/kotlin/svc/MoneyTest.kt"])
  })
})

describe("each affected suite's selection", () => {
  const ir = (gates: string, suites = `unit "src/test/**" affected\n  slow "src/it/**"`) => compiled(`gauntlet "svc"
use jvm
owners @platform
suites {
  ${suites}
}
gates { verify { ${gates} } }
`).ir
  const pack = (over: Partial<Pack> = {}): Pack => ({ spec: jvm, runnerConfig: ["gradle.properties"], manifests: ["**/*.gradle.kts"], detectors: [], gates: {}, runSuite: () => Effect.die("unused"), reruns: true, testMaps: true, ...over })
  const select = (i: ReturnType<typeof ir>, p = pack(), facts = { base: "b", head: "h", dependencyChanges: [] }) =>
    suiteSelections({ ir: i, packs: [p], facts, map: MAP, changes: [modified("src/main/kotlin/svc/Fx.kt")], isTestPath: (x) => x.startsWith("src/test/") })

  test("only affected suites are selected for", () => {
    const s = select(ir("unit, slow"))
    expect([...s.keys()]).toEqual(["unit"])
    expect(s.get("unit")?.get(".")).toMatchObject({ kind: "some", classes: ["svc.FxTest"] })
    expect(deselectedBy(s)).toEqual(["svc.ClusterSpec", "svc.MoneyTest"])
  })

  test("everything runs on trunk, with coverage of the whole project, or for a pack that can't run part of a suite", () => {
    expect(select(ir("unit"), pack(), { base: "h", head: "h", dependencyChanges: [] }).get("unit")?.get(".")).toEqual({ kind: "all", reason: "the check runs on trunk" })
    expect(select(ir("unit, coverage >= 80%")).get("unit")?.get(".")).toMatchObject({ kind: "all", reason: expect.stringContaining("coverage of the whole project") })
    expect(select(ir("unit, coverage >= 80% on changed")).get("unit")?.get(".")).toMatchObject({ kind: "some" })
    expect(select(ir("unit"), pack({ testMaps: false })).get("unit")?.get(".")).toMatchObject({ kind: "all", reason: expect.stringContaining("can't run part of a suite") })
  })
})
