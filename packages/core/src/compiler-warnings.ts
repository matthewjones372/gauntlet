import type { Run } from "@gauntlet/sarif"

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

/** Every warning in a compiler's (or build tool's) output, paths relative to the checkout. */
export const parseCompilerWarnings = (output: string, dir: string): Warning[] => {
  const lines = output.split(/\r?\n/).map(withoutColour)
  const warnings: Warning[] = []
  const relative = (p: string) => (p.startsWith(`${dir}/`) ? p.slice(dir.length + 1) : undefined)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const k = KOTLINC.exec(line) ?? SCALAC2.exec(line)
    if (k) {
      const path = relative(k[1]!)
      if (path) warnings.push({ path, line: Number(k[2]), column: Number(k[3]), message: k[4]!.trim() })
      continue
    }
    const j = JAVAC.exec(line)
    if (j) {
      const path = relative(j[1]!)
      if (path) warnings.push({ path, line: Number(j[2]), message: j[4]!.trim(), ...(j[3] ? { category: j[3] } : {}) })
      continue
    }
    const s = SCALAC3.exec(line)
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
  results: parseCompilerWarnings(output, dir).map((w) => ({
    ruleId: w.category ? `${COMPILER_WARNING}/${w.category}` : COMPILER_WARNING,
    level: "warning" as const,
    message: { text: w.message },
    locations: [{ physicalLocation: { artifactLocation: { uri: w.path }, region: { startLine: w.line, ...(w.column ? { startColumn: w.column } : {}) } } }],
  })),
}) as unknown as Run
