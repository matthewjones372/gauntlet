import type { DetectorInput, DetectorOutput, IntegrityDetector, IntegrityFinding } from "@gauntlet/core"
import type { Metric } from "@gauntlet/sarif"
import { near } from "@gauntlet/syntax"
import { Effect, FileSystem, Option, Path } from "effect"
import { attributesOf, calleeText, inTestModule, line, macroName, nameOf, type Node, ofType, parseRust } from "./syntax.ts"
import { isRust, isTestFile } from "./toolchain.ts"

// Rust integrity detectors (ADR 0013): tests in tests/ and in #[cfg(test)]
// modules, with proptest and quickcheck counted towards the property-test
// ratchet. Inline tests live next to main code, so test checks look at test
// functions wherever they are, and main-code checks skip test modules.

const TEST_ATTRIBUTE = /^(test|tokio::test|async_std::test|rstest|test_case\b|quickcheck|proptest|test_log::test)/
const ASSERT_MACRO = /^(assert|assert_eq|assert_ne|assert_matches|debug_assert|debug_assert_eq|debug_assert_ne|prop_assert|prop_assert_eq|prop_assert_ne|panic)$/
const SUPPRESSION_ATTRIBUTE = /^(allow|expect)\s*\(/
const EQUALITY_TRAIT = /^(PartialEq|Eq|PartialOrd|Ord|Hash)$/
const EXIT = /(^|::)(process::)?exit$|^std::process::abort$|(^|::)process::abort$/
const ENV_CALL = /(^|::)env::(var|var_os|vars)$/
const QUARANTINE_WORD = /flak|quarantin/i

const finding = (check: IntegrityFinding["check"], kind: IntegrityFinding["kind"], message: string, path: string, at?: number): IntegrityFinding => ({
  check, kind, message, path, ...(at !== undefined ? { line: at } : {}), detector: "rust",
})

interface TestFn {
  readonly name: string
  readonly node: Node
  readonly assertions: number
  readonly attributes: ReadonlyArray<string>
}

const modulePath = (n: Node) => {
  const names: string[] = []
  for (let p: Node | null = n.parent; p; p = p.parent) if (p.type === "mod_item") names.unshift(nameOf(p))
  return names
}

const assertionCount = (fn: Node, attributes: ReadonlyArray<string>) =>
  ofType(fn, "macro_invocation").filter((m) => ASSERT_MACRO.test(macroName(m))).length + (attributes.some((a) => a.startsWith("should_panic")) ? 1 : 0)

export const testFunctions = (root: Node): TestFn[] =>
  ofType(root, "function_item").flatMap((f) => {
    const attributes = attributesOf(f)
    return attributes.some((a) => TEST_ATTRIBUTE.test(a))
      ? [{ name: [...modulePath(f), nameOf(f)].join("::"), node: f, assertions: assertionCount(f, attributes), attributes }]
      : []
  })

/** Property tests: functions in proptest! blocks, and #[quickcheck] or #[proptest] functions. */
const propertyCount = (root: Node) =>
  ofType(root, "macro_invocation").filter((m) => macroName(m) === "proptest").reduce((n, m) => n + (m.text.match(/\bfn\s+\w+/g)?.length ?? 0), 0)
  + testFunctions(root).filter((t) => t.attributes.some((a) => /^(quickcheck|proptest)/.test(a))).length

const skips = (root: Node) => testFunctions(root).filter((t) => t.attributes.some((a) => /^ignore\b/.test(a)))

const suppressions = (root: Node): Node[] =>
  [...ofType(root, "attribute_item"), ...ofType(root, "inner_attribute_item")].filter((a) => SUPPRESSION_ATTRIBUTE.test(a.namedChild(0)?.text ?? ""))

/** The tokens of a macro call, for `assert_eq!(x, x)`. */
const macroArgs = (m: Node) => (m.namedChildren.find((c) => c?.type === "token_tree")?.text ?? "").replace(/^[([{]|[)\]}]$/g, "")

const tautology = (m: Node) => {
  const name = macroName(m)
  const a = macroArgs(m).replace(/\s/g, "")
  if (name === "assert" && a === "true") return true
  if (/^assert_eq$|^prop_assert_eq$/.test(name)) {
    const [x, y] = splitTop(a)
    return x !== undefined && x === y
  }
  return false
}

/** Splits macro arguments at top-level commas. */
const splitTop = (s: string): string[] => {
  const out: string[] = []
  let depth = 0
  let cur = ""
  for (const ch of s) {
    if ("([{".includes(ch)) depth++
    if (")]}".includes(ch)) depth--
    if (ch === "," && depth === 0) {
      out.push(cur)
      cur = ""
    } else cur += ch
  }
  if (cur !== "") out.push(cur)
  return out
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
    for (const file of input.headFiles.filter(isRust)) {
      const text = yield* fs.readFileString(path.join(input.dir, file)).pipe(Effect.option)
      if (Option.isNone(text)) continue
      const root = parseRust(text.value).rootNode
      suppressed += suppressions(root).length
      const fns = testFunctions(root)
      asserted += fns.reduce((n, f) => n + f.assertions, 0)
      quarantined += fns.filter((f) => f.attributes.some((a) => /^ignore\b/.test(a) && QUARANTINE_WORD.test(a))).length
      properties += propertyCount(root)
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
    const cond = p.type === "if_expression" || p.type === "while_expression" ? p.childForFieldName("condition")
      : p.type === "match_expression" ? p.childForFieldName("value")
      : null
    if (cond) return n.startIndex >= cond.startIndex && n.endIndex <= cond.endIndex
    if (p.type === "function_item" || p.type === "closure_expression") return false
  }
  return false
}

/** Struct names a crate's main code declares, for spotting mocks of concrete types. */
const structNames = (roots: ReadonlyArray<Node>) =>
  new Set(roots.flatMap((r) => ofType(r, "struct_item").filter((s) => !inTestModule(s)).map((s) => nameOf(s))))

const compare = (input: DetectorInput) =>
  Effect.gen(function*() {
    const out: IntegrityFinding[] = []
    let crateStructs: Set<string> | undefined
    for (const f of input.facts.files) {
      if (f.status === "deleted" || !isRust(f.path)) continue
      const head = yield* input.readHead(f.path)
      if (Option.isNone(head)) continue
      const base = f.status === "added" ? Option.none<string>() : yield* input.readBase(f.oldPath ?? f.path)
      const headRoot = parseRust(head.value).rootNode
      const baseRoot = Option.map(base, (b) => parseRust(b).rootNode)
      const added = new Set((input.facts.addedLines.get(f.path) ?? []).map((l) => l.line))
      const testFile = input.isTestPath(f.path) || isTestFile(f.path)

      const before = Option.match(baseRoot, { onNone: () => 0, onSome: (r) => suppressions(r).length })
      const after = suppressions(headRoot)
      if (after.length > before) {
        const at = after.find((a) => added.has(line(a)))
        out.push(finding("new-suppressions", "forbid", `${after.length - before} new lint suppression${after.length - before === 1 ? "" : "s"} (#[allow(...)], #[expect(...)]).`, f.path, at ? line(at) : undefined))
      }

      // Tests, wherever they are: tests/ and #[cfg(test)] modules.
      const beforeTests = Option.match(baseRoot, { onNone: () => [] as TestFn[], onSome: testFunctions })
      const afterTests = testFunctions(headRoot)
      if (skips(headRoot).length > Option.match(baseRoot, { onNone: () => 0, onSome: (r) => skips(r).length })) {
        for (const s of skips(headRoot).filter((s) => !beforeTests.some((b) => b.name === s.name && b.attributes.some((a) => /^ignore\b/.test(a))))) {
          out.push(finding("new-skips", "forbid", `New skip: #[${s.attributes.find((a) => /^ignore\b/.test(a))}] on ${s.name}.`, f.path, line(s.node)))
        }
      }
      for (const b of beforeTests) {
        const a = afterTests.find((x) => x.name === b.name)
        if (!a) out.push(finding("deleted-tests", "forbid", `Test ${b.name} was removed.`, f.path))
        else if (a.assertions < b.assertions) out.push(finding("weakened-assertions", "forbid", `Test ${b.name} went from ${b.assertions} assertions to ${a.assertions}.`, f.path, line(a.node)))
      }
      for (const a of afterTests) {
        if (a.assertions === 0 && !beforeTests.some((b) => b.name === a.name)) {
          out.push(finding("weakened-assertions", "forbid", `New test ${a.name} has no assertions, so it can't fail on a wrong result.`, f.path, line(a.node)))
        }
        for (const m of ofType(a.node, "macro_invocation")) if (added.has(line(m)) && tautology(m)) out.push(finding("weakened-assertions", "forbid", `${m.text.split("\n")[0]} can't fail.`, f.path, line(m)))
        for (const c of ofType(a.node, "call_expression")) if (added.has(line(c)) && EXIT.test(calleeText(c))) out.push(finding("exit-in-tests", "forbid", `${calleeText(c)} ends the test process.`, f.path, line(c)))
      }
      if (testFile || afterTests.length > 0) {
        for (const m of ofType(headRoot, "macro_invocation").filter((m) => macroName(m) === "mock" && added.has(line(m)))) {
          crateStructs ??= structNames(yield* Effect.forEach(input.headFiles.filter((p) => isRust(p) && !isTestFile(p)), (p) => input.readHead(p).pipe(Effect.map((t) => Option.map(t, (x) => parseRust(x).rootNode))))
            .pipe(Effect.map((xs) => xs.flatMap(Option.toArray))))
          const mocked = /^\s*[{([]\s*(?:pub\s+)?(\w+)/.exec(m.namedChildren.find((c) => c?.type === "token_tree")?.text ?? "")?.[1]
          if (mocked && crateStructs.has(mocked)) out.push(finding("mocks-of-class-under-test", "flag", `mock! stands in for ${mocked}, a struct this crate declares.`, f.path, line(m)))
        }
      }
      if (testFile) continue

      // Main code, outside test modules.
      for (const m of ofType(headRoot, "macro_invocation")) {
        if (macroName(m) === "cfg" && /\btest\b/.test(macroArgs(m)) && added.has(line(m)) && !inTestModule(m)) {
          out.push(finding("test-refs-in-main", "forbid", "Main code checks cfg!(test), so it behaves differently under test.", f.path, line(m)))
        }
      }
      for (const a of ofType(headRoot, "attribute_item")) {
        if (/^cfg\(\s*not\(\s*test\s*\)\s*\)$/.test((a.namedChild(0)?.text ?? "").replace(/\s/g, "")) && added.has(line(a))) {
          out.push(finding("test-refs-in-main", "forbid", "#[cfg(not(test))] compiles different main code for tests.", f.path, line(a)))
        }
      }
      for (const i of ofType(headRoot, "impl_item")) {
        const trait = i.childForFieldName("trait")?.text.split("::").pop() ?? ""
        if (EQUALITY_TRAIT.test(trait) && added.has(line(i)) && !inTestModule(i)) {
          out.push(finding("equality-overrides", "flag", `New impl ${trait}: equality changes can make tests pass for the wrong reason.`, f.path, line(i)))
        }
      }
      for (const c of ofType(headRoot, "call_expression")) {
        if (inTestModule(c)) continue
        if (/(^|::)catch_unwind$/.test(calleeText(c)) && near(added, line(c), 3)) {
          out.push(finding("catch-all-near-changed-code", "flag", "catch_unwind near changed code can hide panics.", f.path, line(c)))
        }
        if (ENV_CALL.test(calleeText(c)) && added.has(line(c)) && insideCondition(c)) {
          out.push(finding("env-branching", "flag", `${calleeText(c)} decides a branch: behaviour that depends on the environment can differ under test.`, f.path, line(c)))
        }
      }
      for (const arm of ofType(headRoot, "match_arm")) {
        const pattern = arm.childForFieldName("pattern")?.text.replace(/\s/g, "") ?? ""
        const value = arm.childForFieldName("value")?.text.replace(/\s/g, "") ?? ""
        if (/^(Err\(_\)|_)$/.test(pattern) && /^(\{\}|\(\))$/.test(value) && near(added, line(arm), 3) && !inTestModule(arm)) {
          out.push(finding("catch-all-near-changed-code", "flag", `\`${pattern} => ${value}\` near changed code discards errors silently.`, f.path, line(arm)))
        }
      }
    }
    return out
  })

export const rustDetector: IntegrityDetector = {
  name: "rust",
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
