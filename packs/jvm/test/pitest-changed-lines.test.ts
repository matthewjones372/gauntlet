import { BunServices } from "@effect/platform-bun"
import { type GateContext, ProcessRunner, type RunRequest } from "@gauntlet/core"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { mutation } from "../src/gates.ts"
import { pitestLines, pitestTasks } from "../src/sources.ts"

// Spec 0019: with `on changed`, Pitest gets Gauntlet's filter and the file of
// changed lines, and only the touched modules' pitest tasks run.

const SOURCES: Record<string, string> = {
  gradlew: "#!/bin/sh\n",
  "app/src/main/kotlin/svc/domain/Money.kt": "package svc.domain\n\nclass Money(val cents: Long) {\n    fun plus(o: Money) = Money(cents + o.cents)\n}\n",
  "lib/src/main/java/svc/Fx.java": "package svc;\n\nclass Fx {\n    int rate() { return 1; }\n}\n",
}

const MUTATIONS = `<mutations><mutation detected="false" status="SURVIVED"><sourceFile>Money.kt</sourceFile><mutatedClass>svc.domain.Money</mutatedClass><mutatedMethod>plus</mutatedMethod><lineNumber>4</lineNumber><description>replaced Long addition with subtraction</description></mutation></mutations>`

/** A checkout, and a Gradle that writes a Pitest report; `missing` names tasks it says aren't there. */
const setUp = (opts: { changedLinesOnly?: boolean; missing?: string } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "gauntlet-pitest-"))
  for (const [p, t] of Object.entries(SOURCES)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true })
    writeFileSync(join(dir, p), t)
  }
  const out = join(mkdtempSync(join(tmpdir(), "gauntlet-out-")), "0-mutation")
  mkdirSync(out)
  const calls: RunRequest[] = []
  const runner = Layer.succeed(ProcessRunner, {
    run: (r) =>
      Effect.sync(() => {
        calls.push(r)
        if (opts.missing && r.args.includes(opts.missing)) {
          return { exitCode: 1, stdout: "", stderr: `* What went wrong:\nCannot locate tasks that match '${opts.missing}' as task 'pitest' not found in project ':lib'.\n` }
        }
        const report = join(r.env!.GAUNTLET_OUT!, "pitest/app/mutations.xml")
        mkdirSync(dirname(report), { recursive: true })
        writeFileSync(report, MUTATIONS)
        return { exitCode: 0, stdout: "", stderr: "" }
      }),
  })
  const ctx: GateContext = {
    dir,
    outputDir: out,
    collect: Effect.sync(() => readdirSync(out, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => ({ path: join(e.parentPath, e.name).slice(out.length + 1), content: readFileSync(join(e.parentPath, e.name), "utf8") }))),
    ir: { zones: [], arch: [] } as never,
    facts: { addedLines: new Map([["app/src/main/kotlin/svc/domain/Money.kt", [{ line: 4, text: "" }]], ["lib/src/main/java/svc/Fx.java", [{ line: 4, text: "" }]]]) } as never,
    files: Object.keys(SOURCES).sort(),
    legacy: [],
    scope: Object.keys(SOURCES).filter((p) => p.includes("/src/main/")).sort(),
    ...(opts.changedLinesOnly === false ? {} : { changedLinesOnly: true }),
  }
  const run = <A, E, R>(e: Effect.Effect<A, E, R>) => Effect.runPromise(e.pipe(Effect.provide(Layer.mergeAll(runner, BunServices.layer))) as Effect.Effect<A, E, never>)
  return { ctx, calls, run }
}

describe("Pitest on the changed lines", () => {
  test("a filter entry is the package the file declares, its name and the line", () => {
    const files = [{ path: "app/src/main/kotlin/money/Money.kt", text: "package svc.domain\n\nclass Money\n" }, { path: "src/main/kotlin/Top.kt", text: "fun top() = 1\n" }]
    const lines = new Map([["app/src/main/kotlin/money/Money.kt", new Set([3, 1])], ["src/main/kotlin/Top.kt", new Set([1])]])
    expect(pitestLines(files, lines)).toEqual(["Top.kt:1", "svc/domain/Money.kt:1", "svc/domain/Money.kt:3"])
  })

  test("each touched module's pitest task, by the path before src/main", () => {
    expect(pitestTasks(["app/src/main/kotlin/A.kt", "libs/core/src/main/java/B.java", "src/main/kotlin/C.kt", "app/src/main/kotlin/D.kt"]))
      .toEqual([":app:pitest", ":libs:core:pitest", ":pitest"])
  })

  test("on changed, Pitest gets the filter, the changed lines, and the touched modules' tasks", async () => {
    const g = setUp()
    const r = await g.run(mutation({ kind: "gate", name: "mutation" } as never, g.ctx))
    expect(g.calls).toHaveLength(1)
    expect(g.calls[0]!.args.slice(-2)).toEqual([":app:pitest", ":lib:pitest"])
    const env = g.calls[0]!.env!
    const file = /^\+gauntletlines\(file\[(.+)\]\)$/.exec(env.GAUNTLET_PITEST_FEATURE!)![1]!
    expect(readFileSync(file, "utf8")).toBe("svc/Fx.java:4\nsvc/domain/Money.kt:4\n")
    expect(existsSync(join(env.GAUNTLET_PITEST_FILTER!, "gauntlet/ChangedLines.class"))).toBe(true)
    expect(readFileSync(join(env.GAUNTLET_PITEST_FILTER!, "META-INF/services/org.pitest.mutationtest.build.MutationInterceptorFactory"), "utf8")).toBe("gauntlet.ChangedLines\n")
    expect(r.metrics?.mutation?.value).toBe(0)
  })

  test("without on changed, Pitest mutates whole classes with no filter", async () => {
    const g = setUp({ changedLinesOnly: false })
    await g.run(mutation({ kind: "gate", name: "mutation" } as never, g.ctx))
    expect(g.calls[0]!.env!.GAUNTLET_PITEST_FEATURE).toBeUndefined()
    expect(g.calls[0]!.env!.GAUNTLET_PITEST_FILTER).toBeUndefined()
  })

  test("when Gradle can't find a module's task, the root pitest task runs instead", async () => {
    const g = setUp({ missing: ":lib:pitest" })
    const r = await g.run(mutation({ kind: "gate", name: "mutation" } as never, g.ctx))
    expect(g.calls.map((c) => c.args.at(-1))).toEqual([":lib:pitest", "pitest"])
    expect(r.error).toBeUndefined()
    expect(r.metrics?.mutation?.value).toBe(0)
  })
})
