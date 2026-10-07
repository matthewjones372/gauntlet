import { convertJUnit, decodeLog } from "@gauntlet/sarif"
import { Effect, Option } from "effect"
import { jvm } from "../../dsl/test/fixtures/catalog.ts"
import type { GateContext, GateImpl, GateRun, IntegrityDetector, Pack, SuiteImpl } from "../src/index.ts"
import { ProcessRunner } from "../src/index.ts"

// A pack whose gates are shell scripts in the repository under test, so the
// whole check pipeline can run end to end without Gradle. Like real test
// code, the scripts belong to the change being judged.
//
//   scripts/build.sh              exit code decides
//   scripts/<gate>.sh <out>       writes <out>/<gate>.sarif (lint, arch)
//                                 or <out>/<gate>.json {"value": n} (mutation, coverage)
//   scripts/test.sh <out> <glob>  writes JUnit XML into <out>

const sh = (ctx: GateContext, script: string, args: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const runner = yield* ProcessRunner
    const command = ["sh", script, ...args]
    const result = yield* Effect.exit(runner.run({ command: "sh", args: [script, ...args], cwd: ctx.dir, timeout: "30 seconds" }))
    return { command, exitCode: result._tag === "Success" ? result.value.exitCode : -1, error: result._tag === "Failure" ? "the script couldn't run" : undefined }
  })

const outcomeGate: GateImpl = (check, ctx) =>
  sh(ctx, `scripts/${check.name}.sh`, [ctx.outputDir]).pipe(
    Effect.map((r): GateRun => ({ command: r.command, exitCode: r.exitCode, runs: [], ...(r.error ? { error: r.error } : {}) })),
  )

const violationsGate: GateImpl = (check, ctx) =>
  Effect.gen(function*() {
    const r = yield* sh(ctx, `scripts/${check.name}.sh`, [ctx.outputDir])
    const file = (yield* ctx.collect).find((f) => f.path === `${check.name}.sarif`)
    const log = file ? yield* Effect.option(decodeLog(file.content)) : Option.none()
    return { command: r.command, exitCode: r.exitCode, runs: Option.match(log, { onNone: () => [], onSome: (l) => l.runs }) }
  })

const metricGate: GateImpl = (check, ctx) =>
  Effect.gen(function*() {
    const r = yield* sh(ctx, `scripts/${check.name}.sh`, [ctx.outputDir])
    const file = (yield* ctx.collect).find((f) => f.path === `${check.name}.json`)
    const value = file ? (JSON.parse(file.content) as { value: number }).value : undefined
    return {
      command: r.command,
      exitCode: r.exitCode,
      runs: [],
      ...(value !== undefined ? { metrics: { [check.name]: { value, unit: "%" as const, higherIsBetter: true } } } : {}),
    }
  })

const suite: SuiteImpl = (s, ctx) =>
  Effect.gen(function*() {
    const r = yield* sh(ctx, "scripts/test.sh", [ctx.outputDir, s.location])
    const files = (yield* ctx.collect).filter((f) => f.path.endsWith(".xml"))
    if (files.length === 0) return { command: r.command, exitCode: r.exitCode, runs: [] }
    const report = yield* Effect.exit(convertJUnit(s.name, files))
    if (report._tag === "Failure") return { command: r.command, exitCode: r.exitCode, runs: [], error: "the test report isn't valid JUnit XML" }
    return { command: r.command, exitCode: r.exitCode, runs: [report.value.run], tests: { counts: report.value.counts, ids: report.value.tests.map((t) => t.id) } }
  })

/**
 * Stands in for a language pack's detectors: covers every check core doesn't
 * and finds nothing, so a clean change can reach auto. Leave it out to see
 * missing integrity evidence hold a change at review.
 */
export const quietDetector: IntegrityDetector = {
  name: "script-quiet",
  checks: [
    "assertions-per-test", "suppressions", "quarantined-tests", "property-tests", "weakened-assertions", "new-skips", "new-suppressions",
    "exit-in-tests", "equality-overrides", "catch-all-near-changed-code", "env-branching", "mocks-of-class-under-test",
  ],
  run: () => Effect.succeed({
    findings: [],
    metrics: {
      "integrity/assertions-per-test": { value: 1, unit: "ratio", higherIsBetter: true },
      "integrity/suppressions": { value: 0, unit: "count", higherIsBetter: false },
      "integrity/quarantined-tests": { value: 0, unit: "count", higherIsBetter: false },
      "integrity/property-tests": { value: 0, unit: "count", higherIsBetter: true },
    },
  }),
}

export const scriptPack: Pack = {
  spec: jvm,
  runnerConfig: ["scripts/test.sh"],
  manifests: ["deps.txt"],
  dependencies: (_path, text) => text.split("\n").map((l) => l.trim()).filter((l) => l !== ""),
  detectors: [quietDetector],
  gates: { build: outcomeGate, lint: violationsGate, arch: violationsGate, mutation: metricGate, coverage: metricGate },
  runSuite: suite,
}
