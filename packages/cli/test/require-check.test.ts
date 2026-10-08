import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { requireCheckRuleset } from "@gauntlet/connect"
import { TempRepo } from "../../core/test/temp-repo.ts"
import { cli } from "./harness.ts"

// Requiring the gauntlet check is something Claude can do for the person with
// the GitHub CLI, instead of sending them to the repository's settings.

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((c) => c()))

/** A stand-in gh that logs its arguments and the ruleset body it's sent. */
const fakeGh = (o: { workflow: boolean; existing?: string }) => {
  const dir = mkdtempSync(join(tmpdir(), "fake-gh-"))
  const log = join(dir, "log")
  writeFileSync(join(dir, "gh"), `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
  "repo view"*) echo octo/svc ;;
  *contents/.github/workflows/gauntlet.yml*) ${o.workflow ? "echo .github/workflows/gauntlet.yml" : "echo 'Not Found' >&2; exit 1"} ;;
  *"-X "*) while [ "$1" != "--input" ]; do shift; done; cat "$2" > "${dir}/body.json"; echo '{}' ;;
  *rulesets*) echo "${o.existing ?? ""}" ;;
esac
`)
  chmodSync(join(dir, "gh"), 0o755)
  const path = process.env.PATH
  process.env.PATH = `${dir}:${path}`
  cleanups.push(() => {
    process.env.PATH = path
    rmSync(dir, { recursive: true, force: true })
  })
  return { calls: () => readFileSync(log, "utf8"), body: () => JSON.parse(readFileSync(join(dir, "body.json"), "utf8")) }
}
const repo = () => {
  const r = new TempRepo()
  cleanups.push(() => r.cleanup())
  return r
}

describe("gauntlet connect github --require-check", () => {
  test("creates a ruleset requiring the gauntlet check on the default branch", async () => {
    const gh = fakeGh({ workflow: true })
    const res = await cli(["connect", "github", "--repo", repo().dir, "--require-check", "--admin-bypass"])
    expect(res.code).toBe(0)
    expect(gh.calls()).toContain("api -X POST repos/octo/svc/rulesets")
    expect(gh.body()).toEqual(requireCheckRuleset({ adminBypass: true }))
    expect(gh.body().rules[0].parameters.required_status_checks).toEqual([{ context: "gauntlet" }])
    expect(res.out).toContain("admins can still push")
  })

  test("updates the gauntlet ruleset when there is one, and without the bypass nobody skips the check", async () => {
    const gh = fakeGh({ workflow: true, existing: "42" })
    const res = await cli(["connect", "github", "--repo", repo().dir, "--require-check"])
    expect(gh.calls()).toContain("api -X PUT repos/octo/svc/rulesets/42")
    expect(gh.body().bypass_actors).toEqual([])
    expect(res.out).toContain("admins included")
  })

  test("refuses while the workflow isn't on the default branch, and creates nothing", async () => {
    const gh = fakeGh({ workflow: false })
    const res = await cli(["connect", "github", "--repo", repo().dir, "--require-check"])
    expect(res.code).toBe(2)
    expect(res.err).toContain("Push it first")
    expect(gh.calls()).not.toContain("-X")
  })
})
