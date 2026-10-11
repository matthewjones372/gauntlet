import type { Metric, Run } from "@gauntlet/sarif"
import type { GateContext } from "./gate.ts"

// Spec 0011: every pack's mutation gate scores through this, so packs agree on
// what counts. With `on changed` only mutants on the changed lines count: the
// tools mutate whole classes or files, and a change shouldn't answer for the
// rest of them.

/** One mutant, as a pack read it from its tool's report. */
export interface Mutant {
  /** Repository-relative, or undefined when the tool's report can't be traced to a file. */
  readonly path: string | undefined
  readonly line: number
  /** The last line the mutant may be on, when the tool names only a span (mutmut names a function). */
  readonly endLine?: number
  /** Killed, or timed out: a test noticed. */
  readonly killed: boolean
  /** Said for a survivor: "No test kills a conditional-boundary mutant". */
  readonly message: string
}

export interface MutationScope {
  /** Files the check is limited to, or undefined for the whole project. */
  readonly scope?: ReadonlyArray<string>
  /** With `on changed`: the lines the change added or edited, per file. */
  readonly changedLines?: ReadonlyMap<string, ReadonlySet<number>>
}

export interface MutationResult {
  readonly runs: ReadonlyArray<Run>
  readonly metrics?: Readonly<Record<string, Metric>>
  readonly nothingInScope?: string
  /** The score is over changed lines, so per-file scores can't be ratcheted against whole-file ones. */
  readonly lineScoped: boolean
}

/** Whether a changed line is on the mutant's line, or inside its span. */
const touches = (lines: ReadonlySet<number> | undefined, x: Mutant) => {
  if (lines === undefined) return false
  for (let n = x.line; n <= (x.endLine ?? x.line); n++) if (lines.has(n)) return true
  return false
}

const pct = (ms: ReadonlyArray<Mutant>) => Math.round((ms.filter((x) => x.killed).length / ms.length) * 10000) / 100

export const mutationResult = (tool: string, mutants: ReadonlyArray<Mutant>, at: MutationScope): MutationResult => {
  const lineScoped = at.changedLines !== undefined
  const counted = mutants.filter((x) =>
    (at.scope === undefined || (x.path !== undefined && at.scope.includes(x.path)))
    && (at.changedLines === undefined || (x.path !== undefined && touches(at.changedLines.get(x.path), x))))
  if (counted.length === 0) {
    return { runs: [], lineScoped, nothingInScope: `${tool} generated no mutants ${lineScoped ? "on the changed lines" : "for the code in scope"}` }
  }
  const perFile: Record<string, number> = {}
  for (const p of [...new Set(counted.flatMap((x) => x.path ?? []))].sort()) perFile[p] = pct(counted.filter((x) => x.path === p))
  const survivors: Run = {
    tool: { driver: { name: tool } },
    results: counted.filter((x) => !x.killed)
      .sort((a, b) => ((a.path ?? "") < (b.path ?? "") ? -1 : (a.path ?? "") > (b.path ?? "") ? 1 : a.line - b.line))
      .map((x) => ({
        ruleId: "mutation/survived",
        level: "warning" as const,
        message: { text: x.message },
        ...(x.path ? { locations: [{ physicalLocation: { artifactLocation: { uri: x.path }, region: { startLine: x.line } } }] } : {}),
      })),
  }
  return { runs: [survivors], lineScoped, metrics: { mutation: { value: pct(counted), unit: "%", higherIsBetter: true, perFile } } }
}

/** What a gate's context limits mutants to: its files and, with `on changed`, the lines the change added or edited. */
export const mutationScopeOf = (ctx: GateContext): MutationScope => ({
  ...(ctx.scope !== undefined ? { scope: ctx.scope } : {}),
  ...(ctx.changedLinesOnly
    ? { changedLines: new Map([...ctx.facts.addedLines].map(([p, lines]) => [p, new Set(lines.map((l) => l.line))])) }
    : {}),
})

/** A pack's mutation gate result: its survivors and score, scoped as its context says. */
export const mutationGateRun = (tool: string, mutants: ReadonlyArray<Mutant>, ctx: GateContext) => {
  const r = mutationResult(tool, mutants, mutationScopeOf(ctx))
  return {
    runs: r.runs,
    ...(r.metrics ? { metrics: r.metrics } : {}),
    ...(r.nothingInScope ? { nothingInScope: r.nothingInScope } : {}),
    ...(r.lineScoped ? { lineScoped: true as const } : {}),
  }
}
