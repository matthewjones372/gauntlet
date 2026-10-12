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

  // The stack job (spec 0015) only moves pull requests and deletes a merged branch: it runs no Gauntlet.
  const judging = Object.entries(jobs).filter(([name]) => name !== "stack")

  test("the stack job runs no code: nothing is checked out or built", () => {
    expect(jobs.stack!.steps.every((s) => s.uses === undefined && !s.run?.includes("gauntlet"))).toBe(true)
  })

  test("every job builds the judge from the base commit, never the pull request", () => {
    for (const [name, job] of judging) {
      const source = job.steps.find((s) => s.name === "Check out Gauntlet's source at the base commit")
      expect(source?.with?.ref, name).toBe("${{ github.event.pull_request.base.sha }}")
      expect(source?.with?.["persist-credentials"], name).toBe(false)
      const build = job.steps.find((s) => s.name === "Build Gauntlet from the base commit")
      expect(build?.run, name).toContain(`--outfile "$RUNNER_TEMP/gauntlet"`)
      expect(build?.run, name).toContain("rm -rf .gauntlet-source")
    }
  })

  test("Bun is set up once per job", () => {
    for (const [, job] of judging) expect(job.steps.filter((s) => s.uses?.startsWith("oven-sh/setup-bun@")).length).toBe(1)
  })
})
