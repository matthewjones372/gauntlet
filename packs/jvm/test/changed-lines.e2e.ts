import { BunServices } from "@effect/platform-bun"
import type { GateContext } from "@gauntlet/core"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { ProcessRunnerLive } from "../../../packages/core/src/process-runner.ts"
import { mutation } from "../src/gates.ts"

// Spec 0019, end to end against real Gradle and Pitest on
// examples/fixtures/kotlin-service: with `on changed`, Pitest generates only
// the mutants on the changed lines. The gate runs on its own, so Pitest's
// report is still there to count. Opt in with GAUNTLET_E2E=1, like the pack's
// other end-to-end tests; CI always runs it.

const E2E = process.env.GAUNTLET_E2E === "1"
const FIXTURE = join(import.meta.dir, "..", "..", "..", "examples", "fixtures", "kotlin-service")
const TIMEOUT = 15 * 60 * 1000

/** A Java class with mutants on several lines; the change edits line 6 alone, and no test covers it. */
const rates = (rate: string) => `package svc;

public class Rates {
    public static long fee(long amount) {
        if (amount > 1000) return amount / 100;
        return ${rate};
    }

    public static long cap(long a, long b) {
        return a > b ? b : a;
    }
}
`

let dir = ""
const temps: string[] = []

const mutate = async (edits: Record<string, string>, changed: Record<string, number[]>) => {
  for (const [p, text] of Object.entries(edits)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true })
    writeFileSync(join(dir, p), text)
  }
  const root = mkdtempSync(join(tmpdir(), "gauntlet-out-"))
  temps.push(root)
  const out = join(root, "0-mutation")
  mkdirSync(out)
  const ctx: GateContext = {
    dir,
    outputDir: out,
    collect: Effect.sync(() => readdirSync(out, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => ({ path: join(e.parentPath, e.name).slice(out.length + 1), content: readFileSync(join(e.parentPath, e.name), "utf8") }))),
    ir: { zones: [], arch: [] } as never,
    facts: { addedLines: new Map(Object.entries(changed).map(([p, lines]) => [p, lines.map((line) => ({ line, text: "" }))])) } as never,
    files: readdirSync(dir, { recursive: true }).map(String).filter((p) => /\.(kt|java)$/.test(p) || p === "gradlew").sort(),
    legacy: [],
    scope: Object.keys(changed).sort(),
    changedLinesOnly: true,
  }
  const layer = Layer.mergeAll(ProcessRunnerLive.pipe(Layer.provide(BunServices.layer)), BunServices.layer)
  const r = await Effect.runPromise(mutation({ kind: "gate", name: "mutation" } as never, ctx).pipe(Effect.provide(layer)))
  return { r, lines: [...new Set((r.mutants ?? []).map((m) => `${m.path}:${m.line}`))].sort() }
}

describe.skipIf(!E2E)("Pitest on the changed lines end to end (real Gradle)", () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "gauntlet-lines-"))
    temps.push(dir)
    cpSync(FIXTURE, dir, { recursive: true, filter: (src) => !/\/(build|\.gradle|\.kotlin)(\/|$)/.test(src) })
  })

  afterAll(() => {
    for (const t of temps) rmSync(t, { recursive: true, force: true })
  })

  test("a change to one line of a Kotlin function mutates that line, not the rest of the function", async () => {
    const money = readFileSync(join(FIXTURE, "src/main/kotlin/svc/domain/Money.kt"), "utf8")
    // Line 7 of plus changes; line 6, the require, has mutants of its own.
    const { r, lines } = await mutate({ "src/main/kotlin/svc/domain/Money.kt": money.replace("minor + other.minor", "other.minor + minor") }, { "src/main/kotlin/svc/domain/Money.kt": [7] })
    expect(r.error).toBeUndefined()
    expect(lines).toEqual(["src/main/kotlin/svc/domain/Money.kt:7"])
    expect(r.metrics?.mutation?.value).toBe(100)
  }, TIMEOUT)

  test("a change to one line of a Java class mutates that line alone", async () => {
    const { r, lines } = await mutate({ "src/main/java/svc/Rates.java": rates("2") }, { "src/main/java/svc/Rates.java": [6] })
    expect(r.error).toBeUndefined()
    expect(lines).toEqual(["src/main/java/svc/Rates.java:6"])
    expect(r.runs[0]?.results.map((x) => x.locations?.[0]?.physicalLocation?.region?.startLine)).toEqual([6])
  }, TIMEOUT)
})
