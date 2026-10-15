import { type Diagnostic, formatDiagnostic, globMatches, readScenarios, type Scenario, sortDiagnostics } from "@gauntlet/dsl"
import type { PolicyIR } from "@gauntlet/ir"
import { Effect, FileSystem, Option, Path } from "effect"

// Scenarios (spec 0012): human-written statements of behaviour with ids, in
// Gherkin files the policy names. Gauntlet never runs them; it checks that each
// is bound to tests that ran, passed, can fail and catch a bug on the changed
// lines. This file reads them; the verdicts come later in the check.

/** The policy's scenario files among \`files\`. */
export const scenarioFiles = (ir: Pick<PolicyIR, "scenarios">, files: ReadonlyArray<string>): string[] =>
  ir.scenarios === undefined ? [] : files.filter((f) => ir.scenarios!.some((g) => globMatches(g, f))).sort()

export interface ReadScenarios {
  readonly scenarios: ReadonlyArray<Scenario>
  /** Scenarios without an id, ids used twice, and Gherkin Gauntlet doesn't read: errors at \`gauntlet validate\`. */
  readonly diagnostics: ReadonlyArray<Diagnostic>
  /** Each file's text, for showing diagnostics with their lines. */
  readonly texts: ReadonlyMap<string, string>
}

/** Reads the policy's scenario files from a directory (the working tree, or the judged checkout). */
export const readScenarioFiles = (dir: string, ir: Pick<PolicyIR, "scenarios">, files: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const texts = new Map<string, string>()
    for (const file of scenarioFiles(ir, files)) {
      const text = yield* fs.readFileString(path.join(dir, file)).pipe(Effect.option)
      if (Option.isSome(text)) texts.set(file, text.value)
    }
    const read = readScenarios([...texts].map(([p, text]) => ({ path: p, text })))
    return { scenarios: read.scenarios, diagnostics: read.diagnostics, texts } satisfies ReadScenarios
  })

/** Scenario diagnostics, each shown with its own file's line. */
export const formatScenarioDiagnostics = (diagnostics: ReadonlyArray<Diagnostic>, texts: ReadonlyMap<string, string>): string =>
  sortDiagnostics(diagnostics)
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
    .map((d) => formatDiagnostic(d, texts.get(d.file) ?? ""))
    .join("\n\n")

/**
 * Scenarios the change deletes (spec 0012 §2): an id in a changed scenario file
 * at base that no scenario file at head has. A scenario is intent, and an agent
 * removing one removes what it's judged against, so it's a \`deleted-tests\`
 * forbid, as for a test. Moving a scenario to another file deletes nothing.
 */
export const deletedScenarios = (input: {
  readonly ir: Pick<PolicyIR, "scenarios">
  readonly facts: { readonly files: ReadonlyArray<{ readonly path: string; readonly status: string; readonly oldPath?: string }> }
  readonly headFiles: ReadonlyArray<string>
  readonly readBase: (path: string) => Effect.Effect<Option.Option<string>>
  readonly readHead: (path: string) => Effect.Effect<Option.Option<string>>
}) =>
  Effect.gen(function*() {
    if (input.ir.scenarios === undefined) return []
    const isScenarioFile = (p: string) => scenarioFiles(input.ir, [p]).length > 0
    const changed = [...new Set(input.facts.files.flatMap((f) => [...(f.status !== "added" ? [f.oldPath ?? f.path] : [])]).filter(isScenarioFile))].sort()
    if (changed.length === 0) return []
    const read = (paths: ReadonlyArray<string>, at: (p: string) => Effect.Effect<Option.Option<string>>) =>
      Effect.gen(function*() {
        const files: { path: string; text: string }[] = []
        for (const p of paths) {
          const text = yield* at(p)
          if (Option.isSome(text)) files.push({ path: p, text: text.value })
        }
        return readScenarios(files).scenarios
      })
    const before = yield* read(changed, input.readBase)
    const now = new Set((yield* read(scenarioFiles(input.ir, input.headFiles), input.readHead)).map((s) => s.id))
    return before.filter((s) => !now.has(s.id)).map((s) => ({
      check: "deleted-tests" as const,
      kind: "forbid" as const,
      message: `Scenario @${s.id} ('${s.name}') was deleted. Scenarios state what a person meant; only they can remove one.`,
      path: s.file,
      line: s.line,
      detector: "core",
    }))
  })
