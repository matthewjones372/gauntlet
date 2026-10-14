import { relativeUri, type Result, type Run } from "@gauntlet/sarif"
import { Option } from "effect"

// `deadcode -json` (golang.org/x/tools/cmd/deadcode) as dead-code findings
// (spec 0017 §4): each function no main package or test reaches, grouped by
// package. Marker methods exist only to make a type satisfy an interface, and
// generated code isn't the project's to remove, so neither is a finding.

export const DEAD_CODE = "dead-code"

/** The version `gauntlet connect` installs and a missing tool's message names. */
export const DEADCODE_MODULE = "golang.org/x/tools/cmd/deadcode@v0.52.0"

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x)

/** deadcode's JSON report as a SARIF run named `deadcode`; none when it isn't one (an empty report is `null`). */
export const parseDeadcode = (json: string, repoRoot: string): Option.Option<Run> => {
  let report: unknown
  try {
    report = JSON.parse(json.trim() === "" ? "null" : json)
  } catch {
    return Option.none()
  }
  if (report !== null && !Array.isArray(report)) return Option.none()
  const results: Result[] = []
  for (const pkg of report ?? []) {
    if (!isRecord(pkg) || !Array.isArray(pkg.Funcs)) continue
    for (const f of pkg.Funcs) {
      if (!isRecord(f) || typeof f.Name !== "string" || !isRecord(f.Position) || typeof f.Position.File !== "string") continue
      if (f.Generated === true || f.Marker === true) continue
      const line = typeof f.Position.Line === "number" && f.Position.Line > 0 ? f.Position.Line : undefined
      const col = typeof f.Position.Col === "number" && f.Position.Col > 0 ? f.Position.Col : undefined
      results.push({
        ruleId: `${DEAD_CODE}/unreachable-func`,
        level: "warning",
        message: { text: `unreachable func: ${f.Name}` },
        locations: [{
          physicalLocation: {
            artifactLocation: { uri: relativeUri(f.Position.File, repoRoot) },
            ...(line !== undefined ? { region: { startLine: line, ...(col !== undefined ? { startColumn: col } : {}) } } : {}),
          },
        }],
      })
    }
  }
  return Option.some({ tool: { driver: { name: "deadcode" } }, results })
}
