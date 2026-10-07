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
}

export interface MetricComparison {
  readonly deltas: ReadonlyArray<MetricDelta>
  readonly regressions: ReadonlyArray<MetricDelta>
  /** Metrics in the baseline that the change didn't produce: missing evidence. */
  readonly missing: ReadonlyArray<string>
}

// Rounding keeps float noise (0.1 + 0.2) from looking like a regression.
const round = (n: number) => Math.round(n * 1e6) / 1e6
const worse = (m: Metric, base: number, head: number) => (m.higherIsBetter ? round(head) < round(base) : round(head) > round(base))

/**
 * Compares head metrics with the baseline. Per-file values are compared file
 * by file; a file new since the baseline is held to the baseline's overall value.
 */
/**
 * Compares head metrics with the baseline, overall and per file. A head value
 * measured only over some files (`on changed`) can't be compared with the
 * project-wide baseline, so with `scoped` only its per-file values are.
 */
export const compareMetrics = (
  base: Readonly<Record<string, Metric>>,
  head: Readonly<Record<string, Metric>>,
  options: { readonly scoped?: boolean } = {},
): MetricComparison => {
  const deltas: MetricDelta[] = []
  const missing: string[] = []
  for (const name of Object.keys(base).sort()) {
    const b = base[name]!
    const h = head[name]
    if (!h) {
      missing.push(name)
      continue
    }
    if (!options.scoped || h.perFile === undefined) deltas.push({ metric: name, base: b.value, head: h.value, delta: round(h.value - b.value), regressed: worse(b, b.value, h.value) })
    for (const file of Object.keys(h.perFile ?? {}).sort()) {
      const hv = h.perFile![file]!
      const bv = b.perFile?.[file] ?? b.value
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
    const comparison = compareMetrics({ [name]: b }, { [name]: r })
    const regressions = comparison.regressions
    if (regressions.length === 0 || allowLower) metrics[name] = r
    lowered.push(...regressions)
  }
  return { metrics, lowered }
}
