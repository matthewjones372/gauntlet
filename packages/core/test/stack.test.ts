import { describe, expect, test } from "bun:test"
import type { PolicyIR } from "@gauntlet/ir"
import { agentSummary, renderAgentSummary } from "../src/report/agent.ts"
import { STACK_LINES, suggestStack } from "../src/stack.ts"

// A big change over several parts of the repository gets a suggestion to
// review it as stacked pull requests: one per part, tests with their code,
// Gauntlet's policy first, the policy's arch modules lowest first, docs last.

const ir = (over: Partial<PolicyIR> = {}) => ({
  packs: ["typescript"],
  arch: [
    { module: "ir", mustNotDependOn: ["dsl", "core", "cli"] },
    { module: "dsl", mustNotDependOn: ["core", "cli"] },
    { module: "core", mustNotDependOn: ["cli"] },
  ],
  ...over,
}) as unknown as PolicyIR

const facts = (files: Record<string, number>, over: object = {}) => ({
  files: Object.entries(files).map(([path, lines]) => ({ path, status: "modified" as const, added: lines, removed: 0 })),
  linesChanged: Object.values(files).reduce((a, b) => a + b, 0),
  zonesTouched: [],
  protectedTouched: [],
  ...over,
}) as never

describe("stacked pull requests", () => {
  test("a big change over several parts: one per part, in the order to review them", () => {
    const s = suggestStack(ir(), facts({
      "packages/cli/src/app.ts": 120,
      "packages/core/src/check.ts": 150,
      "packages/core/test/check.test.ts": 80,
      "packages/ir/src/policy-ir.ts": 40,
      ".gauntlet/policy.gx": 10,
      "docs/adr/0026.md": 30,
      "scripts/build.ts": 20,
    }))!
    expect(s.lines).toBe(450)
    // The 20-line scripts part is small, so it joins the documentation after it.
    expect(s.steps.map((p) => p.title)).toEqual(["Gauntlet's policy and settings", "packages/ir", "packages/core", "packages/cli", "scripts, documentation"])
    expect(s.steps.find((p) => p.title === "packages/core")).toEqual({ title: "packages/core", files: ["packages/core/src/check.ts", "packages/core/test/check.test.ts"], lines: 230, needsOwner: false })
    expect(s.steps[0]!.needsOwner).toBe(true)
  })

  test("a part that touches a zone or a protected file is for an owner", () => {
    const s = suggestStack(ir(), facts({ "packages/core/src/review.ts": 300, "packages/cli/src/app.ts": 200 }, {
      zonesTouched: [{ zone: "decision", files: ["packages/core/src/review.ts"], owners: ["@o"] }],
    }))!
    expect(s.steps.map((p) => [p.title, p.needsOwner])).toEqual([["packages/core", true], ["packages/cli", false]])
  })

  test("with build folders, each build is a part", () => {
    const s = suggestStack(ir({ arch: [], builds: [{ pack: "jvm", dir: "lark-bank" }, { pack: "scala", dir: "bank-checks" }] } as never), facts({
      "lark-bank/src/main/kotlin/App.kt": 250,
      "bank-checks/src/main/scala/Check.scala": 250,
    }))!
    expect(s.steps.map((p) => p.title)).toEqual(["bank-checks", "lark-bank"])
  })

  test("a small part joins the next pull request; the policy stays one of its own, however small", () => {
    const s = suggestStack(ir(), facts({ ".gauntlet/policy.gx": 3, "packages/ir/src/a.ts": 5, "packages/core/src/b.ts": 300, "packages/cli/src/c.ts": 200 }))!
    expect(s.steps.map((p) => [p.title, p.lines])).toEqual([["Gauntlet's policy and settings", 3], ["packages/ir, packages/core", 305], ["packages/cli", 200]])
  })

  test("the last part, if small, joins the one before", () => {
    const s = suggestStack(ir(), facts({ "packages/core/src/b.ts": 300, "packages/cli/src/c.ts": 200, "docs/x.md": 4 }))!
    expect(s.steps.map((p) => p.title)).toEqual(["packages/core", "packages/cli, documentation"])
  })

  test("the policy can set how big a change must be (split when diff > n lines)", () => {
    const big = facts({ "packages/core/src/b.ts": 300, "packages/cli/src/c.ts": 200 })
    expect(suggestStack(ir({ split: { lines: 601 } }), big)).toBeUndefined()
    expect(suggestStack(ir({ split: { lines: 201 } }), facts({ "packages/core/src/b.ts": 150, "packages/cli/src/c.ts": 100 }))).toBeDefined()
  })

  test("a small change, or a big one in one part, is fine as one pull request", () => {
    expect(suggestStack(ir(), facts({ "packages/core/src/a.ts": STACK_LINES - 10, "packages/cli/src/b.ts": 5 }))).toBeUndefined()
    expect(suggestStack(ir(), facts({ "packages/core/src/a.ts": 500, "packages/core/test/a.test.ts": 300 }))).toBeUndefined()
  })

  test("the agent offers the split and only does it if the person agrees", () => {
    const report = {
      decision: { tier: "auto", wouldBlock: false, nominations: [] },
      checks: [], remediation: [], facts: { zonesTouched: [] }, policy: { headSha: "abc", notes: [] },
      stack: { lines: 500, steps: [{ title: "packages/core", files: ["packages/core/src/a.ts"], lines: 300, needsOwner: false }, { title: "packages/cli", files: ["packages/cli/src/b.ts"], lines: 200, needsOwner: false }] },
    } as never
    const text = renderAgentSummary(agentSummary(report, "out"))
    expect(text).toContain("Offer the person to split it into 2 stacked pull requests, each on top of the one before, and only do it if they agree:")
    expect(text).toContain("1. packages/core (300 lines): packages/core/src/a.ts")
    expect(text).toContain("make one branch per part, in this order, each starting from the one before")
  })
})
