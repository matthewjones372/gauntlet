import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { compilerWarningsRun, explainPolicy, type GateContext, type GateRun, ProcessRunner, type RunRequest } from "@gauntlet/core"
import { compilePolicy } from "@gauntlet/dsl"
import { Effect, Layer } from "effect"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { spec } from "../src/catalog.ts"
import { isBuildDefinition, scalacDeadCode, unusedWarningsOn } from "../src/deadcode.ts"
import { deadCode } from "../src/gates.ts"
import { onboard } from "../src/onboard.ts"

// Spec 0017 §4, the Scala pack: scalac's unused warnings as dead-code
// findings, from the build's compile as the warnings check reads them. The
// fixtures are sbt output written by hand in scalac's formats (as the
// warnings check's tests are): Scala 2.13 with -Wunused:all -Wdead-code, and
// Scala 3.7 with -Wunused:all, for the same unused import, private val,
// local val, parameter and pattern variable, beside a deprecation and a var
// never updated, which aren't dead code.

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", "scalac", name), "utf8")
const scala2 = fixture("sbt-scala-2.13-wunused.txt")
const scala3 = fixture("sbt-scala-3-wunused.txt")

const summary = (run: { results: ReadonlyArray<{ ruleId: string; message: { text: string }; locations?: ReadonlyArray<{ physicalLocation?: { artifactLocation?: { uri: string }; region?: { startLine?: number } } }> }> }) =>
  run.results.map((r) => ({ ruleId: r.ruleId, message: r.message.text, path: r.locations?.[0]?.physicalLocation?.artifactLocation?.uri, line: r.locations?.[0]?.physicalLocation?.region?.startLine }))
const at = (kind: string, message: string, line: number) => ({ ruleId: `dead-code/${kind}`, message, path: "src/main/scala/svc/Money.scala", line })

describe("scalac's unused warnings as dead code", () => {
  test("Scala 2: each unused warning is a finding of its kind; deprecations and vars never updated aren't", () => {
    const run = scalacDeadCode([compilerWarningsRun("scalac", scala2, "/repo")])
    expect(run.tool.driver.name).toBe("scalac")
    expect(summary(run)).toEqual([
      at("unused-import", "Unused import", 3),
      at("unused-private", "private val rate in object Money is never used", 8),
      at("unused-private", "private method helper in object Money is never used", 10),
      at("unused-local", "local val unused in method add is never used", 13),
      at("unused-parameter", "parameter ctx in method handle is never used", 17),
      at("unused-pattern-variable", "pattern var rest in method head is never used: use a wildcard `_` or suppress this warning with `rest@_`", 20),
      at("unreachable-code", "dead code following this construct", 24),
    ])
    expect(run.results.every((r) => r.level === "warning")).toBe(true)
  })

  test("Scala 3: the same kinds, from its Unused Symbol Warnings", () => {
    expect(summary(scalacDeadCode([compilerWarningsRun("scalac", scala3, "/repo")]))).toEqual([
      at("unused-import", "unused import", 3),
      at("unused-private", "unused private member", 8),
      at("unused-local", "unused local definition", 13),
      at("unused-parameter", "unused explicit parameter", 17),
      at("unused-parameter", "unused implicit parameter", 18),
      at("unused-pattern-variable", "unused pattern variable", 21),
    ])
  })

  test("only scalac's runs are read", () => {
    expect(scalacDeadCode([{ tool: { driver: { name: "scalafix" } }, results: [{ ruleId: "RemoveUnused", level: "warning", message: { text: "Unused import" } }] }]).results).toEqual([])
  })
})

describe("whether the build turns the unused warnings on", () => {
  const on = (text: string) => unusedWarningsOn([{ text }])

  test("-Wunused, -Ywarn-unused, -Xlint or sbt-tpolecat", () => {
    expect(on(`scalacOptions ++= Seq("-deprecation", "-Wunused:all")`)).toBe(true)
    expect(on(`scalacOptions += "-Wunused:imports,privates,locals"`)).toBe(true)
    expect(on(`scalacOptions += "-Ywarn-unused"`)).toBe(true)
    expect(on(`scalacOptions += "-Xlint"`)).toBe(true)
    expect(on(`addSbtPlugin("org.typelevel" % "sbt-tpolecat" % "0.5.2")`)).toBe(true)
  })

  test("not otherwise, nor when it's commented out", () => {
    expect(on(`scalacOptions += "-deprecation"`)).toBe(false)
    expect(on(`// scalacOptions += "-Wunused:all"`)).toBe(false)
  })

  test("read from every .sbt file and the Scala under project/", () => {
    expect(["build.sbt", "core/build.sbt", "project/plugins.sbt", "project/Settings.scala", "src/main/scala/A.scala", "target/streams/x.sbt"].filter(isBuildDefinition))
      .toEqual(["build.sbt", "core/build.sbt", "project/plugins.sbt", "project/Settings.scala"])
  })
})

const ON = "scalaVersion := \"3.7.3\"\nscalacOptions += \"-Wunused:all\"\n"

