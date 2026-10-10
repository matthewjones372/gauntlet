import { type Condition, type Mode, type PolicyIR, type SourceMap, type SourceRef, sourceRef, type Tier, TIER_ORDER } from "@gauntlet/ir"
import type { DiffFacts } from "./diff-facts.ts"
import type { IntegrityFinding, IntegrityResult } from "./integrity.ts"

// The review decision (ADR 0005). Every rule whose conditions hold nominates
// a tier; Gauntlet adds implicit nominations for failures, missing evidence
// and protected changes; the decision is the most cautious nomination. Rules
// can't loosen each other, and probabilistic signals can only step up once.

export type CheckStatus = "passed" | "failed" | "not-executed" | "errored"

export interface CheckOutcome {
  readonly tier: string
  readonly check: string
  /** JSON pointer of the check in the IR, such as `/gates/1/checks/0`. */
  readonly pointer: string
  readonly status: CheckStatus
  readonly advisory: boolean
  readonly reason?: string
  /** Tests that passed and failed (M15). Flaky tests that let a suite pass still need a person to look. */
  readonly flaky?: ReadonlyArray<string>
  /** Failing tests that also fail with the change's files as the base has them: they were failing before the change. */
  readonly failingOnBase?: ReadonlyArray<string>
  /** Every failure that counts fails on the base too: the change didn't cause the check to fail. */
  readonly failedBefore?: true
}

export interface NewViolation {
  readonly check: string
  readonly ruleId: string
  readonly message: string
  readonly path?: string
  readonly line?: number
}

export interface Regression {
  readonly metric: string
  readonly file?: string
  readonly base: number
  readonly head: number
}

/** A probabilistic signal: an advisory review or an imported finding from a caution source (ADR 0011). */
export interface CautionSignal {
  readonly source: string
  readonly message: string
  /** Advisory reviews raise only when enough of them agree; imported caution findings always do. */
  readonly raise: boolean
}

export interface Evidence {
  readonly checks: ReadonlyArray<CheckOutcome>
  readonly newViolations: ReadonlyArray<NewViolation>
  readonly regressions: ReadonlyArray<Regression>
  readonly integrity: IntegrityResult
  readonly caution: ReadonlyArray<CautionSignal>
  /** Set when the agent called `report_blocked`. */
  readonly blocked?: { readonly reason: string }
}

export type ImplicitRule =
  | "no-rule-matched"
  | "missing-evidence"
  | "gate-failed"
  | "new-violation"
  | "ratchet-regression"
  | "integrity-forbid"
  | "integrity-flag"
  | "integrity-not-executed"
  | "protected-changed"
  | "gauntlet-changed"
  | "reported-blocked"
  | "flaky-test"
  | "failing-on-base"
  | "caution"

export type NominationSource =
  | { readonly kind: "policy"; readonly pointer: string; readonly ref: SourceRef }
  | { readonly kind: "implicit"; readonly rule: ImplicitRule; readonly ref?: SourceRef }

export interface Nomination {
  readonly tier: Tier
  readonly reason: string
  readonly source: NominationSource
  /** In enforce mode, this nomination fails the change. */
  readonly blocking: boolean
}

export interface Decision {
  readonly tier: Tier
  readonly nominations: ReadonlyArray<Nomination>
  /** People to suggest as reviewers: owners of touched zones, and policy owners for `.gauntlet/` changes. */
  readonly owners: ReadonlyArray<string>
  /** Something would fail the change in enforce mode. */
  readonly wouldBlock: boolean
  /** The change fails: `wouldBlock` in enforce mode. */
  readonly blocking: boolean
  readonly mode: Mode
}

export interface ReviewInput {
  readonly ir: PolicyIR
  readonly sourceMap: SourceMap
  readonly facts: DiffFacts
  readonly evidence: Evidence
  /** The mode actually in force (first adoption forces shadow). */
  readonly mode: Mode
}

const rank = (t: Tier) => TIER_ORDER.indexOf(t)
const stepUp = (t: Tier): Tier => TIER_ORDER[Math.min(rank(t) + 1, TIER_ORDER.length - 1)]!

