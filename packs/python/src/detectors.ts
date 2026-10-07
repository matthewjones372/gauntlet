import type { DetectorInput, DetectorOutput, IntegrityDetector, IntegrityFinding } from "@gauntlet/core"
import type { Metric } from "@gauntlet/sarif"
import { near } from "@gauntlet/syntax"
import { Effect, FileSystem, Option, Path } from "effect"
import { exceptTypes } from "./rules.ts"
import { args, calleeText, decorators, line, nameOf, type Node, ofType, parsePython } from "./syntax.ts"
import { isPython, isTestFile } from "./toolchain.ts"

// Python integrity detectors (ADR 0013), for pytest and unittest, with
// Hypothesis counted towards the property-test ratchet.

const SKIP_DECORATOR = /^(pytest\.mark\.(skip|skipif)|unittest\.skip(If|Unless)?|skip(If|Unless)?)\b/
const SKIP_CALL = /^(pytest\.skip|self\.skipTest)$/
const QUARANTINE = /^(pytest\.mark\.(xfail|flaky)|flaky)\b/
const PROPERTY = /^(given|hypothesis\.given)\b/
const EXIT = /^(sys\.exit|os\._exit|exit|quit|os\.kill)$/
const SUPPRESSION = /#\s*(type:\s*ignore|noqa|pragma:\s*no\s*cover|pylint:\s*disable|pyright:\s*ignore|mypy:\s*ignore|pragma:\s*no\s*mutate)/
const TEST_ENV = /PYTEST_CURRENT_TEST|["']pytest["']\s+in\s+sys\.modules|\bsys\.modules\[["']pytest["']\]|["']unittest["']\s+in\s+sys\.modules/
const ENV = /^(os\.environ|os\.getenv|environ|getenv)\b/

const finding = (check: IntegrityFinding["check"], kind: IntegrityFinding["kind"], message: string, path: string, at?: number): IntegrityFinding => ({
  check, kind, message, path, ...(at !== undefined ? { line: at } : {}), detector: "python",
})

interface TestFn {
  readonly name: string
  readonly node: Node
  readonly assertions: number
}

const isAssertCall = (c: Node) => /^(self\.assert\w*|assert\w+|pytest\.raises|pytest\.warns|pytest\.approx)$/.test(calleeText(c))

const assertionCount = (root: Node) => ofType(root, "assert_statement").length + ofType(root, "call").filter(isAssertCall).length

export const testFunctions = (root: Node): TestFn[] =>
  ofType(root, "function_definition")
    .filter((f) => nameOf(f).startsWith("test"))
    .map((f) => ({ name: f.parent?.parent?.type === "class_definition" || f.parent?.parent?.parent?.type === "class_definition" ? qualified(f) : nameOf(f), node: f, assertions: assertionCount(f) }))

const qualified = (f: Node) => {
  for (let p: Node | null = f.parent; p; p = p.parent) if (p.type === "class_definition") return `${nameOf(p)}.${nameOf(f)}`
  return nameOf(f)
}

const skips = (root: Node): Node[] => [
  ...ofType(root, "decorator").filter((d) => SKIP_DECORATOR.test(d.text.replace(/^@\s*/, ""))),
  ...ofType(root, "call").filter((c) => SKIP_CALL.test(calleeText(c))),
]

const tautology = (n: Node): boolean => {
  if (n.type === "assert_statement") {
    const expr = n.namedChild(0)
    if (!expr) return false
    if (expr.type === "true" || (expr.type === "integer" && expr.text !== "0") || (expr.type === "string" && expr.text.length > 2)) return true
    if (expr.type === "comparison_operator" && expr.namedChildCount === 2) {
      const [a, b] = [expr.namedChild(0)!, expr.namedChild(1)!]
      return a.text.replace(/\s/g, "") === b.text.replace(/\s/g, "")
    }
    return false
  }
  if (n.type === "call") {
    const name = calleeText(n)
    const a = args(n).map((x) => x.text.replace(/\s/g, ""))
    if (/assertTrue$/.test(name) && a[0] === "True") return true
    if (/assertFalse$/.test(name) && a[0] === "False") return true
    if (/(assertEqual|assertIs)$/.test(name) && a.length >= 2 && a[0] === a[1]) return true
  }
  return false
}

const suppressionComments = (root: Node) => ofType(root, "comment").filter((c) => SUPPRESSION.test(c.text))

const metric = (value: number, higherIsBetter: boolean): Metric => ({ value, unit: "count", higherIsBetter })

const measure = (input: DetectorInput) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    let asserted = 0
    let suppressed = 0
    let quarantined = 0
    let properties = 0
    for (const file of input.headFiles.filter(isPython)) {
      const text = yield* fs.readFileString(path.join(input.dir, file)).pipe(Effect.option)
      if (Option.isNone(text)) continue
      const root = parsePython(text.value).rootNode
      suppressed += suppressionComments(root).length
      if (!input.isTestPath(file) && !isTestFile(file)) continue
      const fns = testFunctions(root)
      asserted += fns.reduce((n, f) => n + f.assertions, 0)
      quarantined += fns.filter((f) => decorators(f.node).some((d) => QUARANTINE.test(d))).length
      properties += fns.filter((f) => decorators(f.node).some((d) => PROPERTY.test(d))).length
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
    const cond = ["if_statement", "elif_clause", "while_statement"].includes(p.type) ? p.childForFieldName("condition")
      : p.type === "conditional_expression" ? p.namedChild(1)
      : p.type === "match_statement" ? p.childForFieldName("subject")
      : null
    if (cond) return n.startIndex >= cond.startIndex && n.endIndex <= cond.endIndex
    if (p.type === "function_definition" || p.type === "class_definition") return false
  }
  return false
}

