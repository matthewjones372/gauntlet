import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { renderStopHookCorpus, runStopHookCorpus } from "../src/index.ts"
import { CoreTest } from "./layers.ts"

// The stop-hook corpus (ADR 0026) as data: a case that can't be read misses
// rather than vanishing, and the table says which cases missed.

const LIMITS = { unchanged: 3, total: 5 }

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

const corpus = (cases: Record<string, string | undefined>) => {
  const dir = mkdtempSync(join(tmpdir(), "gauntlet-stop-hook-corpus-"))
  dirs.push(dir)
  for (const [name, text] of Object.entries(cases)) {
    mkdirSync(join(dir, name))
    if (text !== undefined) writeFileSync(join(dir, name, "case.json"), text)
  }
  return dir
}

const run = (dir: string) => Effect.runPromise(runStopHookCorpus(dir, LIMITS).pipe(Effect.provide(CoreTest)))

describe("runStopHookCorpus", () => {
  test("a case without a readable case.json misses, and fails the corpus", async () => {
    const r = await run(corpus({
      "control": `{"tamper":"none","expect":"blocked"}`,
      "no-file": undefined,
      "not-json": "{ tamper",
      "unknown-tamper": `{"tamper":"rewrite-history","expect":"exhausted"}`,
    }))
    expect(r.cases).toEqual([
      { name: "control", tamper: "none", expect: "blocked", status: "blocked", met: true },
      { name: "no-file", tamper: "-", expect: "-", status: "-", met: false, error: "no readable case.json" },
      { name: "not-json", tamper: "-", expect: "-", status: "-", met: false, error: "no readable case.json" },
      { name: "unknown-tamper", tamper: "-", expect: "-", status: "-", met: false, error: "no readable case.json" },
    ])
    expect(r.passed).toBe(false)
  }, 60_000)

  test("a case whose expectation is wrong misses; an empty corpus doesn't pass", async () => {
    const r = await run(corpus({ "wrong": `{"tamper":"delete-record","expect":"blocked"}` }))
    expect(r.cases).toEqual([{ name: "wrong", tamper: "delete-record", expect: "blocked", status: "exhausted", met: false }])
    expect(r.passed).toBe(false)
    expect((await run(corpus({}))).passed).toBe(false)
  }, 60_000)
})

describe("renderStopHookCorpus", () => {
  test("one row per case, a missed case marked, its error in place of a status", () => {
    const text = renderStopHookCorpus({
      cases: [
        { name: "control", tamper: "none", expect: "blocked", status: "blocked", met: true },
        { name: "broken", tamper: "-", expect: "-", status: "-", met: false, error: "no readable case.json" },
      ],
      passed: false,
    })
    expect(text.split("\n")).toEqual([
      "| Case | Tampering | Expected | Got |",
      "| --- | --- | --- | --- |",
      "| control | none | blocked | blocked |",
      "| broken | - | - | no readable case.json **(missed)** |",
      "",
      "Some cases missed their expectation.",
    ])
  })

  test("says when every case met its expectation", () => {
    const text = renderStopHookCorpus({ cases: [{ name: "control", tamper: "none", expect: "blocked", status: "blocked", met: true }], passed: true })
    expect(text.endsWith("All 1 cases met their expectation.")).toBe(true)
  })
})
