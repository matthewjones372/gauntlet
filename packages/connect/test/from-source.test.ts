import { describe, expect, test } from "bun:test"
import { compilePolicy } from "@gauntlet/dsl"
import { typescriptSpec } from "@gauntlet/pack-typescript"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { github } from "../src/index.ts"

const text = readFileSync(join(import.meta.dir, "..", "..", "..", ".gauntlet", "policy.gx"), "utf8")
const compiled = compilePolicy({ file: ".gauntlet/policy.gx", text }, [typescriptSpec])
if (compiled._tag === "Invalid") throw new Error("this repository's policy doesn't compile")

describe("connect github --from-source (Gauntlet judging itself)", () => {
  const workflow = github({ mode: "repo", ir: compiled.compiled.ir, files: ["bun.lock"], gauntletVersion: "0.1.0", downloadUrl: "unused", fromSource: true })[0]!.content
  const jobs = (Bun.YAML.parse(workflow) as { jobs: Record<string, { steps: { name?: string; uses?: string; with?: Record<string, unknown>; run?: string }[] }> }).jobs

  test("downloads nothing", () => {
    expect(workflow).not.toContain("GAUNTLET_URL")
    expect(workflow).not.toContain("curl")
  })

  test("every job builds the judge from the base commit, never the pull request", () => {
    for (const [name, job] of Object.entries(jobs)) {
      const source = job.steps.find((s) => s.name === "Check out Gauntlet's source at the base commit")
      expect(source?.with?.ref, name).toBe("${{ github.event.pull_request.base.sha }}")
      expect(source?.with?.["persist-credentials"], name).toBe(false)
      const build = job.steps.find((s) => s.name === "Build Gauntlet from the base commit")
      expect(build?.run, name).toContain(`--outfile "$RUNNER_TEMP/gauntlet"`)
      expect(build?.run, name).toContain("rm -rf .gauntlet-source")
    }
  })

  test("Bun is set up once per job", () => {
    for (const job of Object.values(jobs)) expect(job.steps.filter((s) => s.uses?.startsWith("oven-sh/setup-bun@")).length).toBe(1)
  })
})
