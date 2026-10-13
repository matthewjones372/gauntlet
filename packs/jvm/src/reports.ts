import { XMLParser } from "fast-xml-parser"

// Parsers for the JVM tools' XML reports.

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", isArray: (name) => ["mutation", "package", "sourcefile", "line", "counter"].includes(name) })

type Node = Record<string, unknown>
const arr = <A>(x: unknown): A[] => (Array.isArray(x) ? (x as A[]) : x === undefined ? [] : [x as A])

export interface MutationResult {
  readonly className: string
  readonly sourceFile: string
  readonly line: number
  readonly detected: boolean
  readonly status: string
  /**
   * With Pitest's full mutation matrix (spec 0016): every test that killed the
   * mutant, and the tests that ran it and didn't, named as \`pitestTestName\` names them.
   * Absent without the matrix, where Pitest names only the first killer.
   */
  readonly killingTests?: ReadonlyArray<string>
  readonly succeedingTests?: ReadonlyArray<string>
}

/**
 * A Pitest test name as a test id: \`svc.FxTest.converts\` for JUnit 5's
 * \`svc.FxTest.[engine:junit-jupiter]/[class:svc.FxTest]/[method:converts()]\`,
 * Kotest's \`[spec:svc.FxSpec]/[test:rounds]\` and JUnit 4's \`svc.FxTest.converts(svc.FxTest)\`.
 */
export const pitestTestName = (raw: string): string => {
  const segments = [...raw.matchAll(/\[([\w-]+):([^\]]*)\]/g)].map((m) => ({ kind: m[1]!, value: m[2]! }))
  if (segments.length > 0) {
    const owner = segments.filter((s) => s.kind === "class" || s.kind === "spec").at(-1)?.value ?? raw.slice(0, raw.indexOf(".["))
    const nested = segments.filter((s) => s.kind === "nested-class").map((s) => s.value)
    const tests = segments.filter((s) => ["method", "test-template", "test-factory", "test"].includes(s.kind)).map((s) => s.value.replace(/\(.*\)$/, ""))
    return [owner, ...nested, ...tests].filter((x) => x !== "").join(".")
  }
  return /^(.+)\([\w.$]+\)$/.exec(raw)?.[1] ?? raw
}

const testsIn = (node: unknown): string[] => (typeof node === "string" && node !== "" ? node.split("|").filter((t) => t !== "").map(pitestTestName) : [])

/** Pitest `mutations.xml`. Surviving and uncovered mutants both count against the score. */
export const parseMutations = (xml: string): MutationResult[] => {
  const doc = parser.parse(xml) as Node
  return arr<Node>((doc.mutations as Node | undefined)?.mutation).map((m) => ({
    className: String(m.mutatedClass ?? ""),
    sourceFile: String(m.sourceFile ?? ""),
    line: Number(m.lineNumber ?? 0),
    detected: String(m.detected) === "true",
    status: String(m.status ?? ""),
    ...("killingTests" in m ? { killingTests: testsIn(m.killingTests), succeedingTests: testsIn(m.succeedingTests) } : {}),
  }))
}

export interface FileCoverage {
  readonly packagePath: string
  readonly fileName: string
  /** Executable lines and whether each was covered. */
  readonly lines: ReadonlyMap<number, boolean>
}

/** Kover's XML report (JaCoCo format): per-file line coverage. */
export const parseCoverage = (xml: string): FileCoverage[] => {
  const doc = parser.parse(xml) as Node
  const report = doc.report as Node | undefined
  return arr<Node>(report?.package).flatMap((pkg) =>
    arr<Node>(pkg.sourcefile).map((sf) => ({
      packagePath: String(pkg.name ?? ""),
      fileName: String(sf.name ?? ""),
      lines: new Map(arr<Node>(sf.line).map((l) => [Number(l.nr), Number(l.ci ?? 0) > 0] as const)),
    }))
  )
}
