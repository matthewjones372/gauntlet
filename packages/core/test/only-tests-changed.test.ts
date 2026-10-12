import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Option } from "effect"
import {
  computeFacts,
  decide,
  type Evidence,
  evaluateCondition,
  explainPolicy,
  type FileChange,
  type ReviewInput,
  runIntegrity,
  testPathMatcher,
} from "../src/index.ts"
import { cleanEvidence, compiled } from "./fixtures.ts"

// `only tests changed` lets a change that only adds tests reach auto, without
// letting an edited, deleted or weakened test through.

const policy = compiled(`gauntlet "svc"
use jvm
owners @platform
protect {
  tests    "src/test/**"
  fixtures "src/test/resources/golden/**"
}
zone money { paths "src/main/money/**", "src/test/money/**" owner @payments }
suites { unit "src/test/**" }
gates { fast { build } verify { unit } }
predicate small = diff < 150 lines and no zone touched
review {
  owner  when zone touched
  review when dependency added
  auto   when small and all gates pass
  auto   when only tests changed and no zone touched and all gates pass
}
`)
const ONLY_TESTS = { kind: "only-tests-changed" } as const

const passing: Evidence = cleanEvidence({
  checks: [
    { tier: "fast", check: "build", pointer: "/gates/0/checks/0", status: "passed", advisory: false },
    { tier: "verify", check: "unit", pointer: "/gates/1/checks/0", status: "passed", advisory: false },
  ],
})

type Change = FileChange & { readonly added?: number; readonly removed?: number }
const facts = (changes: ReadonlyArray<Change>, opts: { runnerConfig?: ReadonlyArray<string>; testsAsEdited?: boolean } = {}) =>
  computeFacts({
    base: "b",
    head: "h",
    changes: changes.map(({ status, path, oldPath }) => ({ status, path, ...(oldPath !== undefined ? { oldPath } : {}) })),
    lineCounts: new Map(changes.map((c) => [c.path, { added: c.added ?? 0, removed: c.removed ?? 0 }])),
    addedLines: new Map(),
    ir: policy.ir,
    runnerConfig: opts.runnerConfig ?? [],
    dependencyChanges: [],
    testsAsEdited: opts.testsAsEdited ?? true,
  })

const input = (changes: ReadonlyArray<Change>, over: Partial<ReviewInput> = {}, opts: Parameters<typeof facts>[1] = {}): ReviewInput => ({
  ...policy,
  facts: facts(changes, opts),
  evidence: passing,
  mode: "enforce",
  ...over,
})
const holds = (changes: ReadonlyArray<Change>, opts: Parameters<typeof facts>[1] = {}) => evaluateCondition(ONLY_TESTS, input(changes, {}, opts))
const ruleTexts = (i: ReviewInput) => decide(i).nominations.map((n) => (n.source.kind === "policy" ? n.source.ref.text : n.source.rule))

// Six new test files, 512 lines: too big for `small`.
const sixNewTests: ReadonlyArray<Change> = [86, 86, 85, 85, 85, 85].map((n, i) => ({ status: "added", path: `src/test/feed/Feed${i}Test.kt`, added: n }))

describe("only tests changed: when it holds", () => {
  test("a change that only adds new tests, with every gate passing, gets auto from the rule", () => {
    const i = input(sixNewTests)
    expect(i.facts.linesChanged).toBe(512)
    expect(evaluateCondition(ONLY_TESTS, i)).toBe(true)
    const d = decide(i)
    expect([d.tier, d.blocking]).toEqual(["auto", false])
    expect(ruleTexts(i)).toEqual(["auto   when only tests changed and no zone touched and all gates pass"])
  })

  test("a new test that sits under a test glob holds whatever its extension (test resources are tests)", () => {
    expect(holds([{ status: "added", path: "src/test/resources/feed.json", added: 4 }])).toBe(true)
  })

  test("an empty change doesn't hold: there are no tests in it", () => {
    expect(holds([])).toBe(false)
  })
})

