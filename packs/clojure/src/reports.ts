import { relativeUri, type Result, type Run } from "@gauntlet/sarif"
import { Option, Schema } from "effect"

// Parsers for the Clojure tools' reports: clj-kondo's JSON findings,
// cloverage's lcov, and kaocha's JUnit XML test names.

const KondoOutput = Schema.Struct({
  findings: Schema.Array(Schema.Struct({
    filename: Schema.String,
    row: Schema.optionalKey(Schema.Number),
    level: Schema.String,
    type: Schema.String,
    message: Schema.String,
  })),
})

/** clj-kondo's `{:output {:format :json}}` findings as a SARIF run. */
export const convertKondo = (json: string, repoRoot: string): Option.Option<Run> =>
  Option.map(Schema.decodeUnknownOption(Schema.fromJsonString(KondoOutput))(json), (out) => {
    const results: Result[] = out.findings.map((f) => ({
      ruleId: f.type,
      level: f.level === "error" ? "error" : f.level === "info" ? "note" : "warning",
      message: { text: f.message },
      locations: [{ physicalLocation: { artifactLocation: { uri: relativeUri(f.filename, repoRoot) }, region: { startLine: f.row ?? 1 } } }],
    }))
    return { tool: { driver: { name: "clj-kondo" } }, results }
  })

export interface FileCoverage {
  readonly path: string
  readonly lines: ReadonlyMap<number, boolean>
}

export const parseLcov = (text: string, repoRoot: string): FileCoverage[] => {
  const out: FileCoverage[] = []
  let current: { path: string; lines: Map<number, boolean> } | undefined
  for (const raw of text.split(/\r?\n/)) {
    if (raw.startsWith("SF:")) current = { path: relativeUri(raw.slice(3).trim(), repoRoot), lines: new Map() }
    else if (raw.startsWith("DA:") && current) {
      const [nr, hits] = raw.slice(3).split(",")
      current.lines.set(Number(nr), (current.lines.get(Number(nr)) ?? false) || Number(hits) > 0)
    } else if (raw === "end_of_record" && current) {
      out.push(current)
      current = undefined
    }
  }
  return out
}

/**
 * kaocha names a test case `ns/var` inside a `classname="ns"`; the ns prefix
 * is dropped so test ids read `svc.domain.money-test.adds`, like other packs'.
 */
export const tidyJUnit = (xml: string): string =>
  xml.replace(/<testcase\b([^>]*?)\bname="([^"]*)"([^>]*?)\bclassname="([^"]*)"/g, (all, a: string, name: string, b: string, cls: string) =>
    name.startsWith(`${cls}/`) ? `<testcase${a}name="${name.slice(cls.length + 1)}"${b}classname="${cls}"` : all)

/** kaocha's --focus id for a Gauntlet test id: `svc.domain.money-test.adds` is `svc.domain.money-test/adds`. */
export const focusOf = (id: string, namespaces: ReadonlyArray<string>): string | undefined => {
  const ns = namespaces.filter((n) => id === n || id.startsWith(`${n}.`)).sort((a, b) => b.length - a.length)[0]
  if (!ns) return undefined
  return id === ns ? ns : `${ns}/${id.slice(ns.length + 1).split(/[.\s]/)[0]}`
}
