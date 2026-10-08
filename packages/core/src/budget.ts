import type { Budget, BudgetThreshold } from "@gauntlet/ir"
import type { Metric } from "@gauntlet/sarif"

// Performance budgets (spec 0006): the policy's `budget` runs a command that
// writes its measurements to {json}, and Gauntlet holds them to the budget's
// limits. Three formats are read: Gauntlet's own (metric names as in the
// policy, times in milliseconds), hyperfine's --export-json and k6's
// --summary-export, so an existing benchmark needs no adapter.

/** Measurements, times in milliseconds, errors in percent, throughput in requests a second. */
export type Measures = Readonly<Record<string, number>>

export interface BudgetResults {
  /** The whole run's measurements. */
  readonly overall: Measures
  /** Per endpoint or command, for an aggregate such as `max(p99)`. */
  readonly series: Readonly<Record<string, Measures>>
}

const TIME = new Set(["p50", "p90", "p95", "p99", "p999", "mean", "max", "min"])
const numbers = (o: unknown): Record<string, number> =>
  Object.fromEntries(Object.entries(typeof o === "object" && o !== null ? o : {}).filter(([, v]) => typeof v === "number" && Number.isFinite(v))) as Record<string, number>

/** A command's output in any of the three formats, or undefined when it's none of them. */
export const parseBudgetResults = (text: string): BudgetResults | undefined => {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof json !== "object" || json === null) return undefined
  const o = json as Record<string, unknown>
  // hyperfine --export-json: seconds per command.
  if (Array.isArray(o.results)) {
    const series: Record<string, Measures> = {}
    for (const r of o.results as Array<Record<string, unknown>>) {
      const ms = (k: string) => (typeof r[k] === "number" ? (r[k] as number) * 1000 : undefined)
      const m = { mean: ms("mean"), p50: ms("median"), min: ms("min"), max: ms("max") }
      series[String(r.command ?? `#${Object.keys(series).length + 1}`)] = Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined)) as Measures
    }
    const all = Object.values(series)
    return { overall: all.length === 1 ? all[0]! : {}, series }
  }
  // k6 --summary-export: http_req_duration in milliseconds, failures as a rate, requests a second.
  if (typeof o.metrics === "object" && o.metrics !== null && "http_req_duration" in (o.metrics as object)) {
    const m = o.metrics as Record<string, Record<string, number>>
    const d = m.http_req_duration ?? {}
    const overall: Record<string, number> = {}
    const put = (k: string, v: number | undefined) => {
      if (typeof v === "number" && Number.isFinite(v)) overall[k] = v
    }
    put("mean", d.avg)
    put("p50", d.med)
    put("p90", d["p(90)"])
    put("p95", d["p(95)"])
    put("p99", d["p(99)"])
    put("max", d.max)
    put("min", d.min)
    put("errors", m.http_req_failed?.value !== undefined ? m.http_req_failed.value * 100 : undefined)
    put("throughput", m.http_reqs?.rate)
    return { overall, series: {} }
  }
  // Gauntlet's own: { "p99": 48, "errors": 0.02, "series": { "GET /trades": { "p99": 40 } } }
  const series = Object.fromEntries(Object.entries(typeof o.series === "object" && o.series !== null ? o.series : {}).map(([k, v]) => [k, numbers(v)]))
  return { overall: numbers(o), series }
}

const TO_MS: Readonly<Record<string, number>> = { ms: 1, s: 1000, m: 60_000 }

/** The threshold's limit in the results' units. */
const limitOf = (t: BudgetThreshold) => (t.value.unit !== undefined && TO_MS[t.value.unit] !== undefined ? t.value.value * TO_MS[t.value.unit]! : t.value.value)

const compare = (value: number, op: string, limit: number) =>
  op === "<" ? value < limit : op === "<=" ? value <= limit : op === ">" ? value > limit : op === ">=" ? value >= limit : op === "==" ? value === limit : value !== limit

/** Higher is worse for times and errors, better for throughput. */
export const higherIsWorse = (field: string) => field !== "throughput"

/** The name a measured value is recorded under, `budget/<budget>/<field>` or with its aggregate. */
export const budgetMetricKey = (budget: string, field: string, aggregate?: string) => `budget/${budget}/${aggregate ? `${aggregate}(${field})` : field}`

