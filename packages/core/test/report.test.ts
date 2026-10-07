import { describe, expect, test } from "bun:test"
import { irHash } from "@gauntlet/ir"
import { type Run } from "@gauntlet/sarif"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Schema } from "effect"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildReport, type CheckRecord, decide, type Evidence, renderEvidence, renderJson, renderMarkdown, Report, REPORT_FILES, Reporter, ReporterLive,
  type ReportInput,
} from "../src/index.ts"
import { cleanEvidence, compiled, noFacts } from "./fixtures.ts"
import { expectGolden } from "./golden-file.ts"

const policyText = `gauntlet "trade-reporting"
use jvm
mode enforce
owners @platform
protect {
  tests  "src/test/**"
  config "*.gradle.kts"
}
zone money { paths "src/main/money/**" owner @payments }
suites {
  unit "src/test/**"
  holdout "trade-holdout" ci only
}
gates {
  fast   { build, lint ratchet }
  verify { unit, mutation ratchet on changed }
  behaviour { trade-holdout }
}
on fail mutation { fix "Kill the surviving mutants listed in the report. Do not delete or weaken tests." }
predicate small = diff < 150 lines and no zone touched
review {
  owner when zone touched
  review when protected changed
  auto when small and all gates pass
}
`
const policy = compiled(policyText)

const proof = (cmd: string, executed?: number) => ({ command: ["./gradlew", cmd], exitCode: 0, reports: { [`${cmd}.xml`]: "a".repeat(64) }, ...(executed !== undefined ? { executed } : {}) })
const passed = (tier: string, check: string, pointer: string, extra: Partial<CheckRecord> = {}): CheckRecord => ({ tier, check, pointer, status: "passed", advisory: false, ...extra })

const allPassing: CheckRecord[] = [
  passed("fast", "build", "/gates/0/checks/0", { proof: proof("assemble") }),
  passed("fast", "lint", "/gates/0/checks/1", { proof: proof("detekt") }),
  passed("verify", "mutation", "/gates/1/checks/0", { proof: proof("pitest") }),
  passed("verify", "unit", "/gates/1/checks/1", { proof: proof("test", 42), tests: { executed: 42, passed: 42, failed: 0, errored: 0, skipped: 0 } }),
  { tier: "behaviour", check: "trade-holdout", pointer: "/gates/2/checks/0", status: "not-executed", advisory: false, reason: "holdout pending: holdouts run only in CI" },
]

const scenario = (name: string, over: { checks?: CheckRecord[]; evidence?: Partial<Evidence>; facts?: Parameters<typeof noFacts>[0]; mode?: "shadow" | "enforce"; input?: Partial<ReportInput> }): ReportInput => {
  const checks = over.checks ?? allPassing.filter((c) => c.status === "passed")
  const evidence = cleanEvidence({ checks, ...over.evidence })
  const facts = noFacts({ base: "1111111111111111111111111111111111111111", head: "2222222222222222222222222222222222222222", linesChanged: 12, ...over.facts })
  const mode = over.mode ?? "enforce"
  const decision = decide({ ...policy, facts, evidence, mode })
  return {
    gauntletVersion: "0.1.0",
    policy: { ...policy, irHash: irHash(policy.ir), origin: "base", firstAdoption: false, drift: [], notes: [] },
    facts,
    checks,
    ratchets: [],
    integrity: evidence.integrity,
    violations: evidence.newViolations,
    imports: [],
    decision,
    ...over.input,
    ...(name ? {} : {}),
  }
}

const scenarios: Record<string, ReportInput> = {
  "clean-auto": scenario("clean-auto", {
    facts: { files: [{ path: "src/main/Fx.kt", status: "modified", added: 8, removed: 4 }] },
    input: { agent: { agent: "claude-code", model: "claude-sonnet-5-5", session: "s-123" } },
  }),
  "failing-enforce": scenario("failing-enforce", {
    checks: [
      allPassing[0]!,
      allPassing[1]!,
      { tier: "verify", check: "mutation", pointer: "/gates/1/checks/0", status: "failed", advisory: false, reason: "mutation score 71% is below the baseline 80%", proof: { ...proof("pitest"), exitCode: 0 } },
      { ...allPassing[3]!, status: "failed", reason: "1 test failed", tests: { executed: 42, passed: 41, failed: 1, errored: 0, skipped: 0 } },
    ],
    evidence: {
      newViolations: [{ check: "lint", ruleId: "detekt.style.MagicNumber", message: "1.1 is a magic number", path: "src/main/Fx.kt", line: 5 }],
      regressions: [{ metric: "mutation", base: 80, head: 71 }],
      integrity: {
        findings: [
          { check: "new-skips", kind: "forbid", message: "A new @Disabled skips a test.", path: "src/test/FxTest.kt", line: 12, detector: "kotlin" },
          { check: "env-branching", kind: "flag", message: "System.getenv is used in a condition.", path: "src/main/Fx.kt", line: 20, detector: "kotlin" },
        ],
        metrics: {},
        notExecuted: [],
      },
    },
    input: { ratchets: [{ metric: "mutation", base: 80, head: 71, delta: -9, regressed: true }, { metric: "coverage", base: 70, head: 70, delta: 0, regressed: false }] },
  }),
  "owner-policy-edit": scenario("owner-policy-edit", {
    facts: {
      gauntletChanged: true,
      policyChanged: true,
      zonesTouched: [{ zone: "money", files: ["src/main/money/Fx.kt"], owners: ["@payments"] }],
      protectedTouched: [
        { path: ".gauntlet/policy.gx", group: "gauntlet", kind: "gauntlet", change: "modified", action: "restored" },
        { path: "build.gradle.kts", group: "config", kind: "config", change: "modified", action: "restored" },
      ],
      dependencyChanges: [{ manifest: "build.gradle.kts", added: ["evil:lib:6.6.6"], removed: [], unparsed: false }],
    },
    input: {
      policy: {
        ...policy, irHash: irHash(policy.ir), origin: "base", firstAdoption: false,
        drift: [{ path: ".gauntlet/policy.gx", change: "modified" }],
        notes: ["This change edits .gauntlet/; it is judged by the policy at 111111111111 and the edit nominates owner."],
      },
    },
  }),
  "first-adoption-shadow": scenario("first-adoption-shadow", {
    mode: "shadow",
    checks: allPassing,
    evidence: {
      integrity: { findings: [], metrics: {}, notExecuted: ["assertions-per-test", "mocks-of-class-under-test"] },
      caution: [{ source: "reviewer", message: "possible special-casing", raise: true }],
    },
    input: {
      policy: { ...policy, irHash: irHash(policy.ir), origin: "working-copy", firstAdoption: true, drift: [{ path: ".gauntlet/policy.gx", change: "added" }], notes: ["111111111111 has no .gauntlet/policy.gx, so this change adopts Gauntlet. Its own policy is used, in shadow mode."] },
      imports: [{
        source: "reviewer",
        trust: "caution",
        results: [
          { ruleId: "llm/special-case", message: { text: "Branch only taken under test" }, baselineState: "new", properties: { gauntlet: { caution: true } } },
          { ruleId: "llm/naming", message: { text: "old finding" }, baselineState: "unchanged" },
        ],
      }],
    },
  }),
}