/** Whether a change has missing evidence: a check or integrity check that didn't run. */
export const evidenceMissing = (e: Evidence) =>
  e.checks.some((c) => !c.advisory && (c.status === "not-executed" || c.status === "errored")) || e.integrity.notExecuted.length > 0

const blockingIntegrity = (f: IntegrityFinding) => f.kind === "forbid" || f.kind === "ratchet"

/** Whether every required gate passed with nothing new, worse or forbidden. */
export const allGatesPass = (e: Evidence) =>
  e.checks.filter((c) => !c.advisory).every((c) => c.status === "passed") &&
  e.newViolations.length === 0 &&
  e.regressions.length === 0 &&
  !e.integrity.findings.some(blockingIntegrity)

export const evaluateCondition = (c: Condition, input: ReviewInput, depth = 0): boolean => {
  const { facts, evidence, ir } = input
  switch (c.kind) {
    case "zone-touched":
      return facts.zonesTouched.length > 0
    case "no-zone-touched":
      return facts.zonesTouched.length === 0
    case "protected-changed":
      return facts.protectedTouched.some((p) => p.action !== "kept")
    case "dependency-added":
      return facts.dependencyChanges.some((d) => d.unparsed || d.added.length > 0)
    case "budget-changed":
      return facts.budgetsChanged.length > 0
    case "evidence-missing":
      return evidenceMissing(evidence)
    case "all-gates-pass":
      return allGatesPass(evidence)
    case "diff":
      return compare(facts.linesChanged, c.op, c.lines)
    case "predicate": {
      const p = ir.predicates.find((x) => x.name === c.name)
      // The validator rules out unknown and cyclic predicates; the depth bound is a backstop.
      return p !== undefined && depth <= ir.predicates.length && p.conditions.every((pc) => evaluateCondition(pc, input, depth + 1))
    }
  }
}

const compare = (a: number, op: string, b: number) =>
  op === "<" ? a < b : op === "<=" ? a <= b : op === ">" ? a > b : op === ">=" ? a >= b : op === "==" ? a === b : a !== b

const where = (f: { readonly path?: string; readonly line?: number }) => (f.path ? ` (${f.path}${f.line ? `:${f.line}` : ""})` : "")

