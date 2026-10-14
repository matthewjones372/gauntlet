import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { explainPolicy, type GateRun, ProcessRunner, type RunRequest } from "@gauntlet/core"
import { compilePolicy } from "@gauntlet/dsl"
import { decodeLog } from "@gauntlet/sarif"
import { Effect, Layer } from "effect"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fakeGate } from "../../../packages/core/test/fake-gate.ts"
import { spec } from "../src/catalog.ts"
import { detektDeadCode, enabledDeadCodeRules } from "../src/deadcode.ts"
import { deadCode } from "../src/gates.ts"
import { onboard } from "../src/onboard.ts"

// Spec 0017 §4, the JVM pack: detekt's unused rules as dead-code findings,
// from the SARIF the lint gate reads. No Gradle runs here: the fixture is
// detekt 2.0.0-alpha.6's SARIF, its rule list as that version's `detekt` task
// reports it with the default configuration (UnusedParameter and
// UnusedPrivateClass on; the other unused rules and UnreachableCode off), and
// its results written by hand in detekt's format with its messages.

const fixture = readFileSync(join(import.meta.dir, "fixtures", "detekt", "detekt-2.0.0-alpha.6.sarif"), "utf8")
const runsOf = (text: string) => Effect.runSync(decodeLog(text)).runs

const summary = (run: { results: ReadonlyArray<{ ruleId: string; message: { text: string }; locations?: ReadonlyArray<{ physicalLocation?: { artifactLocation?: { uri: string }; region?: { startLine?: number } } }> }> }) =>
  run.results.map((r) => ({ ruleId: r.ruleId, message: r.message.text, path: r.locations?.[0]?.physicalLocation?.artifactLocation?.uri, line: r.locations?.[0]?.physicalLocation?.region?.startLine }))

const EXPECTED = [
  { ruleId: "dead-code/unused-parameter", message: "Function parameter `ctx` is unused.", path: "src/main/kotlin/svc/Money.kt", line: 12 },
  { ruleId: "dead-code/unused-private-class", message: "Private class Ledger is unused.", path: "src/main/kotlin/svc/Money.kt", line: 16 },
]

/** A detekt SARIF report with every unused rule on and one result for each, plus a rule that isn't dead code. */
const allOn = () => {
  const rules = ["UnusedImport", "UnusedPrivateClass", "UnusedPrivateFunction", "UnusedPrivateProperty", "UnusedParameter", "UnusedVariable", "MagicNumber"]
  const result = (id: string, line: number, text: string) => ({ ruleId: id, message: { text }, locations: [{ physicalLocation: { artifactLocation: { uri: "src/main/kotlin/svc/Fx.kt", uriBaseId: "%SRCROOT%" }, region: { startLine: line, startColumn: 5 } } }] })
  return JSON.stringify({
    version: "2.1.0",
    runs: [{
      tool: { driver: { name: "detekt", rules: [...rules.map((r) => ({ id: `detekt.style.${r}`, name: r, defaultConfiguration: { enabled: true, level: "error" } })), { id: "detekt.potential-bugs.UnreachableCode", name: "UnreachableCode", defaultConfiguration: { enabled: true, level: "error" } }] } },
      results: [
        result("detekt.style.UnusedImport", 3, "The import 'java.util.UUID' is unused."),
        result("detekt.style.UnusedPrivateFunction", 8, "Private function `helper` is unused."),
        result("detekt.style.UnusedPrivateProperty", 10, "Private property `rate` is unused."),
        result("detekt.style.UnusedVariable", 13, "Variable `unused` is unused."),
        result("detekt.potential-bugs.UnreachableCode", 15, "This expression is unreachable code which should either be used or removed."),
        result("detekt.style.MagicNumber", 17, "This expression contains a magic number. Consider defining it to a well named constant."),
        // detekt 1's names, for a build still on it.
        result("detekt.style.UnusedPrivateMember", 20, "Private function `old` is unused."),
        result("detekt.style.UnusedImports", 21, "The import 'java.util.Date' is unused."),
      ],
    }],
  })
}

