import { type Run, SARIF_SCHEMA, SARIF_VERSION } from "@gauntlet/sarif"
import { Effect, FileSystem, Path } from "effect"
import type { GateContext, GateImpl } from "./gate.ts"

// Compiler warnings as findings (spec 0010), so a policy can ratchet them:
// `warnings ratchet` grandfathers today's and fails a change for a new one,
// matched by fingerprint as lint findings are. Read from the build's own
// output, since an incremental compile only warns about what it recompiles.

export const COMPILER_WARNING = "compiler/warning"

/** The compilers whose warnings are read, as SARIF tool names. */
export const COMPILERS = ["kotlinc", "javac", "scalac"] as const
export type Compiler = (typeof COMPILERS)[number]

/** Whether a run holds a compiler's warnings (from a build), for the `warnings` check. */
export const isCompilerWarnings = (run: Run): boolean => (COMPILERS as ReadonlyArray<string>).includes(run.tool.driver.name)

interface Warning {
  readonly path: string
  readonly line: number
  readonly column?: number
  readonly message: string
  readonly category?: string
}

// kotlinc: `w: file:///abs/src/Foo.kt:12:5 Unchecked cast of 'Any' to 'List<String>'.`
const KOTLINC = /^w: (?:file:\/\/)?(\/[^:]+\.kts?):(\d+):(\d+) (.+)$/
// javac: `/abs/src/Foo.java:12: warning: [unchecked] unchecked cast`
const JAVAC = /^(\/[^:]+\.java):(\d+): warning: (?:\[([\w-]+)\] )?(.+)$/
// scalac 2 through sbt: `[warn] /abs/src/Foo.scala:12:5: private val x in object Foo is never used`
const SCALAC2 = /^\[warn\] (\/[^:]+\.scala):(\d+):(\d+): (.+)$/
// scalac 3 through sbt: `[warn] -- [E198] Unused Symbol Warning: /abs/src/Foo.scala:5:8 ---`, the message on the `|` lines after it.
const SCALAC3 = /^\[warn\] -- (?:\[E\d+\] )?(?:[\w ]+ )?Warning: (\/[^:]+\.scala):(\d+):(\d+)\b/
const SCALAC3_BODY = /^\[warn\]\s+(?:\d+\s+)?\|\s?(.*)$/

const withoutColour = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "")

/** Every warning in a compiler's (or build tool's) output, paths relative to the checkout; only `tool`'s when it's named. */
export const parseCompilerWarnings = (output: string, dir: string, tool?: Compiler): Warning[] => {
  const reads = (t: Compiler) => tool === undefined || tool === t
  const lines = output.split(/\r?\n/).map(withoutColour)
  const warnings: Warning[] = []
  const relative = (p: string) => (p.startsWith(`${dir}/`) ? p.slice(dir.length + 1) : undefined)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const k = (reads("kotlinc") ? KOTLINC.exec(line) : null) ?? (reads("scalac") ? SCALAC2.exec(line) : null)
    if (k) {
      const path = relative(k[1]!)
      if (path) warnings.push({ path, line: Number(k[2]), column: Number(k[3]), message: k[4]!.trim() })
      continue
    }
    const j = reads("javac") ? JAVAC.exec(line) : null
    if (j) {
      const path = relative(j[1]!)
      if (path) warnings.push({ path, line: Number(j[2]), message: j[4]!.trim(), ...(j[3] ? { category: j[3] } : {}) })
      continue
    }
    const s = reads("scalac") ? SCALAC3.exec(line) : null
    if (s) {
      // The message is the text on the `|` lines that isn't the code quoted or its caret.
      const body: string[] = []
      for (let n = i + 1; n < lines.length && !SCALAC3.exec(lines[n]!) && SCALAC3_BODY.test(lines[n]!); n++) {
        const text = SCALAC3_BODY.exec(lines[n]!)![1]!.trim()
        if (text !== "" && !/^\^+$/.test(text) && !/^\d+\s*\|/.test(lines[n]!.replace(/^\[warn\]\s+/, ""))) body.push(text)
      }
      const path = relative(s[1]!)
      if (path) warnings.push({ path, line: Number(s[2]), column: Number(s[3]), message: body.join(" ") || "warning" })
    }
  }
  // A file compiled twice (main and test, or two passes) warns twice: once each.
  const seen = new Set<string>()
  return warnings.filter((w) => {
    const key = `${w.path}:${w.line}:${w.column ?? ""}:${w.message}`
    return seen.has(key) ? false : (seen.add(key), true)
  })
}

/** A compiler's warnings as a SARIF run, for the `warnings` check. */
export const compilerWarningsRun = (tool: Compiler, output: string, dir: string): Run => ({
  tool: { driver: { name: tool } },
  results: parseCompilerWarnings(output, dir, tool).map((w) => ({
    ruleId: w.category ? `${COMPILER_WARNING}/${w.category}` : COMPILER_WARNING,
    level: "warning" as const,
    message: { text: w.message },
    locations: [{ physicalLocation: { artifactLocation: { uri: w.path }, region: { startLine: w.line, ...(w.column ? { startColumn: w.column } : {}) } } }],
  })),
}) as unknown as Run

/**
 * A pack's `warnings` check: the warnings the build check printed earlier in
 * this check, or, when no build ran here, the warnings of a compile of its
 * own. Written to warnings.sarif, as a findings check's report.
 */
export const warningsGate = (compile: (ctx: GateContext) => ReturnType<GateImpl>): GateImpl => (_check, ctx) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const compiled = ctx.buildWarnings === undefined ? yield* compile(ctx) : undefined
    if (compiled?.error !== undefined) return compiled
    if (compiled !== undefined && compiled.exitCode !== 0) return { ...compiled, error: "the code doesn't compile, so its warnings can't be read" }
    const runs = ctx.buildWarnings ?? compiled!.runs.filter(isCompilerWarnings)
    yield* fs.writeFileString(path.join(ctx.outputDir, "warnings.sarif"), JSON.stringify({ version: SARIF_VERSION, $schema: SARIF_SCHEMA, runs })).pipe(Effect.orDie)
    return { command: compiled?.command ?? ["(the build check's compiler output)"], exitCode: compiled?.exitCode ?? 0, runs }
  })
