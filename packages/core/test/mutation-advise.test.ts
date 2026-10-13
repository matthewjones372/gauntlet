import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { irHash } from "@gauntlet/ir"
import { emptyBaseline } from "@gauntlet/sarif"
import { Effect, Layer, Option } from "effect"
import { jvm } from "../../dsl/test/fixtures/catalog.ts"
import {
  agentSummary, annotationsOf, buildReport, decide, explainPolicy, type GateRun, githubStatus, MAX_ANNOTATIONS, type Mutant, mutationGateRun, type Pack,
  type PreparedWorkspace, ProcessRunnerLive, renderAgentSummary, renderMarkdown, type Report, runGates,
} from "../src/index.ts"
import { cleanEvidence, compiled, noFacts } from "./fixtures.ts"

// Spec 0011 §3: each mutant that survives on a changed line is a finding on that
// line, in the report, the agent's summary and the pull request's annotations.
// `advise` reports them and blocks nothing; a threshold still blocks below it.

const workspace: PreparedWorkspace = {
  dir: "/checkout", base: "b", head: "h", materialised: [],
  outputDir: (check) => Effect.succeed(`/out/${check}`),
  collect: () => Effect.succeed([{ path: "mutations.xml", content: "<mutations/>" }]),
}

const text = (gates: string) => `gauntlet "x"\nuse jvm\nmode enforce\nowners @p\ngates { ${gates} }\nreview { auto when all gates pass }\n`

const facts = noFacts({
  files: [{ path: "src/A.kt", status: "modified", added: 2, removed: 0 }],
  linesChanged: 2,
  addedLines: new Map([["src/A.kt", [{ line: 3, text: "  if (x > 0) pay()" }, { line: 4, text: "  log()" }]]]),
})

const mutants: Mutant[] = [
  { path: "src/A.kt", line: 3, killed: true, message: "killed" },
  { path: "src/A.kt", line: 3, killed: false, message: "No test kills a conditional-boundary mutant" },
  { path: "src/A.kt", line: 20, killed: false, message: "No test kills a mutant far from the change" },
]

const pack: Pack = {
  spec: jvm, runnerConfig: [], manifests: [], detectors: [],
  gates: { mutation: (_check, ctx) => Effect.sync((): GateRun => ({ command: ["pitest"], exitCode: 0, ...mutationGateRun("pitest", mutants, ctx) })) },
}

const survivor = { check: "mutation", ruleId: "mutation/survived", message: "No test kills a conditional-boundary mutant", path: "src/A.kt", line: 3 }

/** Runs the gates, decides and builds the report, as `gauntlet check` does. */
const judge = async (gates: string) => {
  const policy = compiled(text(gates))
  const out = await Effect.runPromise(
    runGates({ ir: policy.ir, facts, workspace, packs: [pack], baseline: Option.none(), renames: new Map(), files: ["src/A.kt"] })
      .pipe(Effect.provide(Layer.mergeAll(ProcessRunnerLive.pipe(Layer.provide(BunServices.layer)), BunServices.layer))),
  )
  const evidence = cleanEvidence({ checks: out.checks, newViolations: out.newViolations, regressions: out.regressions })
  const decision = decide({ ...policy, facts, evidence, mode: "enforce" })
  const report = buildReport({
    gauntletVersion: "0.1.0",
    policy: { ...policy, irHash: irHash(policy.ir), origin: "base", firstAdoption: false, drift: [], notes: [] },
    facts, checks: out.checks, ratchets: out.ratchets, integrity: evidence.integrity, violations: out.newViolations, advice: out.advice, imports: [], decision,
  })
  return { out, report }
}

