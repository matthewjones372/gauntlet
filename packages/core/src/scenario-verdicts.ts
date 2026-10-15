import { namesScenario, type Scenario } from "@gauntlet/dsl"
import type { Mutant } from "./mutants.ts"
import { type SurveyedTest, testsNothingWhy } from "./test-value.ts"

// Spec 0012 §3-§6: each scenario's verdict, from evidence the check already
// has. A test is bound to a scenario when the scenario's id is a word in its
// name, as the runner reports it, and the mutation tool's killers are matched
// the same way. Nothing here is inferred: a tool that doesn't name killers
// leaves the scenario `passing`, never `proven`.

export type ScenarioVerdict = "unbound" | "not-run" | "failing" | "vacuous" | "unchallenged" | "proven" | "unaffected" | "passing"

/** The verdicts that block under \`scenarios\` (and only report under \`scenarios advise\`). */
export const BLOCKING_VERDICTS: ReadonlySet<ScenarioVerdict> = new Set(["unbound", "not-run", "failing", "vacuous"])

/** How a bound test fared. */
export type BoundStatus = "passed" | "failed" | "skipped" | "not-run" | "left-out"

export interface BoundTest {
  /** The id as the runner reports it, or the test's name in its source when it didn't run. */
  readonly id: string
  readonly status: BoundStatus
  /** A holdout test: shown by id only (spec 0012 §7). */
  readonly holdout?: true
  /** Where it's written, when a pack read the test's source. */
  readonly path?: string
  readonly line?: number
  readonly assertions?: number
  /** Why it can't fail on a wrong result, when it can't. */
  readonly vacuous?: string
}

/** A mutant on a changed line, as a scenario's tests met it. */
export interface MutantEvidence {
  readonly path: string
  readonly line: number
  readonly method?: string
  readonly description?: string
  /** A bound test that killed it, and what that test said. */
  readonly killedBy?: string
  readonly message?: string
}

export interface ScenarioResult {
  readonly id: string
  readonly name: string
  readonly file: string
  readonly line: number
  readonly verdict: ScenarioVerdict
  /** Background, steps and examples as written, for the report. */
  readonly text: ReadonlyArray<string>
  readonly tests: ReadonlyArray<BoundTest>
  /**
   * What the mutation gate says about the scenario's tests on this change: "reported" with the
   * mutants they killed and reached, or why there's nothing to say.
   */
  readonly killers: "reported" | "not-reported" | "not-run" | "not-in-policy"
  readonly killed: ReadonlyArray<MutantEvidence>
  /** Mutants on changed lines a bound test reached and none killed. */
  readonly reachedOnly: ReadonlyArray<MutantEvidence>
  /** Every bound test that ran is a holdout's. */
  readonly holdout?: true
}

/** A function the change touched where no scenario's test killed or reached a mutant (spec 0012 §5). */
export interface NoScenario {
  readonly function: string
  readonly path: string
  readonly line: number
  readonly mutants: number
}

export interface ScenarioJudgement {
  readonly scenarios: ReadonlyArray<ScenarioResult>
  readonly noScenario: ReadonlyArray<NoScenario>
  readonly mutation: ScenarioResult["killers"]
}

/** A test that ran, as the suites reported it. */
export interface RanTest {
  readonly id: string
  readonly status: "passed" | "failed" | "skipped"
  readonly holdout?: true
}

export interface ScenarioEvidence {
  readonly scenarios: ReadonlyArray<Scenario>
  /** Every test the suites and holdouts reported. */
  readonly ran: ReadonlyArray<RanTest>
  /** Test names known not to have run here: the base's test ids, and tests read from the sources. */
  readonly known: ReadonlyArray<string>
  /** The base's tests that \`affected\` selection left out (spec 0013): they didn't need to run. */
  readonly leftOut: ReadonlyArray<string>
  /** Tests read from their source, for where each is and whether it can fail. */
  readonly surveyed: ReadonlyArray<{ readonly path: string; readonly test: SurveyedTest; readonly helpers: ReadonlySet<string> }>
  /** The mutation gate: not in the policy, didn't run, or its mutants. */
  readonly mutation: { readonly state: "not-in-policy" | "not-run" } | { readonly state: "ran"; readonly mutants: ReadonlyArray<Mutant> }
  /** The lines the change added or edited, per file. */
  readonly changedLines: ReadonlyMap<string, ReadonlySet<number>>
  /**
   * Scenario ids named in the files of a holdout that didn't run here (spec 0012 §7), by
   * holdout: only the evidence job runs holdouts, so elsewhere their tests are pending.
   */
  readonly pendingHoldouts?: ReadonlyMap<string, ReadonlyArray<string>>
}

const onChangedLine = (lines: ReadonlyMap<string, ReadonlySet<number>>, m: Mutant): boolean => {
  const at = m.path === undefined ? undefined : lines.get(m.path)
  if (at === undefined) return false
  for (let n = m.line; n <= (m.endLine ?? m.line); n++) if (at.has(n)) return true
  return false
}

