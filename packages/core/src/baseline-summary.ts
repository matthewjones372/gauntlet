import type { PolicyIR } from "@gauntlet/ir"
import type { Baseline } from "@gauntlet/sarif"

// `gauntlet explain baseline`: what `.gauntlet/baseline.sarif` holds, in plain
// language. The baseline is the bar every change is held to, so a person should
// be able to see it: where it was recorded, what's grandfathered, which files
// sit lowest, and where it falls short of the policy's own floors.

export interface BaselineSummary {
  readonly commit: string
  readonly gauntletVersion: string
  /** Test ids that ran where the baseline was recorded. */
  readonly tests: number
  readonly metrics: ReadonlyArray<MetricSummary>
  readonly findings: ReadonlyArray<ToolFindings>
  readonly warnings: ReadonlyArray<string>
}

export interface MetricSummary {
  readonly name: string
  readonly value: number
  readonly unit: string
  readonly higherIsBetter: boolean
  /** For a metric recorded per file: how many files, and the lowest of them. */
  readonly files?: number
  readonly lowest?: ReadonlyArray<{ readonly path: string; readonly value: number }>
  /** The policy's strictest floor for this metric, and how many files sit below it. */
  readonly floor?: { readonly value: number; readonly scope: "changed" | "all"; readonly below: number }
}

export interface ToolFindings {
  readonly tool: string
  readonly total: number
  readonly rules: ReadonlyArray<{ readonly rule: string; readonly count: number }>
  readonly files: ReadonlyArray<{ readonly path: string; readonly count: number }>
}

export interface SummaryOptions {
  /** How many of the lowest files, top rules and top files to name. */
  readonly lowest?: number
}

/** Counts, most first, ties by name, so the summary reads the same every time. */
const tally = (keys: ReadonlyArray<string>) =>
  [...keys.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>())]
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))

/** The strictest non-zone floor a gate sets for [metric], if any. */
const floorFor = (ir: PolicyIR, metric: string) =>
  ir.gates.flatMap((t) => t.checks).flatMap((c) =>
    c.kind === "gate" && c.name === metric && c.threshold !== undefined && c.zone === undefined
      ? [{ value: c.threshold.value.value, scope: c.scope }]
      : []).sort((a, b) => b.value - a.value)[0]

const formatValue = (value: number, unit: string) => (unit === "%" ? `${value}%` : `${value}`)

export const summarizeBaseline = (b: Baseline, ir: PolicyIR, opts: SummaryOptions = {}): BaselineSummary => {
  const n = opts.lowest ?? 10
  const warnings: string[] = []
  const metrics = Object.keys(b.metrics).sort().map((name): MetricSummary => {
    const m = b.metrics[name]!
    const base = { name, value: m.value, unit: m.unit, higherIsBetter: m.higherIsBetter }
    if (m.perFile === undefined) return base
    const files = Object.entries(m.perFile).map(([path, value]) => ({ path, value }))
      .sort((x, y) => (m.higherIsBetter ? x.value - y.value : y.value - x.value) || (x.path < y.path ? -1 : 1))
    const floor = m.higherIsBetter ? floorFor(ir, name) : undefined
    const below = floor === undefined ? 0 : files.filter((f) => f.value < floor.value).length
    if (floor !== undefined && m.value < floor.value) {
      const what = floor.scope === "changed" ? "changed code must meet" : "the project must meet"
      warnings.push(`${name} is ${formatValue(m.value, m.unit)} across the project, below the ${formatValue(floor.value, m.unit)} ${what}: ${below} of ${files.length} files are under it.`)
    }
    for (const dir of (ir.builds ?? []).map((x) => x.dir).filter((d) => d !== ".")) {
      if (!files.some((f) => f.path.startsWith(`${dir}/`))) {
        warnings.push(`${name} has no value for any file in ${dir}: changes there are held only to the policy's floor.`)
      }
    }
    return {
      ...base, files: files.length, lowest: files.slice(0, n),
      ...(floor !== undefined ? { floor: { ...floor, below } } : {}),
    }
  })
  const findings = Object.keys(b.results).sort().flatMap((tool): ToolFindings[] => {
    const results = b.results[tool]!
    if (results.length === 0) return []
    const paths = results.map((r) => r.locations?.[0]?.physicalLocation?.artifactLocation?.uri ?? "(no file)")
    return [{
      tool, total: results.length,
      rules: tally(results.map((r) => r.ruleId)).slice(0, n).map(([rule, count]) => ({ rule, count })),
      files: tally(paths).slice(0, n).map(([path, count]) => ({ path, count })),
    }]
  })
  return { commit: b.commit.slice(0, 12), gauntletVersion: b.gauntletVersion, tests: b.testIds.length, metrics, findings, warnings }
}

export const renderBaselineSummary = (s: BaselineSummary): string => {
  const lines = [`Recorded at ${s.commit} by Gauntlet ${s.gauntletVersion}; ${s.tests} tests ran there.`, ""]
  lines.push(s.metrics.length === 0 ? "No metrics." : "Metrics:")
  for (const m of s.metrics) {
    const extra = m.files === undefined ? ""
      : ` (${m.files} files${m.floor ? `; ${m.floor.below} below the ${formatValue(m.floor.value, m.unit)} floor${m.floor.scope === "changed" ? " on changed code" : ""}` : ""})`
    lines.push(`${m.name}: ${formatValue(m.value, m.unit)}${extra}`)
    if (m.lowest && m.lowest.length > 0) {
      lines.push(`  ${m.higherIsBetter ? "lowest" : "highest"}:`, ...m.lowest.map((f) => `    ${formatValue(f.value, m.unit).padEnd(7)}${f.path}`))
    }
  }
  lines.push("")
  if (s.findings.length === 0) lines.push("No grandfathered findings.")
  for (const f of s.findings) {
    lines.push(`${f.tool}: ${f.total} grandfathered finding${f.total === 1 ? "" : "s"}`)
    for (const r of f.rules) lines.push(`  ${r.rule} ${r.count}`)
    lines.push("  most in:", ...f.files.map((x) => `    ${String(x.count).padEnd(7)}${x.path}`))
  }
  if (s.warnings.length > 0) lines.push("", "Warnings:", ...s.warnings.map((w) => `- ${w}`))
  return `${lines.join("\n")}\n`
}
