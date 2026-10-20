import { globMatches } from "@gauntlet/dsl"
import type { Check, PolicyIR } from "@gauntlet/ir"
import type { DiffFacts } from "./diff-facts.ts"
import { testPathMatcher } from "./integrity.ts"
import { isDocumentation } from "./no-behaviour.ts"
import { seedFor } from "./stability.ts"

// Spec 0020: a mutation gate scoped to the change can say how many mutants a
// change may bring (`max 150 mutants`). Gauntlet estimates the count from the
// diff before anything runs: over the budget, a blocking gate isn't run and
// says how to split the change, and an `advise` gate runs on a sample of the
// changed lines that the head commit picks.

/** The rule of the finding that says a change is over its mutation budget, and how to split it. */
export const SPLIT_RULE = "mutation/over-budget"

/** Each executable changed line counts as this many mutants: high on purpose, so a budget holds for dense code. */
export const MUTANTS_PER_LINE = 2

/** Source files the packs' mutation tools mutate. Build scripts (`.kts`) aren't. */
const MUTATED = /\.(kt|java|scala|sc|ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|clj|cljs|cljc)$/
const SETTINGS = /^\.(gauntlet|github|claude)\//

const COMMENT = /^(\/\/|\/\*|\*|#|--|;;|""")/
const BRACKETS = /^[\s{}()[\];,]*$/
const DECLARATION = /^(import|package|use|from\s+\S+\s+import|\(ns|\(:require|\(:import)\b/

/** Whether a changed line looks like code a mutation tool would change: not blank, a comment, brackets or an import. */
export const executable = (text: string): boolean => {
  const t = text.trim()
  return t !== "" && !COMMENT.test(t) && !BRACKETS.test(t) && !DECLARATION.test(t)
}

export type MutationGate = Extract<Check, { kind: "gate" }>

export interface MutationEstimate {
  /** About how many mutants the change brings to the gate. */
  readonly mutants: number
  /** Each source file in the gate's scope with executable changed lines, by path. */
  readonly files: ReadonlyArray<{ readonly path: string; readonly lines: ReadonlyArray<number>; readonly mutants: number }>
}

/** The files a budgeted gate mutates for this change: what it changes, in the gate's zone. */
const inScope = (ir: PolicyIR, facts: DiffFacts, gate: MutationGate) => {
  const zone = gate.zone === undefined ? undefined : ir.zones.find((z) => z.name === gate.zone)
  const isTest = testPathMatcher(ir)
  return facts.files
    .filter((f) => f.status !== "deleted")
    .map((f) => f.path)
    .filter((p) => MUTATED.test(p) && !isTest(p) && !isDocumentation(p) && !SETTINGS.test(p))
    .filter((p) => zone === undefined || zone.globs.some((g) => globMatches(g, p)))
}

/** The estimate for a gate: each executable changed line in its scope counts as MUTANTS_PER_LINE mutants. */
export const estimateMutants = (ir: PolicyIR, facts: DiffFacts, gate: MutationGate): MutationEstimate => {
  const files = [...new Set(inScope(ir, facts, gate))].sort().flatMap((path) => {
    const lines = (facts.addedLines.get(path) ?? []).filter((l) => executable(l.text)).map((l) => l.line)
    return lines.length === 0 ? [] : [{ path, lines, mutants: lines.length * MUTANTS_PER_LINE }]
  })
  return { mutants: files.reduce((n, f) => n + f.mutants, 0), files }
}

export interface OverBudget {
  readonly gate: MutationGate
  readonly budget: number
  readonly estimate: MutationEstimate
}

/** The budgeted mutation gate the change is over, if any: the project's own before a zone's. Recording never is. */
export const overBudget = (ir: PolicyIR, facts: DiffFacts): OverBudget | undefined => {
  const gates = ir.gates.flatMap((t) => t.checks).filter((c): c is MutationGate => c.kind === "gate" && c.name === "mutation" && c.max !== undefined && c.scope === "changed")
  for (const gate of [...gates.filter((g) => g.zone === undefined), ...gates.filter((g) => g.zone !== undefined)]) {
    const estimate = estimateMutants(ir, facts, gate)
    if (estimate.mutants > gate.max!) return { gate, budget: gate.max!, estimate }
  }
  return undefined
}

/** A small, fast generator: the same seed gives the same numbers. */
const generator = (seed: number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * The changed lines an `advise` gate over its budget mutates: the estimate's
 * lines shuffled by the head commit, as many as the budget holds. The same
 * head picks the same lines.
 */
export const sampleLines = (estimate: MutationEstimate, budget: number, head: string): ReadonlyMap<string, ReadonlyArray<number>> => {
  const all = estimate.files.flatMap((f) => f.lines.map((line) => ({ path: f.path, line })))
  const random = generator(seedFor(head, 0))
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[all[i], all[j]] = [all[j]!, all[i]!]
  }
  const kept = new Map<string, number[]>()
  for (const { path, line } of all.slice(0, Math.max(1, Math.floor(budget / MUTANTS_PER_LINE)))) kept.set(path, [...(kept.get(path) ?? []), line])
  return new Map([...kept].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, lines]) => [p, lines.sort((x, y) => x - y)]))
}

/** The facts as a sampled gate sees them: only the sampled lines are the change's. */
export const sampledFacts = (facts: DiffFacts, lines: ReadonlyMap<string, ReadonlyArray<number>>): DiffFacts => ({
  ...facts,
  addedLines: new Map([...lines].map(([path, kept]) => {
    const keep = new Set(kept)
    return [path, (facts.addedLines.get(path) ?? []).filter((l) => keep.has(l.line))]
  })),
})

/** "about 412 mutants", for a reason or a finding. */
export const aboutMutants = (n: number) => `about ${n} mutant${n === 1 ? "" : "s"}`
