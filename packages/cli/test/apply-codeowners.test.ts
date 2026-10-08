import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { TempRepo } from "../../core/test/temp-repo.ts"
import { answers, appLayer, ExitStatus, launches, Output, runCli } from "../src/index.ts"
import { INSTALLED_PACKS } from "../src/packs.ts"

// `gauntlet apply` offers a CODEOWNERS file built from the policy when the
// repository has none, so GitHub asks the right people to review.

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

const project = (extra: Record<string, string> = {}) => {
  const r = new TempRepo()
  repos.push(r)
  r.write({
    "go.mod": "module example.com/svc\n\ngo 1.25\n",
    "settlement/fx.go": "package settlement\n\nfunc Convert(minor int64, rateBp int64) int64 {\n\treturn minor * rateBp / 10000\n}\n",
    "settlement/fx_test.go": "package settlement\n\nimport \"testing\"\n\nfunc TestConvert(t *testing.T) {\n\tif Convert(100, 9200) != 92 {\n\t\tt.Fatal(\"wrong\")\n\t}\n}\n",
    ...extra,
  })
  r.commit("existing project")
  return r
}
const gauntlet = async (r: TempRepo, args: string[], replies: string[] = []) => {
  const out: string[] = []
  const capture = Layer.succeed(Output, { out: (t) => Effect.sync(() => void out.push(t)), err: (t) => Effect.sync(() => void out.push(t)) })
  const code = await Effect.runPromise(runCli([...args, "--repo", r.dir]).pipe(Effect.provide(Layer.mergeAll(appLayer([...INSTALLED_PACKS]), capture, ExitStatus.layer, answers(...replies), launches([])))))
  return { code, out: out.join("\n") }
}
const subjects = (r: TempRepo) => r.git("log", "--format=%s").trim().split("\n")

describe("apply and CODEOWNERS", () => {
  test("none yet and the policy names owners: on yes, writes and commits one from the policy", async () => {
    const r = project()
    await gauntlet(r, ["setup", "--owner", "@alice"])
    const res = await gauntlet(r, ["apply"], ["y"])
    expect(res.out).toContain("No CODEOWNERS file")
    const file = readFileSync(join(r.dir, ".github/CODEOWNERS"), "utf8")
    expect(file).toContain("/.gauntlet/ @alice")
    expect(subjects(r)).toContain("Add CODEOWNERS from the Gauntlet policy")
  }, TIMEOUT)

  test("with nobody at a terminal, says how to add one later and writes nothing", async () => {
    const r = project()
    await gauntlet(r, ["setup", "--owner", "@alice"])
    const res = await gauntlet(r, ["apply"])
    expect(res.out).toContain("To add one later")
    expect(existsSync(join(r.dir, ".github/CODEOWNERS"))).toBe(false)
  }, TIMEOUT)

  test("an existing CODEOWNERS is left alone, wherever GitHub finds it", async () => {
    const r = project({ "docs/CODEOWNERS": "* @bob\n" })
    await gauntlet(r, ["setup", "--owner", "@alice"])
    const res = await gauntlet(r, ["apply"], ["y"])
    expect(res.out).not.toContain("No CODEOWNERS file")
    expect(existsSync(join(r.dir, ".github/CODEOWNERS"))).toBe(false)
    expect(readFileSync(join(r.dir, "docs/CODEOWNERS"), "utf8")).toBe("* @bob\n")
  }, TIMEOUT)

  test("no owners in the policy: says to add them first", async () => {
    const r = project()
    await gauntlet(r, ["setup"])
    const res = await gauntlet(r, ["apply"], ["y"])
    expect(res.out).toContain("the policy names no owners")
    expect(existsSync(join(r.dir, ".github/CODEOWNERS"))).toBe(false)
  }, TIMEOUT)
})
