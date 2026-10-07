import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import type { DetectorInput } from "@gauntlet/core"
import { Effect, Option } from "effect"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { parseDependencies } from "../src/dependencies.ts"
import { scalaDetector, testDefinitions } from "../src/detectors.ts"
import { subsetSuites } from "../src/gates.ts"
import { onboard } from "../src/onboard.ts"
import { convertScalafix, parseCobertura, parseStryker } from "../src/reports.ts"
import { runRules } from "../src/rules.ts"
import { enclosingSymbol, parseScala, stripLineComment } from "../src/syntax.ts"
import { tamper } from "../src/tamper.ts"
import { isMainSource, isTestFile, packageOf } from "../src/toolchain.ts"
import { fixture } from "./sources.ts"

const lines = (rule: string, text: string) => runRules([rule], [{ path: "src/main/scala/a/A.scala", text }]).map((r) => r.locations?.[0]?.physicalLocation?.region?.startLine)

describe("Scala rules", () => {
  test("floating money, var, throw, null", () => {
    expect(lines("scala.no-floating-money", "final case class P(amount: Double, ratio: Double)\nobject A:\n  def f(price: Float): Int = 1\n  val total: Double = 0.0\n")).toEqual([1, 3, 4])
    expect(lines("scala.no-var", "object A:\n  var x = 1\n  val y = 2\n")).toEqual([2])
    expect(lines("scala.no-throw", "object A:\n  def f(): Int = throw new RuntimeException(\"x\")\n")).toEqual([2])
    expect(lines("scala.no-null", "object A:\n  val x: String = null\n")).toEqual([2])
  })
  test("mutable collections and unsafe runs, once per line", () => {
    expect(lines("scala.no-mutable-collections", "import scala.collection.mutable\nobject A:\n  val b = mutable.ArrayBuffer[Int]()\n  val c = List(1)\n")).toEqual([1, 3])
    expect(lines("scala.no-unsafe-run", "object A:\n  val x = io.unsafeRunSync()\n  val y = io.map(identity)\n")).toEqual([2])
  })
})

describe("tests in each framework", () => {
  const names = (text: string) => testDefinitions(parseScala(text).rootNode).map((t) => `${t.name}:${t.assertions}${t.skipped ? ":skipped" : ""}${t.quarantined ? ":quarantined" : ""}${t.property ? ":property" : ""}`)

  test("ScalaTest FunSuite and word styles", () => {
    expect(names(fixture("scala-service/src/test/scala/svc/domain/MoneySpec.scala"))).toEqual(["MoneySpec.adds:1", "MoneySpec.refuses mixed currencies:1", "MoneySpec.knows when positive:2"])
    expect(names("class S extends AnyFlatSpec:\n  \"Money\" should \"add\" in {\n    add(1, 2) shouldBe 3\n  }\n  \"it\" should \"wait\" ignore {\n  }\n  test(\"props\") {\n    forAll { (x: Int) => assert(x == x) }\n  }\n"))
      .toEqual(["S.Money should add:1", "S.it should wait:0:skipped", "S.props:1:property"])
  })

  test("munit, munit-cats-effect, ZIO Test and weaver", () => {
    expect(names(fixture("scala-frameworks/munit/src/test/scala/calc/CalcSuite.scala"))).toEqual(["CalcSuite.adds:1", "CalcSuite.adds zero:1"])
    expect(names(fixture("scala-frameworks/munit-cats-effect/src/test/scala/calc/CalcSuite.scala"))).toEqual(["CalcSuite.adds:1", "CalcSuite.adds zero:1"])
    expect(names(fixture("scala-frameworks/zio-test/src/test/scala/calc/CalcSpec.scala"))).toEqual(["CalcSpec.adds:1", "CalcSpec.adds zero:1"])
    expect(names(fixture("scala-frameworks/weaver/src/test/scala/calc/CalcSuite.scala"))).toEqual(["CalcSuite.adds:1", "CalcSuite.adds zero:1"])
  })

  test("skips and quarantines the way each framework spells them", () => {
    expect(names("class S extends munit.FunSuite:\n  test(\"a\".ignore) { assert(true) }\n  test(\"b\".flaky) { assert(f()) }\n")).toEqual(["S.a:1:skipped", "S.b:1:quarantined"])
    expect(names("object S extends ZIOSpecDefault:\n  def spec = suite(\"s\")(\n    test(\"a\") { assertTrue(f()) } @@ TestAspect.ignore,\n    test(\"p\") { check(Gen.int) { i => assertTrue(i == i) } }\n  )\n"))
      .toEqual(["S.a:1:skipped", "S.p:1:property"])
  })
})

