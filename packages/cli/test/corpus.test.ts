import { describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { cli } from "./harness.ts"
import { INSTALLED_PACKS } from "../src/packs.ts"

// The committed tamper corpus (spec 0002), run against the real fixtures in
// examples/fixtures. Checks skip the gates, so no language toolchain is needed
// and this runs with the ordinary tests. It pins the measured results: a lost
// detection or a new false positive fails here.

const ROOT = join(import.meta.dir, "..", "..", "..")
const CORPUS = join(ROOT, "corpus", "tamper")

describe("the tamper corpus", () => {
  test("every pack has positives and the three negatives", () => {
    for (const pack of readdirSync(CORPUS)) {
      const cases = readdirSync(join(CORPUS, pack))
      expect(cases.length).toBeGreaterThanOrEqual(8)
      for (const negative of ["renamed-test", "extracted-helper", "tightened-assertion"]) expect(cases).toContain(negative)
    }
  })

  test("measured: every positive detected; the only false positives are renamed tests", async () => {
    const res = await cli(["corpus", "--repo", ROOT, "--json"], [...INSTALLED_PACKS])
    const r = JSON.parse(res.out)
    expect(r.total.detected).toBe(r.total.positives)
    expect(r.total.positives).toBe(35)
    const fired = r.cases.filter((c: { kind: string; met: boolean }) => c.kind === "negative" && !c.met).map((c: { pack: string; name: string }) => `${c.pack}/${c.name}`)
    // Renaming a test with its body unchanged reads as a deleted test today: a known false positive, reported as it is.
    expect(fired).toEqual(["clojure", "go", "jvm", "python", "rust", "scala", "typescript"].map((p) => `${p}/renamed-test`))
    expect(r.cases.filter((c: { error?: string }) => c.error !== undefined)).toEqual([])
    expect(res.code).toBe(1)
  }, 120_000)
})
