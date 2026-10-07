import type { DetectorInput, DetectorOutput, IntegrityDetector, IntegrityFinding } from "@gauntlet/core"
import type { Metric } from "@gauntlet/sarif"
import { near } from "@gauntlet/syntax"
import { Effect, FileSystem, Option, Path } from "effect"
import { args, calleeName, calleeText, importPaths, line, nameOf, type Node, ofType, parseGo } from "./syntax.ts"
import { isGo, isMainSource, isTestFile } from "./toolchain.ts"

// Go integrity detectors (ADR 0013), for the standard testing package with
// testify, is and quick/rapid. Fuzz tests count towards the property-test
// ratchet.

const ASSERT_METHOD = /^(Error|Errorf|Fatal|Fatalf|Fail|FailNow)$/
const ASSERT_PACKAGE = /^(assert|require|is|must|qt|be)\./
const SKIP = /^(Skip|Skipf|SkipNow)$/
const QUARANTINE_WORD = /flak|quarantin/i
const SUPPRESSION = /^\/\/\s*(nolint\b|lint:ignore\b|#nosec\b|coverage:ignore\b)|^\/\/\s*\S.*\/\/\s*nolint\b/
const EXIT = /^(os\.Exit|log\.Fatal|log\.Fatalf|log\.Fatalln|syscall\.Exit)$/
const TEST_ENV = /\btesting\.Testing\(\)|flag\.Lookup\(\s*"test\.v"\s*\)|strings\.HasSuffix\(\s*os\.Args\[0\],\s*"\.test"\s*\)/
const ENV = /^os\.(Getenv|LookupEnv)$/

const finding = (check: IntegrityFinding["check"], kind: IntegrityFinding["kind"], message: string, path: string, at?: number): IntegrityFinding => ({
  check, kind, message, path, ...(at !== undefined ? { line: at } : {}), detector: "go",
})

interface TestFn {
  readonly name: string
  readonly node: Node
  readonly assertions: number
}

const isAssertion = (c: Node) => {
  const text = calleeText(c)
  return ASSERT_PACKAGE.test(text) || (text.includes(".") && ASSERT_METHOD.test(calleeName(c)))
}

const assertionCount = (root: Node) => ofType(root, "call_expression").filter(isAssertion).length

/** `func TestX(t *testing.T)` and `func FuzzX(f *testing.F)`; examples and benchmarks aren't tests that judge behaviour. */
export const testFunctions = (root: Node): TestFn[] =>
  ofType(root, "function_declaration")
    .filter((f) => /^(Test|Fuzz)([A-Z_0-9]|$)/.test(nameOf(f)) && nameOf(f) !== "TestMain")
    .map((f) => ({ name: nameOf(f), node: f, assertions: assertionCount(f) }))

const skips = (root: Node): Node[] => ofType(root, "call_expression").filter((c) => calleeText(c).includes(".") && SKIP.test(calleeName(c)))

const tautology = (c: Node): boolean => {
  if (c.type !== "call_expression") return false
  const text = calleeText(c)
  const a = args(c).map((x) => x.text.replace(/\s/g, ""))
  if (!ASSERT_PACKAGE.test(text)) return false
  const rest = a.slice(1)
  if (/\.(True)$/.test(text) && rest[0] === "true") return true
  if (/\.(False)$/.test(text) && rest[0] === "false") return true
  if (/\.(Nil)$/.test(text) && rest[0] === "nil") return true
  if (/\.(Equal|EqualValues|Exactly|Same)$/.test(text) && rest.length >= 2 && rest[0] === rest[1]) return true
  return false
}

const suppressionComments = (root: Node) => ofType(root, "comment").filter((c) => SUPPRESSION.test(c.text))

const metric = (value: number, higherIsBetter: boolean): Metric => ({ value, unit: "count", higherIsBetter })

const isProperty = (fn: TestFn) =>
  fn.name.startsWith("Fuzz") || ofType(fn.node, "call_expression").some((c) => /^(quick\.Check|quick\.CheckEqual|rapid\.Check|rapid\.MakeCheck)$/.test(calleeText(c)))

const isQuarantine = (fn: TestFn) => skips(fn.node).some((s) => QUARANTINE_WORD.test(args(s).map((a) => a.text).join(" ")))

const measure = (input: DetectorInput) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    let asserted = 0
    let suppressed = 0
    let quarantined = 0
    let properties = 0
    for (const file of input.headFiles.filter(isGo)) {
      const text = yield* fs.readFileString(path.join(input.dir, file)).pipe(Effect.option)
      if (Option.isNone(text)) continue
      const root = parseGo(text.value).rootNode
      suppressed += suppressionComments(root).length
      if (!isTestFile(file)) continue
      const fns = testFunctions(root)
      asserted += fns.reduce((n, f) => n + f.assertions, 0)
      quarantined += fns.filter(isQuarantine).length
      properties += fns.filter(isProperty).length
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
    const cond = p.type === "if_statement" ? p.childForFieldName("condition")
      : p.type === "for_statement" ? p.namedChildren.find((c) => c?.type === "for_clause" || c?.type === "binary_expression") ?? null
      : p.type === "expression_switch_statement" ? p.childForFieldName("value")
      : null
    if (cond) return n.startIndex >= cond.startIndex && n.endIndex <= cond.endIndex
    if (p.type === "function_declaration" || p.type === "method_declaration" || p.type === "func_literal") return false
  }
  return false
}

