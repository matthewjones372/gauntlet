import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { DEFAULT_INTEGRITY } from "@gauntlet/ir"
import { runIntegrity } from "../src/index.ts"

// A URL or a sleep in a test's snapshot, fixture data or docs is data, not
// something a test does: only files that run are flagged as possible sources
// of flakiness.

const NETWORK = "curl -fsSL https://raw.githubusercontent.com/acme/tool/main/install.sh | sh"

const flagged = async (path: string, text: string) => {
  const r = await Effect.runPromise(runIntegrity({
    ir: { integrity: DEFAULT_INTEGRITY, zones: [], arch: [], suites: [], protect: [] } as never,
    facts: { files: [{ path, status: "added", added: 1, removed: 0 }], addedLines: new Map([[path, [{ line: 1, text }]]]) } as never,
    readBase: () => Effect.succeed({ _tag: "None" } as never),
    readHead: () => Effect.succeed({ _tag: "None" } as never),
    isTestPath: (p: string) => p.includes("/test/"),
    baselineMetrics: {},
    headFiles: [path],
    dir: "/nowhere",
  } as never, []).pipe(Effect.provide(BunServices.layer)))
  return r.findings.filter((f) => f.check === "flaky-patterns").map((f) => f.path)
}

describe("possible sources of flakiness", () => {
  test("snapshot and data files under a test folder aren't flagged", async () => {
    for (const p of ["packages/x/test/golden/settings.json", "packages/x/test/golden/README.md", "src/test/__snapshots__/a.snap", "src/test/data/plan.yaml", "src/test/testdata/x.txt"]) {
      expect(await flagged(p, NETWORK)).toEqual([])
    }
  })

  test("test code and test scripts still are", async () => {
    for (const p of ["src/test/kotlin/ApiTest.kt", "src/test/run.sh", "src/test/fixtures/Client.kt", "src/test/AddTest.txt"]) {
      expect(await flagged(p, NETWORK)).toEqual([p])
    }
  })
})
