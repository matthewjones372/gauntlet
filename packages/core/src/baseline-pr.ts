import { type Baseline, compareMetrics, type Metric } from "@gauntlet/sarif"
import type { Regression } from "./review.ts"
import { BASELINE_PATH } from "./baseline-store.ts"

// A pull request that only lowers the baseline (spec 0015). It was always
// judged against the base's baseline, which it means to replace, so it blocked
// itself and needed an override on top of the owner's approval. Now, when the
// baseline is the only file it changes, the values it lowers are taken from
// the baseline it brings and the owner tier names them: approving accepts the
// lower bar. Any other file in the change and it's judged as before.

/** The change touches `.gauntlet/baseline.sarif` and nothing else. */
export const onlyBaseline = (files: ReadonlyArray<{ readonly path: string; readonly status: string; readonly oldPath?: string }>) =>
  files.length === 1 && files[0]!.path === BASELINE_PATH && files[0]!.oldPath === undefined && files[0]!.status !== "deleted"

const round = (n: number) => Math.round(n * 1e6) / 1e6
const worse = (m: Metric, was: number, now: number) => (m.higherIsBetter ? round(now) < round(was) : round(now) > round(was))

/** A metric with every value the brought one lowers taken from it; everything else as the base has it. */
const looser = (base: Metric, brought: Metric): Metric => {
  const perFile = { ...base.perFile }
  for (const [file, value] of Object.entries(brought.perFile ?? {})) if (worse(base, base.perFile?.[file] ?? base.value, value)) perFile[file] = value
  return {
    ...base,
    value: worse(base, base.value, brought.value) ? brought.value : base.value,
    ...(base.perFile !== undefined || Object.keys(perFile).length > 0 ? { perFile } : {}),
  }
}

/**
 * The baseline a baseline-only change is judged against: the base's, with
 * the values the brought baseline lowers taken from it, and what it lowers.
 * Metrics only the brought baseline has, and raised values, aren't taken: they
 * don't lower the bar this change is judged by. Lowering the executed-tests
 * count brings the test ids it counts with it.
 */
export const judgedBaseline = (base: Baseline, brought: Baseline): { readonly baseline: Baseline; readonly lowered: ReadonlyArray<Regression> } => {
  const metrics: Record<string, Metric> = { ...base.metrics }
  const lowered: Regression[] = []
  for (const name of Object.keys(base.metrics).sort()) {
    const b = base.metrics[name]!
    const h = brought.metrics[name]
    if (!h) continue
    const drops = compareMetrics({ [name]: b }, { [name]: h }).regressions
    if (drops.length === 0) continue
    metrics[name] = looser(b, h)
    lowered.push(...drops.map((d) => ({ metric: d.metric, ...(d.file !== undefined ? { file: d.file } : {}), base: d.base, head: d.head })))
  }
  const tests = lowered.some((l) => l.metric === "integrity/executed-tests" && l.file === undefined)
  return { baseline: { ...base, metrics, ...(tests ? { testIds: brought.testIds } : {}) }, lowered }
}

/** The owner nomination's reason: what the change lowers, from what to what. */
export const loweredReason = (lowered: ReadonlyArray<Regression>) => {
  const shown = lowered.slice(0, 5).map((l) => `${l.metric}${l.file !== undefined ? ` for ${l.file}` : ""} (${l.base} to ${l.head})`)
  const more = lowered.length > 5 ? `, and ${lowered.length - 5} more` : ""
  return `This pull request only changes the baseline, and lowers ${shown.join(", ")}${more}. It's judged against the baseline it brings; an owner's approval accepts the lower bar.`
}
