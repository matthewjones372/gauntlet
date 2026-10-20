import type { Metric } from "./schema.ts"

// Ratcheted metrics: a change may not make one worse than the baseline, and
// the baseline only moves when trunk improves (invariant 9).

export interface MetricDelta {
  readonly metric: string
  readonly file?: string
  readonly base: number
  readonly head: number
  readonly delta: number
  readonly regressed: boolean
  /** Why the base value isn't the baseline's as recorded, or what a drop may come from (spec 0017 §3). */
  readonly note?: string
}

export interface MetricComparison {
  readonly deltas: ReadonlyArray<MetricDelta>
  readonly regressions: ReadonlyArray<MetricDelta>
  /** Metrics in the baseline that the change didn't produce: missing evidence. */
  readonly missing: ReadonlyArray<string>
}

export interface CompareOptions {
  /**
   * The head value was measured only over some files (`on changed`), so it
   * can't be compared with the project-wide baseline: only its per-file values are.
   */
  readonly scoped?: boolean
  /**
   * Main-code files the change deletes. A project-wide value is judged against
   * the base's value for the code that's left (spec 0017 §3). Ignored when scoped.
   */
  readonly removed?: ReadonlyArray<string>
  /** Old path to new path for each file the change renames: its base value goes with it. Ignored when scoped. */
  readonly renames?: ReadonlyMap<string, string>
  /** The build a file belongs to, when the project's value is the worst build's (ADR 0022). */
  readonly groupOf?: (path: string) => string
}

// Rounding keeps float noise (0.1 + 0.2) from looking like a regression.
const round = (n: number) => Math.round(n * 1e6) / 1e6
const worse = (m: Metric, base: number, head: number) => (m.higherIsBetter ? round(head) < round(base) : round(head) > round(base))
const pct = (hit: number, total: number) => Math.round((hit / total) * 10000) / 100

/**
 * A percentage worked out from per-file values and what each is out of, as the
 * packs work out the project's (lines hit over lines measured, mutants killed
 * over mutants counted), per group, taking the worst group. Undefined when a
 * file has no total, or there are no files.
 */
const fromFiles = (m: Metric, files: ReadonlyArray<string>, groupOf: (path: string) => string): number | undefined => {
  const groups = new Map<string, { hit: number; total: number }>()
  for (const f of files) {
    const v = m.perFile?.[f]
    const t = m.perFileTotal?.[f]
    if (v === undefined || t === undefined || t <= 0) return undefined
    const g = groups.get(groupOf(f)) ?? { hit: 0, total: 0 }
    g.hit += Math.round((v * t) / 100)
    g.total += t
    groups.set(groupOf(f), g)
  }
  if (groups.size === 0) return undefined
  const values = [...groups.values()].map((g) => pct(g.hit, g.total))
  return m.higherIsBetter ? Math.min(...values) : Math.max(...values)
}

/**
 * A recorded percentage without some of its files (spec 0017 §3), or undefined
 * when it can't be worked out exactly: no per-file values or totals (an older
 * baseline), nothing left, or per-file values that don't give back the recorded
 * value (mutants with no file, say), so how it was aggregated isn't known.
 */
export const valueWithout = (m: Metric, removed: ReadonlyArray<string>, groupOf: (path: string) => string = () => ""): number | undefined => {
  if (m.unit !== "%" || m.perFile === undefined || m.perFileTotal === undefined) return undefined
  const all = Object.keys(m.perFile)
  const whole = fromFiles(m, all, groupOf)
  if (whole === undefined || round(whole) !== round(m.value)) return undefined
  const gone = new Set(removed)
  return fromFiles(m, all.filter((f) => !gone.has(f)), groupOf)
}

const named = (files: ReadonlyArray<string>) =>
  files.length <= 3 ? files.join(", ") : `${files.slice(0, 3).join(", ")} and ${files.length - 3} more`

