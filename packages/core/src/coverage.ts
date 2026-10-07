import { globMatches } from "@gauntlet/dsl"
import type { PolicyIR } from "@gauntlet/ir"

// `gauntlet explain --coverage`: what applies to each file, and which files
// nothing protects. The authoring agent reads this too.

export interface FileCoverage {
  readonly path: string
  readonly zones: ReadonlyArray<string>
  readonly protect: ReadonlyArray<string>
  readonly suites: ReadonlyArray<string>
  readonly rules: ReadonlyArray<string>
}

export interface Coverage {
  readonly files: ReadonlyArray<FileCoverage>
  /** Files no zone, protect group or suite covers. Every gate still runs over them; nothing marks them as sensitive or as tests. */
  readonly uncovered: ReadonlyArray<string>
}

export const coverage = (ir: PolicyIR, paths: ReadonlyArray<string>): Coverage => {
  const files = [...paths].sort().map((path): FileCoverage => {
    const zones = ir.zones.filter((z) => z.globs.some((g) => globMatches(g, path)))
    return {
      path,
      zones: zones.map((z) => z.name),
      protect: ir.protect.filter((g) => g.globs.some((glob) => globMatches(glob, path))).map((g) => g.group),
      suites: ir.suites.flatMap((s) => (s.kind === "suite" && globMatches(s.location, path) ? [s.name] : [])),
      rules: [...new Set(zones.flatMap((z) => z.rules))].sort(),
    }
  })
  return { files, uncovered: files.filter((f) => f.zones.length + f.protect.length + f.suites.length === 0).map((f) => f.path) }
}

export const renderCoverage = (c: Coverage): string => {
  const lines = c.files.map((f) => {
    const parts = [
      f.zones.length > 0 ? `zone ${f.zones.join(", ")}` : "",
      f.protect.length > 0 ? `protected (${f.protect.join(", ")})` : "",
      f.suites.length > 0 ? `suite ${f.suites.join(", ")}` : "",
      f.rules.length > 0 ? `rules ${f.rules.join(", ")}` : "",
    ].filter((p) => p !== "")
    return `${f.path}  ${parts.length > 0 ? parts.join("; ") : "-"}`
  })
  const summary = `${c.files.length} files, ${c.uncovered.length} not covered by any zone, protect group or suite.`
  return [...lines, "", summary, ...(c.uncovered.length > 0 ? ["", "Not covered:", ...c.uncovered.map((p) => `  ${p}`)] : []), ""].join("\n")
}
