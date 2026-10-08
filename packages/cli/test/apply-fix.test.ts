import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { TempRepo } from "../../core/test/temp-repo.ts"
import { answers, appLayer, ExitStatus, launches, Output, runCli } from "../src/index.ts"
import { INSTALLED_PACKS } from "../src/packs.ts"

// `gauntlet apply` on a project whose checks already fail says what fails and
// offers to have Claude Code fix it; and a policy that gained gates gets its
// baseline recorded again rather than failing every change on old findings.

const TIMEOUT = 60_000
const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))
const IDENTITY = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" }
const saved = Object.fromEntries(Object.keys(IDENTITY).map((k) => [k, process.env[k]]))
beforeAll(() => Object.assign(process.env, IDENTITY))
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]
  else process.env[k] = v
})

const GO = (expected: number) => ({
  "go.mod": "module example.com/svc\n\ngo 1.21\n",
  "settlement/fx.go": "package settlement\n\nfunc Convert(minor int64, rateBp int64) int64 {\n\treturn minor * rateBp / 10000\n}\n",
  "settlement/fx_test.go": `package settlement\n\nimport "testing"\n\nfunc TestConvert(t *testing.T) {\n\tif Convert(100, 9200) != ${expected} {\n\t\tt.Fatal("wrong")\n\t}\n}\n`,
})
const project = (expected: number) => {
  const r = new TempRepo()
  repos.push(r)
  r.write(GO(expected))
  r.commit("existing project")
  return r
}
const gauntlet = async (r: TempRepo, args: string[], replies: string[] = [], calls: Array<{ cwd: string; prompt: string }> = []) => {
  const out: string[] = []
  const capture = Layer.succeed(Output, { out: (t) => Effect.sync(() => void out.push(t)), err: (t) => Effect.sync(() => void out.push(t)) })
  const code = await Effect.runPromise(runCli([...args, "--repo", r.dir]).pipe(Effect.provide(Layer.mergeAll(appLayer([...INSTALLED_PACKS]), capture, ExitStatus.layer, answers(...replies), launches(calls)))))
  return { code, out: out.join("\n") }
}

describe("apply on a project whose checks already fail", () => {
  test("says what fails and, on yes, opens Claude Code with /gauntlet-fix", async () => {
    const r = project(93)
    await gauntlet(r, ["setup"])
    const calls: Array<{ cwd: string; prompt: string }> = []
    const res = await gauntlet(r, ["apply"], ["y"], calls)
    expect(res.out).toContain("Your project doesn't pass every check yet:")
    expect(res.out).toMatch(/ {2}- unit: 1 of 1 tests failed/)
    expect(res.out).toContain("Opening Claude Code with /gauntlet-fix")
    expect(calls).toEqual([{ cwd: r.dir, prompt: "/gauntlet-fix" }])
    expect(readFileSync(join(r.dir, ".claude/commands/gauntlet-fix.md"), "utf8")).toContain("Fix the code, not the checks")
  }, TIMEOUT)

  test("on no, or with nobody at a terminal, says how to start the fix later", async () => {
    const r = project(93)
    await gauntlet(r, ["setup"])
    const res = await gauntlet(r, ["apply"])
    expect(res.out).toContain("open Claude Code here and run /gauntlet-fix")
  }, TIMEOUT)

  test("a project that passes isn't offered anything", async () => {
    const r = project(92)
    await gauntlet(r, ["setup"])
    expect((await gauntlet(r, ["apply"])).out).not.toContain("doesn't pass every check")
  }, TIMEOUT)
})

describe("apply after the policy changed", () => {
  test("records the baseline again instead of keeping the old one", async () => {
    const r = project(92)
    await gauntlet(r, ["setup"])
    await gauntlet(r, ["apply"])
    const policy = readFileSync(join(r.dir, ".gauntlet/policy.gx"), "utf8")
    writeFileSync(join(r.dir, "gauntlet.proposal.gx"), policy.replace("mode shadow", "mode enforce"))
    const res = await gauntlet(r, ["apply"])
    expect(res.out).toContain("recorded again for the new gates")
    expect(res.code).toBe(0)
    expect(existsSync(join(r.dir, ".gauntlet/baseline.sarif"))).toBe(true)
  }, TIMEOUT)
})
