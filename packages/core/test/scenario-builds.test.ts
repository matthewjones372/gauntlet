import { describe, expect, test } from "bun:test"
import { mergeBuildRuns, runFromBuild } from "../src/index.ts"

// Spec 0012 with build folders: a build's mutants and skipped tests come back
// with paths from the repository's root, and builds' results are merged.

describe("scenario evidence across builds", () => {
  test("mutant paths are from the root, and builds' mutants and skipped tests are merged", () => {
    const a = runFromBuild({
      command: [], exitCode: 0, runs: [],
      mutants: [{ path: "src/Fx.kt", line: 3, killed: true, message: "", killedBy: ["a:svc.FxTest.FX-1 x"] }, { path: undefined, line: 1, killed: false, message: "" }],
      tests: { counts: { executed: 1, passed: 1, failed: 0, errored: 0, skipped: 1 }, ids: ["svc.A", "svc.B"], skipped: ["svc.B"] },
    }, "lark")
    expect(a.mutants?.map((m) => m.path)).toEqual(["lark/src/Fx.kt", undefined])
    const merged = mergeBuildRuns([
      { dir: "lark", run: a },
      { dir: "bank", run: { command: [], exitCode: 0, runs: [], mutants: [{ path: "bank/src/B.kt", line: 1, killed: false, message: "" }], tests: { counts: { executed: 1, passed: 1, failed: 0, errored: 0, skipped: 0 }, ids: ["svc.C"] } } },
    ])
    expect(merged.mutants?.map((m) => m.path)).toEqual(["lark/src/Fx.kt", undefined, "bank/src/B.kt"])
    expect(merged.tests?.skipped).toEqual(["svc.B"])
    expect(mergeBuildRuns([{ dir: "x", run: { command: [], exitCode: 0, runs: [] } }]).mutants).toBeUndefined()
  })
})
