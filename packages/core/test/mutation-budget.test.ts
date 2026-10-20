import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { irHash } from "@gauntlet/ir"
import { Effect, Layer, Option } from "effect"
import { jvm } from "../../dsl/test/fixtures/catalog.ts"
import {
  agentSummary, buildReport, decide, type DiffFacts, estimateMutants, executable, explainPolicy, type GateContext, type GateRun, gateTimings, type Mutant, MUTANTS_PER_LINE,
  mutationGateRun, type Pack, type PreparedWorkspace, ProcessRunnerLive, renderMarkdown, runGates, sampleLines, SPLIT_RULE, suggestStack, timingLine, timingSection,
} from "../src/index.ts"
import { cleanEvidence, compiled, noFacts } from "./fixtures.ts"

// Spec 0020: a mutation gate scoped to the change takes a budget in mutants,
// estimated from the diff before anything runs. Over it, a blocking gate isn't
// run and says how to split the change; an `advise` gate runs on a sample of the
// changed lines that the head commit picks.

const workspace: PreparedWorkspace = {
  dir: "/checkout", base: "b", head: "h", materialised: [],
  outputDir: (check) => Effect.succeed(`/out/${check}`),
  collect: () => Effect.succeed([{ path: "mutations.xml", content: "<mutations/>" }]),
}

const text = (gates: string) =>
  `gauntlet "x"\nuse jvm\nmode enforce\nowners @p\nprotect { tests "**/test/**" }\ngates { ${gates} }\nreview { auto when all gates pass }\n`

/** A changed file whose lines 1..n are each one executable statement. */
const code = (path: string, n: number) => ({
  file: { path, status: "modified" as const, added: n, removed: 0 },
  lines: Array.from({ length: n }, (_, i) => ({ line: i + 1, text: `  total = total + ${i}` })),
})
const factsOf = (files: ReadonlyArray<ReturnType<typeof code>>, head = "0123abcd"): DiffFacts =>
  noFacts({
    head,
    files: files.map((f) => f.file),
    linesChanged: files.reduce((n, f) => n + f.file.added, 0),
    addedLines: new Map(files.map((f) => [f.file.path, f.lines])),
  })

/** A mutation gate with one mutant on each changed line it's given, the first of each file surviving; it keeps what it was given. */
const recordingPack = () => {
  const seen: GateContext[] = []
  const pack: Pack = {
    spec: jvm, runnerConfig: [], manifests: [], detectors: [],
    gates: {
      mutation: (_check, ctx) =>
        Effect.sync((): GateRun => {
          seen.push(ctx)
          const mutants: Mutant[] = [...ctx.facts.addedLines].flatMap(([path, lines]) =>
            lines.map((l, i) => ({ path, line: l.line, killed: i !== 0, message: `survivor in ${path}` })))
          return { command: ["pitest"], exitCode: 0, ...mutationGateRun("pitest", mutants, ctx) }
        }),
    },
  }
  return { pack, seen }
}

const judge = async (gates: string, facts: DiffFacts, options: { readonly advisedMutation?: "skip" | "only" } = {}) => {
  const policy = compiled(text(gates))
  const { pack, seen } = recordingPack()
  const out = await Effect.runPromise(
    runGates({ ir: policy.ir, facts, workspace, packs: [pack], baseline: Option.none(), renames: new Map(), files: facts.files.map((f) => f.path), ...options })
      .pipe(Effect.provide(Layer.mergeAll(ProcessRunnerLive.pipe(Layer.provide(BunServices.layer)), BunServices.layer))),
  )
  const evidence = cleanEvidence({ checks: out.checks, newViolations: out.newViolations, regressions: out.regressions })
  const decision = decide({ ...policy, facts, evidence, mode: "enforce" })
  const report = buildReport({
    gauntletVersion: "0.1.0",
    policy: { ...policy, irHash: irHash(policy.ir), origin: "base", firstAdoption: false, drift: [], notes: [] },
    facts, checks: out.checks, ratchets: out.ratchets, integrity: evidence.integrity, violations: out.newViolations, advice: out.advice, imports: [], decision,
  })
  return { out, report, seen, ir: policy.ir }
}

