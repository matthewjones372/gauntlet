import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { type GateContext, ProcessRunner, type RunRequest } from "@gauntlet/core"
import type { Check } from "@gauntlet/ir"
import { Effect, Layer } from "effect"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { arch, build, coverage, lint, runSuite } from "../src/gates.ts"
import { project } from "./sources.ts"

// The Clojure gates with a scripted process runner: what the Clojure CLI,
// Leiningen and clj-kondo are asked to do, and how the gates read what they
// write. The real tools are covered by the end-to-end test.

type Handler = (argv: string[], out: string) => { exitCode?: number; stdout?: string; stderr?: string }

const gate = (files: Record<string, string>, handler: Handler, scope?: string[], added: Record<string, number[]> = {}, ir: object = { zones: [], arch: [] }) => {
  const dir = mkdtempSync(join(tmpdir(), "gauntlet-clj-gate-"))
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true })
    writeFileSync(join(dir, p), t)
  }
  const out = join(mkdtempSync(join(tmpdir(), "gauntlet-clj-out-")), "0-check")
  mkdirSync(out)
  const ctx: GateContext = {
    dir,
    outputDir: out,
    collect: Effect.sync(() => readdirSync(out, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => ({ path: join(e.parentPath, e.name).slice(out.length + 1), content: readFileSync(join(e.parentPath, e.name), "utf8") }))),
    ir: ir as never,
    facts: { addedLines: new Map(Object.entries(added).map(([p, ls]) => [p, ls.map((line) => ({ line, text: (files[p] ?? "").split("\n")[line - 1] ?? "" }))])) } as never,
    ...(scope ? { scope } : {}),
    files: Object.keys(files).sort(),
    legacy: [],
  }
  const calls: RunRequest[] = []
  const layer = Layer.mergeAll(Layer.succeed(ProcessRunner, {
    run: (r) => Effect.sync(() => {
      calls.push(r)
      const res = handler([r.command, ...r.args], out)
      return { exitCode: res.exitCode ?? 0, stdout: res.stdout ?? "", stderr: res.stderr ?? "" }
    }),
  }), BunServices.layer)
  const run = <A, E, R>(e: Effect.Effect<A, E, R>) => Effect.runPromise(e.pipe(Effect.provide(layer)) as Effect.Effect<A, E, never>)
  return { ctx, dir, calls, run, argv: () => [calls.at(-1)!.command, ...calls.at(-1)!.args] }
}

const SERVICE = project("clojure-service")
const LEIN = project("clojure-lein")
const GATE = { kind: "gate", name: "x", ratchet: false, scope: "all" } as Extract<Check, { kind: "gate" }>
const JUNIT = `<testsuites><testsuite name="unit" tests="2"><testcase name="svc.settlement.fx-test/converts" classname="svc.settlement.fx-test"><failure message="expected 92"/></testcase><testcase name="svc.domain.money-test/adds" classname="svc.domain.money-test"/></testsuite></testsuites>`

