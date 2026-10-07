import { type Condition, canonicalJson, type PolicyIR, TIER_ORDER } from "@gauntlet/ir"
import { type Draft, type Report, spanOfNode } from "./compile.ts"
import { globMatches, globsMayOverlap } from "./glob.ts"

// Rules that are each valid but don't make sense together.

const IMPLICIT_REVIEW: ReadonlyArray<Condition["kind"]> = ["evidence-missing", "protected-changed"]

export const conflicts = (draft: Draft, report: Report, files?: ReadonlyArray<string>): void => {
  const { ir, refs, spans } = draft
  const error = (code: string, span: NonNullable<ReturnType<typeof spanOfNode>>, message: string, expected: string, fix: string) =>
    report({ severity: "error", code, span, message, expected, fix })
  const warning = (code: string, span: NonNullable<ReturnType<typeof spanOfNode>>, message: string, expected: string, fix: string) =>
    report({ severity: "warning", code, span, message, expected, fix })
  const info = (code: string, span: NonNullable<ReturnType<typeof spanOfNode>>, message: string, fix: string) =>
    report({ severity: "info", code, span, message, expected: "nothing; this is for information", fix })

  // A protected path inside a zone nobody owns: changes there have nobody to escalate to.
  const unowned = ir.zones.filter((z) => z.owners.length === 0)
  for (const ref of refs) {
    if (ref.kind !== "glob" || !("protect" in ref.owner)) continue
    for (const zone of unowned) {
      const overlaps = zone.globs.some((zg) =>
        files ? files.some((f) => globMatches(ref.glob, f) && globMatches(zg, f)) : globsMayOverlap(ref.glob, zg))
      if (overlaps) {
        error("protected-in-unowned-zone", ref.span, `Protected path "${ref.glob}" overlaps zone '${zone.name}', which has no owner.`,
          `an \`owner\` in zone '${zone.name}'`, `Add an owner to the zone, for example: owner @${zone.name}-owners`)
      }
    }
  }

  // With the repository's file list, a pattern that matches nothing is probably a typo.
  if (files) {
    for (const ref of refs) {
      if (ref.kind !== "glob" || files.some((f) => globMatches(ref.glob, f))) continue
      const where = "protect" in ref.owner ? `protect group '${ref.owner.protect}'` : `zone '${ref.owner.zone}'`
      warning("glob-matches-nothing", ref.span, `"${ref.glob}" in ${where} matches no file in the repository.`,
        "a pattern that matches existing files", "Check the path for typos. It's fine to keep it if those files will exist later.")
    }
  }

  if (ir.gates.length > 0 && ir.gates.every((t) => t.advisory) && spans.gates) {
    error("advisory-only", spans.gates, "Every gate tier is advisory, so nothing deterministic can fail a change.",
      "at least one required tier", "Add a required tier, for example: verify { build, unit }")
  }

  // Review rules: expand predicates, then look for rules that can never win.
  const predicates = new Map(ir.predicates.map((p) => [p.name, p]))
  const expand = (conditions: ReadonlyArray<Condition>, depth = 0): Condition[] =>
    depth > ir.predicates.length ? [] : conditions.flatMap((c) =>
      c.kind === "predicate" ? expand(predicates.get(c.name)?.conditions ?? [], depth + 1) : [c])
  const keys = (conditions: ReadonlyArray<Condition>) => new Set(expand(conditions).map(canonicalJson))
  const rank = (tier: PolicyIR["review"][number]["tier"]) => TIER_ORDER.indexOf(tier)

  for (const rule of ir.review) {
    if (rank(rule.tier) >= rank("review")) continue
    const span = spanOfNode(rule)!
    const expanded = expand(rule.conditions)
    const kinds = expanded.map((c) => c.kind)
    const blocker = kinds.find((k) => IMPLICIT_REVIEW.includes(k))
    if (blocker) {
      error("rule-never-wins", span, `This ${rule.tier} rule needs '${blocker.replace("-", " ")}', which always nominates review, so ${rule.tier} can never win.`,
        `conditions that don't imply review`, `Remove '${blocker.replace("-", " ")}' from the rule.`)
      continue
    }
    if (kinds.includes("zone-touched") && kinds.includes("no-zone-touched")) {
      error("rule-never-holds", span, "This rule needs both 'zone touched' and 'no zone touched', so it can never hold.",
        "conditions that can hold together", "Remove one of the two conditions.")
      continue
    }
    const mine = keys(rule.conditions)
    const stricter = ir.review.find((other) =>
      other !== rule && rank(other.tier) > rank(rule.tier) && [...keys(other.conditions)].every((k) => mine.has(k)))
    if (stricter) {
      const line = spanOfNode(stricter)?.line
      error("rule-never-wins", span, `Whenever this ${rule.tier} rule holds, the ${stricter.tier} rule on line ${line} holds too, so ${rule.tier} can never win.`,
        "a rule that can win", `Narrow the rule on line ${line}, or remove this one.`)
    }
  }

  const usedPredicates = new Set(refs.flatMap((r) => (r.kind === "predicate-ref" ? [r.name] : [])))
  for (const p of ir.predicates) {
    if (!usedPredicates.has(p.name)) {
      warning("unused-predicate", spanOfNode(p)!, `Predicate '${p.name}' is never used.`, "a rule that uses it", `Use it in a review rule, or remove it.`)
    }
  }

  const ownerRuleOnZones = ir.review.some((r) => r.tier === "owner" && expand(r.conditions).some((c) => c.kind === "zone-touched"))
  if (ownerRuleOnZones) {
    for (const zone of unowned) {
      warning("zone-without-owner", spanOfNode(zone)!, `Touching zone '${zone.name}' nominates owner, but the zone has no owner to suggest.`,
        "an `owner` line in the zone", `Add a line such as: owner @${zone.name}-owners`)
    }
  }

  if (spans.review && !ir.review.some((r) => r.tier === "auto")) {
    info("no-auto-rule", spans.review, "No rule nominates auto, so every change gets at least skim or review.",
      "Add an `auto when ...` rule if small, fully evidenced changes should skip review.")
  }
}
