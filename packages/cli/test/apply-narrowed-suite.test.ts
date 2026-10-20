import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { TempRepo } from "../../core/test/temp-repo.ts"
import { answers, appLayer, ExitStatus, launches, Output, runCli } from "../src/index.ts"
import { INSTALLED_PACKS } from "../src/packs.ts"

// Issue #163: a proposal that narrows a suite runs fewer tests, so recording
// the baseline again lowered the executed-tests count and `apply` refused it.
// The person applying it is the owner and has just been shown the loosening:
// the lower count is theirs to confirm, not a refusal.

const TIMEOUT = 120_000
const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))
const IDENTITY = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" }
const saved = Object.fromEntries(Object.keys(IDENTITY).map((k) => [k, process.env[k]]))
beforeAll(() => Object.assign(process.env, IDENTITY))
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]
  else process.env[k] = v
})

const goTest = (pkg: string, name: string) => `package ${pkg}\n\nimport "testing"\n\nfunc Test${name}(t *testing.T) {\n\tif ${name}() != 1 {\n\t\tt.Fatal("no")\n\t}\n}\n`
const project = () => {
  const r = new TempRepo()
  repos.push(r)
  r.write({
    "go.mod": "module example.com/svc\n\ngo 1.21\n",
    "a/a.go": "package a\n\nfunc A() int { return 1 }\n",
    "a/a_test.go": goTest("a", "A"),
    "b/b.go": "package b\n\nfunc B() int { return 1 }\n",
    "b/b_test.go": goTest("b", "B"),
  })
  r.commit("project")
  return r
}
const gauntlet = async (r: TempRepo, args: string[], replies: string[] = []) => {
  const out: string[] = []
  const capture = Layer.succeed(Output, { out: (t) => Effect.sync(() => void out.push(t)), err: (t) => Effect.sync(() => void out.push(t)) })
  const code = await Effect.runPromise(runCli([...args, "--repo", r.dir]).pipe(Effect.provide(Layer.mergeAll(appLayer([...INSTALLED_PACKS]), capture, ExitStatus.layer, answers(...replies), launches([])))))
  return { code, out: out.join("\n") }
}
const executed = (r: TempRepo) => {
  const baseline = JSON.parse(readFileSync(join(r.dir, ".gauntlet/baseline.sarif"), "utf8"))
  return JSON.stringify(baseline).match(/"integrity\/executed-tests":\{[^}]*"value":(\d+)/)?.[1]
}
/** Set up and applied, then a proposal that narrows the suite to package a. */
const narrowed = async () => {
  const r = project()
  await gauntlet(r, ["setup", "--owner", "@alice"])
  // Yes to CODEOWNERS, so the next apply asks nothing else first.
  await gauntlet(r, ["apply"], ["y"])
  expect(executed(r)).toBe("2")
  const policy = readFileSync(join(r.dir, ".gauntlet/policy.gx"), "utf8")
  const suites = policy.match(/suites \{[^}]*\}/)?.[0]
  expect(suites).toContain(`"**/*_test.go"`)
  writeFileSync(join(r.dir, "gauntlet.proposal.gx"), policy.replace(suites!, suites!.replace(`"**/*_test.go"`, `"a/**/*_test.go"`)))
  return r
}

describe("apply a proposal that narrows a suite", () => {
  test("shows the lower test count as part of the loosening, and records it when the owner confirms", async () => {
    const r = await narrowed()
    const res = await gauntlet(r, ["apply"], ["y"])
    expect(res.out).toContain("Loosens: suite unit removed or changed")
    expect(res.out).toContain("integrity/executed-tests: 2 -> 1")
    expect(res.out).not.toContain("The baseline was not updated")
    expect(res.code).toBe(0)
    expect(executed(r)).toBe("1")
    expect(r.git("status", "--porcelain", ".gauntlet")).toBe("")
  }, TIMEOUT)

  test("when the owner doesn't confirm, the baseline stays as it was", async () => {
    const r = await narrowed()
    const res = await gauntlet(r, ["apply"], ["n"])
    expect(res.out).toContain("integrity/executed-tests: 2 -> 1")
    expect(res.out).toContain("The baseline was not updated")
    expect(res.code).toBe(1)
    expect(executed(r)).toBe("2")
  }, TIMEOUT)

  test("with nobody at a terminal, it's refused as before", async () => {
    const r = await narrowed()
    const res = await gauntlet(r, ["apply"])
    expect(res.out).toContain("The baseline was not updated")
    expect(res.code).toBe(1)
    expect(executed(r)).toBe("2")
  }, TIMEOUT)
})
