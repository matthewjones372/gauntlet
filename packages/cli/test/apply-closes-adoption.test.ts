import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { TempRepo } from "../../core/test/temp-repo.ts"
import { answers, appLayer, ExitStatus, launches, Output, runCli } from "../src/index.ts"
import { INSTALLED_PACKS } from "../src/packs.ts"

// Setup finishing closes an adoption window left open, so nobody is asked to.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))
const IDENTITY = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" }
const saved = Object.fromEntries(Object.keys(IDENTITY).map((k) => [k, process.env[k]]))
beforeAll(() => Object.assign(process.env, IDENTITY))
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]
  else process.env[k] = v
})
const run = async (r: TempRepo, args: string[], replies: string[] = []) => {
  const out: string[] = []
  const capture = Layer.succeed(Output, { out: (t) => Effect.sync(() => void out.push(t)), err: (t) => Effect.sync(() => void out.push(t)) })
  await Effect.runPromise(runCli([...args, "--repo", r.dir]).pipe(Effect.provide(Layer.mergeAll(appLayer([...INSTALLED_PACKS]), capture, ExitStatus.layer, answers(...replies), launches([])))))
  return out.join("\n")
}

describe("apply and the adoption window", () => {
  test("closes a window left open and prints its record", async () => {
    const r = new TempRepo()
    repos.push(r)
    r.write({ "go.mod": "module example.com/svc\n\ngo 1.21\n", "a.go": "package svc\n\nfunc A() int { return 1 }\n", "a_test.go": "package svc\n\nimport \"testing\"\n\nfunc TestA(t *testing.T) {\n\tif A() != 1 {\n\t\tt.Fatal(\"no\")\n\t}\n}\n" })
    r.commit("project")
    await run(r, ["setup"])
    expect(await run(r, ["adopt"], ["adopt"])).toContain("Open.")
    const out = await run(r, ["apply"])
    expect(out).toContain("Adoption window opened")
    expect(out).toContain("Closed the adoption window")
    expect(existsSync(join(r.dir, ".git", "gauntlet", "adoption.json"))).toBe(false)
  }, 60_000)
})
