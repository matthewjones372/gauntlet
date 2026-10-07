import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { diffFacts, type Pack } from "../src/index.ts"
import { compiled } from "./fixtures.ts"
import { CoreTest, testPacks } from "./layers.ts"
import { TempRepo } from "./temp-repo.ts"

const { ir } = compiled(`gauntlet "svc"
use jvm
owners @platform
protect {
  tests "src/test/**"
  config "*.gradle.kts"
}
zone money { paths "src/main/money/**" owner @payments }
suites { unit "src/test/**" }
budget ingest { command "./perf/ingest.sh" p99 < 50ms }
gates { fast { build } perf { budget ingest } }
`)

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

const factsFor = async (r: TempRepo, base: string, head: string, packs: ReadonlyArray<Pack> = testPacks) => {
  const exit = await Effect.runPromiseExit(diffFacts(r.dir, base, head, ir, packs, packs[0]?.runnerConfig ?? []).pipe(Effect.provide(CoreTest)))
  if (Exit.isFailure(exit)) throw new Error(String(exit.cause))
  return exit.value
}

const setup = () => {
  const r = new TempRepo()
  repos.push(r)
  r.write({
    "src/main/money/Fx.kt": "class Fx\n",
    "src/main/Other.kt": "class Other\n",
    "src/test/FxTest.kt": "class FxTest\n",
    "build.gradle.kts": "dependencies {\n  implementation(\"a:b:1\")\n}\n",
    "perf/ingest.sh": "#!/bin/sh\n",
    ".gauntlet/policy.gx": "p\n",
  })
  return { r, base: r.commit("base") }
}

describe("diffFacts", () => {
  test("zones, protected files, line counts and .gauntlet changes", async () => {
    const { r, base } = setup()
    r.write({
      "src/main/money/Fx.kt": "class Fx {\n  val rate = 1\n}\n",
      "src/test/NewTest.kt": "class NewTest\n",
      "src/test/FxTest.kt": "class FxTest // weakened\n",
      ".gauntlet/baseline.sarif": "{}\n",
    })
    const head = r.commit("change")
    const f = await factsFor(r, base, head)
    expect(f.zonesTouched).toEqual([{ zone: "money", files: ["src/main/money/Fx.kt"], owners: ["@payments"] }])
    expect(f.protectedTouched.map((p) => `${p.action} ${p.group} ${p.path}`)).toEqual([
      "removed gauntlet .gauntlet/baseline.sarif",
      "restored tests src/test/FxTest.kt",
      "kept tests src/test/NewTest.kt",
    ])
    expect(f.linesChanged).toBe(4 + 1 + 2 + 1)
    expect(f.baselineChanged).toBe(true)
    expect(f.policyChanged).toBe(false)
    expect(f.gauntletChanged).toBe(true)
    expect(f.addedLines.get("src/main/money/Fx.kt")?.map((l) => l.line)).toEqual([1, 2, 3])
  })

  test("a file renamed out of a zone still touches the zone", async () => {
    const { r, base } = setup()
    mkdirSync(join(r.dir, "src/main/misc"), { recursive: true })
    r.git("mv", "src/main/money/Fx.kt", "src/main/misc/Fx.kt")
    const head = r.commit("move out of the zone")
    expect((await factsFor(r, base, head)).zonesTouched.map((z) => z.files)).toEqual([["src/main/money/Fx.kt"]])
  })

  test("without a parser, an added manifest line may be a new dependency", async () => {
    const { r, base } = setup()
    r.write({ "build.gradle.kts": "dependencies {\n  implementation(\"a:b:1\")\n  implementation(\"evil:lib:6.6.6\")\n}\n" })
    const head = r.commit("add dependency")
    expect((await factsFor(r, base, head)).dependencyChanges).toEqual([{ manifest: "build.gradle.kts", added: [], removed: [], unparsed: true }])
  })

  test("with a parser, only real additions count", async () => {
    const parse = (_: string, text: string) => [...text.matchAll(/implementation\("([^"]+)"\)/g)].map((m) => m[1]!)
    const packs = testPacks.map((p) => ({ ...p, dependencies: parse }))
    const { r, base } = setup()
    r.write({ "build.gradle.kts": "dependencies {\n  // a comment\n  implementation(\"a:b:1\")\n}\n" })
    const noDep = r.commit("comment only")
    expect((await factsFor(r, base, noDep, packs)).dependencyChanges).toEqual([])
    r.write({ "build.gradle.kts": "dependencies {\n  implementation(\"a:b:2\")\n}\n" })
    const bumped = r.commit("bump")
    expect((await factsFor(r, base, bumped, packs)).dependencyChanges).toEqual([{ manifest: "build.gradle.kts", added: ["a:b:2"], removed: ["a:b:1"], unparsed: false }])
  })

  test("editing a budget's script is a budget change", async () => {
    const { r, base } = setup()
    r.write({ "perf/ingest.sh": "#!/bin/sh\nexit 0\n" })
    const head = r.commit("neuter the perf script")
    expect((await factsFor(r, base, head)).budgetsChanged).toEqual(["ingest"])
  })
})
