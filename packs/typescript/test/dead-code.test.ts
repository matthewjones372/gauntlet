import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { type GateContext, type GateRun, ProcessRunner, type RunRequest } from "@gauntlet/core"
import type { Result } from "@gauntlet/sarif"
import { Effect, Layer, Option } from "effect"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fakeGate } from "../../../packages/core/test/fake-gate.ts"
import { deadCode } from "../src/gates.ts"
import { parseKnip } from "../src/knip.ts"
import { onboard } from "../src/onboard.ts"

// Spec 0017 §4, the TypeScript pack: Knip's JSON report as dead-code findings.
// The fixtures are what Knip 5.66.0 and 6.41.0 printed for the project below
// (`knip --reporter json`): an unused file, export, type, enum member, a
// duplicate export, an unused dependency and devDependency, and an unlisted
// import, which is a mistake rather than dead code.

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", "knip", name), "utf8")

const PACKAGE_JSON = `{ "name": "knipdemo", "version": "1.0.0", "type": "module", "main": "src/index.ts",
  "dependencies": { "left-pad": "1.3.0" },
  "devDependencies": { "knip": "5.66.0", "typescript": "5.9.3", "prettier": "3.3.3" } }
`
const PROJECT: Record<string, string> = {
  "package.json": PACKAGE_JSON,
  "src/index.ts": `import { used, Colour, alias } from "./util.ts"\n\nconsole.log(used(), Colour.Red, alias)\n`,
  "src/util.ts": `import { thing } from "not-listed-pkg"\n\nexport const used = () => thing\n\nexport const unusedHelper = () => 2\n\nexport type UnusedType = { a: number }\n\nexport enum Colour { Red, Green }\n\nexport const alias = used\n`,
  "src/orphan.ts": "export const nobody = 3\n",
}
const lines = (p: string) => PROJECT[p]?.split("\n")

const summary = (results: ReadonlyArray<Result>) =>
  results.map((r) => ({
    ruleId: r.ruleId,
    message: r.message.text,
    path: r.locations?.[0]?.physicalLocation?.artifactLocation?.uri,
    line: r.locations?.[0]?.physicalLocation?.region?.startLine,
  })).sort((a, b) => `${a.path}:${a.line}:${a.ruleId}`.localeCompare(`${b.path}:${b.line}:${b.ruleId}`))

const EXPECTED = [
  { ruleId: "dead-code/unused-dependency", message: "unused dependency: left-pad", path: "package.json", line: 2 },
  { ruleId: "dead-code/unused-dev-dependency", message: "unused devDependency: prettier", path: "package.json", line: 3 },
  { ruleId: "dead-code/unused-file", message: "unused file: src/orphan.ts", path: "src/orphan.ts", line: undefined },
  { ruleId: "dead-code/duplicate-export", message: "duplicate export: used, alias", path: "src/util.ts", line: 3 },
  { ruleId: "dead-code/unused-export", message: "unused export: unusedHelper", path: "src/util.ts", line: 5 },
  { ruleId: "dead-code/unused-type", message: "unused exported type: UnusedType", path: "src/util.ts", line: 7 },
  { ruleId: "dead-code/unused-enum-member", message: "unused enum member: Colour.Green", path: "src/util.ts", line: 9 },
]

describe("Knip's JSON report", () => {
  test("Knip 5's report: each unused thing is a dead-code finding with its file and line", () => {
    const run = Option.getOrThrow(parseKnip(fixture("knip-5.66.0.json"), "/repo", lines))
    expect(run.tool.driver.name).toBe("knip")
    expect(summary(run.results)).toEqual(EXPECTED)
  })

  test("Knip 6's report, which lists everything per file, reads the same", () => {
    expect(summary(Option.getOrThrow(parseKnip(fixture("knip-6.41.0.json"), "/repo", lines)).results)).toEqual(EXPECTED)
  })

  test("an unlisted import is a mistake, not dead code", () => {
    const run = Option.getOrThrow(parseKnip(fixture("knip-6.41.0.json"), "/repo", lines))
    expect(run.results.some((r) => r.message.text.includes("not-listed-pkg"))).toBe(false)
  })

  test("a dependency's line is found in its manifest; without the manifest it has none", () => {
    const run = Option.getOrThrow(parseKnip(fixture("knip-6.41.0.json"), "/repo"))
    expect(run.results.find((r) => r.ruleId === "dead-code/unused-dependency")?.locations?.[0]?.physicalLocation?.region).toBeUndefined()
  })

  test("absolute paths are made relative to the checkout", () => {
    const json = JSON.stringify({ issues: [{ file: "/repo/src/a.ts", exports: [{ name: "x", line: 1, col: 14 }] }] })
    expect(summary(Option.getOrThrow(parseKnip(json, "/repo")).results)).toEqual([{ ruleId: "dead-code/unused-export", message: "unused export: x", path: "src/a.ts", line: 1 }])
  })

  test("output that isn't Knip's JSON report isn't read", () => {
    expect(Option.isNone(parseKnip("Error: no config", "/repo"))).toBe(true)
    expect(Option.isNone(parseKnip("[]", "/repo"))).toBe(true)
  })
})