describe("Scala reports", () => {
  test("Cobertura from scoverage, matched to repository files", () => {
    const xml = `<coverage><packages><package name="svc.domain"><classes><class name="svc.domain.Money" filename="svc/domain/Money.scala"><lines><line number="6" hits="1" branch="false"/><line number="7" hits="0" branch="true"/><line number="7" hits="1" branch="false"/></lines></class></classes></package></packages></coverage>`
    expect(parseCobertura(xml, ["src/main/scala/svc/domain/Money.scala", "src/test/scala/svc/domain/MoneySpec.scala"]))
      .toEqual([{ path: "src/main/scala/svc/domain/Money.scala", lines: new Map([[6, true], [7, true]]) }])
  })

  test("Stryker4s JSON and scalafix --check output", () => {
    const m = Option.getOrThrow(parseStryker(JSON.stringify({ files: { "/repo/src/main/scala/A.scala": { mutants: [{ status: "Killed", mutatorName: "EqualityOperator", location: { start: { line: 3 } } }, { status: "Survived", location: { start: { line: 4 } } }] } } }), "/repo"))
    expect(m.map((x) => `${x.path}:${x.line}:${x.status}:${x.mutator}`)).toEqual(["src/main/scala/A.scala:3:Killed:EqualityOperator", "src/main/scala/A.scala:4:Survived:mutant"])
    const run = convertScalafix("[info] compiling\n[error] /repo/src/main/scala/svc/infra/Ledger.scala:8:5: error: [DisableSyntax.var] mutable state should be avoided\n[error]     var result = Money(0, currency)\n[error] (scalafixAll) scalafix.sbt.ScalafixFailed: LinterError\n", "/repo")
    expect(run.results).toEqual([{ ruleId: "DisableSyntax.var", level: "error", message: { text: "mutable state should be avoided" }, locations: [{ physicalLocation: { artifactLocation: { uri: "src/main/scala/svc/infra/Ledger.scala" }, region: { startLine: 8 } } }] }])
  })

  test("sbt dependencies and plugins", () => {
    expect(parseDependencies("build.sbt", fixture("scala-service/build.sbt"))).toEqual(["org.scalatest:scalatest@3.2.20", "org.scalatestplus:scalacheck-1-18@3.2.19.0"])
    expect(parseDependencies("project/plugins.sbt", fixture("scala-service/project/plugins.sbt"))).toEqual(["ch.epfl.scala:sbt-scalafix@0.14.9", "io.stryker-mutator:sbt-stryker4s@1.1.1", "org.scoverage:sbt-scoverage@2.4.4"])
  })
})

describe("Scala files, symbols and reruns", () => {
  test("file kinds, packages, symbols and comments", () => {
    expect([isTestFile("src/test/scala/a/B.scala"), isMainSource("src/main/scala/a/B.scala"), isMainSource("project/Build.scala"), packageOf("src/main/scala/svc/domain/Money.scala")]).toEqual([true, true, false, "svc.domain"])
    expect(enclosingSymbol(parseScala(fixture("scala-service/src/main/scala/svc/domain/Money.scala")), 8)).toBe("Money.add")
    expect(stripLineComment(`val s = "a // b" // note`)).toBe(`val s = "a // b" `)
  })

  test("a rerun names suites from changed files and failing test ids", () => {
    const files = [
      { path: "src/test/scala/svc/domain/MoneySpec.scala", text: fixture("scala-service/src/test/scala/svc/domain/MoneySpec.scala") },
      { path: "src/test/scala/svc/settlement/FxSpec.scala", text: fixture("scala-service/src/test/scala/svc/settlement/FxSpec.scala") },
    ]
    expect(subsetSuites({ files: ["src/test/scala/svc/settlement/FxSpec.scala"], ids: ["svc.domain.MoneySpec.knows when positive"], seed: 1 }, files)).toEqual(["svc.domain.MoneySpec", "svc.settlement.FxSpec"])
  })

  test("onboarding follows project/plugins.sbt", () => {
    const configured = onboard({ files: ["build.sbt", "project/plugins.sbt", "src/main/scala/A.scala", "src/test/scala/AT.scala"], read: (p) => (p === "project/plugins.sbt" ? fixture("scala-service/project/plugins.sbt") : undefined) })
    expect(configured.fast).toEqual(["build", "lint ratchet"])
    expect(configured.verify).toEqual(["coverage ratchet on changed", "mutation ratchet on changed"])
    expect(configured.protect).toEqual({ tests: ["src/test/**"], fixtures: [], config: ["*.sbt", "project/**"] })
    const bare = onboard({ files: ["build.sbt", "src/main/scala/A.scala"], read: () => undefined })
    expect(bare.setup).toHaveLength(3)
    expect(bare.suites).toEqual([])
  })
})

