import type { DetectorInput, DetectorOutput, IntegrityDetector, IntegrityFinding } from "@gauntlet/core"
import type { Metric } from "@gauntlet/sarif"
import { near } from "@gauntlet/syntax"
import { Effect, FileSystem, Option, Path } from "effect"
import { aliasesOf, type Form, head, live, local, nsOf, read, walk } from "./syntax.ts"
import { isClojure, isTestFile } from "./toolchain.ts"

// Clojure integrity detectors (ADR 0013) for clojure.test, as kaocha runs it:
// `(deftest name ...)` with `is` and `are`, test.check's `defspec`, and
// kaocha's skip metadata (`^:kaocha/skip`, `^:kaocha/pending`).

const ASSERT = /^(is|are|expect)$/
const PROPERTY = /^(defspec|checking|for-all|quick-check)$/
const SKIP_META = /^:(kaocha\/skip|kaocha\/pending|skip|pending|ignore)$/
const QUARANTINE_META = /^:(flaky|kaocha\/flaky|quarantine)$/
const EXIT = /^((java\.lang\.)?System\/exit|\.halt)$/
const TEST_LIB = /^(clojure\.test|clojure\.test\.check(\..*)?|kaocha(\..*)?|matcher-combinators\.test|expectations(\..*)?|midje(\..*)?)$/
const ENV = /^((java\.lang\.)?System\/(getenv|getProperty))$/
const CONDITIONAL = /^(if|if-not|when|when-not|cond|case|condp|if-let|when-let|if-some|when-some)$/

const finding = (check: IntegrityFinding["check"], kind: IntegrityFinding["kind"], message: string, path: string, at?: number): IntegrityFinding => ({
  check, kind, message, path, ...(at !== undefined ? { line: at } : {}), detector: "clojure",
})

interface TestDef {
  readonly name: string
  readonly form: Form
  readonly assertions: number
  readonly skipped: boolean
  readonly quarantined: boolean
  readonly property: boolean
}

const assertionsIn = (f: Form) => [...live(f.children)].filter((c) => ASSERT.test(local(head(c))) && c.prefix === "").length

/** Live `deftest` and `defspec` forms: what kaocha runs. Commented-out or #_ tests don't count. */
export const testDefinitions = (forms: ReadonlyArray<Form>): TestDef[] => {
  const ns = nsOf(forms)?.name ?? ""
  return [...live(forms)].flatMap((f) => {
    const h = local(head(f))
    if (h !== "deftest" && h !== "defspec") return []
    const sym = f.children[1]
    if (sym?.type !== "symbol") return []
    const property = h === "defspec" || [...live(f.children)].some((c) => PROPERTY.test(local(head(c))))
    return [{
      name: ns ? `${ns}.${sym.text}` : sym.text,
      form: f,
      // A defspec's property is its assertion.
      assertions: assertionsIn(f) + (h === "defspec" ? 1 : 0),
      skipped: sym.meta.some((m) => SKIP_META.test(m) || /:kaocha\/skip\s+true/.test(m)),
      quarantined: sym.meta.some((m) => QUARANTINE_META.test(m)),
      property,
    }]
  })
}

/** clj-kondo suppressions: #_{:clj-kondo/ignore [...]}, #_:clj-kondo/ignore, ^{:clj-kondo/ignore ...} and :clj-kondo/config in metadata. */
export const suppressionLines = (forms: ReadonlyArray<Form>): number[] =>
  [...walk(forms)].flatMap((f) => [
    ...(f.type === "keyword" && /^:clj-kondo\/(ignore|config)$/.test(f.text) ? [f.line] : []),
    ...f.meta.filter((m) => /:clj-kondo\/(ignore|config)\b/.test(m)).map(() => f.line),
  ])

const tautology = (f: Form): boolean => {
  if (local(head(f)) !== "is") return false
  const arg = f.children[1]
  if (!arg) return false
  if (arg.type === "symbol" && arg.text === "true") return true
  if (local(head(arg)) === "=" && arg.children.length === 3 && arg.children[1]!.text === arg.children[2]!.text) return true
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
    for (const file of input.headFiles.filter(isClojure)) {
      const text = yield* fs.readFileString(path.join(input.dir, file)).pipe(Effect.option)
      if (Option.isNone(text)) continue
      const forms = read(text.value)
      suppressed += suppressionLines(forms).length
      if (!input.isTestPath(file) && !isTestFile(file)) continue
      const tests = testDefinitions(forms)
      asserted += tests.reduce((n, t) => n + t.assertions, 0)
      quarantined += tests.filter((t) => t.quarantined).length
      properties += tests.filter((t) => t.property).length
    }
    return {
      "integrity/assertions-per-test": metric(asserted, true),
      "integrity/suppressions": metric(suppressed, false),
      "integrity/quarantined-tests": metric(quarantined, false),
      "integrity/property-tests": metric(properties, true),
    }
  })

/** The forms a conditional decides on: `(if c ...)`'s c, every test in `(cond a x b y)`. */
const conditions = (f: Form): Form[] => {
  const h = local(head(f))
  if (h === "cond") return f.children.slice(1).filter((_, k) => k % 2 === 0)
  if (h === "case" || h === "condp") return f.children.slice(1, h === "condp" ? 3 : 2)
  return f.children[1] ? [f.children[1]] : []
}