describe("mutation advise on changed", () => {
  test("compiles to a gate that advises, and explain says it never blocks", () => {
    const { ir } = compiled(text("verify { mutation advise on changed }"))
    expect(ir.gates[0]!.checks).toEqual([{ kind: "gate", name: "mutation", ratchet: false, advise: true, scope: "changed" }])
    expect(explainPolicy(ir, "gates")).toContain("mutation on changed code (findings reported, never blocking)")
  })

  test("a policy without advise compiles as before", () => {
    const { ir } = compiled(text("verify { mutation >= 60% on changed }"))
    expect(ir.gates[0]!.checks[0]).not.toHaveProperty("advise")
  })

  test("a survivor on a changed line is a finding, and the change isn't blocked", async () => {
    const { out, report } = await judge("verify { mutation advise on changed }")
    expect(out.checks.map((c) => [c.status, c.advisory, c.reason])).toEqual([["passed", true, "1 mutant on the changed lines survives, reported without blocking"]])
    // Line 20's survivor is outside the change.
    expect(out.advice).toEqual([survivor])
    expect(out.newViolations).toEqual([])
    expect(report.decision.wouldBlock).toBe(false)
    expect(report.decision.tier).toBe("auto")
    expect(report.advice).toEqual([survivor])
  })

  test("the report, the agent's summary and the check's annotations name it", async () => {
    const { report } = await judge("verify { mutation advise on changed }")
    const md = renderMarkdown(report)
    expect(md).toContain("### Advisory findings")
    expect(md).toContain("| mutation | `mutation/survived` | `src/A.kt:3` | No test kills a conditional-boundary mutant |")
    const summary = agentSummary(report, "/out")
    expect(summary.advice).toEqual(["src/A.kt:3: No test kills a conditional-boundary mutant (mutation)"])
    expect(renderAgentSummary(summary)).toContain("- src/A.kt:3: No test kills a conditional-boundary mutant (mutation)")
    expect(githubStatus(report, [], {}, []).annotations).toEqual([
      { path: "src/A.kt", start_line: 3, end_line: 3, annotation_level: "warning", title: "mutation: mutation/survived", message: "No test kills a conditional-boundary mutant" },
    ])
  })

  test("a threshold still blocks below it, and lists the survivors", async () => {
    const { out, report } = await judge("verify { mutation >= 60% on changed }")
    expect(out.checks.map((c) => [c.status, c.advisory])).toEqual([["failed", false]])
    expect(report.decision.wouldBlock).toBe(true)
    expect(out.advice).toEqual([survivor])
    expect(renderAgentSummary(agentSummary(report, "/out"))).toContain("- src/A.kt:3: No test kills a conditional-boundary mutant (mutation)")
  })

  test("a ratchet's new survivors block as new findings, not as advice", async () => {
    const policy = compiled(text("verify { mutation ratchet on changed }"))
    const out = await Effect.runPromise(
      runGates({ ir: policy.ir, facts, workspace, packs: [pack], baseline: Option.some(emptyBaseline("c", "h", "0")), renames: new Map(), files: ["src/A.kt"] })
        .pipe(Effect.provide(Layer.mergeAll(ProcessRunnerLive.pipe(Layer.provide(BunServices.layer)), BunServices.layer))),
    )
    expect(out.newViolations).toEqual([survivor])
    expect(out.advice).toEqual([])
  })
})

describe("annotations", () => {
  const finding = (i: number) => ({ check: "mutation", ruleId: "mutation/survived", message: `survivor ${i}`, path: "src/A.kt", line: i + 1 })
  const report = (over: Partial<Report>): Report => ({
    policy: { irHash: "ir", headSha: "h".repeat(40), owners: [] },
    decision: { tier: "auto", mode: "enforce", blocking: false, wouldBlock: false, owners: [], nominations: [], overrides: [] },
    violations: [],
    ...over,
  }) as unknown as Report

  test("new findings are failures, advice is warnings, and findings with no line are left out", () => {
    const r = report({
      violations: [{ check: "lint", ruleId: "detekt/MagicNumber", message: "magic", path: "src/B.kt", line: 7 }],
      advice: [finding(0), { check: "mutation", ruleId: "mutation/survived", message: "somewhere" }],
    })
    expect(annotationsOf(r).map((a) => [a.path, a.start_line, a.annotation_level])).toEqual([["src/B.kt", 7, "failure"], ["src/A.kt", 1, "warning"]])
  })

  test("at most GitHub's 50 per request, blocking findings kept first, and the summary says how many more", () => {
    const r = report({
      advice: Array.from({ length: 60 }, (_, i) => finding(i)),
      violations: [{ check: "lint", ruleId: "detekt/MagicNumber", message: "magic", path: "src/B.kt", line: 7 }],
    })
    const s = githubStatus(r, [], {}, [])
    expect(s.annotations).toHaveLength(MAX_ANNOTATIONS)
    expect(s.annotations[0]!.annotation_level).toBe("failure")
    expect(s.summary).toContain("The diff shows the first 50 of 61 findings; the report lists them all.")
  })

  test("a report with no findings has none", () => {
    expect(githubStatus(report({}), [], {}, []).annotations).toEqual([])
  })
})