describe("only tests changed: when it doesn't", () => {
  test("a new test plus one line of main code isn't auto by this rule", () => {
    const changes: ReadonlyArray<Change> = [...sixNewTests, { status: "modified", path: "src/main/feed/Feed.kt", added: 1 }]
    expect(holds(changes)).toBe(false)
    const d = decide(input(changes))
    expect(d.tier).toBe("review")
    expect(ruleTexts(input(changes))).toEqual(["no-rule-matched"])
  })

  test("documentation next to the tests isn't a test (the strict reading)", () => {
    expect(holds([...sixNewTests, { status: "modified", path: "README.md", added: 2 }])).toBe(false)
  })

  test("a fixture under the test folder is protected as a fixture, not a test", () => {
    expect(holds([{ status: "added", path: "src/test/resources/golden/feed.json", added: 4 }])).toBe(false)
  })

  test("runner configuration under the test folder isn't a test", () => {
    expect(holds([{ status: "modified", path: "src/test/resources/junit-platform.properties", added: 1 }], { runnerConfig: ["src/test/resources/junit-platform.properties"] })).toBe(false)
  })

  test(".gauntlet/ and CI files aren't tests", () => {
    expect(holds([...sixNewTests, { status: "modified", path: ".gauntlet/policy.gx", added: 1 }])).toBe(false)
    expect(holds([...sixNewTests, { status: "modified", path: ".github/workflows/ci.yml", added: 1 }])).toBe(false)
  })

  test("a file moved from main code into the tests isn't only tests", () => {
    expect(holds([{ status: "renamed", path: "src/test/feed/Feed.kt", oldPath: "src/main/feed/Feed.kt" }])).toBe(false)
  })
})

describe("only tests changed doesn't weaken anything else", () => {
  test("editing an existing protected test still needs review, whatever the rule says", () => {
    const changes: ReadonlyArray<Change> = [...sixNewTests, { status: "modified", path: "src/test/feed/OldTest.kt", added: 3, removed: 3 }]
    const asEdited = decide(input(changes))
    expect(asEdited.tier).toBe("review")
    expect(asEdited.nominations.some((n) => n.source.kind === "implicit" && n.source.rule === "protected-changed")).toBe(true)
    // Under protect-only, the edit is put back and still needs review.
    const restored = decide(input(changes, {}, { testsAsEdited: false }))
    expect(restored.tier).toBe("review")
  })

  test("a test-only change that touches a zone gets the owner rule", () => {
    const changes: ReadonlyArray<Change> = [{ status: "added", path: "src/test/money/FxTest.kt", added: 40 }]
    expect(holds(changes)).toBe(true)
    const d = decide(input(changes))
    expect(d.tier).toBe("owner")
    expect(d.owners).toEqual(["@payments"])
  })

  test("deleting a test doesn't hold, and stays forbidden", () => {
    const changes: ReadonlyArray<Change> = [...sixNewTests, { status: "deleted", path: "src/test/feed/OldTest.kt", removed: 30 }]
    expect(holds(changes)).toBe(false)
    const i = input(changes)
    const integrity = Effect.runSync(runIntegrity({
      ir: policy.ir,
      facts: i.facts,
      readBase: () => Effect.succeed(Option.none()),
      readHead: () => Effect.succeed(Option.none()),
      isTestPath: testPathMatcher(policy.ir),
      baselineMetrics: {},
      headFiles: sixNewTests.map((c) => c.path),
      dir: "/nonexistent",
    }, []).pipe(Effect.provide(BunServices.layer)))
    expect(integrity.findings.map((f) => `${f.kind} ${f.check}`)).toContain("forbid deleted-tests")
    const d = decide({ ...i, evidence: { ...passing, integrity } })
    expect([d.tier, d.blocking]).toEqual(["review", true])
  })

  test("an integrity flag still keeps a test-only change from auto", () => {
    const evidence = cleanEvidence({
      checks: passing.checks,
      integrity: { findings: [{ kind: "flag", check: "flaky-patterns", message: "Thread.sleep in a test", detector: "core", path: "src/test/feed/Feed0Test.kt", line: 3 }], metrics: {}, notExecuted: [] },
    })
    expect(decide(input(sixNewTests, { evidence })).tier).toBe("review")
  })

  test("a failing gate still keeps a test-only change from auto, and blocks", () => {
    const evidence = cleanEvidence({ checks: [passing.checks[0]!, { ...passing.checks[1]!, status: "failed", reason: "1 test failed" }] })
    const d = decide(input(sixNewTests, { evidence }))
    expect([d.tier, d.blocking]).toEqual(["review", true])
  })
})

describe("explain", () => {
  test("says what the condition means", () => {
    expect(explainPolicy(policy.ir, "review")).toContain("- auto when every required gate passes and no zone is touched and every changed file is a test")
  })
})