describe("the estimate", () => {
  test("counts executable changed lines twice, and skips blanks, comments, brackets and imports", () => {
    expect(["", "  // a note", " * more", "# py", "}", "  });", "import x.y", "package a.b", "use std::io;", "from a import b"].filter(executable)).toEqual([])
    expect(["if (x > 0) pay()", "return a + b", "val y = 2"].every(executable)).toBe(true)
    const facts = noFacts({
      files: [{ path: "src/A.kt", status: "modified", added: 4, removed: 0 }],
      addedLines: new Map([["src/A.kt", [{ line: 1, text: "import a.b" }, { line: 2, text: "" }, { line: 3, text: "if (x) pay()" }, { line: 4, text: "}" }]]]),
    })
    const { ir } = compiled(text("verify { mutation advise on changed max 10 mutants }"))
    const gate = ir.gates[0]!.checks[0]! as Extract<typeof ir.gates[0]["checks"][0], { kind: "gate" }>
    expect(estimateMutants(ir, facts, gate)).toEqual({ mutants: MUTANTS_PER_LINE, files: [{ path: "src/A.kt", lines: [3], mutants: MUTANTS_PER_LINE }] })
  })

  test("leaves out tests, documentation, build scripts, deleted files and files outside the gate's zone", () => {
    const facts = factsOf([code("src/main/A.kt", 3), code("src/test/ATest.kt", 5), code("README.md", 5), code("build.gradle.kts", 5), code("other/B.kt", 2)])
    const deleted: DiffFacts = { ...facts, files: [...facts.files, { path: "src/main/Gone.kt", status: "deleted", added: 0, removed: 9 }] }
    const zoned = compiled(`${text("verify { mutation advise on changed max 10 mutants in zone main }")}zone main { paths "src/main/**" owner @p }\n`).ir
    const gate = zoned.gates[0]!.checks[0]! as Extract<typeof zoned.gates[0]["checks"][0], { kind: "gate" }>
    expect(estimateMutants(zoned, deleted, gate).files.map((f) => f.path)).toEqual(["src/main/A.kt"])
  })
})

describe("over budget, a blocking gate", () => {
  const facts = factsOf([code("core/A.kt", 60), code("cli/B.kt", 40)])

  test("isn't run, says why, and adds a finding naming the split", async () => {
    const { out, report, seen } = await judge("verify { mutation >= 60% on changed max 150 mutants }", facts)
    expect(seen).toEqual([])
    expect(out.checks.map((c) => [c.status, c.advisory, c.reason])).toEqual([
      ["not-executed", false, "about 200 mutants on the changed lines, over the policy's budget of 150: split the change (see the suggested split)"],
    ])
    expect(out.advice).toEqual([{
      check: "mutation", ruleId: SPLIT_RULE,
      message: "About 200 mutants on the changed lines, over the policy's budget of 150. Split the change into pull requests of up to 150 each: 1. cli (about 80 mutants); 2. core (about 120 mutants).",
    }])
    // Missing evidence: never a pass, so a person looks.
    expect(report.decision.tier).toBe("review")
    expect(report.stack).toEqual({
      lines: 100,
      steps: [
        { title: "cli", files: ["cli/B.kt"], lines: 40, needsOwner: false, mutants: 80 },
        { title: "core", files: ["core/A.kt"], lines: 60, needsOwner: false, mutants: 120 },
      ],
      mutation: { estimate: 200, budget: 150 },
    })
    expect(renderMarkdown(report)).toContain("This change brings about 200 mutants to mutation testing, over the policy's budget of 150.")
    expect(agentSummary(report, "/out").stack?.map((s) => s.title)).toEqual(["cli", "core"])
  })

  test("within its budget runs as before, with no split", async () => {
    const { out, report, seen } = await judge("verify { mutation >= 60% on changed max 200 mutants }", facts)
    expect(seen).toHaveLength(1)
    expect(out.checks[0]!.status).toBe("passed")
    expect(out.advice.some((a) => a.ruleId === SPLIT_RULE)).toBe(false)
    expect(report.stack).toBeUndefined()
  })
})

