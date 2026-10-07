import { describe, expect, test } from "bun:test"
import { PolicyIR, sourceRef } from "@gauntlet/ir"
import { Effect, Exit, Layer, Schema } from "effect"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Catalog, Compiler, CompilerLive } from "../src/index.ts"
import { installed } from "./fixtures/catalog.ts"

const TestCompiler = CompilerLive.pipe(Layer.provide(Catalog.layer(installed)))
const run = <A, E>(effect: Effect.Effect<A, E, Compiler>) => Effect.runPromiseExit(Effect.provide(effect, TestCompiler))
const example = readFileSync(join(import.meta.dir, "..", "..", "..", "examples", "policies", "valid", "trade-reporting.gx"), "utf8")

describe("Compiler service", () => {
  test("compiles a valid policy to IR that decodes with the PolicyIR schema", async () => {
    const exit = await run(Compiler.use((c) => c.compile({ file: ".gauntlet/policy.gx", text: example })))
    expect(Exit.isSuccess(exit)).toBe(true)
    if (!Exit.isSuccess(exit)) return
    const decoded = Schema.decodeUnknownSync(PolicyIR)(exit.value.ir)
    expect(decoded.name).toBe("trade-reporting")
    expect(decoded.protect.some((g) => g.kind === "gauntlet" && g.globs.includes(".gauntlet/**"))).toBe(true)
  })

  test("source map lets every review rule and zone cite its line", async () => {
    const exit = await run(Compiler.use((c) => c.compile({ file: ".gauntlet/policy.gx", text: example })))
    if (!Exit.isSuccess(exit)) throw new Error("expected success")
    const { ir, sourceMap } = exit.value
    ir.review.forEach((_, i) => {
      const ref = sourceRef(sourceMap, `/review/${i}`)
      expect(ref?.text).toMatch(/ when /)
    })
    expect(sourceRef(sourceMap, "/zones/0")?.text).toBe("zone money {")
  })

  test("fails with PolicyInvalid carrying located diagnostics", async () => {
    const exit = await run(Compiler.use((c) => c.compile({ file: "p.gx", text: `gauntlet "x"\nmode lax\n` })))
    expect(Exit.isFailure(exit)).toBe(true)
    const error = Exit.isFailure(exit) ? exit.cause.reasons.find((r) => r._tag === "Fail") : undefined
    expect(error && "error" in error ? (error.error as { _tag: string })._tag : undefined).toBe("PolicyInvalid")
  })

  test("a repository file list makes overlap checks exact", async () => {
    const text = `gauntlet "x"\nuse jvm\nowners @p\ngates { fast { build } }\nzone money { paths "src/*/money/**" }\nprotect { tests "src/*/money/test/**" }\n`
    const conservative = await run(Compiler.use((c) => c.compile({ file: "p.gx", text })))
    expect(Exit.isFailure(conservative)).toBe(true)
    const exact = await run(Compiler.use((c) => c.compile({ file: "p.gx", text, files: ["src/main/money/Fx.kt"] })))
    expect(Exit.isSuccess(exact)).toBe(true)
  })
})

describe("glob-matches-nothing", () => {
  test("warns only when a repository file list is given", async () => {
    const text = `gauntlet "x"\nuse jvm\nowners @p\ngates { fast { build } }\nprotect { tests "src/tset/**" }\n`
    const without = await run(Compiler.use((c) => c.compile({ file: "p.gx", text })))
    const withFiles = await run(Compiler.use((c) => c.compile({ file: "p.gx", text, files: ["src/test/ATest.kt"] })))
    if (!Exit.isSuccess(without) || !Exit.isSuccess(withFiles)) throw new Error("expected success")
    expect(without.value.diagnostics.some((d) => d.code === "glob-matches-nothing")).toBe(false)
    expect(withFiles.value.diagnostics.find((d) => d.code === "glob-matches-nothing")?.message).toContain("src/tset/**")
  })
})
