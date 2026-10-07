import { looseningsBetween } from "@gauntlet/author"
import type { Check, PolicyIR } from "@gauntlet/ir"

// `gauntlet init --apply`: what applying a proposed policy changes, in plain
// lines a person can check before it's written. Loosenings are found by
// comparing compiled IR (ADR 0009), never taken from whoever wrote the proposal.

const quantity = (q: { readonly value: number; readonly unit?: string }) => `${q.value}${q.unit ?? ""}`

export const checkText = (c: Check): string => {
  switch (c.kind) {
    case "gate":
      return [c.name, c.ratchet ? "ratchet" : "", c.threshold ? `${c.threshold.op} ${quantity(c.threshold.value)}` : "", c.scope === "changed" ? "on changed" : "", c.zone ? `in zone ${c.zone}` : ""]
        .filter((s) => s !== "").join(" ")
    case "suite":
    case "holdout":
      return c.name
    case "budget":
      return `budget ${c.budget}`
    case "llm-review":
      return `llm review ${c.reviews}`
  }
}

const MODE = { shadow: "shadow (reports only, never blocks)", enforce: "enforce (failing changes are blocked)" } as const

/** One line per difference between `before` (none for a first policy) and `after`. */
export const describeChanges = (after: PolicyIR, before?: PolicyIR): string[] => {
  const lines: string[] = []
  if (before?.mode !== after.mode) lines.push(`Mode: ${MODE[after.mode]}`)
  if (JSON.stringify(before?.owners ?? []) !== JSON.stringify(after.owners)) lines.push(`Owners: ${after.owners.length > 0 ? after.owners.join(", ") : "none"}`)
  for (const z of after.zones) {
    const old = before?.zones.find((b) => b.name === z.name)
    if (old && JSON.stringify(old) === JSON.stringify(z)) continue
    const detail = [z.globs.join(", "), z.owners.length > 0 ? `owner ${z.owners.join(", ")}` : "no owner", z.rules.length > 0 ? `rules ${z.rules.join(", ")}` : ""].filter((s) => s !== "").join("; ")
    lines.push(`${old ? "Changed" : "New"} zone ${z.name}: ${detail}`)
  }
  for (const z of before?.zones ?? []) if (!after.zones.some((a) => a.name === z.name)) lines.push(`Removed zone ${z.name}`)
  for (const a of after.arch) {
    const old = before?.arch.find((b) => b.module === a.module)
    if (!old || JSON.stringify(old.mustNotDependOn) !== JSON.stringify(a.mustNotDependOn)) lines.push(`Layer rule: ${a.module} must not depend on ${a.mustNotDependOn.join(", ")}`)
  }
  for (const a of before?.arch ?? []) if (!after.arch.some((b) => b.module === a.module)) lines.push(`Removed layer rule for ${a.module}`)
  for (const t of after.gates) {
    const old = before?.gates.find((b) => b.name === t.name)
    const text = t.checks.map(checkText).join(", ")
    if (!old || old.checks.map(checkText).join(", ") !== text) lines.push(`Checks (${t.name}): ${text}`)
  }
  for (const t of before?.gates ?? []) if (!after.gates.some((a) => a.name === t.name)) lines.push(`Removed checks (${t.name})`)
  for (const g of after.protect.filter((p) => p.kind !== "gauntlet")) {
    const old = before?.protect.find((b) => b.kind === g.kind)
    if (!old || JSON.stringify(old.globs) !== JSON.stringify(g.globs)) lines.push(`Protected ${g.kind}: ${g.globs.join(", ")}`)
  }
  if (before) for (const l of looseningsBetween(before, after)) lines.push(`Loosens: ${l.what}`)
  return lines
}
