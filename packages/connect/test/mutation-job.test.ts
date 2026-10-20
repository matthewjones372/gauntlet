import { describe, expect, test } from "bun:test"
import { compilePolicy, formatDiagnostics } from "@gauntlet/dsl"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { jvmSpec } from "@gauntlet/pack-jvm"
import { github, splitsMutation } from "../src/index.ts"
import { expectGolden } from "./golden-file.ts"

// Spec 0020 §6: a policy whose mutation only advises runs it in a job of its own,
// beside the evidence job, so the verdict never waits for it. A trusted job posts
// its survivors as a check of their own.

const root = join(import.meta.dir, "..", "..", "..")
const fixture = readFileSync(join(root, "examples/fixtures/kotlin-service/.gauntlet/policy.gx"), "utf8")
const withMutation = (gate: string) => {
  const text = `${fixture.replace("mutation ratchet on changed", gate)}${gate.includes("scenarios") ? '\nscenarios "specs/**/*.feature"\n' : ""}`
  const r = compilePolicy({ file: ".gauntlet/policy.gx", text }, [jvmSpec])
  if (r._tag === "Invalid") throw new Error(formatDiagnostics(r.diagnostics, text))
  return r.compiled.ir
}
const options = (gate: string, extra: { readonly mode?: "repo" | "org"; readonly protectOnly?: boolean } = {}) => ({
  mode: extra.mode ?? "repo" as const,
  ir: withMutation(gate),
  files: ["settings.gradle.kts", "build.gradle.kts", "gradlew"],
  gauntletVersion: "0.1.0",
  downloadUrl: "https://example.invalid/gauntlet/v0.1.0/gauntlet-linux-x64",
  sha256: "a".repeat(64),
  javaVersion: "25",
  ...(extra.protectOnly ? { protectOnly: true } : {}),
})
const workflowOf = (o: ReturnType<typeof options>) => github(o).find((f) => f.path.endsWith("workflows/gauntlet.yml"))!.content
type Job = { readonly needs?: ReadonlyArray<string>; readonly if?: string; readonly permissions?: Record<string, string>; readonly steps: ReadonlyArray<{ readonly name?: string; readonly run?: string; readonly with?: Record<string, unknown> }> }
const jobsOf = (yml: string) => (Bun.YAML.parse(yml) as { jobs: Record<string, Job> }).jobs
const runs = (job: Job) => job.steps.flatMap((s) => (s.run ? [s.run] : [])).join("\n")

describe("advise mutation in a job of its own", () => {
  const advise = options("mutation advise on changed max 150 mutants")

  test("the workflow matches its snapshot and parses as YAML", () => {
    const yml = workflowOf(advise)
    expectGolden(join(import.meta.dir, "golden", "repo-advise-mutation", ".github__workflows__gauntlet.yml"), yml)
    expect(() => Bun.YAML.parse(yml)).not.toThrow()
  })

  test("evidence skips it, and the mutation job runs only it, beside evidence and without credentials", () => {
    const jobs = jobsOf(workflowOf(advise))
    expect(runs(jobs.evidence!)).toContain("--out gauntlet-out --no-record --advised-mutation skip")
    const mutation = jobs.mutation!
    expect(mutation.needs).toBeUndefined()
    expect(mutation.if).toBe(jobs.evidence!.if)
    expect(mutation.permissions).toEqual({ contents: "read" })
    expect(runs(mutation)).toContain("--out gauntlet-mutation --no-record --advised-mutation only")
    expect(runs(mutation)).not.toContain("selftest")
    expect(mutation.steps.find((s) => s.with?.name === "gauntlet-mutation")).toBeDefined()
    // The verdict waits for the evidence job only.
    expect(jobs.status!.needs).toEqual(["evidence"])
  })

  test("a trusted job posts the survivors as a neutral check of their own, and runs no pull request code", () => {
    const report = jobsOf(workflowOf(advise))["mutation-report"]!
    expect(report.needs).toEqual(["mutation"])
    expect(report.permissions).toEqual({ actions: "read", checks: "write" })
    expect(report.steps.some((s) => s.with?.ref !== undefined)).toBe(false)
    expect(runs(report)).not.toContain("gauntlet\" check")
    expect(runs(report)).toContain('name: "gauntlet mutation"')
    expect(runs(report)).toContain('conclusion: "neutral"')
  })

  test("a blocking mutation gate, a scenarios check, protect-only and org mode keep mutation in the evidence job", () => {
    const cases = [
      options("mutation >= 60% on changed max 150 mutants"),
      options("mutation advise on changed, scenarios advise"),
      options("mutation advise on changed", { protectOnly: true }),
      options("mutation advise on changed", { mode: "org" }),
    ]
    for (const o of cases) {
      expect(splitsMutation(o)).toBe(false)
      const jobs = jobsOf(workflowOf(o))
      expect(jobs.mutation).toBeUndefined()
      expect(jobs["mutation-report"]).toBeUndefined()
      expect(runs(jobs.evidence!)).not.toContain("--advised-mutation")
    }
  })
})
