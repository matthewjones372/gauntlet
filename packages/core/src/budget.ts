import type { Budget, BudgetThreshold } from "@gauntlet/ir"
import type { Metric } from "@gauntlet/sarif"

// Performance budgets (specs 0006, 0007): the policy's `budget` runs a command
// that writes its measurements to {json}, and Gauntlet holds them to the
// budget's limits. It reads Gauntlet's own format (metric names as in the
// policy, times in milliseconds), hyperfine's --export-json, k6's
// --summary-export, a Proofload run document, Gatling's stats.json, JMH's
// -rf json, `go test -bench` (text or -json), criterion's estimates.json,
// pytest-benchmark's --benchmark-json, Locust's --csv stats, vegeta's JSON
// report and oha's --json, so an existing benchmark or load test needs no
// adapter.

/** Measurements, times in milliseconds, errors in percent, throughput in requests a second. */
export type Measures = Readonly<Record<string, number>>

export interface BudgetResults {
  /** The whole run's measurements. */
  readonly overall: Measures
  /** Per endpoint or command, for an aggregate such as `max(p99)`. */
  readonly series: Readonly<Record<string, Measures>>
  /**
   * Why the numbers can't be trusted, when the tool says so: a load generator
   * that fell behind its schedule measured a queue it built itself, not the
   * service. Such a run is not executed, never passed or failed.
   */
  readonly untrusted?: string
}

const NS_PER_MS = 1_000_000

/** A Proofload run document (proofload/run/1): per step p50 and p99 in nanoseconds, and failures. */
const proofload = (o: Record<string, unknown>): BudgetResults => {
  const errors = (count: unknown, failed: unknown) => (typeof count === "number" && count > 0 && typeof failed === "number" ? (failed / count) * 100 : undefined)
  const measures = (s: Record<string, unknown>): Measures => Object.fromEntries(Object.entries({
    p50: typeof s.p50 === "number" ? s.p50 / NS_PER_MS : undefined,
    p99: typeof s.p99 === "number" ? s.p99 / NS_PER_MS : undefined,
    errors: errors(s.count, s.failed),
  }).filter(([, v]) => v !== undefined)) as Measures
  const steps = Array.isArray(o.steps) ? (o.steps as Array<Record<string, unknown>>) : []
  const series = Object.fromEntries(steps.map((s, i) => [String(s.name ?? `#${i + 1}`), measures(s)]))
  const whole = errors(o.count, o.failed)
  const overall = { ...(steps.length === 1 ? measures(steps[0]!) : {}), ...(whole !== undefined ? { errors: whole } : {}) }
  const schedule = o.schedule as { kept?: unknown } | undefined
  const behind = o.verdict === "behind" || schedule?.kept === false
  return { overall, series, ...(behind ? { untrusted: "the load generator fell behind its schedule, so the numbers describe the generator, not the service" } : {}) }
}

/** Gatling's js/stats.json: per request, percentiles1..4 (by default p50, p75, p95, p99) in milliseconds, ko of total, and requests a second. */
const gatling = (o: Record<string, unknown>): BudgetResults => {
  type Stats = Record<string, { total?: number } | undefined>
  const measures = (s: Stats): Measures => {
    const total = s.numberOfRequests?.total
    const ko = s.numberOfRequests && (s.numberOfRequests as { ko?: number }).ko
    return Object.fromEntries(Object.entries({
      p50: s.percentiles1?.total,
      p95: s.percentiles3?.total,
      p99: s.percentiles4?.total,
      mean: s.meanResponseTime?.total,
      min: s.minResponseTime?.total,
      max: s.maxResponseTime?.total,
      errors: typeof total === "number" && total > 0 && typeof ko === "number" ? (ko / total) * 100 : undefined,
      throughput: s.meanNumberOfRequestsPerSecond?.total,
    }).filter(([, v]) => typeof v === "number" && Number.isFinite(v))) as Measures
  }
  const series: Record<string, Measures> = {}
  const walk = (node: Record<string, unknown>) => {
    for (const child of Object.values((node.contents ?? {}) as Record<string, Record<string, unknown>>)) {
      if (child.type === "REQUEST") series[String((child.stats as { name?: string } | undefined)?.name ?? child.name)] = measures((child.stats ?? {}) as Stats)
      else walk(child)
    }
  }
  walk(o)
  return { overall: measures((o.stats ?? {}) as Stats), series }
}

