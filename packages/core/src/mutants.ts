import type { KillMap, KillMapTest, Metric, Run } from "@gauntlet/sarif"
import type { GateContext } from "./gate.ts"

// Spec 0011: every pack's mutation gate scores through this, so packs agree on
// what counts. With `on changed` only mutants on the changed lines count: the
// tools mutate whole classes or files, and a change shouldn't answer for the
// rest of them.

/** The rule of a surviving mutant's finding. */
export const SURVIVED_RULE = "mutation/survived"

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
  /** The tests that killed it, where the tool reports them (spec 0016). */
  readonly killedBy?: ReadonlyArray<string>
  /** Every test that ran it, killers included, where the tool reports them. */
  readonly coveredBy?: ReadonlyArray<string>
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
  const perFileTotal: Record<string, number> = {}
  for (const p of [...new Set(counted.flatMap((x) => x.path ?? []))].sort()) {
    const mine = counted.filter((x) => x.path === p)
    perFile[p] = pct(mine)
    perFileTotal[p] = mine.length
  }
  const survivors: Run = {
    tool: { driver: { name: tool } },
    results: counted.filter((x) => !x.killed)
      .sort((a, b) => ((a.path ?? "") < (b.path ?? "") ? -1 : (a.path ?? "") > (b.path ?? "") ? 1 : a.line - b.line))
      .map((x) => ({
        ruleId: SURVIVED_RULE,
        level: "warning" as const,
        message: { text: x.message },
        ...(x.path ? { locations: [{ physicalLocation: { artifactLocation: { uri: x.path }, region: { startLine: x.line } } }] } : {}),
      })),
  }
  return { runs: [survivors], lineScoped, metrics: { mutation: { value: pct(counted), unit: "%", higherIsBetter: true, perFile, perFileTotal } } }
}

/**
 * Which tests killed which mutants, when the tool reported killers for any of
 * them (spec 0016). Every mutant with a file counts, whatever the gate's scope:
 * a test's value is what it kills anywhere.
 */
export const killMapOf = (mutants: ReadonlyArray<Mutant>): KillMap | undefined => {
  if (!mutants.some((m) => m.killedBy !== undefined)) return undefined
  const located = mutants.filter((m): m is Mutant & { readonly path: string } => m.path !== undefined)
  const killed = new Map<string, number[]>()
  const reached = new Map<string, number>()
  located.forEach((m, i) => {
    for (const t of new Set(m.killedBy ?? [])) killed.set(t, [...(killed.get(t) ?? []), i])
    for (const t of new Set([...(m.coveredBy ?? []), ...(m.killedBy ?? [])])) reached.set(t, (reached.get(t) ?? 0) + 1)
  })
  const tests: Record<string, KillMapTest> = {}
  for (const name of [...reached.keys()].sort()) tests[name] = { killed: killed.get(name) ?? [], reached: reached.get(name)! }
  return { mutants: located.map((m) => ({ path: m.path, line: m.line })), tests }
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
  const killMap = killMapOf(mutants)
  return {
    runs: r.runs,
    ...(killMap ? { killMap } : {}),
    ...(r.metrics ? { metrics: r.metrics } : {}),
    ...(r.nothingInScope ? { nothingInScope: r.nothingInScope } : {}),
    ...(r.lineScoped ? { lineScoped: true as const } : {}),
  }
}
