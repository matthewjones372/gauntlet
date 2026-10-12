import { describe, expect, test } from "bun:test"
import { irHash } from "@gauntlet/ir"
import { join } from "node:path"
import { agentSummary, buildReport, type CheckRecord, decide, type Evidence, renderAgentSummary, renderMarkdown, type ReportInput } from "../src/index.ts"
import { cleanEvidence, compiled, noFacts } from "./fixtures.ts"
import { expectGolden } from "./golden-file.ts"

// Protected files run as the base has them (the change's edit is undone for
// the run). A change that edits build configuration or the policy must be told
// so plainly, or a check that "ignores" its new plugin or budget is a mystery.

const policy = compiled(`gauntlet "tweets"
use jvm
mode enforce
owners @platform
protect {
  tests  "src/test/**"
  config "project/**"
  fixtures "src/test/resources/**"
}
suites { unit "src/test/**" }
gates {
  fast   { build, lint }
  verify { unit }
}
review {
  review when protected changed
  auto when all gates pass
}
`)

const passed = (tier: string, check: string, pointer: string): CheckRecord => ({ tier, check, pointer, status: "passed", advisory: false })
const base = "1111111111111111111111111111111111111111"
const head = "2222222222222222222222222222222222222222"

const input = (over: { checks?: CheckRecord[]; facts?: Parameters<typeof noFacts>[0]; origin?: "base" | "working-copy"; drift?: ReportInput["policy"]["drift"] }): ReportInput => {
  const checks = over.checks ?? [passed("fast", "build", "/gates/0/checks/0"), passed("fast", "lint", "/gates/0/checks/1"), passed("verify", "unit", "/gates/1/checks/0")]
  const evidence: Evidence = cleanEvidence({ checks })
  const facts = noFacts({ base, head, linesChanged: 8, ...over.facts })
  return {
    gauntletVersion: "0.1.0",
    policy: { ...policy, irHash: irHash(policy.ir), origin: over.origin ?? "base", firstAdoption: false, drift: over.drift ?? [], notes: [] },
    facts,
    checks,
    ratchets: [],
    integrity: evidence.integrity,
    violations: [],
    imports: [],
    decision: decide({ ...policy, facts, evidence, mode: "enforce" }),
  }
}

// The tweet-street case: sbt-scalafix added to protected build config, a budget added to the policy, and lint errors.
const scalafix = input({
  checks: [
    passed("fast", "build", "/gates/0/checks/0"),
    { tier: "fast", check: "lint", pointer: "/gates/0/checks/1", status: "errored", advisory: false, reason: "scalafix isn't applied: add sbt-scalafix to project/plugins.sbt" },
    passed("verify", "unit", "/gates/1/checks/0"),
  ],
  facts: {
    gauntletChanged: true,
    protectedTouched: [
      { path: ".gauntlet/policy.gx", group: "gauntlet", kind: "gauntlet", change: "modified", action: "restored" },
      { path: "project/plugins.sbt", group: "config", kind: "config", change: "modified", action: "restored" },
      { path: "project/scalafix.sbt", group: "config", kind: "config", change: "added", action: "removed" },
      { path: "src/test/NewTest.scala", group: "tests", kind: "tests", change: "added", action: "kept" },
    ],
  },
  drift: [{ path: ".gauntlet/policy.gx", change: "modified" }],
})

/** The notice's section of a markdown report, up to the next heading. */
const notice = (md: string) => {
  const from = md.indexOf("### Ran as the base has them")
  const to = md.indexOf("\n### ", from + 1)
  return from < 0 ? "" : md.slice(from, to < 0 ? undefined : to)
}

describe("protected files that ran as the base has them", () => {
  test("the report names them, says the change's version takes effect once it merges, and links the errored check", () => {
    const md = renderMarkdown(buildReport(scalafix))
    expectGolden(join(import.meta.dir, "golden", "protected-from-base.report.md"), md)
    const section = notice(md)
    expect(section).toContain("`project/plugins.sbt` (config)")
    expect(section).toContain("`project/scalafix.sbt` (config), which the change adds, was left out")
    expect(section).toContain("`.gauntlet/policy.gx` (policy)")
    expect(section).toContain("takes effect once it merges")
    expect(section).toContain("budgets")
    expect(section).toContain("**lint** errored")
    // A new test runs as the change has it, so it isn't listed.
    expect(section).not.toContain("NewTest")
  })

  test("the agent is told too", () => {
    const text = renderAgentSummary(agentSummary(buildReport(scalafix), "/tmp/out"))
    expect(text).toContain("These protected files ran as the base has them, not as you changed them: project/plugins.sbt, project/scalafix.sbt (left out), .gauntlet/policy.gx.")
    expect(text).toContain("takes effect once the change merges")
  })

  test("a local check that judges with the working copy's policy doesn't list the policy", () => {
    const local = input({
      origin: "working-copy",
      facts: {
        gauntletChanged: true,
        protectedTouched: [
          { path: ".gauntlet/policy.gx", group: "gauntlet", kind: "gauntlet", change: "modified", action: "restored" },
          { path: "project/plugins.sbt", group: "config", kind: "config", change: "modified", action: "restored" },
        ],
      },
      drift: [{ path: ".gauntlet/policy.gx", change: "modified" }],
    })
    const md = renderMarkdown(buildReport(local))
    const section = notice(md)
    expect(section).toContain("`project/plugins.sbt` (config)")
    expect(section).not.toContain("policy.gx")
    // Nothing failed, so there's no check to link.
    expect(section).not.toContain("errored")
  })

  test("a change that touches no protected file has no such section", () => {
    const md = renderMarkdown(buildReport(input({})))
    expect(md).not.toContain("Ran as the base has them")
    expect(renderAgentSummary(agentSummary(buildReport(input({})), "/tmp/out"))).not.toContain("ran as the base")
  })
})