const TIME = new Set(["p50", "p90", "p95", "p99", "p999", "mean", "max", "min"])
const numbers = (o: unknown): Record<string, number> =>
  Object.fromEntries(Object.entries(typeof o === "object" && o !== null ? o : {}).filter(([, v]) => typeof v === "number" && Number.isFinite(v))) as Record<string, number>

const finite = (m: Record<string, number | undefined>): Measures =>
  Object.fromEntries(Object.entries(m).filter(([, v]) => typeof v === "number" && Number.isFinite(v))) as Measures
const single = (series: Record<string, Measures>): Measures => {
  const all = Object.values(series)
  return all.length === 1 ? all[0]! : {}
}

// JMH's scoreUnit as milliseconds per operation, or operations a second.
const JMH_TIME: Readonly<Record<string, number>> = { "ns/op": 1e-6, "us/op": 1e-3, "µs/op": 1e-3, "ms/op": 1, "s/op": 1000 }
const JMH_RATE: Readonly<Record<string, number>> = { "ops/ns": 1e9, "ops/us": 1e6, "ops/µs": 1e6, "ops/ms": 1000, "ops/s": 1 }

/** JMH's -rf json: each benchmark (with its params) a series; time modes in milliseconds, throughput as operations a second. */
const jmh = (runs: ReadonlyArray<Record<string, unknown>>): BudgetResults => {
  const series: Record<string, Measures> = {}
  for (const r of runs) {
    const p = (r.primaryMetric ?? {}) as { score?: number; scoreUnit?: string; scorePercentiles?: Record<string, number> }
    const params = r.params && typeof r.params === "object" ? Object.entries(r.params as Record<string, unknown>).map(([k, v]) => `${k}=${String(v)}`) : []
    const name = `${String(r.benchmark)}${params.length > 0 ? ` (${params.join(", ")})` : ""}`
    const toMs = JMH_TIME[p.scoreUnit ?? ""]
    const toRate = JMH_RATE[p.scoreUnit ?? ""]
    const pct = (k: string) => (toMs !== undefined && typeof p.scorePercentiles?.[k] === "number" ? p.scorePercentiles[k]! * toMs : undefined)
    series[name] = toRate !== undefined
      ? finite({ throughput: typeof p.score === "number" ? p.score * toRate : undefined })
      : finite({ mean: typeof p.score === "number" && toMs !== undefined ? p.score * toMs : undefined, p50: pct("50.0"), p90: pct("90.0"), p95: pct("95.0"), p99: pct("99.0"), p999: pct("99.9"), max: pct("100.0") })
  }
  return { overall: single(series), series }
}

const GO_BENCH = /^(Benchmark\S+?)(?:-\d+)?\s+\d+\s+([\d.]+) ns\/op/

/** `go test -bench` as text or -json (test2json): each benchmark's ns/op as its mean, in milliseconds. */
const goBench = (text: string): BudgetResults | undefined => {
  const lines = text.split("\n").flatMap((line) => {
    try {
      const e = JSON.parse(line) as { Action?: string; Output?: string }
      return e.Action === "output" && typeof e.Output === "string" ? e.Output.split("\n") : []
    } catch {
      return [line]
    }
  })
  const series: Record<string, Measures> = {}
  for (const line of lines) {
    const m = GO_BENCH.exec(line.trim())
    if (m) series[m[1]!] = { mean: Number(m[2]) / NS_PER_MS }
  }
  return Object.keys(series).length > 0 ? { overall: single(series), series } : undefined
}

/** A CSV line, with quoted fields. */
const csvFields = (line: string): string[] => {
  const out: string[] = []
  let cur = ""
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (quoted && c === '"' && line[i + 1] === '"') { cur += '"'; i++ }
    else if (c === '"') quoted = !quoted
    else if (c === "," && !quoted) { out.push(cur); cur = "" }
    else cur += c
  }
  out.push(cur)
  return out
}