describe("over budget, an advise gate samples", () => {
  const facts = factsOf([code("core/A.kt", 60), code("cli/B.kt", 40)])

  test("runs on the sampled lines only, and says what it sampled", async () => {
    const { out, seen } = await judge("verify { mutation advise on changed max 40 mutants }", facts)
    const ctx = seen[0]!
    const sampled = [...ctx.facts.addedLines].flatMap(([p, ls]) => ls.map((l) => `${p}:${l.line}`))
    expect(sampled).toHaveLength(40 / MUTANTS_PER_LINE)
    expect(ctx.scope).toEqual([...ctx.facts.addedLines.keys()])
    expect(sampleLines(estimateMutants(compiled(text("verify { mutation advise on changed max 40 mutants }")).ir, facts, { kind: "gate", name: "mutation", ratchet: false, advise: true, scope: "changed", max: 40 }), 40, facts.head))
      .toEqual(new Map([...ctx.facts.addedLines].map(([p, ls]) => [p, ls.map((l) => l.line)])))
    const survivors = ctx.facts.addedLines.size
    const check = out.checks[0]!
    expect([check.status, check.advisory]).toEqual(["passed", true])
    expect(check.reason).toBe(`sampled 20 of about 200 mutants (lines chosen by the head commit); ${survivors} mutant${survivors === 1 ? "" : "s"} on the changed lines survive${survivors === 1 ? "s" : ""}, reported without blocking`)
    expect(out.advice.filter((a) => a.ruleId === SPLIT_RULE)).toHaveLength(1)
  })

  test("the same head picks the same lines, and another head can pick others", () => {
    const { ir } = compiled(text("verify { mutation advise on changed max 40 mutants }"))
    const gate = { kind: "gate" as const, name: "mutation", ratchet: false, advise: true as const, scope: "changed" as const, max: 40 }
    const pick = (head: string) => [...sampleLines(estimateMutants(ir, facts, gate), 40, head)].map(([p, ls]) => `${p}:${ls.join(",")}`).join(" ")
    expect(pick("0123abcd")).toBe(pick("0123abcd"))
    const others = ["89abcdef", "fedcba98", "00000001", "deadbeef"].map(pick)
    expect(others.some((o) => o !== pick("0123abcd"))).toBe(true)
  })

  test("the sample is never empty, and holds every line when the budget covers them", () => {
    const small = factsOf([code("core/A.kt", 3)])
    const { ir } = compiled(text("verify { mutation advise on changed max 1 mutants }"))
    const gate = { kind: "gate" as const, name: "mutation", ratchet: false, advise: true as const, scope: "changed" as const, max: 1 }
    expect([...sampleLines(estimateMutants(ir, small, gate), 1, "h").values()].flat()).toHaveLength(1)
    expect([...sampleLines(estimateMutants(ir, small, gate), 100, "h").values()].flat().sort()).toEqual([1, 2, 3])
  })

  test("explain names the budget", () => {
    expect(explainPolicy(compiled(text("verify { mutation advise on changed max 40 mutants }")).ir, "gates")).toContain("mutation on changed code (at most 40 mutants a change) (findings reported, never blocking)")
  })
})

