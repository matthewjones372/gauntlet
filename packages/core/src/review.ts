import { type Condition, type Mode, type PolicyIR, type SourceMap, type SourceRef, sourceRef, type Tier, TIER_ORDER } from "@gauntlet/ir"
import { loweredReason } from "./baseline-pr.ts"
import type { DiffFacts } from "./diff-facts.ts"
import { globMatches } from "@gauntlet/dsl"
import { type IntegrityFinding, type IntegrityResult, testPathMatcher } from "./integrity.ts"
import { blankOrLineComment, isDocumentation } from "./no-behaviour.ts"

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
  /** Why the base isn't the baseline's value as recorded, or what the drop may come from (spec 0017 §3). */
  readonly note?: string
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
  /** What a change that only replaces the baseline lowers (spec 0015): an owner accepts it. */
  readonly baselineLowered?: ReadonlyArray<Regression>
  /** Protected paths the change touches that the owner let the agent change (spec 0015). */
  readonly granted?: ReadonlyArray<GrantedChange>
}

/** A protected path a change touches under the owner's grant. */
export interface GrantedChange {
  readonly path: string
  readonly group: string
  readonly pr: number
  readonly approver: string
  readonly reason: string
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
  | "baseline-lowered"
  | "granted"
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

/**
 * Whether the change only adds or edits tests: it changes at least one file, and
 * every changed path (both sides of a rename) is a test by the policy's own
 * reckoning (a \`suites\` glob or a \`tests\` protect group, as the integrity
 * checks read it), is not deleted, and is not also protected as something else
 * (fixtures, config, runner configuration, \`.gauntlet/\`). Documentation is not a
 * test. An edited protected test still nominates review on its own.
 */
export const onlyTestsChanged = (facts: DiffFacts, ir: PolicyIR): boolean => {
  const isTest = testPathMatcher(ir)
  const otherProtected = ir.protect.filter((g) => g.kind !== "tests").flatMap((g) => g.globs)
  const notTests = new Set(facts.protectedTouched.filter((p) => p.kind !== "tests").map((p) => p.path))
  const test = (path: string) => isTest(path) && !notTests.has(path) && !otherProtected.some((g) => globMatches(g, path))
  return facts.files.length > 0 &&
    !facts.gauntletChanged &&
    facts.dependencyChanges.length === 0 &&
    facts.files.every((f) => f.status !== "deleted" && test(f.path) && (f.oldPath === undefined || test(f.oldPath)))
}

/**
 * Whether the change only removes main code and removes no test (spec 0017 §2),
 * strict enough that \`auto when code removed and ...\` can't let new behaviour
 * through. It holds when at least one file of main code (anything that isn't a
 * test or documentation) is deleted or loses lines, and every changed file is:
 *
 * - main code that is deleted, or modified to lose lines while every line it
 *   gains is blank or a whole-line comment (not one tools act on);
 * - a test that is added or only gains lines (removing no test);
 * - documentation, changed in any way.
 *
 * It doesn't hold for an added or renamed file of main code, a file
 * that changes without losing a line (a binary file, a mode change), a deleted,
 * renamed or shortened test, an added dependency, a change under
 * \`.gauntlet/\`, or any \`deleted-tests\` finding (a test that ran at base and no
 * longer runs). Deleting only comments counts as removing code: it adds nothing.
 */
export const codeRemoved = (facts: DiffFacts, ir: PolicyIR, integrity: IntegrityResult): boolean => {
  const isTest = testPathMatcher(ir)
  let removes = false
  const fileOk = (f: DiffFacts["files"][number]): boolean => {
    const paths = f.oldPath !== undefined ? [f.path, f.oldPath] : [f.path]
    if (paths.every(isDocumentation)) return true
    if (paths.some(isTest)) return (f.status === "added" || f.status === "modified") && f.removed === 0
    if (f.status === "deleted") {
      removes = true
      return true
    }
    if (f.status !== "modified" || f.removed === 0) return false
    const added = facts.addedLines.get(f.path) ?? []
    if (added.length !== f.added || !added.every((l) => blankOrLineComment(f.path, l.text))) return false
    removes = true
    return true
  }
  return facts.files.length > 0 &&
    !facts.gauntletChanged &&
    !facts.dependencyChanges.some((d) => d.unparsed || d.added.length > 0) &&
    !integrity.findings.some((f) => f.check === "deleted-tests") &&
    facts.files.every(fileOk) &&
    removes
}

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
    case "only-tests-changed":
      return onlyTestsChanged(facts, ir)
    case "code-removed":
      return codeRemoved(facts, ir, evidence.integrity)
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
    nominate("review", `${r.metric}${r.file ? ` for ${r.file}` : ""} dropped below the baseline (${r.base} to ${r.head}).${r.note ? ` ${r.note.charAt(0).toUpperCase()}${r.note.slice(1)}.` : ""}`, implicit("ratchet-regression"), true)
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

  // A lower bar is the owner's to accept: the change is judged against it, and says so.
  if (evidence.baselineLowered !== undefined && evidence.baselineLowered.length > 0) nominate("owner", loweredReason(evidence.baselineLowered), implicit("baseline-lowered"))

  // A granted change is still the owner's to accept: it's reviewed, not hidden.
  for (const g of evidence.granted ?? []) {
    nominate("owner", `${g.path} is protected (${g.group}); ${g.approver} granted the agent changing it in #${g.pr}: ${g.reason}`, implicit("granted", groupPointer(g.group)))
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
