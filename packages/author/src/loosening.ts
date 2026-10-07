import type { Check, Comparator, Condition, PolicyIR, ReviewRule, Threshold } from "@gauntlet/ir"
import { canonicalJson } from "@gauntlet/ir"

// What counts as loosening a policy, decided by comparing compiled IR, never
// by the model (ADR 0009). Anything that removes a protection, an owner, a
// gate, a rule or a review requirement, or makes a threshold easier to meet,
// is a loosening; each needs its own typed confirmation before it's written.
// When in doubt this errs towards calling a change loosening.

export interface Loosening {
  readonly what: string
}

const key = (value: unknown) => canonicalJson(value)

const missing = <A>(before: ReadonlyArray<A>, after: ReadonlyArray<A>, id: (a: A) => string): A[] => {
  const kept = new Set(after.map(id))
  return before.filter((b) => !kept.has(id(b)))
}

/** Whether moving a threshold from `before` to `after` makes it easier to meet. */
const easier = (op: Comparator, before: number, after: number): boolean => {
  switch (op) {
    case ">": case ">=": return after < before
    case "<": case "<=": return after > before
    default: return after !== before
  }
}

const checkId = (c: Check): string => {
  switch (c.kind) {
    case "gate": return `gate ${c.name}${c.zone ? ` in zone ${c.zone}` : ""}`
    case "suite": return `suite ${c.name}`
    case "holdout": return `holdout ${c.name}`
    case "budget": return `budget ${c.budget}`
    case "llm-review": return "llm review"
  }
}

const thresholdText = (t: Threshold) => `${t.op} ${t.value.value}${t.value.unit ?? ""}`

const gateLoosenings = (before: PolicyIR, after: PolicyIR): Loosening[] => {
  const out: Loosening[] = []
  const required = (ir: PolicyIR) => ir.gates.filter((t) => !t.advisory).flatMap((t) => t.checks)
  const advisory = (ir: PolicyIR) => new Set(ir.gates.filter((t) => t.advisory).flatMap((t) => t.checks.map(checkId)))
  const afterRequired = new Map(required(after).map((c) => [checkId(c), c]))
  for (const b of required(before)) {
    const a = afterRequired.get(checkId(b))
    if (!a) {
      out.push({ what: advisory(after).has(checkId(b)) ? `${checkId(b)} becomes advisory` : `${checkId(b)} is no longer a required gate` })
      continue
    }
    if (b.kind !== "gate" || a.kind !== "gate") continue
    if (b.ratchet && !a.ratchet) out.push({ what: `${checkId(b)} is no longer a ratchet` })
    if (b.scope === "all" && a.scope === "changed") out.push({ what: `${checkId(b)} now only measures changed code` })
    if (b.threshold && !a.threshold) out.push({ what: `${checkId(b)} loses its threshold (${thresholdText(b.threshold)})` })
    if (b.threshold && a.threshold) {
      if (b.threshold.op !== a.threshold.op || (b.threshold.value.unit ?? "") !== (a.threshold.value.unit ?? "") || easier(b.threshold.op, b.threshold.value.value, a.threshold.value.value)) {
        out.push({ what: `${checkId(b)} threshold changes from ${thresholdText(b.threshold)} to ${thresholdText(a.threshold)}` })
      }
    }
  }
  return out
}

const conditionText = (c: Condition) => (c.kind === "diff" ? `diff ${c.op} ${c.lines} lines` : c.kind === "predicate" ? c.name : c.kind)
const ruleText = (r: ReviewRule) => `${r.tier} when ${r.conditions.map(conditionText).join(" and ")}`
const LENIENT = new Set(["auto", "skim"])

const reviewLoosenings = (before: PolicyIR, after: PolicyIR): Loosening[] => {
  const out: Loosening[] = []
  for (const r of missing(before.review, after.review, key)) if (!LENIENT.has(r.tier)) out.push({ what: `review rule removed: ${ruleText(r)}` })
  for (const r of missing(after.review, before.review, key)) if (LENIENT.has(r.tier)) out.push({ what: `new lenient review rule: ${ruleText(r)}` })
  // A predicate that a lenient rule relies on can widen what that rule lets through.
  const lenientUses = new Set(after.review.filter((r) => LENIENT.has(r.tier)).flatMap((r) => r.conditions.flatMap((c) => (c.kind === "predicate" ? [c.name] : []))))
  const beforePredicates = new Map(before.predicates.map((p) => [p.name, key(p)]))
  for (const p of after.predicates) {
    const was = beforePredicates.get(p.name)
    if (was !== undefined && was !== key(p) && lenientUses.has(p.name)) out.push({ what: `predicate ${p.name}, which an auto or skim rule uses, changes` })
  }
  return out
}

export const looseningsBetween = (before: PolicyIR, after: PolicyIR): Loosening[] => {
  const out: Loosening[] = []
  if (before.mode === "enforce" && after.mode === "shadow") out.push({ what: "mode goes from enforce to shadow" })
  for (const o of missing(before.owners, after.owners, (x) => x)) out.push({ what: `policy owner ${o} removed` })
  const protections = (ir: PolicyIR) => ir.protect.flatMap((g) => g.globs.map((glob) => ({ kind: g.kind, glob })))
  for (const p of missing(protections(before), protections(after), key)) out.push({ what: `"${p.glob}" is no longer protected as ${p.kind}` })
  for (const z of before.zones) {
    const a = after.zones.find((x) => x.name === z.name)
    if (!a) {
      out.push({ what: `zone ${z.name} removed` })
      continue
    }
    for (const g of missing(z.globs, a.globs, (x) => x)) out.push({ what: `zone ${z.name} no longer covers "${g}"` })
    for (const o of missing(z.owners, a.owners, (x) => x)) out.push({ what: `zone ${z.name} loses owner ${o}` })
    for (const r of missing(z.rules, a.rules, (x) => x)) out.push({ what: `zone ${z.name} drops rule ${r}` })
  }
  const deps = (ir: PolicyIR) => ir.arch.flatMap((r) => r.mustNotDependOn.map((d) => `${r.module} must not depend on ${d}`))
  for (const d of missing(deps(before), deps(after), (x) => x)) out.push({ what: `arch rule removed: ${d}` })
  for (const s of missing(before.suites, after.suites, key)) out.push({ what: `suite ${s.name} removed or changed` })
  for (const list of ["ratchet", "forbid", "flag"] as const) {
    for (const c of missing<string>(before.integrity[list], after.integrity[list], (x) => x)) out.push({ what: `integrity ${list} ${c} removed` })
  }
  for (const b of missing(before.budgets, after.budgets, key)) out.push({ what: `budget ${b.name} removed or changed` })
  for (const i of missing(before.imports, after.imports, (x) => x.name)) out.push({ what: `import ${i.name} removed` })
  // A quarantine excuses a failing test: a new one, or a later date, loosens.
  for (const q of after.quarantine ?? []) {
    const was = (before.quarantine ?? []).find((b) => b.test === q.test)
    if (!was) out.push({ what: `${q.test} is quarantined until ${q.until}` })
    else if (q.until > was.until) out.push({ what: `the quarantine of ${q.test} is extended from ${was.until} to ${q.until}` })
  }
  out.push(...gateLoosenings(before, after), ...reviewLoosenings(before, after))
  return out
}
