import type { Check, Condition, PolicyIR } from "@gauntlet/ir"

// `gauntlet explain [block]`: what the policy enforces, in plain language.
// Deterministic, from the IR; the authoring agent's explanations come later.

const describeCondition = (c: Condition): string => {
  switch (c.kind) {
    case "zone-touched": return "a zone is touched"
    case "no-zone-touched": return "no zone is touched"
    case "protected-changed": return "a protected file changes"
    case "dependency-added": return "a dependency is added"
    case "budget-changed": return "a perf budget's script changes"
    case "evidence-missing": return "some evidence is missing"
    case "all-gates-pass": return "every required gate passes"
    case "diff": return `the diff is ${c.op} ${c.lines} lines`
    case "predicate": return `'${c.name}' holds`
  }
}

const describeCheck = (c: Check): string => {
  switch (c.kind) {
    case "suite": return `the ${c.name} suite passes and runs at least one test`
    case "holdout": return `the ${c.name} holdout passes (CI only; not executed in v1)`
    case "budget": return `perf budget ${c.budget} holds (not executed in v1)`
    case "llm-review": return `${c.reviews} independent LLM reviews (caution only; not executed in v1)`
    case "gate": {
      const parts = [c.name]
      if (c.threshold) parts.push(`${c.threshold.op} ${c.threshold.value.value}${c.threshold.value.unit ?? ""}`)
      if (c.ratchet) parts.push("and no worse than the baseline")
      if (c.scope === "changed") parts.push("on changed code")
      if (c.zone) parts.push(`in zone ${c.zone}`)
      return parts.join(" ")
    }
  }
}

export const explainPolicy = (ir: PolicyIR, block?: string): string => {
  const sections: Record<string, string[]> = {
    mode: [ir.mode === "enforce"
      ? "Mode enforce: a failing gate or forbidden integrity finding fails the change."
      : "Mode shadow: Gauntlet reports what it would do and never fails the change."],
    protect: [
      "Protected files are taken from the base branch before anything runs, and changing them needs review. `.gauntlet/` always counts and needs an owner.",
      ...ir.protect.map((g) => `- ${g.group}${g.kind === "tests" ? " (new tests here run; changed or deleted ones are put back)" : ""}: ${g.globs.join(", ")}`),
    ],
    zones: ir.zones.length === 0 ? ["No zones."] : ir.zones.map((z) =>
      `- zone ${z.name}: ${z.globs.join(", ")}${z.owners.length > 0 ? `, owned by ${z.owners.join(", ")}` : ", no owner"}${z.rules.length > 0 ? `, rules ${z.rules.join(", ")}` : ""}`),
    gates: ir.gates.length === 0 ? ["No gates: every change is missing evidence."] : [
      "Gate tiers run in order; a failure stops the tiers after it.",
      ...ir.gates.map((t) => `- ${t.name}${t.advisory ? " (advisory, caution only)" : ""}: ${t.checks.map(describeCheck).join("; ")}`),
    ],
    integrity: [
      `Always on: ratchets (${ir.integrity.ratchet.join(", ")}), forbidden (${ir.integrity.forbid.join(", ")}), flagged (${ir.integrity.flag.join(", ")}).`,
    ],
    review: [
      "Every matching rule nominates a tier and the most cautious wins. With no match the tier is review.",
      ...ir.predicates.map((p) => `- '${p.name}' means ${p.conditions.map(describeCondition).join(" and ")}`),
      ...ir.review.map((r) => `- ${r.tier} when ${r.conditions.map(describeCondition).join(" and ")}`),
    ],
    flaky: [
      "A failing test is run again on its own; if it passes it's flaky, which needs review. New and changed test files run 3 more times in shuffled order; a test that passes and fails is a new flaky test, which blocks. Adding test retries is forbidden.",
      ...((ir.quarantine ?? []).length === 0
        ? ["No quarantines."]
        : (ir.quarantine ?? []).map((q) => `- ${q.test} is quarantined until ${q.until} (inclusive, by the judged commit's date) by ${q.owners.join(", ")}: it runs, and its failure doesn't fail the suite until then.`)),
    ],
  }
  const aliases: Record<string, string> = { zone: "zones", gate: "gates", predicate: "review", predicates: "review", suites: "gates", quarantine: "flaky" }
  const wanted = block === undefined ? Object.keys(sections) : [aliases[block] ?? block]
  const unknown = wanted.filter((w) => !(w in sections))
  if (unknown.length > 0) return `Unknown block '${block}'. Choose one of: ${Object.keys(sections).join(", ")}.\n`
  return `${wanted.map((w) => `${w}\n${sections[w]!.join("\n")}`).join("\n\n")}\n`
}