/** A runner's id without its call parentheses: \`FX-003 converts()\` is \`FX-003 converts\`. */
const bare = (id: string) => id.replace(/\([^()]*\)$/, "")

/** Whether a surveyed test is the one a runner reports under \`id\`: its name ends the id, and its class or describe is in it. */
const isSurveyed = (id: string, t: SurveyedTest): boolean => {
  const name = bare(id)
  // Kotlin writes a test named in words between backticks.
  const own = t.name.replace(/^`(.*)`$/, "$1")
  const ends = name === own || [".", " ", "/", ":", ">"].some((sep) => name.endsWith(`${sep}${own}`))
  return ends && (t.scope === "" || name.includes(t.scope))
}

const evidence = (m: Mutant, killedBy?: string): MutantEvidence => ({
  path: m.path!,
  line: m.line,
  ...(m.method !== undefined ? { method: m.method } : {}),
  ...(m.description !== undefined ? { description: m.description } : {}),
  ...(killedBy !== undefined ? { killedBy } : {}),
  ...(killedBy !== undefined && m.killMessage !== undefined ? { message: m.killMessage.split("\n")[0]!.trim() } : {}),
})

const stepText = (s: Scenario): string[] => [
  ...s.background.flatMap((st) => [`${st.keyword} ${st.text}`, ...(st.argument ?? []).map((a) => `  ${a}`)]),
  ...s.steps.flatMap((st) => [`${st.keyword} ${st.text}`, ...(st.argument ?? []).map((a) => `  ${a}`)]),
  ...(s.examples ?? []).flatMap((table) => ["", "Examples:", ...table.map((row) => `  ${row}`)]),
]

/** Each scenario's verdict, first match wins (spec 0012 §4), and the changed code no scenario's test catches (§5). */
export const judgeScenarios = (e: ScenarioEvidence): ScenarioJudgement => {
  const changed = e.mutation.state === "ran" ? e.mutation.mutants.filter((m) => m.path !== undefined && onChangedLine(e.changedLines, m)) : []
  const all = e.mutation.state === "ran" ? e.mutation.mutants : []
  // A tool names killers when any of its mutants carries them; none means it doesn't (spec 0012 §6).
  const killers: ScenarioResult["killers"] = e.mutation.state !== "ran" ? e.mutation.state : all.some((m) => m.killedBy !== undefined) || all.length === 0 ? "reported" : "not-reported"
  const leftOut = new Set(e.leftOut)

  const scenarios = e.scenarios.map((s): ScenarioResult => {
    const binds = (name: string) => namesScenario(name, s.id)
    const surveyFor = (id: string) => e.surveyed.find((x) => binds(x.test.name) && isSurveyed(id, x.test))
    const ran = e.ran.filter((t) => binds(t.id)).map((t): BoundTest => {
      const found = surveyFor(t.id)
      const why = found ? testsNothingWhy(found.test, found.helpers) : undefined
      return {
        id: t.id,
        status: t.status,
        ...(t.holdout ? { holdout: true as const } : {}),
        // Holdouts are shown by id only (spec 0003, 0012 §7).
        ...(found && !t.holdout ? { path: found.path, line: found.test.line, assertions: found.test.assertions } : {}),
        ...(why !== undefined && !t.holdout ? { vacuous: why } : {}),
      }
    })
    const reported = new Set(ran.map((t) => bare(t.id)))
    // Bound tests that exist but didn't run here: the base's, or ones read from the sources.
    const absent = [...new Set(e.known.filter(binds))].filter((name) => !reported.has(bare(name)))
      .map((name): BoundTest => ({ id: name, status: leftOut.has(name) ? "left-out" : "not-run" }))
    const sourced = e.surveyed.filter((x) => binds(x.test.name) && ![...ran, ...absent].some((t) => isSurveyed(t.id, x.test)))
      .map((x): BoundTest => ({ id: x.test.name, status: "not-run", path: x.path, line: x.test.line, assertions: x.test.assertions }))
    const tests = [...ran, ...absent, ...sourced].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    const executed = ran.filter((t) => t.status === "passed" || t.status === "failed")

    const boundKiller = (m: Mutant) => m.killedBy?.find(binds)
    const reaches = (m: Mutant) => [...(m.coveredBy ?? []), ...(m.killedBy ?? [])].some(binds)
    const killed = changed.flatMap((m) => {
      const by = boundKiller(m)
      return by !== undefined ? [evidence(m, by)] : []
    })
    const reachedOnly = changed.filter((m) => boundKiller(m) === undefined && reaches(m)).map((m) => evidence(m))
    const result = (verdict: ScenarioVerdict, extra: { holdout?: true } = {}): ScenarioResult => ({
      id: s.id, name: s.name, file: s.file, line: s.line, verdict, text: stepText(s), tests, killers, killed, reachedOnly, ...extra,
    })

    // A holdout that didn't run here names the id: pending, and it's the holdout check that's missing evidence.
    const pending = [...(e.pendingHoldouts ?? [])].filter(([, ids]) => ids.includes(s.id)).map(([name]) => name)
    if (executed.length === 0 && pending.length > 0) {
      return { ...result("passing", { holdout: true }), tests: [...tests, ...pending.map((name): BoundTest => ({ id: `holdout ${name}`, status: "not-run", holdout: true }))] }
    }
    if (tests.length === 0) return result("unbound")
    if (executed.length === 0) return result(tests.every((t) => t.status === "left-out") ? "unaffected" : "not-run")
    if (executed.some((t) => t.status === "failed")) return result("failing")
    const visible = executed.filter((t) => !t.holdout)
    if (visible.length > 0 && visible.every((t) => t.vacuous !== undefined)) return result("vacuous")
    // Holdout tests aren't mutated (spec 0012 §7).
    if (visible.length === 0) return result("passing", { holdout: true })
    if (killers !== "reported") return result("passing")
    if (killed.length > 0) return result("proven")
    if (reachedOnly.length > 0) return result("unchallenged")
    return result("unaffected")
  })

  // §5: a changed function none of whose changed-line mutants a scenario's test killed. Not claimed without killers.
  const bound = (name: string) => e.scenarios.some((s) => namesScenario(name, s.id))
  const byFunction = new Map<string, Mutant[]>()
  if (killers === "reported") {
    for (const m of changed) {
      const key = m.method ?? m.path!
      byFunction.set(key, [...(byFunction.get(key) ?? []), m])
    }
  }
  // A scenario whose tests reach the function stated an intent for it: that's an unchallenged scenario, not code without one.
  const noScenario = [...byFunction].filter(([, ms]) => !ms.some((m) => [...(m.killedBy ?? []), ...(m.coveredBy ?? [])].some(bound)))
    .map(([fn, ms]): NoScenario => {
      const first = [...ms].sort((a, b) => (a.path! < b.path! ? -1 : a.path! > b.path! ? 1 : a.line - b.line))[0]!
      return { function: fn, path: first.path!, line: first.line, mutants: ms.length }
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line))

  return { scenarios, noScenario, mutation: killers }
}