/**
 * Compares head metrics with the baseline, overall and per file. Per-file
 * values are compared file by file; a file new since the baseline is held to
 * the baseline's overall value, and a renamed one to its old path's. A head
 * value measured only over some files (`on changed`) can't be compared with
 * the project-wide baseline, so with `scoped` only its per-file values are.
 *
 * When the change deletes files the baseline measured, the project-wide value
 * is held to the base's value without them (spec 0017 §3): code that's gone
 * doesn't hold the bar up. A baseline that can't be worked out again without
 * them keeps today's comparison, and a drop says it may come from the removed code.
 */
export const compareMetrics = (
  base: Readonly<Record<string, Metric>>,
  head: Readonly<Record<string, Metric>>,
  options: CompareOptions = {},
): MetricComparison => {
  const deltas: MetricDelta[] = []
  const missing: string[] = []
  const wholeProject = !options.scoped
  const oldPath = new Map(wholeProject ? [...(options.renames ?? [])].map(([from, to]) => [to, from] as const) : [])
  for (const name of Object.keys(base).sort()) {
    const b = base[name]!
    const h = head[name]
    if (!h) {
      missing.push(name)
      continue
    }
    // The removed files the base's value counted: all of them when it doesn't say which files it counted.
    const measured = wholeProject ? (options.removed ?? []).filter((f) => b.perFile === undefined || b.perFile[f] !== undefined).sort() : []
    const left = measured.length > 0 ? valueWithout(b, measured, options.groupOf) : undefined
    const bar = left ?? b.value
    if (!options.scoped || h.perFile === undefined) {
      const regressed = worse(b, bar, h.value)
      const note = left !== undefined
        ? `${left} is the base's ${b.value} without the code this change removes (${named(measured)})`
        : measured.length > 0 && regressed
        ? `this change removes ${named(measured)}, and the baseline doesn't record enough per file to leave ${measured.length === 1 ? "it" : "them"} out, so the drop may come from the removed code; an owner can re-record the baseline with \`gauntlet baseline --update --allow-lower\` (spec 0015 §2)`
        : undefined
      deltas.push({ metric: name, base: bar, head: h.value, delta: round(h.value - bar), regressed, ...(note !== undefined ? { note } : {}) })
    }
    for (const file of Object.keys(h.perFile ?? {}).sort()) {
      const hv = h.perFile![file]!
      const bv = b.perFile?.[oldPath.get(file) ?? file] ?? bar
      deltas.push({ metric: name, file, base: bv, head: hv, delta: round(hv - bv), regressed: worse(b, bv, hv) })
    }
  }
  return { deltas, regressions: deltas.filter((d) => d.regressed), missing }
}

export interface MetricUpdate {
  readonly metrics: Readonly<Record<string, Metric>>
  /** Metrics that would get worse. Kept at their old value unless lowering is allowed. */
  readonly lowered: ReadonlyArray<MetricDelta>
}

/**
 * Merges freshly recorded metrics into the baseline. Improvements are taken;
 * anything worse keeps the old value unless `allowLower` is set, in which case
 * it is taken and reported as lowered. Metrics that weren't recorded this
 * time stay as they were: missing evidence never lowers the bar.
 *
 * A file the baseline never measured (the tool now covers a module it didn't)
 * is recorded as it is, not held to the project's value, and the
 * project's value is judged without such files when it can be worked out
 * without them.
 */
export const updateMetrics = (
  base: Readonly<Record<string, Metric>>,
  recorded: Readonly<Record<string, Metric>>,
  allowLower: boolean,
): MetricUpdate => {
  const metrics: Record<string, Metric> = { ...base }
  const lowered: MetricDelta[] = []
  for (const name of Object.keys(recorded).sort()) {
    const r = recorded[name]!
    const b = base[name]
    if (!b) {
      metrics[name] = r
      continue
    }
    const first = Object.keys(r.perFile ?? {}).filter((f) => b.perFile?.[f] === undefined)
    const without = b.perFile !== undefined && first.length > 0 ? valueWithout(r, first) : undefined
    const comparison = compareMetrics({ [name]: b }, { [name]: without !== undefined ? { ...r, value: without } : r })
    const regressions = comparison.regressions.filter((d) => d.file === undefined || !first.includes(d.file))
    if (regressions.length === 0 || allowLower) metrics[name] = r
    lowered.push(...regressions)
  }
  return { metrics, lowered }
}
