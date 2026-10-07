import { compilePolicy, formatDiagnostics } from "@gauntlet/dsl"
import type { PolicyIR, SourceMap } from "@gauntlet/ir"
import { installed } from "../../dsl/test/fixtures/catalog.ts"
import type { DiffFacts } from "../src/diff-facts.ts"
import type { Evidence } from "../src/review.ts"

/** Compiles policy text with the test catalog, optionally with the repository's file list (as `init` and `check` do); throws on errors. */
export const compiled = (text: string, files?: ReadonlyArray<string>): { ir: PolicyIR; sourceMap: SourceMap } => {
  const r = compilePolicy({ file: ".gauntlet/policy.gx", text, ...(files ? { files } : {}) }, installed)
  if (r._tag === "Invalid") throw new Error(formatDiagnostics(r.diagnostics, text))
  return { ir: r.compiled.ir, sourceMap: r.compiled.sourceMap }
}

export const noFacts = (over: Partial<DiffFacts> = {}): DiffFacts => ({
  base: "b",
  head: "h",
  files: [],
  linesChanged: 0,
  protectedTouched: [],
  zonesTouched: [],
  dependencyChanges: [],
  budgetsChanged: [],
  policyChanged: false,
  baselineChanged: false,
  gauntletChanged: false,
  addedLines: new Map(),
  ...over,
})

export const cleanEvidence = (over: Partial<Evidence> = {}): Evidence => ({
  checks: [],
  newViolations: [],
  regressions: [],
  integrity: { findings: [], metrics: {}, notExecuted: [] },
  caution: [],
  ...over,
})