const compare = (input: DetectorInput) =>
  Effect.gen(function*() {
    const out: IntegrityFinding[] = []
    for (const f of input.facts.files) {
      if (f.status === "deleted" || !isPython(f.path)) continue
      const head = yield* input.readHead(f.path)
      if (Option.isNone(head)) continue
      const base = f.status === "added" ? Option.none<string>() : yield* input.readBase(f.oldPath ?? f.path)
      const headRoot = parsePython(head.value).rootNode
      const baseRoot = Option.map(base, (b) => parsePython(b).rootNode)
      const added = new Set((input.facts.addedLines.get(f.path) ?? []).map((l) => l.line))
      const isTest = input.isTestPath(f.path) || isTestFile(f.path)

      const before = Option.match(baseRoot, { onNone: () => 0, onSome: (r) => suppressionComments(r).length })
      const after = suppressionComments(headRoot)
      if (after.length > before) {
        const at = after.find((c) => added.has(line(c)))
        out.push(finding("new-suppressions", "forbid", `${after.length - before} new suppression${after.length - before === 1 ? "" : "s"} (# type: ignore, # noqa, # pragma: no cover...).`, f.path, at ? line(at) : undefined))
      }

      if (isTest) {
        if (skips(headRoot).length > Option.match(baseRoot, { onNone: () => 0, onSome: (r) => skips(r).length })) {
          for (const s of skips(headRoot).filter((s) => added.has(line(s)))) out.push(finding("new-skips", "forbid", `New skip: ${s.text.replace(/^@\s*/, "").split("(")[0]}.`, f.path, line(s)))
        }
        const beforeTests = Option.match(baseRoot, { onNone: () => [] as TestFn[], onSome: testFunctions })
        const afterTests = testFunctions(headRoot)
        for (const b of beforeTests) {
          const a = afterTests.find((x) => x.name === b.name)
          if (!a) out.push(finding("deleted-tests", "forbid", `Test ${b.name} was removed.`, f.path))
          else if (a.assertions < b.assertions) out.push(finding("weakened-assertions", "forbid", `Test ${b.name} went from ${b.assertions} assertions to ${a.assertions}.`, f.path, line(a.node)))
        }
        for (const a of afterTests) {
          if (a.assertions === 0 && !beforeTests.some((b) => b.name === a.name)) {
            out.push(finding("weakened-assertions", "forbid", `New test ${a.name} has no assertions, so it can't fail on a wrong result.`, f.path, line(a.node)))
          }
        }
        for (const n of [...ofType(headRoot, "assert_statement"), ...ofType(headRoot, "call")]) {
          if (!added.has(line(n))) continue
          if (tautology(n)) out.push(finding("weakened-assertions", "forbid", `${n.text.split("\n")[0]} can't fail.`, f.path, line(n)))
          if (n.type === "call" && EXIT.test(calleeText(n))) out.push(finding("exit-in-tests", "forbid", `${calleeText(n)} ends the test process.`, f.path, line(n)))
          if (n.type === "call" && /(^|\.)patch(\.object)?$/.test(calleeText(n))) {
            const target = args(n)[0]?.text.replace(/^["']|["']$/g, "") ?? ""
            const subject = f.path.split("/").pop()!.replace(/^test_|_test\.py$|\.py$/g, "")
            if (target.split(".").includes(subject)) out.push(finding("mocks-of-class-under-test", "flag", `The test patches ${target}, in the module it tests.`, f.path, line(n)))
          }
        }
        continue
      }

      for (const imp of ofType(headRoot, "import_statement", "import_from_statement")) {
        if (added.has(line(imp)) && /\b(tests?|conftest)\b/.test(imp.text.replace(/^(from|import)\s+/, "").split(/\s/)[0] ?? "")) {
          out.push(finding("test-refs-in-main", "forbid", `Main code imports test code (${imp.text}).`, f.path, line(imp)))
        }
      }
      for (const l of input.facts.addedLines.get(f.path) ?? []) {
        if (TEST_ENV.test(l.text)) out.push(finding("test-refs-in-main", "forbid", "Main code checks whether it is running under a test runner.", f.path, l.line))
      }
      for (const fn of ofType(headRoot, "function_definition")) {
        const name = nameOf(fn)
        if ((name === "__eq__" || name === "__hash__" || name === "__ne__") && added.has(line(fn))) {
          out.push(finding("equality-overrides", "flag", `New ${name}: equality changes can make tests pass for the wrong reason.`, f.path, line(fn)))
        }
      }
      for (const c of ofType(headRoot, "except_clause")) {
        const types = exceptTypes(c)
        if ((types.length === 0 || types.some((t) => t === "Exception" || t === "BaseException")) && near(added, line(c), 3) && ofType(c, "raise_statement").length === 0) {
          out.push(finding("catch-all-near-changed-code", "flag", "A catch-all except near changed code that never re-raises can hide failures.", f.path, line(c)))
        }
      }
      for (const n of [...ofType(headRoot, "attribute"), ...ofType(headRoot, "call"), ...ofType(headRoot, "subscript")]) {
        if (ENV.test(n.text) && added.has(line(n)) && n.parent?.type !== "attribute" && n.parent?.type !== "call" && insideCondition(n)) {
          out.push(finding("env-branching", "flag", `${n.text} decides a branch: behaviour that depends on the environment can differ under test.`, f.path, line(n)))
        }
      }
    }
    return out
  })

export const pythonDetector: IntegrityDetector = {
  name: "python",
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

