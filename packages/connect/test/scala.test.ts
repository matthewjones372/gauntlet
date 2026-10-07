import { describe, expect, test } from "bun:test"
import { compilePolicy } from "@gauntlet/dsl"
import { scalaSpec } from "@gauntlet/pack-scala"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { github } from "../src/index.ts"

const text = readFileSync(join(import.meta.dir, "..", "..", "..", "examples", "fixtures", "scala-service", ".gauntlet", "policy.gx"), "utf8")
const compiled = compilePolicy({ file: ".gauntlet/policy.gx", text }, [scalaSpec])
if (compiled._tag === "Invalid") throw new Error("the Scala fixture's policy doesn't compile")

describe("connect github for an sbt build", () => {
  test("sets up Java and a pinned sbt, and no Gradle", () => {
    const workflow = github({ mode: "repo", ir: compiled.compiled.ir, files: ["build.sbt"], gauntletVersion: "0.1.0", downloadUrl: "https://example.invalid/gauntlet" })[0]!.content
    const steps = (Bun.YAML.parse(workflow) as { jobs: { evidence: { steps: { name?: string; uses?: string; with?: Record<string, unknown> }[] } } }).jobs.evidence.steps
    expect(steps.find((s) => s.name === "Set up Java")?.with).toEqual({ distribution: "temurin", "java-version": "21" })
    expect(steps.find((s) => s.name === "Set up sbt")?.uses).toMatch(/^sbt\/setup-sbt@[0-9a-f]{40}$/)
    expect(steps.some((s) => s.name === "Set up Gradle")).toBe(false)
  })
})