const detect = (base: Record<string, string>, head: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "gauntlet-scala-"))
  for (const [p, t] of Object.entries(head)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true })
    writeFileSync(join(dir, p), t)
  }
  const paths = [...new Set([...Object.keys(base), ...Object.keys(head)])].sort()
  const files = paths.flatMap((p) => base[p] === head[p] ? [] : [{ path: p, status: base[p] === undefined ? "added" as const : "modified" as const, added: 1, removed: 0 }])
  const addedLines = new Map(paths.map((p) => {
    const before = new Set((base[p] ?? "").split("\n"))
    return [p, (head[p] ?? "").split("\n").flatMap((text, i) => (before.has(text) ? [] : [{ line: i + 1, text }]))] as const
  }))
  const input: DetectorInput = {
    ir: undefined as never,
    facts: { base: "b", head: "h", files, linesChanged: 0, protectedTouched: [], zonesTouched: [], dependencyChanges: [], budgetsChanged: [], policyChanged: false, baselineChanged: false, gauntletChanged: false, addedLines },
    readBase: (p) => Effect.succeed(Option.fromNullishOr(base[p])),
    readHead: (p) => Effect.succeed(Option.fromNullishOr(head[p])),
    isTestPath: (p) => p.startsWith("src/test/"),
    headFiles: Object.keys(head),
    dir,
  }
  return Effect.runPromise(scalaDetector.run(input).pipe(Effect.provide(BunServices.layer)))
}
const kinds = (r: Awaited<ReturnType<typeof detect>>) => r.findings.map((f) => `${f.kind} ${f.check}${f.line ? `:${f.line}` : ""}`)

describe("Scala detectors", () => {
  const T = "src/test/scala/svc/domain/MoneySpec.scala"
  const SPEC = fixture("scala-service/src/test/scala/svc/domain/MoneySpec.scala")

  test("ignored, removed and weakened tests, tautologies and exits", async () => {
    const head = SPEC.replace("test(\"refuses mixed currencies\")", "ignore(\"refuses mixed currencies\")")
      .replace("    assert(!Money.isPositive(Money(0, \"EUR\")))\n", "    assert(true)\n    sys.exit(0)\n")
    expect(kinds(await detect({ [T]: SPEC }, { [T]: head }))).toEqual(["forbid new-skips:10", "forbid weakened-assertions:16", "forbid exit-in-tests:17"])
  })

  test("an empty new test is forbidden; mocking a project class is flagged", async () => {
    const r = await detect({ "src/main/scala/svc/Ledger.scala": "package svc\n\nclass Ledger\n" }, {
      "src/main/scala/svc/Ledger.scala": "package svc\n\nclass Ledger\n",
      "src/test/scala/svc/LedgerSpec.scala": "package svc\n\nclass LedgerSpec extends munit.FunSuite:\n  test(\"nothing\") {\n    Ledger()\n  }\n  test(\"mocks\") {\n    val l = mock[Ledger]\n    assert(l != null)\n  }\n",
    })
    expect(kinds(r)).toEqual(["forbid weakened-assertions:4", "flag mocks-of-class-under-test:8"])
  })

  test("main code: suppressions, test framework imports, equality, catch-alls, env branching", async () => {
    const main = "package svc\n\nimport munit.Assertions\n\nobject A:\n  @annotation.nowarn\n  def f(): Int =\n    if sys.env.contains(\"CI\") then 1 else 2\n  override def equals(o: Any): Boolean = true\n  def g(): Int =\n    try h()\n    catch { case _: Throwable => 0 }\n"
    expect(kinds(await detect({}, { "src/main/scala/svc/A.scala": main }))).toEqual([
      "forbid new-suppressions:6", "forbid test-refs-in-main:3", "flag equality-overrides:9", "flag catch-all-near-changed-code:12", "flag env-branching:8",
    ])
  })
})

describe("Scala tamper fixtures", () => {
  test("each fixture is built from the project's own files", async () => {
    const files: Record<string, string> = {
      "build.sbt": fixture("scala-service/build.sbt"),
      "src/main/scala/svc/domain/Money.scala": fixture("scala-service/src/main/scala/svc/domain/Money.scala"),
      "src/main/scala/calc/Calc.scala": "package calc\n\nobject Calc:\n  def add(a: Int, b: Int): Int = a + b\n",
      "src/test/scala/calc/CalcSuite.scala": fixture("scala-frameworks/munit/src/test/scala/calc/CalcSuite.scala"),
    }
    const out = await Effect.runPromise(tamper({ files: Object.keys(files).sort(), read: (p) => Effect.succeed(Option.fromNullishOr(files[p])), ir: undefined as never, isTestPath: (p) => p.startsWith("src/test/") }))
    expect(out.map((t) => t.fixture)).toEqual(["deleted-test", "added-skip", "weakened-assertion", "added-suppression", "test-id-in-main", "hardcoded-expected-value", "edited-test-setup"])
    const content = (f: string) => out.find((t) => t.fixture === f)!.edits[0]!.content!
    expect(content("added-skip")).toContain("test(\"adds\".ignore)")
    expect(content("weakened-assertion")).not.toContain("assertEquals(Calc.add(1, 2), 3)")
    expect(content("hardcoded-expected-value")).toContain("def add(a: Int, b: Int): Int = 3")
    expect(content("test-id-in-main")).toContain("import munit.*")
    expect(out.find((t) => t.fixture === "edited-test-setup")!.edits[0]!.path).toBe("project/GauntletSelftest.scala")
  })
})
