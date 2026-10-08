import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { type GateContext, ProcessRunner, type RunRequest } from "@gauntlet/core"
import type { Check } from "@gauntlet/ir"
import { Effect, Layer } from "effect"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { arch, build, coverage, lint, mutation, runSuite } from "../src/gates.ts"

// The Scala gates with a scripted process runner: what sbt is asked to do, and
// how the gates read what the tools write. The real tools are covered by the
// end-to-end test.

const FILES: Record<string, string> = {
  "build.sbt": "scalaVersion := \"3.10.0\"\n",
  "stryker4s.conf": "stryker4s.excluded-mutations = [\"StringLiteral\"]\n",
  "src/main/scala/svc/domain/Money.scala": "package svc.domain\n\nimport svc.infra.Ledger\n\nobject Money:\n  def add(a: Long, b: Long): Long = a + b\n",
  "src/main/scala/svc/domain/Types.scala": "package svc.domain\n\nfinal case class Id(value: String)\n",
  "src/test/scala/svc/domain/MoneySpec.scala": "package svc.domain\n\nimport org.scalatest.funsuite.AnyFunSuite\n\nclass MoneySpec extends AnyFunSuite:\n  test(\"adds\") {\n    assert(Money.add(1, 2) == 3)\n  }\n",
}

// The thin client gets one command line; every call starts from the build as written.
const commandsOf = (r: RunRequest) => r.args[1]!.split("; ").slice(2)

type Handler = (commands: string[], dir: string, out: string) => { exitCode?: number; stdout?: string; stderr?: string }

const gate = (handler: Handler, scope?: string[], added: Record<string, number[]> = {}, ir: object = { zones: [], arch: [] }) => {
  const dir = mkdtempSync(join(tmpdir(), "gauntlet-scala-gate-"))
  for (const [p, t] of Object.entries(FILES)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true })
    writeFileSync(join(dir, p), t)
  }
  const out = join(mkdtempSync(join(tmpdir(), "gauntlet-scala-out-")), "0-check")
  mkdirSync(out)
  const ctx: GateContext = {
    dir,
    outputDir: out,
    collect: Effect.sync(() => readdirSync(out, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => ({ path: join(e.parentPath, e.name).slice(out.length + 1), content: readFileSync(join(e.parentPath, e.name), "utf8") }))),
    ir: ir as never,
    facts: { addedLines: new Map(Object.entries(added).map(([p, ls]) => [p, ls.map((line) => ({ line, text: (FILES[p] ?? "").split("\n")[line - 1] ?? "" }))])) } as never,
    ...(scope ? { scope } : {}),
    files: Object.keys(FILES).sort(),
    legacy: [],
  }
  const calls: RunRequest[] = []
  const layer = Layer.mergeAll(Layer.succeed(ProcessRunner, {
    run: (r) => Effect.sync(() => {
      calls.push(r)
      const res = handler(commandsOf(r), dir, out)
      return { exitCode: res.exitCode ?? 0, stdout: res.stdout ?? "", stderr: res.stderr ?? "" }
    }),
  }), BunServices.layer)
  const run = <A, E, R>(e: Effect.Effect<A, E, R>) => Effect.runPromise(e.pipe(Effect.provide(layer)) as Effect.Effect<A, E, never>)
  return { ctx, dir, calls, run, commands: () => commandsOf(calls.at(-1)!) }
}

const GATE = { kind: "gate", name: "x", ratchet: false, scope: "all" } as Extract<Check, { kind: "gate" }>
const JUNIT = `<testsuite name="svc.domain.MoneySpec" tests="1"><testcase classname="svc.domain.MoneySpec" name="adds"><failure message="2 did not equal 3"/></testcase></testsuite>`