describe("detekt's SARIF as dead code", () => {
  test("each unused rule's finding is a dead-code finding of its kind; other rules' aren't", () => {
    const run = detektDeadCode(runsOf(fixture))
    expect(run.tool.driver.name).toBe("detekt")
    expect(summary(run)).toEqual(EXPECTED)
    expect(run.results.every((r) => r.level === "warning")).toBe(true)
  })

  test("every rule's kind, detekt 2's names and detekt 1's", () => {
    expect(summary(detektDeadCode(runsOf(allOn()))).map((r) => `${r.line} ${r.ruleId}`)).toEqual([
      "3 dead-code/unused-import", "8 dead-code/unused-private-function", "10 dead-code/unused-private-property", "13 dead-code/unused-variable",
      "15 dead-code/unreachable-code", "20 dead-code/unused-private-function", "21 dead-code/unused-import",
    ])
  })

  test("which unused rules detekt ran, from its rule list", () => {
    expect(enabledDeadCodeRules([fixture])).toEqual(["UnusedParameter", "UnusedPrivateClass"])
    expect(enabledDeadCodeRules([allOn()])).toEqual(["UnreachableCode", "UnusedImport", "UnusedParameter", "UnusedPrivateClass", "UnusedPrivateFunction", "UnusedPrivateProperty", "UnusedVariable"])
    expect(enabledDeadCodeRules([JSON.stringify({ version: "2.1.0", runs: [{ tool: { driver: { name: "detekt" } }, results: [] }] })])).toBeUndefined()
  })
})

/** The gate with a Gradle that writes `sarif` as detekt's report (none when undefined) and answers as given. */
const detektGate = (sarif: string | undefined, answer: { exitCode?: number; stderr?: string } = {}) => {
  const g = fakeGate({ gradlew: "#!/bin/sh\n", "build.gradle.kts": "", "src/main/kotlin/svc/Money.kt": "package svc\n" })
  const calls: RunRequest[] = []
  const layer = Layer.mergeAll(
    Layer.succeed(ProcessRunner, {
      run: (r) => Effect.sync(() => {
        calls.push(r)
        if (sarif !== undefined && r.args.includes("detekt")) {
          const file = join(r.env!.GAUNTLET_OUT!, "detekt", "root.sarif")
          mkdirSync(dirname(file), { recursive: true })
          writeFileSync(file, sarif)
        }
        return { exitCode: answer.exitCode ?? 0, stdout: "", stderr: answer.stderr ?? "" }
      }),
    }),
    BunServices.layer,
  )
  const run = () => Effect.runPromise(deadCode({ kind: "gate", name: "dead-code", ratchet: true, scope: "all" }, g.ctx).pipe(Effect.provide(layer)) as Effect.Effect<GateRun, never, never>)
  return { ctx: g.ctx, calls, run }
}

describe("the dead-code gate", () => {
  test("runs detekt as lint does and reports its unused rules' findings", async () => {
    const g = detektGate(fixture)
    const r = await g.run()
    expect(r.error).toBeUndefined()
    expect(g.calls.some((c) => c.args.includes("detekt"))).toBe(true)
    expect(r.runs.flatMap((x) => summary(x))).toEqual(EXPECTED)
    expect(existsSync(join(g.ctx.outputDir, "dead-code.sarif"))).toBe(true)
  })

  test("without detekt applied it's an error saying how to add it, not a pass", async () => {
    const r = await detektGate(undefined, { exitCode: 1, stderr: "Task 'detekt' not found in root project 'svc'." }).run()
    expect(r.error).toBe("detekt isn't applied; add the dev.detekt Gradle plugin")
    expect(r.notSetUp).toBe(true)
  })

  test("a detekt that runs none of its unused rules can't find any: an error naming them, not a pass", async () => {
    const off = fixture.replace(/("enabled": )true(,\s*"level": "error"\s*},\s*"helpUri": "[^"]*#unused(parameter|privateclass)")/g, "$1false$2")
    expect(enabledDeadCodeRules([off])).toEqual([])
    const r = await detektGate(off).run()
    expect(r.error).toBe("detekt ran none of its unused rules: turn on UnusedPrivateClass, UnusedPrivateFunction, UnusedPrivateProperty, UnusedParameter, UnusedVariable or UnusedImport in its configuration")
    expect(r.notSetUp).toBe(true)
  })

  test("a report it can't read is an error naming it", async () => {
    expect((await detektGate("<checkstyle/>").run()).error).toBe("detekt's SARIF report couldn't be read: detekt/root.sarif")
  })
})

describe("the policy language", () => {
  const compile = (gates: string) => compilePolicy({ file: ".gauntlet/policy.gx", text: `gauntlet "svc"\nuse jvm\nmode enforce\nowners @p\ngates { fast { ${gates} } }\nreview { auto when all gates pass }\n` }, [spec])

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
  test("init doesn't draft dead-code: `lint ratchet` already holds detekt's unused rules", () => {
    const files: Record<string, string> = { "settings.gradle.kts": "", "build.gradle.kts": `plugins {\n  id("dev.detekt") version "2.0.0-alpha.6"\n}\n`, "src/main/kotlin/A.kt": "" }
    const o = onboard({ files: Object.keys(files).sort(), read: (p) => files[p] })
    expect(o.fast).toContain("lint ratchet")
    expect(o.fast).not.toContain("dead-code ratchet")
  })
})