/** Struct types (not interfaces) a package's main files declare. */
const structTypes = (roots: ReadonlyArray<Node>) =>
  new Set(roots.flatMap((r) => ofType(r, "type_spec").filter((s) => s.childForFieldName("type")?.type === "struct_type").map((s) => nameOf(s))))

const compare = (input: DetectorInput) =>
  Effect.gen(function*() {
    const out: IntegrityFinding[] = []
    for (const f of input.facts.files) {
      if (f.status === "deleted" || !isGo(f.path)) continue
      const head = yield* input.readHead(f.path)
      if (Option.isNone(head)) continue
      const base = f.status === "added" ? Option.none<string>() : yield* input.readBase(f.oldPath ?? f.path)
      const headRoot = parseGo(head.value).rootNode
      const baseRoot = Option.map(base, (b) => parseGo(b).rootNode)
      const added = new Set((input.facts.addedLines.get(f.path) ?? []).map((l) => l.line))

      const before = Option.match(baseRoot, { onNone: () => 0, onSome: (r) => suppressionComments(r).length })
      const after = suppressionComments(headRoot)
      if (after.length > before) {
        const at = after.find((c) => added.has(line(c)))
        out.push(finding("new-suppressions", "forbid", `${after.length - before} new suppression${after.length - before === 1 ? "" : "s"} (//nolint, //lint:ignore, #nosec...).`, f.path, at ? line(at) : undefined))
      }

      if (isTestFile(f.path)) {
        if (skips(headRoot).length > Option.match(baseRoot, { onNone: () => 0, onSome: (r) => skips(r).length })) {
          for (const s of skips(headRoot).filter((s) => added.has(line(s)))) out.push(finding("new-skips", "forbid", `New skip: ${calleeText(s)}.`, f.path, line(s)))
        }
        const beforeTests = Option.match(baseRoot, { onNone: () => [] as TestFn[], onSome: testFunctions })
        const afterTests = testFunctions(headRoot)
        for (const b of beforeTests) {
          const a = afterTests.find((x) => x.name === b.name)
          if (!a) out.push(finding("deleted-tests", "forbid", `Test ${b.name} was removed.`, f.path))
          else if (a.assertions < b.assertions) out.push(finding("weakened-assertions", "forbid", `Test ${b.name} went from ${b.assertions} assertions to ${a.assertions}.`, f.path, line(a.node)))
        }
        for (const a of afterTests) {
          if (a.assertions === 0 && !a.name.startsWith("Fuzz") && !beforeTests.some((b) => b.name === a.name)) {
            out.push(finding("weakened-assertions", "forbid", `New test ${a.name} has no assertions, so it can't fail on a wrong result.`, f.path, line(a.node)))
          }
        }
        const testMain = ofType(headRoot, "function_declaration").find((d) => nameOf(d) === "TestMain")
        // A TestMain that never calls m.Run() runs none of the package's tests.
        if (testMain && near(added, line(testMain), Math.max(1, testMain.endPosition.row - testMain.startPosition.row + 1)) && !ofType(testMain, "call_expression").some((c) => calleeName(c) === "Run")) {
          out.push(finding("exit-in-tests", "forbid", "TestMain never calls m.Run(), so none of the package's tests run.", f.path, line(testMain)))
        }
        for (const c of ofType(headRoot, "call_expression")) {
          if (!added.has(line(c))) continue
          if (tautology(c)) out.push(finding("weakened-assertions", "forbid", `${c.text.split("\n")[0]} can't fail.`, f.path, line(c)))
          const inMain = testMain !== undefined && c.startIndex >= testMain.startIndex && c.endIndex <= testMain.endIndex
          if (EXIT.test(calleeText(c)) && !(inMain && calleeText(c) === "os.Exit")) out.push(finding("exit-in-tests", "forbid", `${calleeText(c)} ends the test process.`, f.path, line(c)))
        }
        // Mocking a concrete type the package itself declares tests the mock, not the code.
        const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/") + 1) : ""
        const siblings = input.headFiles.filter((p) => isMainSource(p) && p.startsWith(dir) && !p.slice(dir.length).includes("/"))
        const mains: Node[] = []
        for (const p of siblings) {
          const text = yield* input.readHead(p)
          if (Option.isSome(text)) mains.push(parseGo(text.value).rootNode)
        }
        const structs = structTypes(mains)
        for (const s of ofType(headRoot, "type_spec")) {
          const m = /^(mock|fake|stub)_?(\w+)$/i.exec(nameOf(s))
          const subject = m ? [...structs].find((t) => t.toLowerCase() === m[2]!.toLowerCase()) : undefined
          if (subject && added.has(line(s))) out.push(finding("mocks-of-class-under-test", "flag", `${nameOf(s)} stands in for ${subject}, a type this package declares.`, f.path, line(s)))
        }
        continue
      }

      for (const imp of importPaths(headRoot)) {
        if (added.has(imp.line) && imp.path === "testing") out.push(finding("test-refs-in-main", "forbid", "Main code imports the testing package.", f.path, imp.line))
      }
      for (const l of input.facts.addedLines.get(f.path) ?? []) {
        if (TEST_ENV.test(l.text)) out.push(finding("test-refs-in-main", "forbid", "Main code checks whether it is running under go test.", f.path, l.line))
      }
      for (const m of ofType(headRoot, "method_declaration")) {
        if (/^(Equal|Equals|Compare|Less)$/.test(nameOf(m)) && added.has(line(m))) {
          out.push(finding("equality-overrides", "flag", `New ${nameOf(m)} method: equality changes can make tests pass for the wrong reason.`, f.path, line(m)))
        }
      }
      for (const c of ofType(headRoot, "call_expression")) {
        if (calleeText(c) === "recover" && near(added, line(c), 3)) {
          let fn: Node | null = c.parent
          while (fn && fn.type !== "func_literal" && fn.type !== "function_declaration" && fn.type !== "method_declaration") fn = fn.parent
          if (!fn || !ofType(fn, "call_expression").some((x) => calleeText(x) === "panic")) {
            out.push(finding("catch-all-near-changed-code", "flag", "recover() near changed code that never re-panics can hide failures.", f.path, line(c)))
          }
        }
        if (ENV.test(calleeText(c)) && added.has(line(c)) && insideCondition(c)) {
          out.push(finding("env-branching", "flag", `${calleeText(c)} decides a branch: behaviour that depends on the environment can differ under test.`, f.path, line(c)))
        }
      }
    }
    return out
  })

export const goDetector: IntegrityDetector = {
  name: "go",
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
