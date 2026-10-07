import type { DetectorInput, DetectorOutput, IntegrityDetector, IntegrityFinding } from "@gauntlet/core"
import type { Metric } from "@gauntlet/sarif"
import { Effect, FileSystem, Option, Path } from "effect"
import { near } from "@gauntlet/syntax"
import { annotations, calleeName, calleeText, isKotlin, line, type Node, ofType, parseKotlin } from "./syntax.ts"

// Kotlin integrity detectors (ADR 0013). Whole-project ratchet values are
// measured from the judged checkout; findings about a change compare each
// changed file's base and head versions.

const ASSERTION = /^(assert\w*|expect\w*|verify\w*|check)$/
const INFIX_ASSERTION = /^should\w*/
const TEST_ANNOTATIONS = new Set(["Test", "ParameterizedTest", "RepeatedTest", "TestFactory", "Property"])
const SKIP_ANNOTATIONS = new Set(["Disabled", "Ignore", "DisabledIf", "DisabledOnOs"])
const QUARANTINE_TAGS = /"(flaky|quarantine|quarantined)"/i
const PROPERTY_CALLS = new Set(["checkAll", "forAll", "forNone", "checkAllExhaustive"])
const EXIT_CALLS = new Set(["exitProcess", "System.exit", "Runtime.getRuntime().halt", "Runtime.getRuntime().exit"])
const SUPPRESSION_COMMENT = /\b(detekt:disable|noinspection|ktlint-disable|@formatter:off)\b/
const CATCH_ALL = new Set(["Exception", "Throwable", "RuntimeException", "kotlin.Exception", "java.lang.Exception"])
const MOCKERS = /\b(mockk|spyk|mock|spy|mockkClass)\s*(<\s*(\w+)\s*>|\(\s*(\w+)(::class)?)/

interface TestFn {
  readonly name: string
  readonly node: Node
  readonly assertions: number
}

const assertionCount = (root: Node) =>
  ofType(root, "call_expression").filter((c) => ASSERTION.test(calleeName(c) ?? "")).length +
  ofType(root, "infix_expression").filter((i) => INFIX_ASSERTION.test(i.namedChild(1)?.text ?? "")).length

export const testFunctions = (root: Node): TestFn[] =>
  ofType(root, "function_declaration")
    .filter((f) => annotations(f).some((a) => TEST_ANNOTATIONS.has(a.name)))
    .map((f) => ({ name: f.namedChildren.find((c) => c?.type === "identifier")?.text ?? "", node: f, assertions: assertionCount(f) }))

/** @Suppress annotations, and inline disables in comments (not the same words in code or strings). */
const suppressions = (root: Node, _text: string) =>
  ofType(root, "annotation").filter((a) => /^(Suppress|SuppressWarnings)\b/.test(ofType(a, "user_type")[0]?.text ?? "")).length +
  ofType(root, "line_comment", "block_comment").filter((c) => SUPPRESSION_COMMENT.test(c.text)).length

const skips = (root: Node) => [
  ...ofType(root, "annotation").filter((a) => SKIP_ANNOTATIONS.has(ofType(a, "user_type")[0]?.text.split(".").pop() ?? "")),
  ...ofType(root, "call_expression").filter((c) => (calleeName(c) === "assumeTrue" && /\(\s*false\s*\)/.test(c.text)) || calleeName(c) === "abort"),
]

const tautology = (call: Node): boolean => {
  const name = calleeName(call)
  const args = ofType(call, "value_arguments")[0]?.namedChildren.filter((a) => a !== null).map((a) => a!.text.replace(/\s/g, "")) ?? []
  if (name === "assertTrue" && args[0] === "true") return true
  if (name === "assertFalse" && args[0] === "false") return true
  if ((name === "assertEquals" || name === "assertSame") && args.length >= 2 && args[0] === args[1]) return true
  return false
}

const finding = (check: IntegrityFinding["check"], kind: IntegrityFinding["kind"], message: string, path: string, at?: number): IntegrityFinding => ({
  check, kind, message, path, ...(at !== undefined ? { line: at } : {}), detector: "kotlin",
})

const insideCondition = (n: Node) => {
  for (let p: Node | null = n.parent; p; p = p.parent) {
    if (p.type === "when_subject" || p.type === "when_condition") return true
    if (p.type === "if_expression") return p.namedChild(0) !== null && n.startIndex >= p.namedChild(0)!.startIndex && n.endIndex <= p.namedChild(0)!.endIndex
    if (p.type === "function_declaration" || p.type === "class_body") return false
  }
  return false
}

const metric = (value: number, higherIsBetter: boolean, unit: Metric["unit"] = "count"): Metric => ({ value, unit, higherIsBetter })

/** Whole-project values for the Kotlin ratchets, measured in the judged checkout. */
const measure = (input: DetectorInput) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    let assertions = 0
    let suppressed = 0
    let quarantined = 0
    let properties = 0
    for (const file of input.headFiles.filter(isKotlin)) {
      const text = yield* fs.readFileString(path.join(input.dir, file)).pipe(Effect.option)
      if (Option.isNone(text)) continue
      const root = parseKotlin(text.value).rootNode
      suppressed += suppressions(root, text.value)
      if (!input.isTestPath(file)) continue
      const fns = testFunctions(root)
      assertions += fns.reduce((n, f) => n + f.assertions, 0)
      quarantined += ofType(root, "annotation").filter((a) => /^Tag\b/.test(ofType(a, "user_type")[0]?.text ?? "") && QUARANTINE_TAGS.test(a.text)).length
      properties += ofType(root, "call_expression").filter((c) => PROPERTY_CALLS.has(calleeName(c) ?? "")).length
        + fns.filter((f) => annotations(f.node).some((a) => a.name === "Property")).length
    }
    return {
      // The total can't drop; per-test weakening is the weakened-assertions forbid.
      "integrity/assertions-per-test": metric(assertions, true),
      "integrity/suppressions": metric(suppressed, false),
      "integrity/quarantined-tests": metric(quarantined, false),
      "integrity/property-tests": metric(properties, true),
    }
  })