/** How a check run says what the verdicts were: one line. */
export const describeVerdicts = (j: ScenarioJudgement): string => {
  const count = (v: ScenarioVerdict) => j.scenarios.filter((s) => s.verdict === v).length
  const blocking = j.scenarios.filter((s) => BLOCKING_VERDICTS.has(s.verdict))
  const parts = [
    ...(blocking.length > 0 ? [`${blocking.map((s) => `${s.id} ${s.verdict}`).join(", ")}`] : []),
    ...(["unchallenged", "proven", "passing", "unaffected"] as const).flatMap((v) => (count(v) > 0 ? [`${count(v)} ${v}`] : [])),
    ...(j.noScenario.length > 0 ? [`changed code with no scenario: ${j.noScenario.length} function${j.noScenario.length === 1 ? "" : "s"}`] : []),
  ]
  return `${j.scenarios.length} scenario${j.scenarios.length === 1 ? "" : "s"}: ${parts.join("; ")}`
}

/** Rule ids of the scenarios check's findings. */
export const SCENARIO_RULES = { unchallenged: "scenarios/unchallenged", noScenario: "scenarios/no-scenario", verdict: "scenarios/verdict" } as const

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`

/**
 * The findings that never block on their own: an unchallenged scenario, and
 * changed code with no scenario (spec 0012 §4, §5). Under \`scenarios advise\`,
 * the verdicts that would block are findings too.
 */
export const scenarioAdvice = (j: ScenarioJudgement, advise: boolean) => [
  ...j.scenarios.filter((s) => s.verdict === "unchallenged").map((s) => ({
    check: "scenarios",
    ruleId: SCENARIO_RULES.unchallenged,
    message: `Scenario @${s.id} (${s.name}): its tests reach ${plural(s.reachedOnly.length, "mutant")} on the changed lines and kill none.`,
    path: s.reachedOnly[0]!.path,
    line: s.reachedOnly[0]!.line,
  })),
  ...j.noScenario.map((n) => ({
    check: "scenarios",
    ruleId: SCENARIO_RULES.noScenario,
    message: `${n.function}: changed code with no scenario; no scenario's test kills any of its ${plural(n.mutants, "mutant")} on the changed lines.`,
    path: n.path,
    line: n.line,
  })),
  ...(advise ? j.scenarios.filter((s) => BLOCKING_VERDICTS.has(s.verdict)) : []).map((s) => ({
    check: "scenarios",
    ruleId: SCENARIO_RULES.verdict,
    message: `Scenario @${s.id} (${s.name}) is ${s.verdict}.`,
    path: s.file,
    line: s.line,
  })),
]