describe("Scala gates", () => {
  test("every gate talks to the check's sbt server, starting from the build as written", async () => {
    const g = gate(() => ({}))
    await g.run(build(GATE, g.ctx))
    const call = g.calls[0]!
    expect([call.command, ...call.args]).toEqual(["sbt", "--client", "session clear-all; reload; Test/compile"])
    expect(call.cwd).toBe(g.dir)
    expect(call.env?.NO_COLOR).toBe("1")
    // The server carries the check's marker, so it can be found and ended (ADR 0020).
    expect(call.env?.SBT_OPTS).toContain(`-Dgauntlet.check=${dirname(g.ctx.outputDir)}`)
  })

  test("the suite points JUnit reports at the output directory and names the failing test", async () => {
    const g = gate((_c, _d, out) => {
      mkdirSync(join(out, "junit"))
      writeFileSync(join(out, "junit", "TEST-svc.domain.MoneySpec.xml"), JUNIT)
      return { exitCode: 1 }
    })
    const res = await g.run(runSuite({ name: "unit", location: "src/test/**" }, g.ctx))
    expect(g.commands()).toEqual([`set every Test / testReportsDirectory := file(${JSON.stringify(join(g.ctx.outputDir, "junit"))})`, "test"])
    expect(res.tests?.counts.failed).toBe(1)
    expect(res.tests?.ids[0]).toStartWith("svc.domain.MoneySpec.adds")
  })

  test("a suite that fails before any test ran says why", async () => {
    const g = gate(() => ({ exitCode: 1, stdout: "[error] Money.scala:6:3: Found: String\n[error] Total time: 3 s\n" }))
    expect((await g.run(runSuite({ name: "unit", location: "src/test/**" }, g.ctx))).error).toBe("sbt test failed before any test ran: Money.scala:6:3: Found: String")
  })

  test("reruns run only the suites concerned, with parallel execution varied by seed", async () => {
    const g = gate(() => ({}))
    await g.run(runSuite({ name: "unit", location: "src/test/**" }, g.ctx, { files: [], ids: ["svc.domain.MoneySpec.adds"], seed: 4 }))
    expect(g.commands().slice(1)).toEqual(["set every Test / parallelExecution := true", "testOnly svc.domain.MoneySpec"])
    await g.run(runSuite({ name: "unit", location: "src/test/**" }, g.ctx, { files: ["src/test/scala/svc/domain/MoneySpec.scala"], ids: [], seed: 3 }))
    expect(g.commands().slice(1)).toEqual(["set every Test / parallelExecution := false", "testOnly svc.domain.MoneySpec"])
    expect((await g.run(runSuite({ name: "unit", location: "src/test/**" }, g.ctx, { files: ["README.md"], ids: [], seed: 1 }))).error).toBe("no test suites to run again")
  })

  test("lint turns scalafix's findings into SARIF and tells a missing plugin from a broken build", async () => {
    const g = gate((_c, dir) => ({ exitCode: 1, stdout: `[error] ${dir}/src/main/scala/svc/domain/Money.scala:6:3: error: [DisableSyntax.var] mutable state should be avoided\n[error] (Compile / scalafix) scalafix.sbt.ScalafixFailed: LinterError\n` }))
    const res = await g.run(lint(GATE, g.ctx))
    expect(g.commands()).toEqual(["scalafixAll --check"])
    expect(res.error).toBeUndefined()
    expect(res.runs.map((r) => `${r.tool.driver.name}:${r.results.length}`)).toEqual(["scalafix:1", "scala-rules:0"])
    expect(res.runs[0]!.results[0]!.locations![0]!.physicalLocation!.artifactLocation!.uri).toBe("src/main/scala/svc/domain/Money.scala")
    const missing = gate(() => ({ exitCode: 1, stdout: "[error] Not a valid command: scalafixAll\n" }))
    expect((await missing.run(lint(GATE, missing.ctx))).error).toContain("scalafix isn't applied")
    const broken = gate(() => ({ exitCode: 1, stdout: "[error] Money.scala:6:3: Not found: Ledgr\n" }))
    expect((await broken.run(lint(GATE, broken.ctx))).error).toBe("scalafix couldn't check the code: Money.scala:6:3: Not found: Ledgr")
  })

  test("arch reads imports against the policy's rules", async () => {
    const g = gate(() => ({}), undefined, {}, { zones: [], arch: [{ module: "domain", mustNotDependOn: ["infra"] }] })
    const res = await g.run(arch(GATE, g.ctx))
    expect(g.calls).toHaveLength(0)
    expect(res.runs[0]!.results.map((r) => r.message.text)).toEqual(["domain imports svc.infra.Ledger, which belongs to infra."])
  })

  test("mutation overrides Stryker4s' config for the run, restores it, and scores the report", async () => {
    let during = ""
    const g = gate((_c, dir) => {
      during = readFileSync(join(dir, "stryker4s.conf"), "utf8")
      const runDir = join(dir, "target", "stryker4s-report", "1700000000000")
      mkdirSync(runDir, { recursive: true })
      const m = (status: string, line: number) => ({ id: `${line}${status}`, mutatorName: "ArithmeticOperator", status, location: { start: { line, column: 1 }, end: { line, column: 2 } } })
      writeFileSync(join(runDir, "report.json"), JSON.stringify({ files: { [join(dir, "src/main/scala/svc/domain/Money.scala")]: { mutants: [m("Killed", 6), m("Survived", 6), m("CompileError", 6)] } } }))
      return {}
    }, ["src/main/scala/svc/domain/Money.scala", "src/test/scala/svc/domain/MoneySpec.scala"])
    const res = await g.run(mutation(GATE, g.ctx))
    expect(g.commands()).toEqual(["stryker"])
    expect(during).toContain("stryker4s.excluded-mutations")
    expect(during).toContain("stryker4s.reporters = [\"json\"]")
    expect(during).toContain("stryker4s.mutate = [\"src/main/scala/svc/domain/Money.scala\"]")
    expect(readFileSync(join(g.dir, "stryker4s.conf"), "utf8")).toBe(FILES["stryker4s.conf"]!)
    expect(existsSync(join(g.ctx.outputDir, "stryker4s", "report.json"))).toBe(true)
    expect(res.metrics?.mutation).toMatchObject({ value: 50, perFile: { "src/main/scala/svc/domain/Money.scala": 50 } })
    expect(res.runs[0]!.results[0]!.message.text).toBe("No test kills a ArithmeticOperator mutant")
  })

  test("mutation with nothing in scope runs nothing", async () => {
    const g = gate(() => ({}), ["src/test/scala/svc/domain/MoneySpec.scala"])
    expect((await g.run(mutation(GATE, g.ctx))).nothingInScope).toBe("no main Scala files in scope to mutate")
    expect(g.calls).toHaveLength(0)
  })

  test("coverage reads scoverage's Cobertura on changed lines; a type-only file isn't uncovered", async () => {
    const g = gate((_c, _d, out) => {
      mkdirSync(join(out, "scoverage", "coverage-report"), { recursive: true })
      writeFileSync(join(out, "scoverage", "coverage-report", "cobertura.xml"), `<coverage><packages><package><classes><class name="svc.domain.Money" filename="svc/domain/Money.scala"><lines><line number="6" hits="1"/></lines></class></classes></package></packages></coverage>`)
      return {}
    }, ["src/main/scala/svc/domain/Money.scala", "src/main/scala/svc/domain/Types.scala"], { "src/main/scala/svc/domain/Money.scala": [6], "src/main/scala/svc/domain/Types.scala": [3] })
    const res = await g.run(coverage(GATE, g.ctx))
    expect(g.commands()).toEqual([`set every coverageDataDir := file(${JSON.stringify(join(g.ctx.outputDir, "scoverage"))})`, "coverage", "test", "coverageReport"])
    expect(res.metrics?.coverage).toMatchObject({ value: 100, perFile: { "src/main/scala/svc/domain/Money.scala": 100 } })
  })
})