/** Findings about the change: each changed Kotlin file, base against head. */
const compare = (input: DetectorInput) =>
  Effect.gen(function*() {
    const out: IntegrityFinding[] = []
    for (const f of input.facts.files) {
      if (f.status === "deleted" || !isKotlin(f.path)) continue
      const head = yield* input.readHead(f.path)
      if (Option.isNone(head)) continue
      const base = f.status === "added" ? Option.none<string>() : yield* input.readBase(f.oldPath ?? f.path)
      const headRoot = parseKotlin(head.value).rootNode
      const baseRoot = Option.map(base, (b) => parseKotlin(b).rootNode)
      const added = new Set((input.facts.addedLines.get(f.path) ?? []).map((l) => l.line))
      const isTest = input.isTestPath(f.path)

      const headSuppressions = suppressions(headRoot, head.value)
      const baseSuppressions = Option.match(baseRoot, { onNone: () => 0, onSome: (r) => suppressions(r, Option.getOrElse(base, () => "")) })
      if (headSuppressions > baseSuppressions) {
        const at = [...ofType(headRoot, "annotation")].find((a) => /^(Suppress|SuppressWarnings)\b/.test(ofType(a, "user_type")[0]?.text ?? "") && added.has(line(a)))
        out.push(finding("new-suppressions", "forbid", `${headSuppressions - baseSuppressions} new suppression${headSuppressions - baseSuppressions === 1 ? "" : "s"} (@Suppress or an inline disable).`, f.path, at ? line(at) : undefined))
      }

      if (isTest) {
        const newSkips = skips(headRoot).filter((s) => added.has(line(s)))
        if (skips(headRoot).length > Option.match(baseRoot, { onNone: () => 0, onSome: (r) => skips(r).length })) {
          for (const s of newSkips) out.push(finding("new-skips", "forbid", `New skip: ${s.text.split("\n")[0]}.`, f.path, line(s)))
        }
        const before = Option.match(baseRoot, { onNone: () => [] as TestFn[], onSome: testFunctions })
        const after = testFunctions(headRoot)
        for (const b of before) {
          const a = after.find((x) => x.name === b.name)
          if (!a) out.push(finding("deleted-tests", "forbid", `Test ${b.name} was removed.`, f.path))
          else if (a.assertions < b.assertions) out.push(finding("weakened-assertions", "forbid", `Test ${b.name} went from ${b.assertions} assertions to ${a.assertions}.`, f.path, line(a.node)))
        }
        for (const a of after) {
          if (a.assertions === 0 && !before.some((b) => b.name === a.name)) {
            out.push(finding("weakened-assertions", "forbid", `New test ${a.name} has no assertions, so it can't fail on a wrong result.`, f.path, line(a.node)))
          }
        }
        for (const call of ofType(headRoot, "call_expression")) {
          if (added.has(line(call)) && tautology(call)) out.push(finding("weakened-assertions", "forbid", `${call.text} can't fail.`, f.path, line(call)))
          if (added.has(line(call)) && EXIT_CALLS.has(calleeText(call))) out.push(finding("exit-in-tests", "forbid", `${calleeText(call)} exits the test process.`, f.path, line(call)))
        }
        const underTest = f.path.split("/").pop()!.replace(/\.kts?$/, "").replace(/(Test|Tests|Spec)$/, "")
        for (const l of input.facts.addedLines.get(f.path) ?? []) {
          const m = MOCKERS.exec(l.text)
          if (m && (m[3] ?? m[4]) === underTest) out.push(finding("mocks-of-class-under-test", "flag", `The test mocks ${underTest}, the class it tests.`, f.path, l.line))
        }
        continue
      }

      for (const fn of ofType(headRoot, "function_declaration")) {
        const name = fn.namedChildren.find((c) => c?.type === "identifier")?.text
        if ((name === "equals" || name === "hashCode") && /\boverride\b/.test(fn.text.split("fun")[0] ?? "") && added.has(line(fn))) {
          out.push(finding("equality-overrides", "flag", `New ${name} override: equality changes can make tests pass for the wrong reason.`, f.path, line(fn)))
        }
      }
      for (const c of ofType(headRoot, "catch_block")) {
        const type = ofType(c, "user_type")[0]?.text ?? ""
        if (CATCH_ALL.has(type) && near(added, line(c), 3)) out.push(finding("catch-all-near-changed-code", "flag", `catch (${type}) near changed code can hide failures.`, f.path, line(c)))
      }
      for (const call of ofType(headRoot, "call_expression")) {
        const callee = calleeText(call)
        if (calleeName(call) === "runCatching" && near(added, line(call), 3)) out.push(finding("catch-all-near-changed-code", "flag", "runCatching near changed code swallows every exception.", f.path, line(call)))
        if (/(^|\.)(getenv|getProperty)$/.test(callee) && /System|^getenv/.test(callee) && added.has(line(call)) && insideCondition(call)) {
          out.push(finding("env-branching", "flag", `${callee} decides a branch: behaviour that depends on the environment can differ under test.`, f.path, line(call)))
        }
      }
    }
    return out
  })

export const kotlinDetector: IntegrityDetector = {
  name: "kotlin",
  checks: [
    "assertions-per-test", "suppressions", "quarantined-tests", "property-tests",
    "weakened-assertions", "new-skips", "new-suppressions", "exit-in-tests", "deleted-tests",
    "equality-overrides", "catch-all-near-changed-code", "env-branching", "mocks-of-class-under-test",
  ],
  run: (input) =>
    Effect.gen(function*() {
      const metrics = yield* measure(input)
      const findings = yield* compare(input)
      return { findings, metrics } satisfies DetectorOutput
    }),
}
