import { sha256 } from "@gauntlet/ir"
import { type Baseline, compareWithBaseline, importSarif, resultPath, resultRegion, type Run } from "@gauntlet/sarif"
import { Effect, Option } from "effect"
import type { ImportRecord, CheckRecord } from "./report/build.ts"
import { fingerprintRuns } from "./fingerprints.ts"
import { ProcessRunner } from "./process-runner.ts"
import type { CautionSignal, NewViolation } from "./review.ts"
import type { PreparedWorkspace } from "./workspace.ts"
import type { PolicyIR } from "@gauntlet/ir"

// External scanners declared with `import`. Gauntlet runs each command itself
// with {sarif} pointing at a fresh output file, and reads only that file
// (ADR 0012). Findings from a `caution` source can only raise the tier.

export interface ImportsOutput {
  readonly checks: ReadonlyArray<CheckRecord>
  readonly runs: ReadonlyArray<Run>
  readonly records: ReadonlyArray<ImportRecord>
  readonly newViolations: ReadonlyArray<NewViolation>
  readonly caution: ReadonlyArray<CautionSignal>
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

export const runImports = (ir: PolicyIR, workspace: PreparedWorkspace, baseline: Option.Option<Baseline>, renames: ReadonlyMap<string, string>) =>
  Effect.gen(function*() {
    const runner = yield* ProcessRunner
    const out = { checks: [] as CheckRecord[], runs: [] as Run[], records: [] as ImportRecord[], newViolations: [] as NewViolation[], caution: [] as CautionSignal[] }
    for (const [i, imp] of ir.imports.entries()) {
      const base = { tier: "imports", check: imp.name, pointer: `/imports/${i}`, advisory: imp.trust === "caution" }
      const dirName = `import-${imp.name.replace(/[^A-Za-z0-9._-]+/g, "-")}`
      const dir = yield* Effect.exit(workspace.outputDir(dirName))
      if (dir._tag === "Failure") {
        out.checks.push({ ...base, status: "errored", reason: "couldn't create an output directory" })
        continue
      }
      const target = `${dir.value}/results.sarif`
      const command = imp.command.replaceAll("{sarif}", quote(target))
      const result = yield* Effect.exit(runner.run({ command: "sh", args: ["-c", command], cwd: workspace.dir }))
      const files = yield* workspace.collect(dirName).pipe(Effect.orElseSucceed(() => []))
      const sarif = files.find((f) => f.path === "results.sarif")
      const exitCode = result._tag === "Success" ? result.value.exitCode : -1
      const proof = { command: ["sh", "-c", imp.command], exitCode, reports: Object.fromEntries(files.map((f) => [f.path, sha256(f.content)])) }
      if (!sarif) {
        out.checks.push({ ...base, status: "not-executed", reason: `${imp.name} wrote no SARIF to {sarif}`, proof })
        continue
      }
      const imported = yield* Effect.exit(importSarif(imp.name, sarif.content, { trust: imp.trust, repoRoot: workspace.dir, check: imp.name }))
      if (imported._tag === "Failure") {
        out.checks.push({ ...base, status: "errored", reason: `${imp.name} wrote SARIF Gauntlet couldn't read`, proof })
        continue
      }
      const fingerprinted = yield* fingerprintRuns(imported.value, workspace.dir, {}).pipe(Effect.orElseSucceed(() => imported.value))
      const runs = fingerprinted.map((r): Run => ({ ...r, properties: { ...r.properties, gauntlet: { ...r.properties?.gauntlet, proof } } }))
      out.runs.push(...runs)
      const results = runs.flatMap((r) => {
        const grandfathered = Option.match(baseline, { onNone: () => [], onSome: (b) => b.results[r.tool.driver.name] ?? [] })
        return compareWithBaseline(grandfathered, r.results, { renames }).results
      })
      out.records.push({ source: imp.name, trust: imp.trust, results })
      const fresh = results.filter((r) => r.baselineState === "new")
      if (imp.trust === "caution") {
        out.caution.push(...fresh.map((r) => ({ source: imp.name, message: r.message.text, raise: true })))
        out.checks.push({ ...base, status: "passed", proof })
      } else {
        for (const v of fresh) {
          const path = resultPath(v)
          const line = resultRegion(v)?.startLine
          out.newViolations.push({ check: imp.name, ruleId: v.ruleId, message: v.message.text, ...(path ? { path } : {}), ...(line ? { line } : {}) })
        }
        out.checks.push(fresh.length === 0
          ? { ...base, status: "passed", proof }
          : { ...base, status: "failed", reason: `${fresh.length} new finding${fresh.length === 1 ? "" : "s"}`, proof })
      }
    }
    return out satisfies ImportsOutput
  })
