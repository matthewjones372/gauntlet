import { afterEach, describe, expect, test } from "bun:test"
import { appendFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { hookCli } from "./agent-harness.ts"
import { baseRepo, cli, POLICY } from "./harness.ts"

// Once the agent has reported it's blocked, the Stop hook mustn't raise the
// same block on every turn while the owner works through their steps. It
// stays quiet while the blocking findings are the ones reported and only the
// owner's (protected, non-test) files changed; anything else blocks again.
// Each test runs several full checks, hence the longer timeouts.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))
const stop = (r: TempRepo) => hookCli(["hook", "stop"], JSON.stringify({ cwd: r.dir }))
const REASON = "Adding needs the AddTest expectation changed for the new rule."

/** A failing change the agent has reported blocked, and the first stop after it. */
const reported = async () => {
  const { r } = baseRepo()
  repos.push(r)
  writeFileSync(join(r.dir, "src/main/behaviour.txt"), "broken add\n")
  expect((await cli(["report", "blocked", "--repo", r.dir, "--reason", REASON])).code).toBe(0)
  expect((await stop(r)).out).toBe("")
  return r
}

describe("a block already waiting on the owner", () => {
  test("stays quiet on later turns while the owner edits their own files", async () => {
    const r = await reported()
    // The owner's step: a protected config file, which the agent can't edit.
    appendFileSync(join(r.dir, "scripts/build.sh"), "# owner's change\n")
    for (let turn = 0; turn < 2; turn++) {
      const out = JSON.parse((await stop(r)).out)
      expect(out.decision).toBeUndefined()
      expect(out.systemMessage).toBe(`Gauntlet: still waiting on the owner: ${REASON}`)
    }
  }, 60_000)

  test("blocks again when the blocking findings change", async () => {
    const r = await reported()
    // The owner's step raises the coverage floor locally: a finding the report didn't cover.
    writeFileSync(join(r.dir, ".gauntlet/policy.gx"), POLICY.replace("coverage >= 80%", "coverage >= 95%"))
    const out = JSON.parse((await stop(r)).out)
    expect(out.decision).toBe("block")
    expect(out.reason).toContain("coverage")
  }, 60_000)

  test("blocks again once the agent edits the change", async () => {
    const r = await reported()
    writeFileSync(join(r.dir, "src/main/behaviour.txt"), "broken add\nand more\n")
    expect(JSON.parse((await stop(r)).out).decision).toBe("block")
  }, 60_000)
})
