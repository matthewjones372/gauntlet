import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { baseRepo, cli } from "./harness.ts"

// ADR 0023: a change to comments or documentation only can't change what the
// code does, so nothing is built or run for it; any code change runs as ever.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

const setup = () => {
  const s = baseRepo()
  repos.push(s.r)
  return s
}
const check = async (r: TempRepo, base: string) => {
  const out = join(r.dir, "out")
  const res = await cli(["check", "--repo", r.dir, "--base", base, "--out", out, "--no-record"])
  return { res, report: JSON.parse(readFileSync(join(out, "gauntlet-report.json"), "utf8")) }
}

describe("a change to comments only", () => {
  test("runs no checks, and says why", async () => {
    const { r, base } = setup()
    // The build script would fail: it never runs.
    r.write({ "src/main/App.kt": "// The app.\nclass App\n" })
    r.commit("document the app")
    const { report } = await check(r, base)
    expect(report.checks.every((c: { status: string; reason?: string }) => c.status === "passed" && c.reason === "the change only edits comments or documentation, so there's nothing for this check to run")).toBe(true)
    expect((await cli(["needs-build", "--repo", r.dir, "--policy-ref", base, "--head", "HEAD"])).out).toBe("false")
  })

  test("doesn't ask for approval because no tests ran, and says so in plain words", async () => {
    const { r, base } = setup()
    r.write({ "src/main/App.kt": "// The app.\nclass App\n" })
    r.commit("document the app")
    const out = join(r.dir, "out")
    await cli(["check", "--repo", r.dir, "--base", base, "--out", out, "--no-record"])
    const report = JSON.parse(readFileSync(join(out, "gauntlet-report.json"), "utf8"))
    expect(report.integrity.notExecuted).not.toContain("executed-tests")
    expect(report.integrity.notExecuted).not.toContain("skipped-tests")
    expect(readFileSync(join(out, "gauntlet-report.md"), "utf8")).toContain("only comments or documentation, so nothing needed building or testing.")
  })

  test("a code change runs the checks as ever, and needs building", async () => {
    const { r, base } = setup()
    r.write({ "src/main/App.kt": "class App { fun x() = 1 }\n" })
    r.commit("change the app")
    const { report } = await check(r, base)
    expect(report.checks.find((c: { check: string }) => c.check === "unit").reason).toBeUndefined()
    expect((await cli(["needs-build", "--repo", r.dir, "--policy-ref", base, "--head", "HEAD"])).out).toBe("true")
  })
})

describe("check --ci", () => {
  test("runs the build's tools as .gauntlet/ci.yml at the base says", async () => {
    const s = setup()
    s.r.git("checkout", "-q", "main")
    // The build only passes when run under the wrapper, as a project that needs its CI's setup would.
    s.r.write({ "scripts/build.sh": "test \"$WRAPPED\" = yes\n", ".gauntlet/ci.yml": "builds:\n  .:\n    wrap: env WRAPPED=yes\n" })
    const base = s.r.commit("needs its CI's way of building")
    s.r.git("checkout", "-q", "-b", "change")
    s.r.write({ "src/main/App.kt": "class App { fun x() = 1 }\n" })
    s.r.commit("change")
    const out = join(s.r.dir, "out")
    const build = async (args: string[]) => {
      await cli(["check", "--repo", s.r.dir, "--base", base, "--out", out, "--no-record", ...args])
      return JSON.parse(readFileSync(join(out, "gauntlet-report.json"), "utf8")).checks.find((c: { check: string }) => c.check === "build").status
    }
    expect(await build([])).toBe("failed")
    expect(await build(["--ci"])).toBe("passed")
  })
})