export const decide = (input: ReviewInput): Decision => {
  const { ir, sourceMap, facts, evidence } = input
  const nominations: Nomination[] = []
  const nominate = (tier: Tier, reason: string, source: NominationSource, blocking = false) =>
    nominations.push({ tier, reason, source, blocking })
  // Compiled policies map every rule to its line; the fallback keeps a hand-built IR citable.
  const policy = (pointer: string, describe: string): NominationSource => ({
    kind: "policy",
    pointer,
    ref: sourceRef(sourceMap, pointer) ?? { file: sourceMap.file, line: 0, column: 0, text: describe },
  })
  const implicit = (rule: ImplicitRule, pointer?: string): NominationSource => {
    const ref = pointer !== undefined ? sourceRef(sourceMap, pointer) : undefined
    return ref ? { kind: "implicit", rule, ref } : { kind: "implicit", rule }
  }

  // Policy rules.
  ir.review.forEach((rule, i) => {
    if (!rule.conditions.every((c) => evaluateCondition(c, input))) return
    nominate(rule.tier, `The policy's ${rule.tier} rule matched.`, policy(`/review/${i}`, `${rule.tier} when ...`))
  })
  if (nominations.length === 0) nominate("review", "No review rule matched, so the change needs review.", implicit("no-rule-matched"))

  // Evidence.
  for (const c of evidence.checks) {
    if (c.advisory) continue
    // Tests that fail on the base too were broken before the change: a person looks, but the change isn't blocked for them.
    if (c.status === "failed" && c.failedBefore) nominate("review", `${c.check} failed${c.reason ? `: ${c.reason}` : "."}`, implicit("failing-on-base", c.pointer))
    else if (c.status === "failed") nominate("review", `${c.check} failed${c.reason ? `: ${c.reason}` : "."}`, implicit("gate-failed", c.pointer), true)
    if (c.status === "not-executed" || c.status === "errored") {
      nominate("review", `${c.check} ${c.status === "errored" ? "errored" : "was not executed"}${c.reason ? `: ${c.reason}` : "."}`, implicit("missing-evidence", c.pointer))
    }
    if (c.status === "passed" && c.flaky && c.flaky.length > 0) {
      nominate("review", `${c.check} passed only because ${c.flaky.length === 1 ? "a failing test" : "failing tests"} passed when run again: ${c.flaky.slice(0, 5).join(", ")}${c.flaky.length > 5 ? ", ..." : ""}. Flaky tests hide real failures.`, implicit("flaky-test", c.pointer))
    }
  }
  for (const v of evidence.newViolations) nominate("review", `New ${v.ruleId} finding from ${v.check}${where(v)}: ${v.message}`, implicit("new-violation"), true)
  for (const r of evidence.regressions) {
    nominate("review", `${r.metric}${r.file ? ` for ${r.file}` : ""} dropped below the baseline (${r.base} to ${r.head}).`, implicit("ratchet-regression"), true)
  }

  // Integrity.
  for (const f of evidence.integrity.findings) {
    if (f.kind === "flag") nominate("review", `${f.message}${where(f)}`, implicit("integrity-flag"))
    else nominate("review", `${f.message}${where(f)}`, implicit(f.kind === "forbid" ? "integrity-forbid" : "ratchet-regression"), true)
  }
  for (const check of evidence.integrity.notExecuted) {
    nominate("review", `The integrity check '${check.replaceAll("-", " ")}' was not executed.`, implicit("integrity-not-executed"))
  }

  // Protected changes. New tests in a `tests` group run and need no review on their own.
  const groupPointer = (group: string) => {
    const i = ir.protect.findIndex((g) => g.group === group)
    return i >= 0 ? `/protect/${i}` : undefined
  }
  for (const p of facts.protectedTouched) {
    if (p.action === "kept") continue
    if (p.kind === "gauntlet") {
      nominate("owner", `${p.path} is under .gauntlet/; policy, baseline and self-test changes need an owner.`, implicit("gauntlet-changed"))
    } else {
      nominate("review", p.action === "edited"
        ? `${p.path} is a protected test (${p.group}) the change ${p.change === "deleted" ? "deletes" : "edits"}; it runs as the change has it and needs review.`
        : `${p.path} is protected (${p.group}); the change is ${p.action === "restored" ? "undone for the run" : "left out of the run"} and needs review.`,
        implicit("protected-changed", groupPointer(p.group)))
    }
  }

  if (evidence.blocked) nominate("review", `The agent reported it was blocked: ${evidence.blocked.reason}`, implicit("reported-blocked"))

  // Caution: one step above the deterministic decision, never more and never below it.
  const deterministic = nominations.reduce<Tier>((t, n) => (rank(n.tier) > rank(t) ? n.tier : t), "auto")
  const raising = evidence.caution.filter((s) => s.raise)
  if (raising.length > 0) {
    nominate(stepUp(deterministic), `${raising.length} caution signal${raising.length === 1 ? "" : "s"} (${[...new Set(raising.map((s) => s.source))].sort().join(", ")}) raised the tier one step.`,
      implicit("caution"))
  }

  const tier = nominations.reduce<Tier>((t, n) => (rank(n.tier) > rank(t) ? n.tier : t), "auto")
  const wouldBlock = nominations.some((n) => n.blocking)
  const owners = [
    ...facts.zonesTouched.flatMap((z) => z.owners),
    ...(facts.gauntletChanged ? ir.owners : []),
  ]
  const key = (n: Nomination) => `${String(9 - rank(n.tier))}\0${n.source.kind}\0${n.source.kind === "policy" ? n.source.pointer : n.source.rule}\0${n.reason}`
  return {
    tier,
    nominations: nominations.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)),
    owners: [...new Set(owners)].sort(),
    wouldBlock,
    blocking: wouldBlock && input.mode === "enforce",
    mode: input.mode,
  }
}
