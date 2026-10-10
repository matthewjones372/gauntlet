import { describe, expect, test } from "bun:test"
import { mergeBuildRuns } from "../src/builds.ts"
import type { GateRun } from "../src/gate.ts"

// With several builds, a build where a linter isn't set up at all is left out
// of that check when another build has it, and the proof says so. Every build
// without it, or a real failure to run, is still an error.

const linted: GateRun = { command: ["sbt", "scalafixAll --check"], exitCode: 0, runs: [] }
const missing: GateRun = { command: ["sbt", "scalafixAll --check"], exitCode: 1, runs: [], error: "scalafix isn't applied", notSetUp: true }

describe("a linter set up in only some builds", () => {
  test("the builds without it are left out, and the proof names them", () => {
    const run = mergeBuildRuns([{ dir: "bank", run: linted }, { dir: "checks", run: missing }])
    expect(run.error).toBeUndefined()
    expect(run.exitCode).toBe(0)
    expect(run.command).toEqual(["[bank]", "sbt", "scalafixAll --check", "[checks] left out: scalafix isn't applied"])
  })

  test("no build has it: an error, as with one build", () => {
    const run = mergeBuildRuns([{ dir: "bank", run: missing }, { dir: "checks", run: missing }])
    expect(run.error).toBe("bank: scalafix isn't applied")
  })

  test("a linter that is set up but can't run is still an error", () => {
    const broken: GateRun = { ...linted, exitCode: 2, error: "scalafix couldn't check the code" }
    const run = mergeBuildRuns([{ dir: "bank", run: broken }, { dir: "checks", run: missing }])
    expect(run.error).toBe("bank: scalafix couldn't check the code")
  })

  test("a finding in a build that has it still counts", () => {
    const failing: GateRun = { ...linted, exitCode: 1 }
    const run = mergeBuildRuns([{ dir: "bank", run: failing }, { dir: "checks", run: missing }])
    expect(run.exitCode).toBe(1)
  })
})
