import type { DetectorInput, DetectorOutput, IntegrityDetector, IntegrityFinding } from "@gauntlet/core"
import type { Metric } from "@gauntlet/sarif"
import { near } from "@gauntlet/syntax"
import { Effect, FileSystem, Option, Path } from "effect"
import { args, calleeName, calleeText, line, type Node, ofType, parseTs } from "./syntax.ts"
import { isTestFile, isTsSource } from "./toolchain.ts"

// TypeScript integrity detectors (ADR 0013), for vitest, jest and bun test
// alike: they share `test`/`it`, `expect` and their modifiers.

const TEST_CALL = /^(test|it)(\.(each|concurrent|sequential|only|skip|todo|fails|skipIf|runIf|prop))*$/
const SKIPPING = /(^|\.)(skip|todo|only)$|^x(it|test|describe)$|^(describe|suite)\.(skip|only)$/
const QUARANTINE = /(^|\.)fails$/
const EXIT = /^(process\.exit|Deno\.exit|process\.kill)$/
const SUPPRESSION = /@ts-ignore|@ts-expect-error|@ts-nocheck|eslint-disable|biome-ignore|istanbul ignore|c8 ignore|v8 ignore|Stryker disable/
const TEST_ENV = /process\.env\.(VITEST|JEST_WORKER_ID|NODE_ENV\s*===?\s*["']test["'])|import\.meta\.vitest|\bBun\.env\.NODE_ENV\s*===?\s*["']test["']/
const EQUALITY_METHODS = new Set(["equals", "valueOf", "toJSON", "[Symbol.toPrimitive]", "hashCode"])
const ENV_ACCESS = /^(process\.env|import\.meta\.env|Bun\.env)\b/

const finding = (check: IntegrityFinding["check"], kind: IntegrityFinding["kind"], message: string, path: string, at?: number): IntegrityFinding => ({
  check, kind, message, path, ...(at !== undefined ? { line: at } : {}), detector: "typescript",
})

interface TestFn {
  readonly name: string
  readonly node: Node
  readonly assertions: number
}

const assertions = (root: Node) =>
  ofType(root, "call_expression").filter((c) => {
    const text = calleeText(c)
    return text === "expect" || text === "assert" || /^assert\.\w+$/.test(text) || /^expect\.(soft|poll)$/.test(text)
  }).length

const testCalls = (root: Node) => ofType(root, "call_expression").filter((c) => TEST_CALL.test(calleeText(c)))

export const testFunctions = (root: Node): TestFn[] =>
  testCalls(root).map((c) => {
    const title = args(c)[0]
    return { name: title?.type === "string" || title?.type === "template_string" ? title.text.slice(1, -1) : "", node: c, assertions: assertions(c) }
  }).filter((t) => t.name !== "")

const skips = (root: Node) => ofType(root, "call_expression").filter((c) => SKIPPING.test(calleeText(c)))

const tautology = (call: Node): boolean => {
  // expect(<subject>).<matcher>(<expected>)
  const fn = call.childForFieldName("function")
  if (fn?.type !== "member_expression") return false
  const subjectCall = fn.childForFieldName("object")
  if (subjectCall?.type !== "call_expression" || calleeText(subjectCall) !== "expect") return false
  const subject = args(subjectCall)[0]
  const matcher = fn.childForFieldName("property")?.text ?? ""
  const expected = args(call)[0]
  if (!subject) return false
  const literal = ["true", "false", "number", "string", "null"].includes(subject.type)
  if (literal && ["toBeTruthy", "toBeDefined", "toBeFalsy", "toBeNull", "toBeUndefined"].includes(matcher)) return true
  if (expected && ["toBe", "toEqual", "toStrictEqual"].includes(matcher) && subject.text.replace(/\s/g, "") === expected.text.replace(/\s/g, "")) return true
  return false
}

/** Suppressions live in comments; the same words in code or strings don't count. */
const suppressionComments = (root: Node) => ofType(root, "comment").filter((c) => SUPPRESSION.test(c.text))
const suppressionCount = (root: Node) => suppressionComments(root).length

const metric = (value: number, higherIsBetter: boolean, unit: Metric["unit"] = "count"): Metric => ({ value, unit, higherIsBetter })

const measure = (input: DetectorInput) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    let asserted = 0
    let suppressed = 0
    let quarantined = 0
    let properties = 0
    for (const file of input.headFiles.filter(isTsSource)) {
      const text = yield* fs.readFileString(path.join(input.dir, file)).pipe(Effect.option)
      if (Option.isNone(text)) continue
      const root = parseTs(file, text.value).rootNode
      suppressed += suppressionCount(root)
      if (!input.isTestPath(file) && !isTestFile(file)) continue
      const fns = testFunctions(root)
      asserted += fns.reduce((n, f) => n + f.assertions, 0)
      quarantined += testCalls(root).filter((c) => QUARANTINE.test(calleeText(c))).length + (text.value.match(/\bretry\s*:\s*[1-9]/g) ?? []).length
      properties += ofType(root, "call_expression").filter((c) => /^fc\.(assert|property|asyncProperty)$/.test(calleeText(c)) || /^(test|it)\.prop$/.test(calleeText(c))).length
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
    const cond = p.type === "if_statement" || p.type === "while_statement" ? p.childForFieldName("condition")
      : p.type === "ternary_expression" ? p.childForFieldName("condition")
      : p.type === "switch_statement" ? p.childForFieldName("value")
      : null
    if (cond) return n.startIndex >= cond.startIndex && n.endIndex <= cond.endIndex
    if (["function_declaration", "arrow_function", "method_definition", "class_body"].includes(p.type)) return false
  }
  return false
}

const compare = (input: DetectorInput) =>
  Effect.gen(function*() {
    const out: IntegrityFinding[] = []
    for (const f of input.facts.files) {
      if (f.status === "deleted" || !isTsSource(f.path)) continue
      const head = yield* input.readHead(f.path)
      if (Option.isNone(head)) continue
      const base = f.status === "added" ? Option.none<string>() : yield* input.readBase(f.oldPath ?? f.path)
      const headRoot = parseTs(f.path, head.value).rootNode
      const baseRoot = Option.map(base, (b) => parseTs(f.path, b).rootNode)
      const added = new Set((input.facts.addedLines.get(f.path) ?? []).map((l) => l.line))
      const isTest = input.isTestPath(f.path) || isTestFile(f.path)

      const before = Option.match(baseRoot, { onNone: () => 0, onSome: suppressionCount })
      const after = suppressionCount(headRoot)
      if (after > before) {
        const at = suppressionComments(headRoot).find((c) => added.has(line(c)))
        out.push(finding("new-suppressions", "forbid", `${after - before} new suppression${after - before === 1 ? "" : "s"} (@ts-ignore, eslint-disable, biome-ignore...).`, f.path, at ? line(at) : undefined))
      }

      if (isTest) {
        const baseSkips = Option.match(baseRoot, { onNone: () => 0, onSome: (r) => skips(r).length })
        if (skips(headRoot).length > baseSkips) {
          for (const s of skips(headRoot).filter((s) => added.has(line(s)))) {
            out.push(finding("new-skips", "forbid", `${calleeText(s)} ${calleeText(s).endsWith("only") ? "focuses one test and skips the rest" : "skips a test"}.`, f.path, line(s)))
          }
        }
        const beforeTests = Option.match(baseRoot, { onNone: () => [] as TestFn[], onSome: testFunctions })
        const afterTests = testFunctions(headRoot)
        for (const b of beforeTests) {
          const a = afterTests.find((x) => x.name === b.name)
          if (!a) out.push(finding("deleted-tests", "forbid", `Test "${b.name}" was removed.`, f.path))
          else if (a.assertions < b.assertions) out.push(finding("weakened-assertions", "forbid", `Test "${b.name}" went from ${b.assertions} assertions to ${a.assertions}.`, f.path, line(a.node)))
        }
        for (const a of afterTests) {
          if (a.assertions === 0 && !calleeText(a.node).includes("todo") && !beforeTests.some((b) => b.name === a.name)) {
            out.push(finding("weakened-assertions", "forbid", `New test "${a.name}" has no assertions, so it can't fail on a wrong result.`, f.path, line(a.node)))
          }
        }
        for (const call of ofType(headRoot, "call_expression")) {
          if (!added.has(line(call))) continue
          if (tautology(call)) out.push(finding("weakened-assertions", "forbid", `${call.text} can't fail.`, f.path, line(call)))
          if (EXIT.test(calleeText(call))) out.push(finding("exit-in-tests", "forbid", `${calleeText(call)} ends the test process.`, f.path, line(call)))
          if (/^(vi|jest)\.(mock|doMock)$/.test(calleeText(call))) {
            const target = args(call)[0]?.text.slice(1, -1) ?? ""
            const subject = f.path.split("/").pop()!.replace(/\.(test|spec)\.[cm]?[jt]sx?$/, "")
            if (target.split("/").pop()?.replace(/\.[cm]?[jt]sx?$/, "") === subject) {
              out.push(finding("mocks-of-class-under-test", "flag", `The test mocks ${target}, the module it tests.`, f.path, line(call)))
            }
          }
        }
        continue
      }

      for (const imp of ofType(headRoot, "import_statement")) {
        const source = imp.childForFieldName("source")?.text.slice(1, -1) ?? ""
        if (added.has(line(imp)) && (isTestFile(source) || /(^|\/)(__tests__|test|tests)\//.test(source))) {
          out.push(finding("test-refs-in-main", "forbid", `Main code imports test code (${source}).`, f.path, line(imp)))
        }
      }
      for (const l of input.facts.addedLines.get(f.path) ?? []) {
        if (TEST_ENV.test(l.text)) out.push(finding("test-refs-in-main", "forbid", "Main code checks whether it is running under a test runner.", f.path, l.line))
      }
      for (const m of ofType(headRoot, "method_definition")) {
        const name = m.childForFieldName("name")?.text ?? ""
        if (EQUALITY_METHODS.has(name) && added.has(line(m))) out.push(finding("equality-overrides", "flag", `New ${name} method: equality changes can make tests pass for the wrong reason.`, f.path, line(m)))
      }
      for (const c of ofType(headRoot, "catch_clause")) {
        if (near(added, line(c), 3) && ofType(c, "throw_statement").length === 0) {
          out.push(finding("catch-all-near-changed-code", "flag", "A catch near changed code that never rethrows can hide failures.", f.path, line(c)))
        }
      }
      for (const call of ofType(headRoot, "call_expression")) {
        if (calleeName(call) === "catch" && near(added, line(call), 3) && ofType(call, "throw_statement").length === 0) {
          out.push(finding("catch-all-near-changed-code", "flag", ".catch() near changed code swallows every rejection.", f.path, line(call)))
        }
      }
      for (const m of ofType(headRoot, "member_expression")) {
        if (ENV_ACCESS.test(m.text) && m.parent?.type !== "member_expression" && added.has(line(m)) && insideCondition(m)) {
          out.push(finding("env-branching", "flag", `${m.text} decides a branch: behaviour that depends on the environment can differ under test.`, f.path, line(m)))
        }
      }
    }
    return out
  })

export const typescriptDetector: IntegrityDetector = {
  name: "typescript",
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
