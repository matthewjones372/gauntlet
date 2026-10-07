import { canonicalJson, sha256 } from "./canonical.ts"
import type { PolicyIR } from "./policy-ir.ts"

// Puts an IR into canonical order so that two policies with the same meaning
// produce the same JSON and the same hash. Gate tiers keep their declared
// order because tiers run in that order; every other list is sorted, and
// duplicates that carry no meaning are dropped.
//
// Objects are copied with spread, so any symbol-keyed annotations the
// compiler attached (source spans) survive into the result.

const strings = (xs: ReadonlyArray<string>): string[] => [...new Set(xs)].sort()

const byKey = <A>(key: (a: A) => string) => (xs: ReadonlyArray<A>): A[] =>
  [...xs].sort((a, b) => {
    const ka = key(a)
    const kb = key(b)
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })

const byJson = <A>(xs: ReadonlyArray<A>): A[] => {
  const seen = new Set<string>()
  return byKey<A>(canonicalJson)(xs).filter((x) => {
    const k = canonicalJson(x)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

const byName = <A extends { readonly name: string }>(xs: ReadonlyArray<A>): A[] => byKey<A>((x) => x.name)(xs)

export const canonicalize = (ir: PolicyIR): PolicyIR => ({
  ...ir,
  packs: strings(ir.packs),
  owners: strings(ir.owners),
  protect: byKey<PolicyIR["protect"][number]>((g) => g.group)(ir.protect).map((g) => ({ ...g, globs: strings(g.globs) })),
  zones: byName(ir.zones).map((z) => ({ ...z, globs: strings(z.globs), owners: strings(z.owners), rules: strings(z.rules) })),
  arch: byKey<PolicyIR["arch"][number]>((a) => a.module)(ir.arch).map((a) => ({ ...a, mustNotDependOn: strings(a.mustNotDependOn) })),
  suites: byName(ir.suites),
  integrity: {
    ...ir.integrity,
    ratchet: [...new Set(ir.integrity.ratchet)].sort(),
    forbid: [...new Set(ir.integrity.forbid)].sort(),
    flag: [...new Set(ir.integrity.flag)].sort(),
  },
  budgets: byName(ir.budgets).map((b) => ({ ...b, thresholds: byJson(b.thresholds) })),
  gates: ir.gates.map((t) => ({ ...t, checks: byJson(t.checks) })),
  remediation: byKey<PolicyIR["remediation"][number]>((r) => r.gate)(ir.remediation),
  imports: byName(ir.imports),
  predicates: byName(ir.predicates).map((p) => ({ ...p, conditions: byJson(p.conditions) })),
  review: byJson(ir.review.map((r) => ({ ...r, conditions: byJson(r.conditions) }))),
  ...(ir.stack
    ? { stack: { ...ir.stack, layers: byName(ir.stack.layers).map((l) => ({ ...l, properties: byJson(l.properties) })) } }
    : {}),
  ...(ir.quarantine && ir.quarantine.length > 0
    ? { quarantine: byKey<NonNullable<PolicyIR["quarantine"]>[number]>((q) => q.test)(ir.quarantine).map((q) => ({ ...q, owners: strings(q.owners) })) }
    : {}),
})

/** sha256 of the canonical JSON of the canonicalised IR. */
export const irHash = (ir: PolicyIR): string => sha256(canonicalJson(canonicalize(ir)))
