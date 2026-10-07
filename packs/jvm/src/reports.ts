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
}

/** Pitest `mutations.xml`. Surviving and uncovered mutants both count against the score. */
export const parseMutations = (xml: string): MutationResult[] => {
  const doc = parser.parse(xml) as Node
  return arr<Node>((doc.mutations as Node | undefined)?.mutation).map((m) => ({
    className: String(m.mutatedClass ?? ""),
    sourceFile: String(m.sourceFile ?? ""),
    line: Number(m.lineNumber ?? 0),
    detected: String(m.detected) === "true",
    status: String(m.status ?? ""),
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