const aggregateOf = (aggregate: string, values: ReadonlyArray<number>) =>
  aggregate === "avg" ? values.reduce((a, b) => a + b, 0) / values.length
    : aggregate === "min" ? Math.min(...values)
    : aggregate === "max" ? Math.max(...values)
    : values.reduce((a, b) => a + b, 0)

/** A field's value: from the whole run, or an aggregate over the series. */
const valueOf = (r: BudgetResults, field: string, aggregate?: string): number | undefined => {
  if (aggregate !== undefined) {
    const values = Object.values(r.series).flatMap((s) => (s[field] !== undefined ? [s[field]!] : []))
    if (values.length > 0) return aggregateOf(aggregate, values)
    return r.overall[field]
  }
  return r.overall[field]
}

const unitOf = (field: string): Metric["unit"] => (field === "errors" ? "%" : field === "throughput" ? "count" : "ms")
const fmt = (n: number) => String(Math.round(n * 100) / 100)
const shown = (field: string, n: number) => `${fmt(n)}${field === "errors" ? "%" : field === "throughput" ? " rps" : "ms"}`

export interface BudgetOutcome {
  readonly status: "passed" | "failed" | "not-executed"
  readonly reason?: string
  /** What was measured, to record in the baseline and compare against later. */
  readonly metrics: Readonly<Record<string, Metric>>
}

/**
 * Holds a budget's results to its thresholds. "vs baseline" compares with the
 * value the baseline recorded: `p99 < 10% vs baseline` lets p99 grow by less
 * than 10%, and `regression < 5% vs baseline` holds every measured time (and
 * throughput) to that. A threshold with nothing to compare against is missing
 * evidence, never a pass.
 */
export const judgeBudget = (budget: Budget, r: BudgetResults, recorded: Readonly<Record<string, Metric>>): BudgetOutcome => {
  const metrics: Record<string, Metric> = {}
  for (const [field, value] of Object.entries(r.overall)) {
    metrics[budgetMetricKey(budget.name, field)] = { value, unit: unitOf(field), higherIsBetter: !higherIsWorse(field) }
  }
  const failed: string[] = []
  const missing: string[] = []
  for (const t of budget.thresholds) {
    const label = t.aggregate ? `${t.aggregate}(${t.metric})` : t.metric
    if (t.vsBaseline) {
      const fields = t.metric === "regression" ? Object.keys(r.overall).filter((f) => TIME.has(f) || f === "throughput") : [t.metric]
      if (fields.length === 0) missing.push(`no measurements to compare for ${label}`)
      for (const field of fields) {
        const now = valueOf(r, field, t.aggregate)
        if (now !== undefined && t.aggregate) metrics[budgetMetricKey(budget.name, field, t.aggregate)] = { value: now, unit: unitOf(field), higherIsBetter: !higherIsWorse(field) }
        const before = recorded[budgetMetricKey(budget.name, field, t.aggregate)]?.value
        if (now === undefined) {
          missing.push(`the command reported no ${t.aggregate ? `${t.aggregate}(${field})` : field}`)
          continue
        }
        if (before === undefined || before === 0) {
          missing.push(`the baseline has no ${t.aggregate ? `${t.aggregate}(${field})` : field} for budget ${budget.name}; run gauntlet baseline`)
          continue
        }
        const worse = (higherIsWorse(field) ? now - before : before - now) / before * 100
        if (!compare(worse, t.op, t.value.value)) {
          failed.push(`${t.aggregate ? `${t.aggregate}(${field})` : field} got ${fmt(Math.abs(worse))}% ${worse >= 0 ? "worse" : "better"} than the baseline (${shown(field, before)} to ${shown(field, now)}), over the ${t.value.value}% allowed`)
        }
      }
      continue
    }
    const value = valueOf(r, t.metric, t.aggregate)
    if (value === undefined) {
      missing.push(`the command reported no ${label}`)
      continue
    }
    if (t.aggregate) metrics[budgetMetricKey(budget.name, t.metric, t.aggregate)] = { value, unit: unitOf(t.metric), higherIsBetter: !higherIsWorse(t.metric) }
    const limit = limitOf(t)
    if (!compare(value, t.op, limit)) failed.push(`${label} ${shown(t.metric, value)} doesn't meet ${t.op} ${shown(t.metric, limit)}`)
  }
  if (failed.length > 0) return { status: "failed", reason: failed.join("; "), metrics }
  if (missing.length > 0) return { status: "not-executed", reason: missing.join("; "), metrics }
  return { status: "passed", metrics }
}
