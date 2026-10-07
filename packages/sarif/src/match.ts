import { contextKey, LINE_V1, SYMBOL_V1 } from "./fingerprint.ts"
import type { Result } from "./schema.ts"
import { resultPath, resultRegion } from "./schema.ts"

// Compares current results with grandfathered baseline results and sets
// SARIF `baselineState` on each (ADR 0004):
//   unchanged  same rule, path and context window
//   updated    same rule and path, and the same enclosing symbol or line text
//   new        no match: a new finding, which fails
//   absent     in the baseline but gone now
// Matching is one-to-one, so a second copy of a grandfathered finding is new.

export interface MatchOptions {
  /** Renames from the diff, old path to new path, so baseline findings follow their file. */
  readonly renames?: ReadonlyMap<string, string>
  /** The tool's locations aren't stable; compare per-file counts for everything. */
  readonly unstableLocations?: boolean
}

export interface Comparison {
  /** Current results in a fixed order, each with `baselineState`. */
  readonly results: ReadonlyArray<Result>
  /** Baseline results with no current match, with `baselineState: "absent"`. */
  readonly absent: ReadonlyArray<Result>
}

type Match = "context" | "symbol" | "line" | "count"

type State = NonNullable<Result["baselineState"]>

const annotate = (r: Result, state: State, match?: Match): Result => ({
  ...r,
  baselineState: state,
  ...(match ? { properties: { ...r.properties, gauntlet: { ...r.properties?.gauntlet, match } } } : {}),
})

const order = (a: Result, b: Result): number => {
  const ka = [resultPath(a) ?? "", a.ruleId, String(resultRegion(a)?.startLine ?? 0).padStart(9, "0"), a.message.text].join("\0")
  const kb = [resultPath(b) ?? "", b.ruleId, String(resultRegion(b)?.startLine ?? 0).padStart(9, "0"), b.message.text].join("\0")
  return ka < kb ? -1 : ka > kb ? 1 : 0
}

export const compareWithBaseline = (
  baseline: ReadonlyArray<Result>,
  current: ReadonlyArray<Result>,
  options: MatchOptions = {},
): Comparison => {
  const renames = options.renames ?? new Map()
  const pathOf = (r: Result, side: "base" | "head") => {
    const p = resultPath(r) ?? ""
    return side === "base" ? renames.get(p) ?? p : p
  }
  const group = (r: Result, side: "base" | "head") => `${pathOf(r, side)}\0${r.ruleId}`

  // A (file, rule) group is compared by counts when either side lacks fingerprints.
  const countGroups = new Set<string>()
  for (const [rs, side] of [[baseline, "base"], [current, "head"]] as const) {
    for (const r of rs) if (options.unstableLocations || contextKey(r) === undefined) countGroups.add(group(r, side))
  }

  const sortedCurrent = [...current].sort(order)
  const sortedBaseline = [...baseline].sort(order)
  const states = new Map<Result, { state: State; match?: Match }>()
  const absent: Result[] = []

  // Count mode.
  const byGroup = (rs: ReadonlyArray<Result>, side: "base" | "head") => {
    const m = new Map<string, Result[]>()
    for (const r of rs) {
      const g = group(r, side)
      if (countGroups.has(g)) m.set(g, [...(m.get(g) ?? []), r])
    }
    return m
  }
  const baseGroups = byGroup(sortedBaseline, "base")
  const headGroups = byGroup(sortedCurrent, "head")
  for (const g of countGroups) {
    const b = baseGroups.get(g) ?? []
    const h = headGroups.get(g) ?? []
    const rose = h.length > b.length
    for (const r of h) states.set(r, { state: rose ? "new" : "unchanged", match: "count" })
    if (h.length < b.length) absent.push(...b.slice(h.length))
  }

  // Fingerprint mode, strongest key first.
  let pendingBase = sortedBaseline.filter((r) => !countGroups.has(group(r, "base")))
  let pendingHead = sortedCurrent.filter((r) => !countGroups.has(group(r, "head")))
  const passes: ReadonlyArray<[(r: Result) => string | undefined, State, Match]> = [
    [contextKey, "unchanged", "context"],
    [(r) => r.partialFingerprints?.[SYMBOL_V1], "updated", "symbol"],
    [(r) => r.partialFingerprints?.[LINE_V1], "updated", "line"],
  ]
  for (const [key, state, match] of passes) {
    const pool = new Map<string, Result[]>()
    for (const r of pendingBase) {
      const k = key(r)
      if (k !== undefined) pool.set(`${group(r, "base")}\0${k}`, [...(pool.get(`${group(r, "base")}\0${k}`) ?? []), r])
    }
    const matchedBase = new Set<Result>()
    pendingHead = pendingHead.filter((r) => {
      const k = key(r)
      const candidates = k === undefined ? undefined : pool.get(`${group(r, "head")}\0${k}`)
      const hit = candidates?.shift()
      if (!hit) return true
      matchedBase.add(hit)
      states.set(r, { state, match })
      return false
    })
    pendingBase = pendingBase.filter((r) => !matchedBase.has(r))
  }
  for (const r of pendingHead) states.set(r, { state: "new" })
  absent.push(...pendingBase)

  return {
    results: sortedCurrent.map((r) => {
      const s = states.get(r)!
      return s.match ? annotate(r, s.state, s.match) : annotate(r, s.state)
    }),
    absent: absent.sort(order).map((r) => annotate(r, "absent")),
  }
}

export const newResults = (c: Comparison): ReadonlyArray<Result> => c.results.filter((r) => r.baselineState === "new")