/** The gate over a checkout whose build.sbt is `sbt`, with a scripted sbt that prints `stdout`. */
const setup = (sbt: string, stdout: (dir: string) => string, exitCode = 0) => {
  const dir = mkdtempSync(join(tmpdir(), "scala-dead-"))
  const files = { "build.sbt": sbt, "src/main/scala/svc/Money.scala": "package svc\n" }
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true })
    writeFileSync(join(dir, p), t)
  }
  const out = join(mkdtempSync(join(tmpdir(), "scala-dead-out-")), "0-check")
  mkdirSync(out)
  const ctx: GateContext = {
    dir, outputDir: out,
    collect: Effect.sync(() => readdirSync(out).map((name) => ({ path: name, content: readFileSync(join(out, name), "utf8") }))),
    ir: { zones: [], arch: [] } as never, facts: { addedLines: new Map() } as never, files: Object.keys(files).sort(), legacy: [],
  }
  const calls: RunRequest[] = []
  const layer = Layer.mergeAll(Layer.succeed(ProcessRunner, { run: (r) => Effect.sync(() => (calls.push(r), { exitCode, stdout: stdout(dir), stderr: "" })) }), BunServices.layer)
  const run = (c: GateContext = ctx) => Effect.runPromise(deadCode({ kind: "gate", name: "dead-code", ratchet: true, scope: "all" }, c).pipe(Effect.provide(layer)) as Effect.Effect<GateRun, never, never>)
  return { ctx, calls, run, out }
}
const withDir = (dir: string) => scala3.replaceAll("/repo/", `${dir}/`)

describe("the dead-code gate", () => {
  test("reads the build's warnings when a build ran in this check, without compiling", async () => {
    const s = setup(ON, withDir)
    const r = await s.run({ ...s.ctx, buildWarnings: [compilerWarningsRun("scalac", scala3, "/repo")] })
    expect(s.calls).toEqual([])
    expect(r.error).toBeUndefined()
    expect(r.command).toEqual(["(the build check's compiler output)"])
    expect(r.runs[0]!.results).toHaveLength(6)
    expect(existsSync(join(s.out, "dead-code.sarif"))).toBe(true)
  })

  test("compiles itself when no build ran", async () => {
    const s = setup(ON, withDir)
    const r = await s.run()
    expect(s.calls.length).toBeGreaterThan(0)
    expect(r.error).toBeUndefined()
    expect(summary(r.runs[0]!).map((x) => x.ruleId)).toEqual(["dead-code/unused-import", "dead-code/unused-private", "dead-code/unused-local", "dead-code/unused-parameter", "dead-code/unused-parameter", "dead-code/unused-pattern-variable"])
  })

  test("a build that doesn't turn the unused warnings on is an error naming the option, not a pass", async () => {
    const s = setup("scalaVersion := \"3.7.3\"\n", withDir)
    const r = await s.run()
    expect(r.error).toBe("scalac's unused warnings are off: add scalacOptions += \"-Wunused:all\" to build.sbt (Scala 2.13 or 3.3+; -Ywarn-unused on 2.12)")
    expect(r.notSetUp).toBe(true)
    expect(s.calls).toEqual([])
  })

  test("code that doesn't compile is an error: its warnings can't be read", async () => {
    const r = await setup(ON, () => "[error] /x/Money.scala:1:1: not found: value y\n", 1).run()
    expect(r.error).toBe("the code doesn't compile, so its warnings can't be read")
  })
})

describe("the policy language", () => {
  const compile = (gates: string) => compilePolicy({ file: ".gauntlet/policy.gx", text: `gauntlet "svc"\nuse scala\nmode enforce\nowners @p\ngates { fast { ${gates} } }\nreview { auto when all gates pass }\n` }, [spec])

  test("accepts `dead-code`, `dead-code ratchet` and `dead-code advise on changed`", () => {
    for (const gates of ["build, dead-code", "build, dead-code ratchet", "dead-code advise on changed"]) {
      const c = compile(gates)
      if (c._tag === "Invalid") throw new Error(`'${gates}' didn't compile: ${JSON.stringify(c.diagnostics)}`)
      expect(c.compiled.ir.gates[0]!.checks.some((x) => x.kind === "gate" && x.name === "dead-code")).toBe(true)
    }
  })

  test("explain says what a dead-code ratchet holds", () => {
    const c = compile("build, dead-code ratchet")
    if (c._tag === "Invalid") throw new Error("didn't compile")
    expect(explainPolicy(c.compiled.ir, "gates")).toContain("dead-code and no worse than the baseline")
  })
})

describe("setting up", () => {
  const view = (files: Record<string, string>) => ({ files: Object.keys(files).sort(), read: (p: string) => files[p] })

  test("init drafts `dead-code ratchet` when the build already turns the unused warnings on", () => {
    expect(onboard(view({ "build.sbt": ON, "src/main/scala/A.scala": "" })).fast).toEqual(["build", "dead-code ratchet"])
    expect(onboard(view({ "build.sbt": "", "project/plugins.sbt": `addSbtPlugin("org.typelevel" % "sbt-tpolecat" % "0.5.2")\n`, "src/main/scala/A.scala": "" })).fast).toContain("dead-code ratchet")
  })

  test("and not otherwise", () => {
    expect(onboard(view({ "build.sbt": "scalaVersion := \"3.7.3\"\n", "src/main/scala/A.scala": "" })).fast).toEqual(["build"])
  })
})
