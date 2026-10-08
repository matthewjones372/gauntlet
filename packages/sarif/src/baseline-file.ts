import { prettyCanonicalJson } from "@gauntlet/ir"
import { Data, Effect, Schema } from "effect"
import { compareWithBaseline } from "./match.ts"
import { type MetricDelta, updateMetrics } from "./metrics.ts"
import { type LegacyEntry, Log, type Metric, type Result, type Run, SARIF_SCHEMA, SARIF_VERSION } from "./schema.ts"

// `.gauntlet/baseline.sarif`: a SARIF log whose first run (tool "gauntlet")
// carries metrics, legacy sets and where the baseline was recorded; the other
// runs hold each tool's grandfathered results.

export const GAUNTLET_TOOL = "gauntlet"

export interface Baseline {
  readonly commit: string
  readonly irHash: string
  readonly gauntletVersion: string
  readonly metrics: Readonly<Record<string, Metric>>
  readonly legacy: ReadonlyArray<LegacyEntry>
  /** Test ids that ran at the recorded commit. */
  readonly testIds: ReadonlyArray<string>
  /** Grandfathered results, keyed by tool. */
  readonly results: Readonly<Record<string, ReadonlyArray<Result>>>
}

export class BaselineInvalid extends Data.TaggedError("BaselineInvalid")<{ readonly reason: string }> {}

export const emptyBaseline = (commit: string, irHash: string, gauntletVersion: string): Baseline => ({
  commit, irHash, gauntletVersion, metrics: {}, legacy: [], testIds: [], results: {},
})

/** What a baseline stores for a result: no state or Gauntlet match details. */
const stored = (r: Result): Result => {
  const { baselineState: _state, properties, ...rest } = r
  const caution = properties?.gauntlet?.caution
  return caution ? { ...rest, properties: { gauntlet: { caution } } } : rest
}

export const encodeBaseline = (b: Baseline): string => {
  const meta: Run = {
    tool: { driver: { name: GAUNTLET_TOOL } },
    results: [],
    properties: {
      gauntlet: {
        baseline: { commit: b.commit, irHash: b.irHash, gauntletVersion: b.gauntletVersion },
        metrics: b.metrics,
        legacy: [...b.legacy].sort((x, y) => (`${x.tool}\0${x.id}` < `${y.tool}\0${y.id}` ? -1 : 1)),
        testIds: [...new Set(b.testIds)].sort(),
      },
    },
  }
  const tools: Run[] = Object.keys(b.results).sort().map((tool) => ({
    tool: { driver: { name: tool } },
    results: compareWithBaseline([], b.results[tool]!).results.map(stored),
  }))
  const log: Log = { version: SARIF_VERSION, $schema: SARIF_SCHEMA, runs: [meta, ...tools] }
  return prettyCanonicalJson(log)
}

export const decodeBaseline = (json: string) =>
  Effect.gen(function*() {
    const raw = yield* Effect.try({ try: () => JSON.parse(json) as unknown, catch: (e) => new BaselineInvalid({ reason: `not JSON: ${String(e)}` }) })
    const log = yield* Schema.decodeUnknownEffect(Log)(raw).pipe(Effect.mapError((e) => new BaselineInvalid({ reason: String(e) })))
    const [meta, ...tools] = log.runs
    const info = meta?.tool.driver.name === GAUNTLET_TOOL ? meta.properties?.gauntlet : undefined
    if (!info?.baseline) return yield* new BaselineInvalid({ reason: `the first run must be the "${GAUNTLET_TOOL}" run with baseline details` })
    const results: Record<string, Result[]> = {}
    for (const run of tools) results[run.tool.driver.name] = [...(results[run.tool.driver.name] ?? []), ...run.results]
    return {
      ...info.baseline,
      metrics: info.metrics ?? {},
      legacy: info.legacy ?? [],
      testIds: info.testIds ?? [],
      results,
    } satisfies Baseline
  })

export interface UpdateRequest {
  readonly commit: string
  readonly irHash: string
  readonly gauntletVersion: string
  readonly metrics: Readonly<Record<string, Metric>>
  readonly results: Readonly<Record<string, ReadonlyArray<Result>>>
  readonly testIds: ReadonlyArray<string>
  readonly allowLower: boolean
  /**
   * The policy gained gates: grandfather the findings of tools the old
   * baseline never recorded at all, without counting them as a lowering.
   * Findings of tools it already recorded follow the usual rule.
   */
  readonly adoptNewTools?: boolean
}

export interface UpdateOutcome {
  readonly baseline: Baseline
  /** Metrics that got worse. Applied only with `allowLower`. */
  readonly loweredMetrics: ReadonlyArray<MetricDelta>
  /** Findings that would be newly grandfathered. Applied only with `allowLower`. */
  readonly newlyGrandfathered: ReadonlyArray<Result>
  /** Findings that disappeared and leave the baseline: an improvement. */
  readonly fixed: ReadonlyArray<Result>
  readonly lowers: boolean
}

/**
 * Records a fresh run on trunk into the baseline (`gauntlet baseline --update`).
 * Fixed findings drop out and better metrics are taken. Anything that would
 * lower the bar (a worse metric, a finding not already grandfathered) is
 * refused unless `allowLower` is set.
 */
export const updateBaseline = (old: Baseline, request: UpdateRequest): UpdateOutcome => {
  const metricUpdate = updateMetrics(old.metrics, request.metrics, request.allowLower)
  const results: Record<string, ReadonlyArray<Result>> = {}
  const newlyGrandfathered: Result[] = []
  const fixed: Result[] = []
  for (const tool of [...new Set([...Object.keys(old.results), ...Object.keys(request.results)])].sort()) {
    const recorded = request.results[tool]
    if (recorded === undefined) {
      // Not recorded this time: keep what was grandfathered rather than forget it.
      results[tool] = old.results[tool] ?? []
      continue
    }
    const comparison = compareWithBaseline(old.results[tool] ?? [], recorded)
    if (request.adoptNewTools && old.results[tool] === undefined) {
      // A gate the old baseline never ran: its existing findings are where it starts.
      results[tool] = comparison.results
      continue
    }
    const added = comparison.results.filter((r) => r.baselineState === "new")
    newlyGrandfathered.push(...added)
    fixed.push(...comparison.absent)
    results[tool] = request.allowLower ? comparison.results : comparison.results.filter((r) => r.baselineState !== "new")
  }
  const lowers = metricUpdate.lowered.length > 0 || newlyGrandfathered.length > 0
  return {
    baseline: {
      commit: request.commit,
      irHash: request.irHash,
      gauntletVersion: request.gauntletVersion,
      metrics: metricUpdate.metrics,
      legacy: old.legacy,
      // Not ratcheted: a test deleted on trunk went through review (deleted tests are forbidden in PRs).
      testIds: request.testIds,
      results,
    },
    loweredMetrics: metricUpdate.lowered,
    newlyGrandfathered,
    fixed,
    lowers,
  }
}