describe("the split for a mutation budget", () => {
  const over = (facts: DiffFacts, budget: number) => {
    const { ir } = compiled(text(`verify { mutation advise on changed max ${budget} mutants }`))
    const gate = { kind: "gate" as const, name: "mutation", ratchet: false, advise: true as const, scope: "changed" as const, max: budget }
    return suggestStack(ir, facts, { gate, budget, estimate: estimateMutants(ir, facts, gate) })!
  }

  test("joins consecutive parts while they stay within the budget, even for a small change", () => {
    const s = over(factsOf([code("a/A.kt", 10), code("b/B.kt", 10), code("c/C.kt", 10)]), 40)
    expect(s.steps.map((x) => [x.title, x.mutants])).toEqual([["a, b", 40], ["c", 20]])
    expect(s.mutation).toEqual({ estimate: 60, budget: 40 })
  })

  test("breaks a part over the budget into its files, its tests going with the first", () => {
    const s = over(factsOf([code("svc/A.kt", 15), code("svc/B.kt", 15), { ...code("svc/test/ATest.kt", 4) }]), 40)
    expect(s.steps.map((x) => [x.title, x.files, x.mutants])).toEqual([
      ["svc/A.kt", ["svc/A.kt", "svc/test/ATest.kt"], 30],
      ["svc/B.kt", ["svc/B.kt"], 30],
    ])
  })

  test("says when one file is over the budget on its own", async () => {
    const { out } = await judge("verify { mutation advise on changed max 40 mutants }", factsOf([code("svc/A.kt", 30), code("lib/B.kt", 5)]))
    expect(out.advice.find((a) => a.ruleId === SPLIT_RULE)!.message)
      .toBe("About 70 mutants on the changed lines, over the policy's budget of 40. Split the change into pull requests of up to 40 each: 1. lib (about 10 mutants); 2. svc (about 60 mutants, over the budget on its own).")
  })

  test("a change in one file has no stack to show, only the finding", async () => {
    const { report, out } = await judge("verify { mutation advise on changed max 40 mutants }", factsOf([code("svc/A.kt", 30)]))
    expect(report.stack).toBeUndefined()
    expect(out.advice.some((a) => a.ruleId === SPLIT_RULE)).toBe(true)
  })
})

describe("advise mutation beside the verdict (spec 0020 §6)", () => {
  const facts = factsOf([code("core/A.kt", 3)])
  const gates = "fast { lint } verify { mutation advise on changed }"
  const lintPack = (seen: string[]): Pack => ({
    spec: jvm, runnerConfig: [], manifests: [], detectors: [],
    gates: {
      lint: () => Effect.sync((): GateRun => (seen.push("lint"), { command: ["lint"], exitCode: 0, runs: [] })),
      mutation: (_c, ctx) => Effect.sync((): GateRun => (seen.push("mutation"), { command: ["pitest"], exitCode: 0, ...mutationGateRun("pitest", [], ctx) })),
    },
  })
  const run = async (advisedMutation: "skip" | "only") => {
    const seen: string[] = []
    const out = await Effect.runPromise(
      runGates({ ir: compiled(text(gates)).ir, facts, workspace, packs: [lintPack(seen)], baseline: Option.none(), renames: new Map(), files: ["core/A.kt"], advisedMutation })
        .pipe(Effect.provide(Layer.mergeAll(ProcessRunnerLive.pipe(Layer.provide(BunServices.layer)), BunServices.layer))),
    )
    return { seen, checks: out.checks.map((c) => [c.check, c.status, c.advisory]) }
  }

  test("skip runs the rest and records advise mutation as not executed, advisory", async () => {
    const r = await run("skip")
    expect(r.seen).toEqual(["lint"])
    expect(r.checks).toEqual([["lint", "passed", false], ["mutation", "not-executed", true]])
  })

  test("only runs advise mutation and nothing else", async () => {
    const r = await run("only")
    expect(r.seen).toEqual(["mutation"])
    expect(r.checks.map((c) => c[0])).toEqual(["mutation"])
  })
})

describe("time per gate (spec 0020 §7)", () => {
  const durations = { build: 12_000, unit: 65_000, mutation: 842_000, total: 930_000 }

  test("the CLI's line lists the gates in the order they ran, then the total", () => {
    expect(timingLine(durations)).toBe("Time per gate: build 12s, unit 1m 05s, mutation 14m 02s; total 15m 30s")
    expect(gateTimings(durations).map(([k]) => k)).toEqual(["build", "unit", "mutation", "total"])
  })

  test("the comment's section is a table, and nothing when no gate ran", () => {
    expect(timingSection(durations)).toBe("<details><summary>Time per gate</summary>\n\n| Check | Time |\n|---|---|\n| build | 12s |\n| unit | 1m 05s |\n| mutation | 14m 02s |\n| total | 15m 30s |\n\n</details>\n")
    expect(timingLine({ total: 50 })).toBeUndefined()
    expect(timingSection({ total: 50 })).toBe("")
  })
})
