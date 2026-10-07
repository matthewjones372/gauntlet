import { afterEach, describe, expect, test } from "bun:test"
import { emptyBaseline, encodeBaseline } from "@gauntlet/sarif"
import { Effect, Exit, Option } from "effect"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { BASELINE_PATH, BaselineStore, Git, renamesOf } from "../src/index.ts"
import { CoreTest } from "./layers.ts"
import { TempRepo } from "./temp-repo.ts"

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

const run = <A, E>(effect: Effect.Effect<A, E, BaselineStore | Git>) => Effect.runPromiseExit(Effect.provide(effect, CoreTest))

describe("BaselineStore", () => {
  test("reads the base's baseline and ignores an edited head copy", async () => {
    const r = new TempRepo()
    repos.push(r)
    r.write({ [BASELINE_PATH]: encodeBaseline({ ...emptyBaseline("c1", "h1", "0.0.0"), metrics: { mutation: { value: 80, unit: "%", higherIsBetter: true } } }) })
    const base = r.commit("base")
    r.write({ [BASELINE_PATH]: encodeBaseline({ ...emptyBaseline("c2", "h2", "0.0.0"), metrics: { mutation: { value: 10, unit: "%", higherIsBetter: true } } }) })
    r.commit("lower it")
    const exit = await run(BaselineStore.use((s) => s.at(r.dir, base)))
    if (!Exit.isSuccess(exit) || Option.isNone(exit.value)) throw new Error("expected a baseline")
    expect(exit.value.value.metrics.mutation?.value).toBe(80)
  })

  test("no baseline at the ref is none, and a corrupt one is BaselineInvalid", async () => {
    const r = new TempRepo()
    repos.push(r)
    r.write({ "README.md": "x" })
    const before = r.commit("before")
    r.write({ [BASELINE_PATH]: "not sarif" })
    const broken = r.commit("broken")
    expect(await run(BaselineStore.use((s) => s.at(r.dir, before)))).toEqual(Exit.succeed(Option.none()))
    expect(Exit.isFailure(await run(BaselineStore.use((s) => s.at(r.dir, broken))))).toBe(true)
  })

  test("renamesOf maps renamed paths from a real diff", async () => {
    const r = new TempRepo()
    repos.push(r)
    r.write({ "src/Fx.kt": "class Fx {\n  val a = 1\n  val b = 2\n  val c = 3\n}\n" })
    const base = r.commit("base")
    mkdirSync(join(r.dir, "src/money"), { recursive: true })
    r.git("mv", "src/Fx.kt", "src/money/FxConverter.kt")
    const head = r.commit("rename")
    const exit = await run(Git.use((g) => g.diff(r.dir, base, head)).pipe(Effect.map(renamesOf)))
    if (!Exit.isSuccess(exit)) throw new Error(String(exit))
    expect([...exit.value]).toEqual([["src/Fx.kt", "src/money/FxConverter.kt"]])
  })
})
