import { relativeUri, type Result, type Run } from "@gauntlet/sarif"
import { Option, Schema } from "effect"

// Parsers for the Rust tools' reports: clippy's JSON messages, lcov from
// cargo-llvm-cov, and cargo-mutants' outcomes.json.

const CompilerMessage = Schema.Struct({
  reason: Schema.String,
  message: Schema.optionalKey(Schema.Struct({
    code: Schema.NullOr(Schema.Struct({ code: Schema.String })),
    level: Schema.String,
    message: Schema.String,
    spans: Schema.Array(Schema.Struct({ file_name: Schema.String, line_start: Schema.Number, is_primary: Schema.Boolean })),
  })),
})
const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(CompilerMessage))

/**
 * `cargo clippy --message-format=json` as a SARIF run. Lints only: compiler
 * errors fail the build gate instead. A file compiled for several targets
 * reports the same lint once per target, so results are deduplicated.
 */
export const convertClippy = (stdout: string, repoRoot: string): Run => {
  const seen = new Set<string>()
  const results: Result[] = []
  for (const raw of stdout.split("\n")) {
    const m = Option.getOrUndefined(decodeMessage(raw))?.message
    const code = m?.code?.code
    if (!m || !code || m.level === "error") continue
    const span = m.spans.find((s) => s.is_primary)
    if (!span) continue
    const uri = relativeUri(span.file_name, repoRoot)
    const key = `${code}\u0000${uri}\u0000${span.line_start}\u0000${m.message}`
    if (seen.has(key)) continue
    seen.add(key)
    results.push({
      ruleId: code,
      level: m.level === "warning" ? "warning" : "note",
      message: { text: m.message },
      locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: span.line_start } } }],
    })
  }
  results.sort((a, b) => {
    const ka = `${a.locations?.[0]?.physicalLocation?.artifactLocation?.uri}\u0000${String(a.locations?.[0]?.physicalLocation?.region?.startLine).padStart(9, "0")}\u0000${a.ruleId}`
    const kb = `${b.locations?.[0]?.physicalLocation?.artifactLocation?.uri}\u0000${String(b.locations?.[0]?.physicalLocation?.region?.startLine).padStart(9, "0")}\u0000${b.ruleId}`
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })
  return { tool: { driver: { name: "clippy" } }, results }
}

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

export interface Mutant {
  readonly path: string
  readonly line: number
  readonly description: string
  readonly outcome: "killed" | "survived" | "timeout" | "other"
}

const MutantsOutcomes = Schema.Struct({
  outcomes: Schema.Array(Schema.Struct({
    scenario: Schema.Union([
      Schema.String,
      Schema.Struct({ Mutant: Schema.Struct({ name: Schema.String, file: Schema.String, span: Schema.Struct({ start: Schema.Struct({ line: Schema.Number }) }) }) }),
    ]),
    summary: Schema.String,
  })),
})

const MUTANT_OUTCOME: Record<string, Mutant["outcome"]> = { CaughtMutant: "killed", MissedMutant: "survived", Timeout: "timeout" }

/** cargo-mutants' outcomes.json. The baseline run and unviable mutants (they don't compile) don't count. */
export const parseMutants = (json: string): Option.Option<Mutant[]> =>
  Option.map(Schema.decodeUnknownOption(Schema.fromJsonString(MutantsOutcomes))(json), (r) =>
    r.outcomes.flatMap((o) => {
      if (typeof o.scenario === "string") return []
      const m = o.scenario.Mutant
      return [{ path: m.file, line: m.span.start.line, description: m.name.replace(/^[^:]+:\d+:\d+:\s*/, ""), outcome: MUTANT_OUTCOME[o.summary] ?? "other" }]
    }))
