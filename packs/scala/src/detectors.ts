import type { DetectorInput, DetectorOutput, IntegrityDetector, IntegrityFinding } from "@gauntlet/core"
import type { Metric } from "@gauntlet/sarif"
import { near } from "@gauntlet/syntax"
import { Effect, FileSystem, Option, Path } from "effect"
import { args, calleeName, calleeText, line, nameOf, type Node, ofType, operatorOf, parseScala, unquote } from "./syntax.ts"
import { isScala, isTestFile } from "./toolchain.ts"

// Scala integrity detectors (ADR 0013) for ScalaTest, munit,
// munit-cats-effect, ZIO Test and weaver. Tests are curried calls,
// `test("name") { ... }`, or ScalaTest's word styles, `"x" should "y" in { ... }`.

/** Calls that define a test, by framework: ScalaTest FunSuite/FunSpec/PropSpec, munit, ZIO Test, weaver. */
const TEST_CALL = new Set(["test", "it", "property", "pureTest", "loggedTest", "simpleTest", "ignore", "testM"])
/** Calls and methods that assert, across the frameworks. */
const ASSERT_CALL = /^(assert|assertEquals|assertNotEquals|assertNoDiff|assertResult|assertThrows|assertTrue|assertZIO|assertIO|assertIO_|assertIOBoolean|assertCompletes|assertNever|assertTypeError|assertDoesNotCompile|expect|intercept|interceptMessage|interceptIO|fail|failure)$/
const MATCHER = /^(shouldBe|should|shouldEqual|shouldNot|shouldNotBe|shouldMatch|mustBe|must|mustEqual|mustNot)$/
const PROPERTY_CALL = /^(forAll|forall|check|checkAll|checkN|property)$/
const EXIT = /^(sys\.exit|System\.exit|Runtime\.getRuntime\.halt|java\.lang\.System\.exit)$/
const SUPPRESSION_ANNOTATION = /^@(((scala\.)?annotation\.)?(nowarn|unused)|(java\.lang\.)?SuppressWarnings)\b/
const SUPPRESSION_COMMENT = /\/\/\s*(scalafix:(off|ok)|scalastyle:(off|ignore)|wartremover:off)\b/
const TEST_FRAMEWORK_IMPORT = /^import\s+(org\.scalatest|munit|zio\.test|weaver|org\.scalacheck|org\.specs2|utest)\b/
const ENV = /\b(sys\.env|sys\.props|System\.getenv|System\.getProperty)\b/

const finding = (check: IntegrityFinding["check"], kind: IntegrityFinding["kind"], message: string, path: string, at?: number): IntegrityFinding => ({
  check, kind, message, path, ...(at !== undefined ? { line: at } : {}), detector: "scala",
})

interface TestDef {
  readonly name: string
  readonly node: Node
  readonly body: Node | undefined
  readonly assertions: number
  /** Tags from the name (munit's "x".ignore, .flaky, .fail) and the defining call (ignore, pending). */
  readonly skipped: boolean
  readonly quarantined: boolean
  readonly property: boolean
}

const owner = (n: Node) => {
  for (let p: Node | null = n.parent; p; p = p.parent) if (p.type === "class_definition" || p.type === "object_definition") return nameOf(p)
  return ""
}

const assertionsIn = (body: Node | undefined) =>
  body === undefined ? 0 : ofType(body, "call_expression").filter((c) => ASSERT_CALL.test(calleeName(c)) || /^expect\./.test(calleeText(c))).length
    + ofType(body, "infix_expression").filter((i) => MATCHER.test(operatorOf(i))).length

const isProperty = (body: Node | undefined) => body !== undefined && ofType(body, "call_expression").some((c) => PROPERTY_CALL.test(calleeName(c)) && c.namedChildren.some((x) => x?.type === "block" || x?.type === "arguments"))