/** Locust's --csv _stats.csv: each request a series, the Aggregated row overall; milliseconds, failures as errors. */
const locust = (text: string): BudgetResults | undefined => {
  const [header, ...rows] = text.trim().split(/\r?\n/).map(csvFields)
  if (!header || !header.includes("Request Count") || !header.includes("Failure Count")) return undefined
  const col = (row: string[], name: string) => {
    const i = header.indexOf(name)
    const v = i >= 0 ? Number(row[i]) : Number.NaN
    return Number.isFinite(v) ? v : undefined
  }
  const measures = (row: string[]): Measures => {
    const count = col(row, "Request Count")
    const failed = col(row, "Failure Count")
    return finite({
      p50: col(row, "50%") ?? col(row, "Median Response Time"), p90: col(row, "90%"), p95: col(row, "95%"), p99: col(row, "99%"), p999: col(row, "99.9%"),
      mean: col(row, "Average Response Time"), min: col(row, "Min Response Time"), max: col(row, "Max Response Time"),
      errors: count !== undefined && count > 0 && failed !== undefined ? (failed / count) * 100 : undefined,
      throughput: col(row, "Requests/s"),
    })
  }
  const series: Record<string, Measures> = {}
  let overall: Measures = {}
  for (const row of rows) {
    const name = row[header.indexOf("Name")] ?? ""
    if (name === "Aggregated") overall = measures(row)
    else series[`${row[header.indexOf("Type")] ?? ""} ${name}`.trim()] = measures(row)
  }
  return { overall, series }
}

/** A command's output in any of the formats above, or undefined when it's none of them. */
export const parseBudgetResults = (text: string): BudgetResults | undefined => {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return goBench(text) ?? locust(text)
  }
  if (typeof json !== "object" || json === null) return undefined
  if (Array.isArray(json)) return json.length > 0 && json.every((r) => typeof r === "object" && r !== null && "primaryMetric" in r) ? jmh(json as Array<Record<string, unknown>>) : undefined
  const o = json as Record<string, unknown>
  // criterion's estimates.json: nanoseconds.
  const est = (k: string) => (o[k] as { point_estimate?: number } | undefined)?.point_estimate
  if (typeof est("mean") === "number" && typeof est("median") === "number") return { overall: finite({ mean: est("mean")! / NS_PER_MS, p50: est("median")! / NS_PER_MS }), series: {} }
  // pytest-benchmark --benchmark-json: seconds per benchmark, ops a second.
  if (Array.isArray(o.benchmarks) && (o.benchmarks as Array<Record<string, unknown>>).every((b) => typeof b.stats === "object")) {
    const series: Record<string, Measures> = {}
    for (const b of o.benchmarks as Array<{ name?: string; fullname?: string; stats: Record<string, number> }>) {
      const ms = (k: string) => (typeof b.stats[k] === "number" ? b.stats[k] * 1000 : undefined)
      series[String(b.fullname ?? b.name)] = finite({ mean: ms("mean"), p50: ms("median"), min: ms("min"), max: ms("max"), throughput: b.stats.ops })
    }
    return { overall: single(series), series }
  }
  // vegeta report -type=json: nanoseconds, success as a fraction.
  if (typeof o.latencies === "object" && o.latencies !== null && typeof o.success === "number") {
    const l = o.latencies as Record<string, number>
    const ms = (k: string) => (typeof l[k] === "number" ? l[k] / NS_PER_MS : undefined)
    return { overall: finite({ mean: ms("mean"), p50: ms("50th"), p90: ms("90th"), p95: ms("95th"), p99: ms("99th"), max: ms("max"), min: ms("min"), errors: (1 - (o.success as number)) * 100, throughput: o.throughput as number }), series: {} }
  }
  // oha --json: seconds, success as a fraction.
  if (typeof o.summary === "object" && o.summary !== null && typeof o.latencyPercentiles === "object" && o.latencyPercentiles !== null) {
    const s = o.summary as Record<string, number>
    const p = o.latencyPercentiles as Record<string, number>
    const ms = (v: number | undefined) => (typeof v === "number" ? v * 1000 : undefined)
    return {
      overall: finite({ mean: ms(s.average), min: ms(s.fastest), max: ms(s.slowest), p50: ms(p.p50), p90: ms(p.p90), p95: ms(p.p95), p99: ms(p.p99), p999: ms(p["p99.9"]), errors: typeof s.successRate === "number" ? (1 - s.successRate) * 100 : undefined, throughput: s.requestsPerSec }),
      series: {},
    }
  }
  if (o.schema === "proofload/run/1") return proofload(o)
  if (o.type === "GROUP" && typeof o.stats === "object" && o.stats !== null && "numberOfRequests" in (o.stats as object)) return gatling(o)
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
  if (r.untrusted !== undefined) return { status: "not-executed", reason: r.untrusted, metrics: {} }
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