describe("Clojure gates", () => {
  test("build loads every namespace on the test classpath, through the project's :test alias", async () => {
    const g = gate(SERVICE, () => ({}))
    expect((await g.run(build(GATE, g.ctx))).error).toBeUndefined()
    const [cmd, sdeps, alias, aliases] = g.argv()
    expect([cmd, sdeps, aliases]).toEqual(["clojure", "-Sdeps", "-M:test:gauntlet"])
    expect(alias).toContain(`:main-opts ["-e" "(doseq [n '[svc.domain.money svc.domain.money-test svc.infra.ledger svc.settlement.fx svc.settlement.fx-test]] (require n))"]`)
    expect(g.argv()).toHaveLength(4)
    const broken = gate(SERVICE, () => ({ exitCode: 1, stderr: "Syntax error reading source at (svc/domain/money.clj:8:1).\nEOF while reading\n" }))
    const failed = await broken.run(build(GATE, broken.ctx))
    expect([failed.exitCode, failed.error]).toEqual([1, undefined])
  })

  test("with Leiningen, Gauntlet's runner is added for the run with update-in", async () => {
    const g = gate(LEIN, (_a, out) => {
      writeFileSync(join(out, "junit.xml"), `<testsuites><testsuite name="unit"><testcase name="calc.core-test/adds" classname="calc.core-test"/></testsuite></testsuites>`)
      return {}
    })
    await g.run(runSuite({ name: "unit", location: "test/**" }, g.ctx))
    expect(g.argv().slice(0, 11)).toEqual(["lein", "update-in", ":dependencies", "conj", "[lambdaisland/kaocha \"1.91.1392\"]", "--", "update-in", ":dependencies", "conj", "[lambdaisland/kaocha-junit-xml \"1.17.101\"]", "--"])
    expect(g.argv().slice(11, 16)).toEqual(["with-profile", "+test", "run", "-m", "kaocha.runner"])
  })

  test("the suite runs kaocha in a fixed order with JUnit in the output directory, and names the failing test", async () => {
    const g = gate(SERVICE, (_a, out) => {
      writeFileSync(join(out, "junit.xml"), JUNIT)
      return { exitCode: 1 }
    })
    const res = await g.run(runSuite({ name: "unit", location: "test/**" }, g.ctx))
    expect(g.argv().slice(4)).toEqual(["--no-color", "--no-randomize", "--plugin", "kaocha.plugin/junit-xml", "--junit-xml-file", join(g.ctx.outputDir, "junit.xml")])
    expect(g.argv()[2]).toContain(`lambdaisland/kaocha {:mvn/version "1.91.1392"}`)
    expect(res.tests?.counts).toMatchObject({ executed: 2, failed: 1 })
    expect(res.tests?.ids).toContain("svc.settlement.fx-test.converts")
  })

  test("reruns focus on the tests concerned and shuffle with the seed", async () => {
    const g = gate(SERVICE, () => ({}))
    await g.run(runSuite({ name: "unit", location: "test/**" }, g.ctx, { files: ["test/svc/settlement/fx_test.clj"], ids: ["svc.domain.money-test.adds"], seed: 7 }))
    const argv = g.argv()
    expect(argv.slice(argv.indexOf("--seed"), argv.indexOf("--seed") + 2)).toEqual(["--seed", "7"])
    expect(argv.slice(-4)).toEqual(["--focus", "svc.domain.money-test/adds", "--focus", "svc.settlement.fx-test"])
    expect((await g.run(runSuite({ name: "unit", location: "test/**" }, g.ctx, { files: ["README.md"], ids: [], seed: 1 }))).error).toBe("no tests to run again")
  })

  test("a suite that fails before any test ran says why; a project without a build file can't run", async () => {
    const g = gate(SERVICE, () => ({ exitCode: 1, stderr: "Error building classpath. Could not find artifact x:y:jar:1\n" }))
    expect((await g.run(runSuite({ name: "unit", location: "test/**" }, g.ctx))).error).toBe("kaocha failed before any test ran: Error building classpath. Could not find artifact x:y:jar:1")
    const bare = gate({ "src/a.clj": "(ns a)\n" }, () => ({}))
    expect((await bare.run(build(GATE, bare.ctx))).error).toBe("no deps.edn or project.clj at the repository root")
  })

  test("lint turns clj-kondo's JSON into SARIF; findings exit 2 or 3, anything else couldn't lint", async () => {
    const g = gate(SERVICE, () => ({ exitCode: 2, stdout: JSON.stringify({ findings: [{ filename: "src/svc/infra/ledger.clj", row: 5, level: "warning", type: "unused-binding", message: "unused binding unused" }] }) }))
    const res = await g.run(lint(GATE, g.ctx))
    expect(g.argv()).toEqual(["clj-kondo", "--lint", "src", "test", "--config", "{:output {:format :json}}", "--parallel"])
    expect(res.error).toBeUndefined()
    expect(res.runs.map((r) => `${r.tool.driver.name}:${r.results.length}`)).toEqual(["clj-kondo:1", "clojure-rules:0"])
    const crashed = gate(SERVICE, () => ({ exitCode: 1, stderr: "Exception in thread main\n" }))
    expect((await crashed.run(lint(GATE, crashed.ctx))).error).toBe("clj-kondo couldn't lint the code: Exception in thread main")
  })

  test("lint runs the zones' rules on main code in scope", async () => {
    const ir = { zones: [{ name: "money", globs: ["src/svc/settlement/**"], rules: ["clojure.no-throw"] }], arch: [] }
    const files = { ...SERVICE, "src/svc/settlement/fx.clj": `${SERVICE["src/svc/settlement/fx.clj"]}\n(defn fail [] (throw (ex-info "no" {})))\n` }
    const g = gate(files, () => ({ stdout: JSON.stringify({ findings: [] }) }), undefined, {}, ir)
    expect((await g.run(lint(GATE, g.ctx))).runs[1]!.results.map((r) => r.ruleId)).toEqual(["clojure.no-throw"])
  })

  test("arch reads ns :require against the policy's rules", async () => {
    const files = { ...SERVICE, "src/svc/domain/audit.clj": "(ns svc.domain.audit\n  (:require [svc.infra.ledger :as ledger]))\n" }
    const g = gate(files, () => ({}), undefined, {}, { zones: [], arch: [{ module: "domain", mustNotDependOn: ["infra"] }] })
    const res = await g.run(arch(GATE, g.ctx))
    expect(g.calls).toHaveLength(0)
    expect(res.runs[0]!.results.map((r) => `${r.message.text}:${r.locations![0]!.physicalLocation!.region!.startLine}`)).toEqual(["domain requires svc.infra.ledger, which belongs to infra.:2"])
  })

  test("coverage runs cloverage over the project's roots and reads changed lines from its lcov", async () => {
    const g = gate(SERVICE, (_a, out) => {
      mkdirSync(join(out, "coverage"), { recursive: true })
      writeFileSync(join(out, "coverage", "lcov.info"), "TN:\nSF:src/svc/domain/money.clj\nDA:1,1\nDA:6,1\nDA:9,0\nend_of_record\n")
      return {}
    }, ["src/svc/domain/money.clj"], { "src/svc/domain/money.clj": [6, 9] })
    const res = await g.run(coverage(GATE, g.ctx))
    expect(g.argv().slice(4)).toEqual(["-p", "src", "-s", "test", "--lcov", "--no-html", "--no-text", "-o", join(g.ctx.outputDir, "coverage")])
    expect(g.argv()[2]).toContain(`cloverage/cloverage {:mvn/version "1.2.4"}`)
    expect(res.metrics?.coverage).toMatchObject({ value: 50, perFile: { "src/svc/domain/money.clj": 66.67 } })
  })
})
