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
      for (const suite of suitesOf(doc)) {
        for (const tc of asArray(suite.testcase as Node[] | undefined)) {
          const id = `${String(tc.classname ?? suite.name ?? "")}.${String(tc.name ?? "")}`
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
