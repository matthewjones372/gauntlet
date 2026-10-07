import { relativeUri, type Result, type Run } from "@gauntlet/sarif"
import { Option, Schema } from "effect"

// Parsers for the Scala tools' reports: scoverage's Cobertura XML, Stryker4s'
// mutation-testing JSON, and scalafix's --check messages.

export interface FileCoverage {
  readonly path: string
  readonly lines: ReadonlyMap<number, boolean>
}

/**
 * scoverage's cobertura.xml. File names are relative to a source root
 * (`svc/domain/Money.scala`), so each is matched to the repository file that
 * ends with it.
 */
export const parseCobertura = (xml: string, files: ReadonlyArray<string>): FileCoverage[] => {
  const out = new Map<string, Map<number, boolean>>()
  const classes = xml.split(/<class\s/).slice(1)
  for (const c of classes) {
    const name = /filename="([^"]+)"/.exec(c)?.[1]
    if (!name) continue
    const path = files.includes(name) ? name : files.filter((f) => f.endsWith(`/${name}`)).sort((a, b) => a.length - b.length)[0]
    if (!path) continue
    const lines = out.get(path) ?? new Map<number, boolean>()
    for (const m of c.matchAll(/<line\s+number="(\d+)"\s+hits="(\d+)"/g)) lines.set(Number(m[1]), (lines.get(Number(m[1])) ?? false) || Number(m[2]) > 0)
    out.set(path, lines)
  }
  return [...out].sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, lines]) => ({ path, lines }))
}

const StrykerReport = Schema.Struct({
  files: Schema.Record(Schema.String, Schema.Struct({
    mutants: Schema.Array(Schema.Struct({
      status: Schema.String,
      mutatorName: Schema.optionalKey(Schema.String),
      location: Schema.Struct({ start: Schema.Struct({ line: Schema.Number }) }),
    })),
  })),
})

export interface Mutant {
  readonly path: string
  readonly line: number
  readonly status: string
  readonly mutator: string
}

/** Statuses that count towards the score: detected over all that ran. */
export const DETECTED = new Set(["Killed", "Timeout"])
export const UNDETECTED = new Set(["Survived", "NoCoverage"])

/** Stryker4s' mutation-testing-report JSON (the same schema as StrykerJS). */
export const parseStryker = (json: string, repoRoot: string): Option.Option<Mutant[]> =>
  Option.map(Schema.decodeUnknownOption(Schema.fromJsonString(StrykerReport))(json), (r) =>
    Object.entries(r.files).flatMap(([file, f]) =>
      f.mutants.map((m) => ({ path: relativeUri(file, repoRoot), line: m.location.start.line, status: m.status, mutator: m.mutatorName ?? "mutant" }))))

const SCALAFIX = /^\[(?:error|warn)\]\s+(\S+\.scala):(\d+):\d+:\s+(error|warning):\s+\[([^\]]+)\]\s+(.*)$/

/** `scalafixAll --check` output as a SARIF run: one result per reported rule violation. */
export const convertScalafix = (output: string, repoRoot: string): Run => {
  const results: Result[] = []
  const seen = new Set<string>()
  for (const raw of output.split("\n")) {
    const m = SCALAFIX.exec(raw.trim())
    if (!m) continue
    const uri = relativeUri(m[1]!, repoRoot)
    const key = `${m[4]}\u0000${uri}\u0000${m[2]}\u0000${m[5]}`
    if (seen.has(key)) continue
    seen.add(key)
    results.push({ ruleId: m[4]!, level: m[3] === "error" ? "error" : "warning", message: { text: m[5]! }, locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: Number(m[2]) } } }] })
  }
  return { tool: { driver: { name: "scalafix" } }, results }
}