/** `test("name") { body }`: the outer call has the inner call as its function. */
const curriedTests = (root: Node): TestDef[] =>
  ofType(root, "call_expression").flatMap((outer) => {
    const inner = outer.namedChild(0)
    if (inner?.type !== "call_expression" || !TEST_CALL.has(calleeName(inner))) return []
    const first = args(inner)[0]
    if (!first) return []
    const literal = first.type === "string" ? first : first.type === "field_expression" && first.namedChild(0)?.type === "string" ? first.namedChild(0)! : undefined
    if (!literal) return []
    const tag = first.type === "field_expression" ? first.namedChild(first.namedChildCount - 1)?.text ?? "" : ""
    const body = outer.namedChildren.find((c) => c?.type === "block" || c?.type === "arguments" || c?.type === "indented_block") ?? undefined
    // ZIO aspects: test("x")(...) @@ ignore / @@ flaky.
    const aspect = outer.parent?.type === "infix_expression" && operatorOf(outer.parent) === "@@" ? outer.parent.namedChild(2)?.text ?? "" : ""
    const kind = calleeName(inner)
    return [{
      name: `${owner(outer)}.${unquote(literal.text)}`,
      node: outer,
      body,
      assertions: assertionsIn(body),
      skipped: kind === "ignore" || tag === "ignore" || /\bignore\b/.test(aspect),
      quarantined: tag === "flaky" || tag === "fail" || /\bflaky\b/.test(aspect),
      property: kind === "property" || isProperty(body),
    }]
  })

/** `"x" should "y" in { body }`, `"x" in { }`, and `... ignore { }` (a skip). */
const wordTests = (root: Node): TestDef[] =>
  ofType(root, "infix_expression").flatMap((i) => {
    const op = operatorOf(i)
    if (op !== "in" && op !== "ignore" && op !== "is") return []
    const left = i.namedChild(0)
    if (!left || !(left.type === "string" || ofType(left, "string").length > 0)) return []
    const body = i.namedChild(2) ?? undefined
    return [{
      name: `${owner(i)}.${left.text.replace(/"/g, "").replace(/\s+/g, " ")}`,
      node: i,
      body,
      assertions: assertionsIn(body),
      skipped: op === "ignore" || op === "is",
      quarantined: false,
      property: isProperty(body),
    }]
  })

export const testDefinitions = (root: Node): TestDef[] => [...curriedTests(root), ...wordTests(root)].sort((a, b) => a.node.startIndex - b.node.startIndex)

const skipCalls = (root: Node): Node[] =>
  [...ofType(root, "identifier").filter((n) => n.text === "pending" && n.parent?.type !== "call_expression"), ...ofType(root, "call_expression").filter((c) => /^(cancel|pendingUntilFixed)$/.test(calleeName(c)))]

const suppressions = (root: Node, text: string): number =>
  ofType(root, "annotation").filter((a) => SUPPRESSION_ANNOTATION.test(a.text)).length + text.split("\n").filter((l) => SUPPRESSION_COMMENT.test(l)).length

const tautology = (c: Node): boolean => {
  const name = calleeName(c)
  const a = args(c).map((x) => x.text.replace(/\s/g, ""))
  if ((name === "assert" || name === "assertTrue" || name === "expect") && a.length === 1) {
    if (a[0] === "true") return true
    const m = /^(.+)==(.+)$/.exec(a[0]!)
    if (m && m[1] === m[2]) return true
  }
  if ((name === "assertEquals" || name === "assertResult") && a.length >= 2 && a[0] === a[1]) return true
  return false
}

const metric = (value: number, higherIsBetter: boolean): Metric => ({ value, unit: "count", higherIsBetter })

const measure = (input: DetectorInput) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    let asserted = 0
    let suppressed = 0
    let quarantined = 0
    let properties = 0
    for (const file of input.headFiles.filter(isScala)) {
      const text = yield* fs.readFileString(path.join(input.dir, file)).pipe(Effect.option)
      if (Option.isNone(text)) continue
      const root = parseScala(text.value).rootNode
      suppressed += suppressions(root, text.value)
      if (!input.isTestPath(file) && !isTestFile(file)) continue
      const tests = testDefinitions(root)
      asserted += tests.reduce((n, t) => n + t.assertions, 0)
      quarantined += tests.filter((t) => t.quarantined).length
      properties += tests.filter((t) => t.property).length
    }
    return {
      // The total can't drop; per-test weakening is the weakened-assertions forbid.
      "integrity/assertions-per-test": metric(asserted, true),
      "integrity/suppressions": metric(suppressed, false),
      "integrity/quarantined-tests": metric(quarantined, false),
      "integrity/property-tests": metric(properties, true),
    }
  })