const compare = (input: DetectorInput) =>
  Effect.gen(function*() {
    const out: IntegrityFinding[] = []
    for (const f of input.facts.files) {
      if (f.status === "deleted" || !isClojure(f.path)) continue
      const headText = yield* input.readHead(f.path)
      if (Option.isNone(headText)) continue
      const base = f.status === "added" ? Option.none<string>() : yield* input.readBase(f.oldPath ?? f.path)
      const headForms = read(headText.value)
      const baseForms = Option.map(base, read)
      const added = new Set((input.facts.addedLines.get(f.path) ?? []).map((l) => l.line))

      const before = Option.match(baseForms, { onNone: () => 0, onSome: (b) => suppressionLines(b).length })
      const after = suppressionLines(headForms)
      if (after.length > before) {
        out.push(finding("new-suppressions", "forbid", `${after.length - before} new clj-kondo suppression${after.length - before === 1 ? "" : "s"}.`, f.path, after.find((l) => added.has(l))))
      }

      if (input.isTestPath(f.path) || isTestFile(f.path)) {
        const beforeTests = Option.match(baseForms, { onNone: () => [] as TestDef[], onSome: testDefinitions })
        const afterTests = testDefinitions(headForms)
        for (const t of afterTests.filter((t) => t.skipped && !beforeTests.some((b) => b.name === t.name && b.skipped))) out.push(finding("new-skips", "forbid", `New skip: ${t.name}.`, f.path, t.form.line))
        for (const b of beforeTests) {
          const a = afterTests.find((x) => x.name === b.name)
          if (!a) out.push(finding("deleted-tests", "forbid", `Test ${b.name} was removed.`, f.path))
          else if (a.assertions < b.assertions) out.push(finding("weakened-assertions", "forbid", `Test ${b.name} went from ${b.assertions} assertions to ${a.assertions}.`, f.path, a.form.line))
        }
        for (const a of afterTests) {
          if (a.assertions === 0 && !a.skipped && !beforeTests.some((b) => b.name === a.name)) {
            out.push(finding("weakened-assertions", "forbid", `New test ${a.name} has no assertions, so it can't fail on a wrong result.`, f.path, a.form.line))
          }
        }
        // with-redefs of a var in the namespace under test replaces the code the test is meant to check.
        const ns = nsOf(headForms)?.name ?? ""
        const underTest = ns.replace(/-test$/, "")
        const aliases = aliasesOf(headForms)
        for (const c of live(headForms)) {
          if (!added.has(c.line) || c.prefix !== "") continue
          if (tautology(c)) out.push(finding("weakened-assertions", "forbid", `${c.text.split("\n")[0]} can't fail.`, f.path, c.line))
          if (EXIT.test(head(c))) out.push(finding("exit-in-tests", "forbid", `${head(c)} ends the test JVM.`, f.path, c.line))
          if (/^(with-redefs|with-redefs-fn)$/.test(local(head(c))) && c.children[1]?.type === "vector" && underTest !== ns) {
            const redefined = c.children[1].children.filter((_, k) => k % 2 === 0).map((s) => s.text.replace(/^#'/, ""))
            const hit = redefined.find((s) => {
              const [q, name] = s.includes("/") ? [s.slice(0, s.lastIndexOf("/")), s.slice(s.lastIndexOf("/") + 1)] : ["", s]
              return name !== "" && (aliases.get(q) ?? q) === underTest
            })
            if (hit) out.push(finding("mocks-of-class-under-test", "flag", `with-redefs replaces ${hit}, part of the namespace under test.`, f.path, c.line))
          }
        }
        continue
      }

      for (const r of nsOf(headForms)?.requires ?? []) {
        if (added.has(r.line) && TEST_LIB.test(r.lib)) out.push(finding("test-refs-in-main", "forbid", `Main code requires a test library (${r.lib}).`, f.path, r.line))
      }
      for (const c of live(headForms)) {
        const h = local(head(c))
        if (/^(deftype|defrecord|reify|extend-type|extend-protocol)$/.test(h)) {
          for (const m of c.children.filter((x) => x.type === "list" && /^(equals|hashCode|hasheq|equiv|compareTo)$/.test(head(x)) && added.has(x.line))) {
            out.push(finding("equality-overrides", "flag", `New ${head(m)}: equality changes can make tests pass for the wrong reason.`, f.path, m.line))
          }
        }
        if (h === "catch" && /^(Exception|Throwable|Object|:default|java\.lang\.(Exception|Throwable))$/.test(c.children[1]?.text ?? "") && ![...live(c.children)].some((x) => local(head(x)) === "throw") && near(added, c.line, 3)) {
          out.push(finding("catch-all-near-changed-code", "flag", `A catch of ${c.children[1]!.text} near changed code that never rethrows can hide failures.`, f.path, c.line))
        }
        if (CONDITIONAL.test(h)) {
          for (const cond of conditions(c)) {
            for (const e of [cond, ...live(cond.children)].filter((x) => ENV.test(head(x)) && added.has(x.line))) {
              out.push(finding("env-branching", "flag", `${e.text} decides a branch: behaviour that depends on the environment can differ under test.`, f.path, e.line))
            }
          }
        }
      }
    }
    return out
  })

export const clojureDetector: IntegrityDetector = {
  name: "clojure",
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
