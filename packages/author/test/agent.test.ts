import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { draftProposals } from "../src/index.ts"
import { BASE, context, MONEY_ZONE, PROTECT_TESTS, scripted, type Step } from "./fake.ts"

const run = (steps: ReadonlyArray<Step>, options: { maxRepairs?: number } = {}) => {
  const model = scripted(steps)
  const result = Effect.runPromise(draftProposals({ mode: "review", text: BASE, ctx: context(), ...options }).pipe(Effect.provide(model.layer)))
  return { result, model }
}

describe("the authoring loop", () => {
  test("explores with tools, then returns checked proposals; tool results come from Gauntlet", async () => {
    const { result, model } = run([
      { tools: [{ name: "search", params: { pattern: "amount|rate" } }, { name: "read_file", params: { path: "src/main/kotlin/svc/settlement/Fx.kt" } }] },
      { tools: [{ name: "coverage", params: {} }, { name: "selftest_plan", params: {} }] },
      { text: "I've seen enough." },
      { object: { proposals: [MONEY_ZONE, PROTECT_TESTS] } },
    ])
    const r = await result
    expect(r.rounds).toBe(1)
    expect(r.dropped).toEqual([])
    expect(r.proposals.map((p) => p.proposal.kind)).toEqual(["zone", "protect"])
    expect(r.proposals.every((p) => p.loosenings.length === 0)).toBe(true)
    // The second call carried the search hit and the file text that Gauntlet produced.
    expect(model.seen[1]!.prompt).toContain("amountMinor * rate / 10_000")
    expect(model.seen[3]!.json).toBe(true)
  })

  test("converges: proposals that don't compile go back with the diagnostics until they do", async () => {
    const broken = { ...MONEY_ZONE, text: MONEY_ZONE.text.replace("kotlin.no-floating-money", "kotlin.no-floats") }
    const { result, model } = run([
      { text: "Looked around." },
      { object: { proposals: [broken] } },
      { object: { proposals: [MONEY_ZONE] } },
    ])
    const r = await result
    expect(r.rounds).toBe(2)
    expect(r.proposals.map((p) => p.proposal.name)).toEqual(["money"])
    expect(model.seen[2]!.prompt).toContain("set zone money: the policy doesn't compile with it")
    expect(model.seen[2]!.prompt).toContain("kotlin.no-floats")
  })

  test("gives up after the repair rounds and drops what still doesn't work", async () => {
    const broken = { ...PROTECT_TESTS, text: "protect {" }
    const r = await run([{ text: "." }, { object: { proposals: [broken] } }, { object: { proposals: [broken] } }], { maxRepairs: 1 }).result
    expect(r.proposals).toEqual([])
    expect(r.dropped).toHaveLength(1)
    expect(r.dropped[0]!.reason).toStartWith("still unusable after 2 rounds: the block doesn't parse")
  })

  test("drops proposals whose citation Gauntlet can't verify or that don't address it", async () => {
    const proposals = [
      { ...MONEY_ZONE, citation: { ...MONEY_ZONE.citation, excerpt: "val amount: Double" } },
      { ...MONEY_ZONE, citation: { ...MONEY_ZONE.citation, path: "src/main/kotlin/svc/Ghost.kt" } },
      { ...MONEY_ZONE, citation: { kind: "sensitive-code", path: "src/main/kotlin/svc/domain/Money.kt", line: 3, excerpt: "data class Money" } },
      { ...PROTECT_TESTS, citation: { kind: "unprotected-tests", path: "README.md" } },
      { ...PROTECT_TESTS, citation: { kind: "shadow-escape", reason: "tests were deleted" } },
      { ...PROTECT_TESTS, citation: { kind: "configured-tool", path: "build.gradle.kts", excerpt: `id("info.solidsoft.pitest")` } },
      { ...PROTECT_TESTS, citation: { kind: "selftest-gap", fixture: "edited-test-setup" } },
    ]
    const r = await run([{ text: "." }, { object: { proposals } }]).result
    expect(r.dropped.map((d) => d.reason)).toEqual([
      "citation rejected: line 3 of src/main/kotlin/svc/settlement/Fx.kt doesn't contain the quoted text",
      "citation rejected: src/main/kotlin/svc/Ghost.kt isn't in the repository",
      "citation rejected: the proposal doesn't put src/main/kotlin/svc/domain/Money.kt in a zone or under new rules",
      "citation rejected: README.md doesn't look like a test file",
      "citation rejected: the shadow history doesn't list that reason",
      "citation rejected: a configured tool backs a gates proposal that changes the gates",
    ])
    // The selftest gap is real, and protecting tests closes it.
    expect(r.proposals.map((p) => p.proposal.citation.kind)).toEqual(["selftest-gap"])
  })

  test("a configured tool backs a new gate, and a shadow reason can back a stricter review rule", async () => {
    const gates = {
      kind: "gates", action: "set", text: "gates {\n  fast   { build }\n  verify { unit, mutation ratchet on changed }\n}",
      rationale: "Pitest is applied, so mutation can be gated.",
      citation: { kind: "configured-tool", path: "build.gradle.kts", excerpt: `id("info.solidsoft.pitest") version "1.19.0"` },
    }
    const onFail = {
      kind: "on fail", name: "unit", action: "set", text: `on fail unit { fix "Fix the code under test, not the test." }`,
      rationale: "Unit failures were the most frequent shadow reason.",
      citation: { kind: "shadow-escape", reason: "unit failed: 1 of 9 tests failed" },
    }
    const r = await run([{ text: "." }, { object: { proposals: [gates, onFail] } }]).result
    expect(r.dropped).toEqual([])
    expect(r.proposals.map((p) => p.proposal.kind)).toEqual(["gates", "on fail"])
  })

  test("loosening is flagged by Gauntlet, whatever the model says", async () => {
    const removeRule = {
      kind: "review", action: "set", text: "review {\n  auto when all gates pass\n}",
      rationale: "Simplify review.", citation: { kind: "shadow-escape", reason: "unit failed: 1 of 9 tests failed" },
    }
    const r = await run([{ text: "." }, { object: { proposals: [removeRule] } }]).result
    expect(r.proposals[0]!.loosenings.map((l) => l.what)).toEqual(["review rule removed: review when protected-changed"])
  })

  test("two proposals for one block keep the first, and changes that change nothing are dropped", async () => {
    const same = { ...PROTECT_TESTS, text: `protect {\n  tests "src/test/**", "src/it/**"\n}` }
    const noop = { kind: "suites", action: "set", text: `suites { unit "src/test/**" }`, rationale: "x", citation: PROTECT_TESTS.citation }
    const r = await run([{ text: "." }, { object: { proposals: [PROTECT_TESTS, same, noop] } }]).result
    expect(r.proposals).toHaveLength(1)
    expect(r.dropped.map((d) => d.reason)).toEqual(["another proposal already changes this block", "it changes nothing"])
  })
})
