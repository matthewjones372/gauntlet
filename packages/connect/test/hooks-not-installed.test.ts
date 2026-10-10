import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HOOKS, INSTALL_COMMAND } from "../src/claude-code.ts"

// Claude Code's settings are committed, so a teammate runs Gauntlet's hooks
// before they may have installed it. With it, the hooks run it and its exit
// code (2 blocks) passes through. Without it, the check says so with the
// install command instead of failing unseen, and the edit hook stays quiet.

const run = (command: string, path: string) => spawnSync("sh", ["-c", command], { input: "{}", encoding: "utf8", env: { PATH: path } })
const [stop, beforeWrite] = [HOOKS.find((h) => h.event === "stop")!, HOOKS.find((h) => h.event === "before-write")!]

const fakeGauntlet = () => {
  const bin = mkdtempSync(join(tmpdir(), "bin-"))
  writeFileSync(join(bin, "gauntlet"), `#!/bin/sh\necho "ran gauntlet $*"\nexit 2\n`)
  chmodSync(join(bin, "gauntlet"), 0o755)
  return `${bin}:/usr/bin:/bin`
}

describe("Gauntlet's hooks on a machine without it", () => {
  test("with Gauntlet installed, the hooks run it and its exit code passes through", () => {
    const path = fakeGauntlet()
    expect(run(stop.command, path)).toMatchObject({ status: 2, stdout: "ran gauntlet hook stop\n" })
    expect(run(beforeWrite.command, path)).toMatchObject({ status: 2, stdout: "ran gauntlet hook pre-tool-use\n" })
  })

  test("without it, the check says so with the install command, and doesn't block", () => {
    const r = run(stop.command, "/usr/bin:/bin")
    expect(r.status).toBe(1)
    expect(r.stderr).toBe(`Gauntlet isn't installed on this machine, so this work wasn't checked. Install it with: ${INSTALL_COMMAND}\n`)
  })

  test("without it, the edit hook stays quiet and lets the edit through", () => {
    expect(run(beforeWrite.command, "/usr/bin:/bin")).toMatchObject({ status: 0, stdout: "", stderr: "" })
  })

  test("setup still recognises its own hooks on a re-run", () => {
    for (const h of HOOKS) expect(h.command).toContain("gauntlet hook ")
  })
})
