import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { assessStability, type GateRun, type TestSubset } from "../src/index.ts"

// A failure that counts runs again with the change's files as the base has
// them. Only a test that ran there and failed again was already failing; one
// that passed there, or didn't run there (new with the change), is the
// change's doing.

const failing = (id: string): GateRun["runs"][number]["results"][number] => ({
  ruleId: "test/failed", level: "error", message: { text: `${id}: boom` },
  locations: [{ physicalLocation: { artifactLocation: { uri: `test/${id}.test.ts` } }, logicalLocations: [{ fullyQualifiedName: id, kind: "function" }] }],
})
const run = (ids: string[], failed: string[]): GateRun => ({
  command: [], exitCode: failed.length > 0 ? 1 : 0, runs: [{ tool: { driver: { name: "junit" } }, results: failed.map(failing) }],
  tests: { counts: { executed: ids.length, passed: ids.length - failed.length, failed: failed.length, errored: 0, skipped: 0 }, ids },
})
const facts = { head: "00000010aaaa", files: [] } as never

const assess = (onBase?: (subset: TestSubset) => GateRun) => {
  const asked: TestSubset[] = []
  return Effect.runPromise(assessStability({
    suite: { name: "unit", location: "test/**" },
    main: run(["old", "broke", "fresh", "ok"], ["old", "broke", "fresh"]),
    facts,
    quarantine: [],
    today: "2026-01-01",
    // Still failing when run again alone: none is flaky.
    rerun: (subset) => Effect.succeed(run(subset.ids as string[], subset.ids as string[])),
    ...(onBase ? { onBase: (subset: TestSubset) => Effect.sync(() => (asked.push(subset), onBase(subset))) } : {}),
  })).then((st) => ({ st, asked }))
}

describe("failures that fail on the base too", () => {
  test("only those that ran on the base and failed there", async () => {
    // On the base: "old" fails, "broke" passes, "fresh" doesn't exist.
    const { st, asked } = await assess(() => run(["old", "broke", "ok"], ["old"]))
    expect(asked).toEqual([{ files: ["test/broke.test.ts", "test/fresh.test.ts", "test/old.test.ts"], ids: ["broke", "fresh", "old"], seed: 16 }])
    expect(st.failures.map((f) => f.id)).toEqual(["broke", "fresh", "old"])
    expect(st.failingOnBase).toEqual(["old"])
  })

  test("a base run that couldn't run excuses nothing", async () => {
    const { st } = await assess(() => ({ command: [], exitCode: -1, runs: [], error: "couldn't put the base's files in place" }))
    expect(st.failingOnBase).toEqual([])
  })

  test("without a way to run on the base, nothing is excused", async () => {
    const { st } = await assess()
    expect(st.failingOnBase).toEqual([])
    expect(st.failures).toHaveLength(3)
  })
})
