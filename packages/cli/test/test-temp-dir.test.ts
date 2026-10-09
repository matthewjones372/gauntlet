import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { alive, isolateRun, RUN_PREFIX, startRun, sweepDeadRuns } from "../../../scripts/test-temp-dir.ts"

// Test runs leave nothing in the temporary directory: each run works in its
// own directory, and one killed before it cleaned up is removed by the next.

describe("test run temporary directories", () => {
  test("a run's directory is named after its process", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"))
    const dir = startRun(root, 4242)
    expect(dir.startsWith(join(root, `${RUN_PREFIX}4242-`))).toBe(true)
    expect(existsSync(dir)).toBe(true)
  })

  test("runs whose process is gone are removed, running ones and other directories kept", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"))
    mkdirSync(join(root, `${RUN_PREFIX}111-aaaaaa`, "checkout"), { recursive: true })
    writeFileSync(join(root, `${RUN_PREFIX}111-aaaaaa`, "checkout", "f"), "x")
    mkdirSync(join(root, `${RUN_PREFIX}222-bbbbbb`))
    mkdirSync(join(root, `${RUN_PREFIX}not-a-pid`))
    mkdirSync(join(root, "someone-else"))
    const removed = sweepDeadRuns(root, (pid) => pid === 222)
    expect(removed).toEqual([`${RUN_PREFIX}111-aaaaaa`])
    expect(readdirSync(root).sort()).toEqual([`${RUN_PREFIX}222-bbbbbb`, `${RUN_PREFIX}not-a-pid`, "someone-else"])
  })

  test("this process is alive, a finished one is not", () => {
    expect(alive(process.pid)).toBe(true)
    const done = Bun.spawnSync(["true"])
    expect(alive(done.pid)).toBe(false)
  })

  test("a process owned by someone else counts as alive, a bad process id is an error", () => {
    expect(alive(1)).toBe(true)
    expect(() => alive(Number.NaN)).toThrow()
  })

  test("a run points the temporary directory at its own directory and removes it at the end", () => {
    const root = mkdtempSync(join(tmpdir(), "runs-"))
    const before = process.env.TMPDIR
    let cleanup: (() => void) | undefined
    try {
      const dir = isolateRun(root, (f) => { cleanup = f })
      expect(process.env.TMPDIR).toBe(dir)
      expect(existsSync(dir)).toBe(true)
      cleanup?.()
      expect(existsSync(dir)).toBe(false)
    } finally {
      if (before === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = before
    }
  })
})