const insideCondition = (n: Node) => {
  for (let p: Node | null = n.parent; p; p = p.parent) {
    const cond = p.type === "if_expression" || p.type === "while_expression" ? p.childForFieldName("condition") ?? p.namedChild(0) : p.type === "match_expression" ? p.childForFieldName("value") ?? p.namedChild(0) : null
    if (cond) return n.startIndex >= cond.startIndex && n.endIndex <= cond.endIndex
    if (p.type === "function_definition" || p.type === "lambda_expression") return false
  }
  return false
}

const classNames = (roots: ReadonlyArray<Node>) =>
  new Set(roots.flatMap((r) => ofType(r, "class_definition").filter((c) => !/\btrait\b|\babstract\b/.test(c.text.slice(0, 40))).map(nameOf)))

const compare = (input: DetectorInput) =>
  Effect.gen(function*() {
    const out: IntegrityFinding[] = []
    let mainClasses: Set<string> | undefined
    for (const f of input.facts.files) {
      if (f.status === "deleted" || !isScala(f.path)) continue
      const head = yield* input.readHead(f.path)
      if (Option.isNone(head)) continue
      const base = f.status === "added" ? Option.none<string>() : yield* input.readBase(f.oldPath ?? f.path)
      const headRoot = parseScala(head.value).rootNode
      const baseRoot = Option.map(base, (b) => parseScala(b).rootNode)
      const added = new Set((input.facts.addedLines.get(f.path) ?? []).map((l) => l.line))

      const before = Option.match(base, { onNone: () => 0, onSome: (b) => suppressions(parseScala(b).rootNode, b) })
      const after = suppressions(headRoot, head.value)
      if (after > before) {
        const at = (input.facts.addedLines.get(f.path) ?? []).find((l) => SUPPRESSION_COMMENT.test(l.text) || SUPPRESSION_ANNOTATION.test(l.text.trim()))
        out.push(finding("new-suppressions", "forbid", `${after - before} new suppression${after - before === 1 ? "" : "s"} (@nowarn, @SuppressWarnings, // scalafix:off...).`, f.path, at?.line))
      }

      if (input.isTestPath(f.path) || isTestFile(f.path)) {
        const beforeTests = Option.match(baseRoot, { onNone: () => [] as TestDef[], onSome: testDefinitions })
        const afterTests = testDefinitions(headRoot)
        for (const t of afterTests.filter((t) => t.skipped && !beforeTests.some((b) => b.name === t.name && b.skipped))) out.push(finding("new-skips", "forbid", `New skip: ${t.name}.`, f.path, line(t.node)))
        const beforeSkips = Option.match(baseRoot, { onNone: () => 0, onSome: (r) => skipCalls(r).length })
        if (skipCalls(headRoot).length > beforeSkips) for (const s of skipCalls(headRoot).filter((s) => added.has(line(s)))) out.push(finding("new-skips", "forbid", `New skip: ${s.text.split("(")[0]}.`, f.path, line(s)))
        for (const b of beforeTests) {
          const a = afterTests.find((x) => x.name === b.name)
          if (!a) out.push(finding("deleted-tests", "forbid", `Test ${b.name} was removed.`, f.path))
          else if (a.assertions < b.assertions) out.push(finding("weakened-assertions", "forbid", `Test ${b.name} went from ${b.assertions} assertions to ${a.assertions}.`, f.path, line(a.node)))
        }
        for (const a of afterTests) {
          if (a.assertions === 0 && !a.skipped && !beforeTests.some((b) => b.name === a.name)) {
            out.push(finding("weakened-assertions", "forbid", `New test ${a.name} has no assertions, so it can't fail on a wrong result.`, f.path, line(a.node)))
          }
        }
        for (const c of ofType(headRoot, "call_expression")) {
          if (!added.has(line(c))) continue
          if (tautology(c)) out.push(finding("weakened-assertions", "forbid", `${c.text.split("\n")[0]} can't fail.`, f.path, line(c)))
          if (EXIT.test(calleeText(c))) out.push(finding("exit-in-tests", "forbid", `${calleeText(c)} ends the test JVM.`, f.path, line(c)))
        }
        // mock[Ledger], stub[Ledger] (Mockito Scala, ScalaMock) of a concrete class the project declares.
        for (const g of ofType(headRoot, "generic_function").filter((g) => added.has(line(g)) && /^(mock|stub|spy)$/.test(g.namedChild(0)?.text ?? ""))) {
          const mocked = /\[(\w+)\]/.exec(g.text)?.[1]
          mainClasses ??= classNames(yield* Effect.forEach(input.headFiles.filter((p) => isScala(p) && !isTestFile(p)), (p) => input.readHead(p).pipe(Effect.map((t) => Option.map(t, (x) => parseScala(x).rootNode)))).pipe(Effect.map((xs) => xs.flatMap(Option.toArray))))
          if (mocked && mainClasses.has(mocked)) out.push(finding("mocks-of-class-under-test", "flag", `The test mocks ${mocked}, a concrete class the project declares.`, f.path, line(g)))
        }
        continue
      }

      for (const imp of ofType(headRoot, "import_declaration")) {
        if (added.has(line(imp)) && TEST_FRAMEWORK_IMPORT.test(imp.text)) out.push(finding("test-refs-in-main", "forbid", `Main code imports a test framework (${imp.text}).`, f.path, line(imp)))
      }
      for (const d of ofType(headRoot, "function_definition")) {
        if (/^(equals|hashCode|compare|canEqual)$/.test(nameOf(d)) && added.has(line(d))) out.push(finding("equality-overrides", "flag", `New ${nameOf(d)}: equality changes can make tests pass for the wrong reason.`, f.path, line(d)))
      }
      for (const g of [...ofType(headRoot, "given_definition"), ...ofType(headRoot, "val_definition")]) {
        if (/\b(Eq|Order|Equal|Ordering)\[/.test(g.text.split("=")[0] ?? "") && /^(given|implicit)\b|given/.test(g.text) && added.has(line(g))) out.push(finding("equality-overrides", "flag", "New equality or ordering instance: it can make tests pass for the wrong reason.", f.path, line(g)))
      }
      for (const c of ofType(headRoot, "catch_clause")) {
        const t = c.text.replace(/\s/g, "")
        if (/case_(:Throwable)?=>|NonFatal\(/.test(t) && !/throw/.test(c.text) && near(added, line(c), 3)) out.push(finding("catch-all-near-changed-code", "flag", "A catch-all near changed code that never rethrows can hide failures.", f.path, line(c)))
      }
      for (const c of ofType(headRoot, "call_expression")) {
        if (/^(catchAll|orElseSucceed|handleError|recover|recoverWith|attempt)$/.test(calleeName(c)) && /\{?\s*(case\s+)?_\s*=>/.test(c.text) && near(added, line(c), 3)) {
          out.push(finding("catch-all-near-changed-code", "flag", `${calleeName(c)} discarding the error near changed code can hide failures.`, f.path, line(c)))
        }
      }
      for (const n of [...ofType(headRoot, "field_expression"), ...ofType(headRoot, "call_expression")]) {
        if (ENV.test(n.text) && n.text.length < 80 && added.has(line(n)) && n.parent?.type !== "field_expression" && n.parent?.type !== "call_expression" && insideCondition(n)) {
          out.push(finding("env-branching", "flag", `${n.text} decides a branch: behaviour that depends on the environment can differ under test.`, f.path, line(n)))
        }
      }
    }
    return out
  })

export const scalaDetector: IntegrityDetector = {
  name: "scala",
  checks: [
    "assertions-per-test", "suppressions", "quarantined-tests", "property-tests",
    "weakened-assertions", "new-skips", "new-suppressions", "exit-in-tests", "deleted-tests", "test-refs-in-main",
    "equality-overrides", "catch-all-near-changed-code", "env-branching", "mocks-of-class-under-test",
  ],
  run: (input) =>
    Effect.gen(function*() {
      return { findings: yield* compare(input), metrics: yield* measure(input) } satisfies DetectorOutput
    }),
}