/** A gate over the project whose process runner answers Knip with `stdout` and installs succeed. */
const knipGate = (files: Record<string, string>, knip: { exitCode?: number; stdout?: string; stderr?: string }) => {
  const g = fakeGate(files)
  const calls: RunRequest[] = []
  const layer = Layer.mergeAll(
    Layer.succeed(ProcessRunner, {
      run: (r) => Effect.sync(() => {
        calls.push(r)
        return r.command.endsWith("/knip") ? { exitCode: knip.exitCode ?? 0, stdout: knip.stdout ?? "", stderr: knip.stderr ?? "" } : { exitCode: 0, stdout: "", stderr: "" }
      }),
    }),
    BunServices.layer,
  )
  const run = (ctx: GateContext) => Effect.runPromise(deadCode({ kind: "gate", name: "dead-code", ratchet: true, scope: "all" }, ctx).pipe(Effect.provide(layer)) as Effect.Effect<GateRun, never, never>)
  return { ctx: g.ctx, calls, run: () => run(g.ctx) }
}

describe("the dead-code gate", () => {
  const installed = { ...PROJECT, "bun.lock": "", "node_modules/.bin/knip": "" }

  test("runs the project's Knip and reports its findings, keeping the report in the output directory", async () => {
    const g = knipGate(installed, { stdout: fixture("knip-6.41.0.json") })
    const r = await g.run()
    expect(r.error).toBeUndefined()
    const knip = g.calls.find((c) => c.command.endsWith("/knip"))!
    expect(knip.args).toEqual(["--reporter", "json", "--no-progress", "--no-exit-code", "--no-config-hints"])
    expect(r.command).toEqual(["knip", "--reporter", "json", "--no-progress", "--no-exit-code", "--no-config-hints"])
    expect(summary(r.runs.flatMap((x) => x.results))).toEqual(EXPECTED)
    expect(existsSync(join(g.ctx.outputDir, "knip.json"))).toBe(true)
    expect(existsSync(join(g.ctx.outputDir, "knip.sarif"))).toBe(true)
  })

  test("without Knip in the project it's an error that says how to add it, not a pass", async () => {
    const { "node_modules/.bin/knip": _, ...files } = installed
    const g = knipGate({ ...files, "package.json": JSON.stringify({ devDependencies: { typescript: "5" } }) }, {})
    const r = await g.run()
    expect(r.error).toBe("Knip isn't installed: add knip to devDependencies")
    expect(r.notSetUp).toBe(true)
    expect(g.calls.some((c) => c.command.endsWith("/knip"))).toBe(false)
  })

  test("a Knip that fails to run is an error, with what it said", async () => {
    const r = await knipGate(installed, { exitCode: 2, stderr: "ERROR: Error loading knip.json\n" }).run()
    expect(r.error).toBe("Knip couldn't run: ERROR: Error loading knip.json")
  })

  test("a report that can't be read is an error", async () => {
    expect((await knipGate(installed, { stdout: "not json" }).run()).error).toBe("Knip's JSON report couldn't be read")
  })
})

describe("onboarding", () => {
  test("a project that uses Knip gets `dead-code ratchet`; one that doesn't isn't told to add it", () => {
    const view = (deps: Record<string, string>) => {
      const files: Record<string, string> = { "package.json": JSON.stringify({ devDependencies: deps }), "tsconfig.json": "{}", "knip.json": "{}", "src/a.ts": "" }
      return { files: Object.keys(files).sort(), read: (p: string) => files[p] }
    }
    const withKnip = onboard(view({ typescript: "5", eslint: "9", knip: "6" }))
    expect(withKnip.fast).toEqual(["build", "lint ratchet", "dead-code ratchet"])
    expect(withKnip.protect.config).toContain("knip.json")
    const without = onboard(view({ typescript: "5", eslint: "9" }))
    expect(without.fast).toEqual(["build", "lint ratchet"])
    expect(without.setup.some((s) => s.includes("Knip"))).toBe(false)
  })
})
