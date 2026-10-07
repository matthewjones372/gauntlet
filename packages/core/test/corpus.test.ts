import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type CaseResult, readCorpus, renderCorpus, score } from "../src/index.ts"

// Spec 0002: reading the corpus, scoring it and reporting the measured rates.

const result = (pack: string, name: string, kind: "positive" | "negative", met: boolean, findings: string[] = []): CaseResult => ({ pack, name, kind, met, findings })

describe("scoring the corpus", () => {
  test("detection and false-positive rates per pack and in total; passed only when every case meets its expectation", () => {
    const cases = [
      result("go", "deleted-test", "positive", true),
      result("go", "added-skip", "positive", false),
      result("go", "renamed-test", "negative", false, ["forbid deleted-tests"]),
      result("go", "extracted-helper", "negative", true),
      result("python", "deleted-test", "positive", true),
      result("python", "renamed-test", "negative", true),
    ]
    const s = score(cases)
    expect(s.packs).toEqual([
      { pack: "go", positives: 2, detected: 1, negatives: 2, falsePositives: 1 },
      { pack: "python", positives: 1, detected: 1, negatives: 1, falsePositives: 0 },
    ])
    expect(s.total).toEqual({ pack: "all", positives: 3, detected: 2, negatives: 3, falsePositives: 1 })
    expect(s.passed).toBe(false)
    expect(score([result("go", "deleted-test", "positive", true)]).passed).toBe(true)
  })

  test("the table shows measured numbers and names each miss", () => {
    const cases = [result("go", "deleted-test", "positive", true), result("go", "added-skip", "positive", false), result("go", "renamed-test", "negative", false, ["forbid deleted-tests", "flag env-branching"])]
    const text = renderCorpus({ cases, ...score(cases) })
    expect(text).toContain("| go | 1/2 | 50% | 1/1 | 100% |")
    expect(text).toContain("- go/added-skip (positive): not detected")
    expect(text).toContain("- go/renamed-test (negative): fired: forbid deleted-tests")
  })
})

describe("reading the corpus", () => {
  test("one case per directory; an unreadable expected.json is reported, not skipped silently", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gauntlet-corpus-read-"))
    const write = (p: string, text: string) => {
      mkdirSync(join(dir, p, ".."), { recursive: true })
      writeFileSync(join(dir, p), text)
    }
    write("go/deleted-test/expected.json", JSON.stringify({ kind: "positive", fixture: "go-service", finding: "deleted-tests" }))
    write("go/renamed-test/expected.json", JSON.stringify({ kind: "negative", fixture: "go-service" }))
    write("go/broken/expected.json", "{ not json")
    const r = await Effect.runPromise(readCorpus(dir).pipe(Effect.provide(BunServices.layer)))
    expect(r.cases.map((c) => `${c.pack}/${c.name}:${c.expected.kind}`)).toEqual(["go/deleted-test:positive", "go/renamed-test:negative"])
    expect(r.problems).toEqual(["go/broken: no readable expected.json"])
  })
})
