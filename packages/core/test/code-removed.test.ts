import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { irHash } from "@gauntlet/ir"
import { Effect, Option } from "effect"
import {
  type AddedLine,
  blankOrLineComment,
  buildReport,
  computeFacts,
  decide,
  type Evidence,
  evaluateCondition,
  explainPolicy,
  type FileChange,
  plainSummary,
  type ReviewInput,
  runIntegrity,
  testPathMatcher,
} from "../src/index.ts"
import { cleanEvidence, compiled } from "./fixtures.ts"

// `code removed` (spec 0017 §2) lets an owner choose how a change that only
// deletes main code is treated, without letting new behaviour or a removed
// test through.

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
review {
  owner  when zone touched
  review when dependency added
  auto   when code removed and no zone touched and all gates pass
}
`)
const CODE_REMOVED = { kind: "code-removed" } as const

const passing: Evidence = cleanEvidence({
  checks: [
    { tier: "fast", check: "build", pointer: "/gates/0/checks/0", status: "passed", advisory: false },
    { tier: "verify", check: "unit", pointer: "/gates/1/checks/0", status: "passed", advisory: false },
  ],
})

/** A changed file, with the text of the lines it adds (their count is `added`). */
type Change = FileChange & { readonly lines?: ReadonlyArray<string>; readonly removed?: number }
const facts = (changes: ReadonlyArray<Change>, deps: Parameters<typeof computeFacts>[0]["dependencyChanges"] = []) =>
  computeFacts({
    base: "b",
    head: "h",
    changes: changes.map(({ status, path, oldPath }) => ({ status, path, ...(oldPath !== undefined ? { oldPath } : {}) })),
    lineCounts: new Map(changes.map((c) => [c.path, { added: c.lines?.length ?? 0, removed: c.removed ?? 0 }])),
    addedLines: new Map(changes.flatMap((c): Array<[string, AddedLine[]]> => (c.lines ? [[c.path, c.lines.map((text, i) => ({ line: i + 1, text }))]] : []))),
    ir: policy.ir,
    runnerConfig: [],
    dependencyChanges: deps,
    testsAsEdited: true,
  })

const input = (changes: ReadonlyArray<Change>, over: Partial<ReviewInput> = {}): ReviewInput => ({
  ...policy,
  facts: facts(changes),
  evidence: passing,
  mode: "enforce",
  ...over,
})
const holds = (changes: ReadonlyArray<Change>, over: Partial<ReviewInput> = {}) => evaluateCondition(CODE_REMOVED, input(changes, over))
const ruleTexts = (i: ReviewInput) => decide(i).nominations.map((n) => (n.source.kind === "policy" ? n.source.ref.text : n.source.rule))

const integrityOf = (i: ReviewInput, headFiles: ReadonlyArray<string>) =>
  Effect.runSync(runIntegrity({
    ir: policy.ir,
    facts: i.facts,
    readBase: () => Effect.succeed(Option.none()),
    readHead: () => Effect.succeed(Option.none()),
    isTestPath: testPathMatcher(policy.ir),
    baselineMetrics: {},
    headFiles,
    dir: "/nonexistent",
  }, []).pipe(Effect.provide(BunServices.layer)))

const deleteFile: Change = { status: "deleted", path: "src/main/feed/Legacy.kt", removed: 40 }
const deleteLines: Change = { status: "modified", path: "src/main/feed/Feed.kt", removed: 12 }

describe("code removed: when it holds", () => {
  test("deleting a file of main code, with every gate passing, gets auto from the rule", () => {
    const i = input([deleteFile])
    expect(evaluateCondition(CODE_REMOVED, i)).toBe(true)
    const d = decide(i)
    expect([d.tier, d.blocking]).toEqual(["auto", false])
    expect(ruleTexts(i)).toEqual(["auto   when code removed and no zone touched and all gates pass"])
  })

  test("deleting lines from a file that stays holds", () => {
    expect(holds([deleteLines])).toBe(true)
    expect(holds([deleteFile, deleteLines])).toBe(true)
  })

  test("lines it gains that are blank or line comments don't stop it", () => {
    expect(holds([{ ...deleteLines, lines: ["", "  // Fees are now charged by the gateway.", "   "] }])).toBe(true)
    expect(holds([{ status: "modified", path: "src/main/fx.py", removed: 3, lines: ["# no longer converts"] }])).toBe(true)
  })

  test("documentation changed alongside it doesn't stop it", () => {
    expect(holds([deleteFile, { status: "modified", path: "README.md", removed: 4, lines: ["The legacy feed is gone."] }])).toBe(true)
    expect(holds([deleteFile, { status: "deleted", path: "docs/legacy-feed.md", removed: 30 }])).toBe(true)
  })

  test("a new test, or a test that only gains lines, removes no test", () => {
    expect(holds([deleteLines, { status: "added", path: "src/test/feed/FeedTest.kt", lines: ["class FeedTest"] }])).toBe(true)
    expect(holds([deleteLines, { status: "modified", path: "src/test/feed/OtherTest.kt", lines: ["  @Test fun more() {}"] }])).toBe(true)
  })

  test("a removed dependency is fine", () => {
    const i = { ...input([deleteFile]), facts: facts([deleteFile], [{ manifest: "build.gradle.kts", added: [], removed: ["org.legacy:feed"], unparsed: false }]) }
    expect(evaluateCondition(CODE_REMOVED, i)).toBe(true)
  })
})

describe("code removed: when it doesn't", () => {
  test("an empty change, or only documentation, removes no code", () => {
    expect(holds([])).toBe(false)
    expect(holds([{ status: "deleted", path: "docs/old.md", removed: 10 }])).toBe(false)
  })

  test("main code that gains a line of code isn't only a removal", () => {
    expect(holds([{ ...deleteLines, lines: ["  return 0"] }])).toBe(false)
    expect(holds([deleteFile, { status: "modified", path: "src/main/feed/Other.kt", removed: 1, lines: ["val x = 2"] }])).toBe(false)
    const i = input([deleteFile, { status: "modified", path: "src/main/feed/Other.kt", removed: 1, lines: ["val x = 2"] }])
    expect(decide(i).tier).toBe("review")
    expect(ruleTexts(i)).toEqual(["no-rule-matched"])
  })

  test("a comment tools act on, or a block comment, counts as code", () => {
    expect(holds([{ ...deleteLines, lines: ["  // @ts-ignore"] }])).toBe(false)
    expect(holds([{ ...deleteLines, lines: ["@Suppress(\"unused\") // detekt"] }])).toBe(false)
    expect(holds([{ ...deleteLines, lines: [" * a block comment line"] }])).toBe(false)
  })

  test("a language it doesn't know allows only blank lines", () => {
    expect(holds([{ status: "modified", path: "src/main/run.sh", removed: 2, lines: ["# a comment"] }])).toBe(false)
    expect(holds([{ status: "modified", path: "src/main/run.sh", removed: 2, lines: [""] }])).toBe(true)
  })

  test("a file of main code added, renamed or changed without losing a line", () => {
    expect(holds([deleteFile, { status: "added", path: "src/main/feed/New.kt", lines: ["object New"] }])).toBe(false)
    expect(holds([deleteFile, { status: "renamed", path: "src/main/feed/B.kt", oldPath: "src/main/feed/A.kt" }])).toBe(false)
    expect(holds([{ status: "renamed", path: "src/main/feed/B.kt", oldPath: "src/main/feed/A.kt", removed: 3 }])).toBe(false)
    // A binary file or a mode change: something changed that the line counts can't show.
    expect(holds([deleteFile, { status: "modified", path: "src/main/resources/logo.png" }])).toBe(false)
  })

  test("added lines it can't read count as code", () => {
    const i = input([deleteLines])
    const unread = { ...i, facts: { ...i.facts, files: i.facts.files.map((f) => ({ ...f, added: 2 })) } }
    expect(evaluateCondition(CODE_REMOVED, unread)).toBe(false)
  })

  test("a deleted test, or a test that loses lines, is a test removed", () => {
    expect(holds([deleteFile, { status: "deleted", path: "src/test/feed/LegacyTest.kt", removed: 30 }])).toBe(false)
    expect(holds([deleteLines, { status: "modified", path: "src/test/feed/FeedTest.kt", removed: 8 }])).toBe(false)
    expect(holds([deleteLines, { status: "renamed", path: "src/test/feed/B.kt", oldPath: "src/test/feed/A.kt" }])).toBe(false)
  })

  test("a test that ran at base and no longer runs is a test removed", () => {
    const evidence = cleanEvidence({
      checks: passing.checks,
      integrity: { findings: [{ kind: "flag", check: "deleted-tests", message: "Test svc.LegacyTest.parses no longer runs: its test file was removed along with the code it tested.", detector: "core" }], metrics: {}, notExecuted: [] },
    })
    expect(holds([deleteFile], { evidence })).toBe(false)
  })

  test("a test file removed with the code it's named after (flagged, not forbidden) still isn't `code removed`", () => {
    const changes: ReadonlyArray<Change> = [deleteFile, { status: "deleted", path: "src/test/feed/LegacyTest.kt", removed: 30 }]
    const i = input(changes)
    const integrity = integrityOf(i, [])
    expect(integrity.findings.map((f) => `${f.kind} ${f.check}`)).toContain("flag deleted-tests")
    const withIntegrity = { ...i, evidence: { ...passing, integrity } }
    expect(evaluateCondition(CODE_REMOVED, withIntegrity)).toBe(false)
    expect(decide(withIntegrity).tier).toBe("review")
  })

  test("a change under .gauntlet/ or an added dependency", () => {
    expect(holds([deleteFile, { status: "modified", path: ".gauntlet/policy.gx", removed: 1 }])).toBe(false)
    const i = { ...input([deleteFile]), facts: facts([deleteFile], [{ manifest: "build.gradle.kts", added: ["org.new:lib"], removed: [], unparsed: false }]) }
    expect(evaluateCondition(CODE_REMOVED, i)).toBe(false)
    const unparsed = { ...input([deleteFile]), facts: facts([deleteFile], [{ manifest: "deps.edn", added: [], removed: [], unparsed: true }]) }
    expect(evaluateCondition(CODE_REMOVED, unparsed)).toBe(false)
  })
})

describe("code removed doesn't weaken anything else", () => {
  test("a removal in a zone still gets the owner rule", () => {
    const changes: ReadonlyArray<Change> = [{ status: "deleted", path: "src/main/money/Fx.kt", removed: 50 }]
    expect(holds(changes)).toBe(true)
    const d = decide(input(changes))
    expect(d.tier).toBe("owner")
    expect(d.owners).toEqual(["@payments"])
  })

  test("a failing gate still keeps a removal from auto, and blocks", () => {
    const evidence = cleanEvidence({ checks: [passing.checks[0]!, { ...passing.checks[1]!, status: "failed", reason: "does not compile" }] })
    expect(holds([deleteFile], { evidence })).toBe(true)
    const d = decide(input([deleteFile], { evidence }))
    expect([d.tier, d.blocking]).toEqual(["review", true])
  })

  test("deleting a protected test with the code nominates review and blocks if forbidden", () => {
    const changes: ReadonlyArray<Change> = [deleteLines, { status: "deleted", path: "src/test/feed/CheckoutFlowTest.kt", removed: 30 }]
    const i = input(changes)
    const integrity = integrityOf(i, [])
    expect(integrity.findings.map((f) => `${f.kind} ${f.check}`)).toContain("forbid deleted-tests")
    const d = decide({ ...i, evidence: { ...passing, integrity } })
    expect([d.tier, d.blocking]).toEqual(["review", true])
  })
})

describe("blank or line comment", () => {
  test("knows each language's line comments", () => {
    expect(blankOrLineComment("a.kt", "  // gone")).toBe(true)
    expect(blankOrLineComment("a.ts", "/// <reference path=\"x\" />")).toBe(true)
    expect(blankOrLineComment("a.py", "# gone")).toBe(true)
    expect(blankOrLineComment("a.clj", ";; gone")).toBe(true)
    expect(blankOrLineComment("a.kt", "val a = 1 // trailing")).toBe(false)
    expect(blankOrLineComment("a.kt", "# not a comment here")).toBe(false)
    expect(blankOrLineComment("a.go", "//go:build linux")).toBe(false)
    expect(blankOrLineComment("a.txt", "")).toBe(true)
  })
})

describe("explain and the report", () => {
  test("explain says what the condition means", () => {
    expect(explainPolicy(policy.ir, "review")).toContain("the change only deletes main code and removes no test")
  })

  const report = (changes: ReadonlyArray<Change>) => {
    const i = input(changes)
    return buildReport({
      gauntletVersion: "0.1.0",
      policy: { ...policy, irHash: irHash(policy.ir), origin: "base", firstAdoption: false, drift: [], notes: [] },
      facts: i.facts,
      checks: passing.checks,
      ratchets: [],
      integrity: passing.integrity,
      violations: [],
      imports: [],
      decision: decide(i),
    })
  }

  test("the report says when it held", () => {
    const r = report([deleteFile, deleteLines])
    expect(r.facts.codeRemoved).toBe(true)
    expect(plainSummary(r).join("\n")).toContain("It changes 2 files (52 lines), only removing code and no tests (the review condition `code removed`).")
  })

  test("and says nothing when it didn't", () => {
    const r = report([{ ...deleteLines, lines: ["val x = 1"] }])
    expect(r.facts.codeRemoved).toBeUndefined()
    expect(plainSummary(r).join("\n")).not.toContain("code removed")
  })
})