describe("report goldens", () => {
  for (const [name, input] of Object.entries(scenarios)) {
    test(name, () => {
      const report = buildReport(input)
      expect(Schema.decodeUnknownSync(Report)(JSON.parse(renderJson(report)))).toEqual(report)
      expectGolden(join(import.meta.dir, "golden", `${name}.report.json`), renderJson(report))
      expectGolden(join(import.meta.dir, "golden", `${name}.report.md`), renderMarkdown(report))
    })
  }

  test("the scenarios cover each tier and blocking state they're named for", () => {
    const tiers = Object.fromEntries(Object.entries(scenarios).map(([k, v]) => [k, `${v.decision.tier}/${v.decision.blocking}/${v.decision.wouldBlock}`]))
    expect(tiers).toEqual({
      "clean-auto": "auto/false/false",
      "failing-enforce": "review/true/true",
      "owner-policy-edit": "owner/false/false",
      "first-adoption-shadow": "owner/false/false",
    })
  })
})

const shuffle = <A>(xs: ReadonlyArray<A>, seed: number): A[] => {
  const out = [...xs]
  let s = seed
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648
    const j = s % (i + 1)
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

describe("determinism (invariant 4)", () => {
  test("the same inputs in any order give byte-identical JSON and markdown", () => {
    for (const input of Object.values(scenarios)) {
      const json = renderJson(buildReport(input))
      const md = renderMarkdown(buildReport(input))
      for (const seed of [1, 2, 3, 42]) {
        const shuffled: ReportInput = {
          ...input,
          checks: shuffle(input.checks, seed),
          ratchets: shuffle(input.ratchets, seed),
          violations: shuffle(input.violations, seed),
          imports: shuffle(input.imports, seed),
          integrity: { ...input.integrity, findings: shuffle(input.integrity.findings, seed), notExecuted: shuffle(input.integrity.notExecuted, seed) },
          facts: { ...input.facts, files: shuffle(input.facts.files, seed), protectedTouched: shuffle(input.facts.protectedTouched, seed) },
        }
        expect(renderJson(buildReport(shuffled))).toBe(json)
        expect(renderMarkdown(buildReport(shuffled))).toBe(md)
      }
    }
  })

  test("the report carries no timing", () => {
    const json = renderJson(buildReport(scenarios["failing-enforce"]!))
    expect(json).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/)
    expect(json).not.toMatch(/duration|startedAt|finishedAt/i)
  })

  test("the evidence log doesn't depend on run order", () => {
    const run = (check: string, tool: string): Run => ({ tool: { driver: { name: tool } }, results: [], properties: { gauntlet: { check } } })
    const runs = [run("unit", "junit"), run("lint", "detekt"), run("lint", "kotlin-rules"), run("build", "gradle")]
    expect(renderEvidence(shuffle(runs, 7))).toBe(renderEvidence(runs))
  })
})

describe("markdown limits", () => {
  test("long lists are cut with a count so comments stay within GitHub's limit", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ check: "env-branching" as const, kind: "flag" as const, message: `finding ${i}`, path: `src/F${String(i).padStart(3, "0")}.kt`, line: 1, detector: "kotlin" }))
    const input = scenario("many", { evidence: { integrity: { findings: many, metrics: {}, notExecuted: [] } } })
    const md = renderMarkdown(buildReport(input))
    expect(md).toContain("60 more in gauntlet-report.json")
    expect(md.length).toBeLessThan(65536)
  })
})

describe("Reporter", () => {
  test("writes the four files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gauntlet-report-"))
    try {
      const report = buildReport(scenarios["clean-auto"]!)
      await Effect.runPromise(
        Reporter.use((r) => r.write(dir, report, [], { startedAt: "2026-10-07T12:00:00Z", finishedAt: "2026-10-07T12:01:00Z", durationsMs: { unit: 1200 } }))
          .pipe(Effect.provide(ReporterLive.pipe(Layer.provide(BunServices.layer)))),
      )
      expect(readdirSync(dir).sort()).toEqual(Object.values(REPORT_FILES).sort())
      expect(readFileSync(join(dir, REPORT_FILES.json), "utf8")).toBe(renderJson(report))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
