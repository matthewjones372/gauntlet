import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { build, hostTarget, TARGETS } from "../../../scripts/build.ts"
import { smoke } from "../../../scripts/smoke.ts"

// The release binary for this machine, compiled and driven through the smoke
// test, on every test run. CI does the same on each release platform.

const dist = mkdtempSync(join(tmpdir(), "gauntlet-dist-"))
afterAll(() => rmSync(dist, { recursive: true, force: true }))
const host = hostTarget()

describe.skipIf(!host)("the compiled binary", () => {
  test("builds reproducibly, with a checksum, and passes the smoke test", async () => {
    const sum = build([host!], dist)[0]!
    expect(sum).toMatch(new RegExp(`^[0-9a-f]{64}  gauntlet-${host}$`))
    expect(readFileSync(join(dist, "checksums.txt"), "utf8")).toBe(`${sum}\n`)
    expect(build([host!], dist)).toEqual([sum])
    const log: string[] = []
    expect(await smoke(join(dist, `gauntlet-${host}`), (l) => log.push(l))).toEqual([])
    expect(log.length).toBeGreaterThanOrEqual(10)
  }, 120_000)

  test("a binary that fails a step is reported, with its output", async () => {
    const failures = await smoke("/usr/bin/false", () => {})
    expect(failures.length).toBeGreaterThan(5)
    expect(failures[0]).toStartWith("--version: exit 1")
  }, 60_000)
})

test("the release targets", () => {
  expect(TARGETS).toEqual(["darwin-arm64", "darwin-x64", "linux-x64"])
  expect(() => build([], dist)).not.toThrow()
})
