import type { Check, PolicyIR } from "@gauntlet/ir"
import type { LegacyEntry, Metric, Run } from "@gauntlet/sarif"
import type { Effect, FileSystem, Path } from "effect"
import type { DiffFacts } from "./diff-facts.ts"
import type { TestRecord } from "./integrity.ts"
import type { ProcessRunner } from "./process-runner.ts"
import type { OutputFile } from "./workspace.ts"

// The contract between the gate runner and the packs that implement gates.
// A pack runs its tool in the judged checkout, writes reports into the fresh
// output directory it is given, and turns them into SARIF. The runner, not
// the pack, decides pass or fail and checks the proof (ADR 0012).

export interface GateContext {
  /** The judged checkout (ADR 0003). */
  readonly dir: string
  /** A fresh, empty directory for this check's reports, outside the checkout. */
  readonly outputDir: string
  /** Files the tool wrote into `outputDir`. Nothing else may be read as evidence. */
  readonly collect: Effect.Effect<ReadonlyArray<OutputFile>>
  readonly ir: PolicyIR
  readonly facts: DiffFacts
  /** Paths the check is limited to (`on changed`, `in zone`), or undefined for the whole project. */
  readonly scope?: ReadonlyArray<string>
  /** Every file in the judged checkout, repository-relative. */
  readonly files: ReadonlyArray<string>
  /** Legacy grandfathered entries from the baseline, for tools with their own baseline format. */
  readonly legacy: ReadonlyArray<LegacyEntry>
  /**
   * The project's own CI already ran this (ADR 0024): its reports are in
   * \`outputDir\`, with paths from the build's folder, and the gate reads them
   * instead of running its tool. A gate that can't read CI's reports runs as usual.
   */
  readonly fromCi?: boolean
  /** A suite: measure coverage in the same test run, so the coverage gate needn't run the tests again. */
  readonly withCoverage?: boolean
  /** The coverage gate: the suite's run already wrote the coverage reports into \`outputDir\`. */
  readonly coverageFromSuite?: boolean
}

export interface GateRun {
  /** What was run, for the proof. */
  readonly command: ReadonlyArray<string>
  readonly exitCode: number
  /** SARIF converted from the reports in the output directory. */
  readonly runs: ReadonlyArray<Run>
  /** Tests that ran, for suites. */
  readonly tests?: TestRecord
  /** Metric values, keyed by gate name (for example `coverage`) or `integrity/<check>`. */
  readonly metrics?: Readonly<Record<string, Metric>>
  /** Set when the tool couldn't run at all; the check is then `errored`, never passed. */
  readonly error?: string
  /**
   * Set when there was genuinely nothing to check (no changed classes to
   * mutate, no executable changed lines). The check passes with this reason
   * instead of reporting a made-up metric.
   */
  readonly nothingInScope?: string
}

type GateServices = ProcessRunner | FileSystem.FileSystem | Path.Path

export type GateImpl = (check: Extract<Check, { kind: "gate" }>, ctx: GateContext) => Effect.Effect<GateRun, never, GateServices>

/** Part of a suite to run again: some test files, or single tests where the runner can select them, in an order set by `seed`. */
export interface TestSubset {
  readonly files: ReadonlyArray<string>
  readonly ids: ReadonlyArray<string>
  readonly seed: number
}

/** Runs a suite; with `subset`, only those tests, shuffled by its seed where the runner can (M15). */
export type SuiteImpl = (suite: { readonly name: string; readonly location: string }, ctx: GateContext, subset?: TestSubset) => Effect.Effect<GateRun, never, GateServices>
