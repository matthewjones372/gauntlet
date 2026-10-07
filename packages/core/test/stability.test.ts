import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { assessStability, failuresOf, type GateRun, seedFor, type TestSubset } from "../src/index.ts"

const failing = (id: string, file?: string): GateRun["runs"][number]["results"][number] => ({
  ruleId: "test/failed", level: "error", message: { text: `${id}: boom` },
  locations: [{ ...(file ? { physicalLocation: { artifactLocation: { uri: file } } } : {}), logicalLocations: [{ fullyQualifiedName: id, kind: "function" }] }],
})
const run = (ids: string[], failed: GateRun["runs"][number]["results"]): GateRun => ({
  command: [], exitCode: failed.length > 0 ? 1 : 0, runs: [{ tool: { driver: { name: "junit" } }, results: failed }],
  tests: { counts: { executed: ids.length, passed: ids.length - failed.length, failed: failed.length, errored: 0, skipped: 0 }, ids },
})
const facts = (changed: string[] = []) => ({ head: "00000010aaaa", files: changed.map((path) => ({ path, status: "modified" as const, added: 1, removed: 0 })) }) as never

describe("stability", () => {
  test("failures carry their id and file, and seeds are consecutive per commit", () => {
    expect(failuresOf(run(["a.t"], [failing("a.t", "test/a.test.ts")]))).toEqual([{ id: "a.t", file: "test/a.test.ts", text: "a.t: boom" }])
    expect([0, 1, 2].map((i) => seedFor("00000010", i))).toEqual([16, 17, 18])
  })

  test("a failure without a file is rerun by the file its id starts with (vitest names tests after their file)", async () => {
    const asked: TestSubset[] = []
    const st = await Effect.runPromise(assessStability({
      suite: { name: "unit", location: "test/**" },
      main: run(["test/a.test.ts > adds"], [failing("test/a.test.ts > adds")]),
      facts: facts(),
      quarantine: [],
      today: "2026-01-01",
      files: ["test/a.test.ts", "test/a.ts"],
      rerun: (subset) => Effect.sync(() => {
        asked.push(subset)
        return run(["test/a.test.ts > adds"], [])
      }),
    }))
    expect(asked).toEqual([{ files: ["test/a.test.ts"], ids: ["test/a.test.ts > adds"], seed: 16 }])
    expect(st.rerunFlaky).toEqual(["test/a.test.ts > adds"])
    expect(st.failures).toEqual([])
  })

  test("without reruns the failure counts, and the report says why it wasn't rerun", async () => {
    const st = await Effect.runPromise(assessStability({
      suite: { name: "unit", location: "test/**" },
      main: run(["x"], [failing("x")]),
      facts: facts(["test/x.test.ts"]),
      quarantine: [{ test: "y", until: "2026-12-01", owners: ["@a"] }],
      today: "2026-01-01",
    }))
    expect(st.failures.map((f) => f.id)).toEqual(["x"])
    expect(st.notes).toEqual([
      "failed tests weren't run again: the pack can't run single tests",
      "new and changed tests weren't repeated to look for flakiness: the pack can't run single tests",
    ])
  })
})
