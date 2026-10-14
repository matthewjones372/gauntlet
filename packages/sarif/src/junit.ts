import { Data, Effect } from "effect"
import { XMLParser } from "fast-xml-parser"
import type { Result, Run, TestCounts } from "./schema.ts"

// Converts JUnit XML (as written by Gradle, Maven Surefire and most other
// runners) into a SARIF run. Counts come from the test cases themselves, not
// from the summary attributes, which a report can claim anything in.

export class JUnitInvalid extends Data.TaggedError("JUnitInvalid")<{ readonly file: string; readonly reason: string }> {}

export interface TestCase {
  readonly id: string
  readonly status: "passed" | "failed" | "errored" | "skipped"
}

export interface JUnitReport {
  readonly run: Run
  readonly counts: TestCounts
  readonly tests: ReadonlyArray<TestCase>
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  textNodeName: "#text",
  processEntities: true,
  isArray: (name) => ["testsuite", "testcase", "failure", "error", "skipped"].includes(name),
})

const asArray = <A>(x: A | ReadonlyArray<A> | undefined): ReadonlyArray<A> => (x === undefined ? [] : Array.isArray(x) ? x : [x as A])

type Node = Record<string, unknown>

const suitesOf = (doc: Node): Node[] => {
  const out: Node[] = []
  const walk = (suites: ReadonlyArray<Node>) => {
    for (const s of suites) {
      out.push(s)
      walk(asArray(s.testsuite as Node[] | undefined))
    }
  }
  const root = (doc.testsuites as Node | undefined) ?? doc
  walk(asArray(root.testsuite as Node[] | undefined))
  return out
}

const text = (n: unknown): string => {
  if (typeof n === "string") return n
  if (n && typeof n === "object") {
    const o = n as Node
    return String(o.message ?? o["#text"] ?? "").trim()
  }
  return ""
}

/** Bun's JUnit reporter names its root element `bun test`. */
const isBun = (doc: Node) => (doc.testsuites as Node | undefined)?.name === "bun test"

/** A path as a runner wrote it, with `/` separators and no leading `./`. */
const filePath = (file: string) => file.replaceAll("\\", "/").replace(/^\.\//, "")

/**
 * A test's id: `<classname>.<name>`. Bun's classname is only the describe
 * path (empty at the top level), so two files' tests could share an id; a bun
 * test is named after its file too, as Vitest's are (ADR 0027):
 * `<file>.<classname>.<name>`, or `<file>.<name>` at the top level. What
 * follows the file is the id older versions gave it, so a baseline recorded
 * with those still matches (see `legacyBunIds`).
 */
const testId = (tc: Node, suite: Node, bun: boolean): string => {
  const classname = String(tc.classname ?? suite.name ?? "")
  const name = String(tc.name ?? "")
  if (bun && typeof tc.file === "string" && tc.file !== "") return `${filePath(tc.file)}.${classname === "" ? "" : `${classname}.`}${name}`
  return `${classname}.${name}`
}

/** Parses one or more JUnit XML documents into a single run named `check`. */
export const convertJUnit = (check: string, files: ReadonlyArray<{ readonly path: string; readonly content: string }>) =>
  Effect.gen(function*() {
    const tests: TestCase[] = []
    const results: Result[] = []
    for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
      const doc = yield* Effect.try({
        try: () => parser.parse(file.content, true) as Node,
        catch: (e) => new JUnitInvalid({ file: file.path, reason: String(e) }),
      })
      if (doc.testsuites === undefined && doc.testsuite === undefined) {
        return yield* new JUnitInvalid({ file: file.path, reason: "no <testsuites> or <testsuite> element" })
      }
      const bun = isBun(doc)
      for (const suite of suitesOf(doc)) {
        for (const tc of asArray(suite.testcase as Node[] | undefined)) {
          const id = testId(tc, suite, bun)
          const failure = asArray(tc.failure as unknown[] | undefined)[0]
          const error = asArray(tc.error as unknown[] | undefined)[0]
          const skipped = asArray(tc.skipped as unknown[] | undefined).length > 0
          const status = error !== undefined ? "errored" : failure !== undefined ? "failed" : skipped ? "skipped" : "passed"
          tests.push({ id, status })
          if (status === "failed" || status === "errored") {
            const detail = text(error ?? failure)
            results.push({
              ruleId: status === "failed" ? "test/failed" : "test/errored",
              level: "error",
              message: { text: detail ? `${id}: ${detail}` : id },
              locations: [{
                ...(typeof tc.file === "string" ? { physicalLocation: { artifactLocation: { uri: tc.file } } } : {}),
                logicalLocations: [{ fullyQualifiedName: id, kind: "function" }],
              }],
            })
          }
        }
      }
    }
    tests.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    const count = (s: TestCase["status"]) => tests.filter((t) => t.status === s).length
    const counts: TestCounts = {
      executed: tests.length - count("skipped"),
      passed: count("passed"),
      failed: count("failed"),
      errored: count("errored"),
      skipped: count("skipped"),
    }
    const run: Run = { tool: { driver: { name: "junit" } }, results, properties: { gauntlet: { check, tests: counts } } }
    return { run, counts, tests } satisfies JUnitReport
  })

// ---------- baselines recorded before bun's tests were named after their files (ADR 0027) ----------

/** Where a JavaScript or TypeScript test file's name ends inside an id: `.ts.`, `.tsx.`, `.mjs.` and so on. */
const SCRIPT_FILE_END = /\.[cm]?[jt]sx?\./g

/**
 * The ids an older Gauntlet gave the bun test with this id: the id without its
 * file, keeping a build's `<folder>:` prefix. Bun's top-level tests had ids
 * starting with `.`, so both spellings are given. Any id with a script file's
 * name in it has candidates; they only matter if a baseline holds one of them.
 */
export const legacyBunIds = (id: string): string[] => {
  const out: string[] = []
  const colon = id.indexOf(":")
  for (const m of id.matchAll(SCRIPT_FILE_END)) {
    const build = colon >= 0 && colon < m.index ? id.slice(0, colon + 1) : ""
    const rest = id.slice(m.index + m[0].length)
    out.push(`${build}${rest}`, `${build}.${rest}`)
  }
  return out
}

/**
 * The base's test ids as the head names them. A baseline recorded before bun's
 * tests were named after their files (ADR 0027) holds ids like `grp.adds`; the
 * head's run names that test `test/a.test.ts.grp.adds`. A base id the head
 * doesn't have, but that is a head id without its file, is that test: it takes
 * the head's name. One such id with several files' tests (the same name in
 * two files, one id before) still ran, so it takes the first of them: the
 * migration never makes a test look deleted. A base id no head id carries is
 * left as it is, so a test that really went is still missing. Every id keeps
 * its place, so counts don't change. Once the baseline is recorded again no id
 * needs this, and it changes nothing.
 */
export const migrateTestIds = (baseIds: ReadonlyArray<string>, headIds: ReadonlyArray<string>): string[] => {
  const head = new Set(headIds)
  if (baseIds.every((id) => head.has(id))) return [...baseIds]
  const byLegacy = new Map<string, string>()
  for (const id of [...head].sort()) for (const old of legacyBunIds(id)) if (!byLegacy.has(old)) byLegacy.set(old, id)
  return baseIds.map((id) => (head.has(id) ? id : byLegacy.get(id) ?? id))
}
