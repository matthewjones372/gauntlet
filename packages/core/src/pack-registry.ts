import { Catalog, type PackSpec } from "@gauntlet/dsl"
import type { Build } from "@gauntlet/ir"
import type { LineNormaliser, SymbolLocator } from "@gauntlet/sarif"
import { Context, Effect, type FileSystem, Layer, type Path } from "effect"
import { runnerConfigForBuilds } from "./builds.ts"
import type { GateImpl, SuiteImpl } from "./gate.ts"
import type { IntegrityDetector } from "./integrity.ts"
import type { Onboarding, RepoView } from "./onboard.ts"
import type { ProcessRunner } from "./process-runner.ts"
import type { TamperContext, Tampering } from "./selftest.ts"

/** One `gauntlet doctor` finding. A failed required check means this build or machine can't run Gauntlet. */
export interface DoctorCheck {
  readonly what: string
  readonly ok: boolean
  readonly detail: string
  /** Informational only: a missing tool the project may not need. */
  readonly optional?: boolean
}

/** A pack as the core sees it (ADR 0006). Grows as milestones add gates and importers. */
export interface Pack {
  readonly spec: PackSpec
  /** Whether the repository looks like this pack's kind of project, for `gauntlet init`. */
  readonly detect?: (files: ReadonlyArray<string>) => boolean
  /**
   * Whether a folder the pack detects, inside another of its builds, is a
   * build of its own rather than part of that one (Gradle: it has a settings
   * file, as an included build does). Without it, nested folders are parts.
   */
  readonly ownBuild?: (files: ReadonlyArray<string>) => boolean
  /** Its test suite and coverage can read the reports the project's own CI wrote (ADR 0024). */
  readonly readsCi?: boolean
  /** Its suite can measure coverage in the same run, for its coverage gate to read (\`withCoverage\`). */
  readonly suiteWithCoverage?: boolean
  /** Policy defaults for this repository with the tools it already has (`gauntlet init --template`). */
  readonly onboard?: (repo: RepoView) => Onboarding
  /** Runner config materialised from base before suites run (ADR 0003). */
  readonly runnerConfig: ReadonlyArray<string>
  /** Dependency manifests, for the `dependency added` condition. */
  readonly manifests: ReadonlyArray<string>
  /** Parses a manifest into dependency coordinates. Without it, any added manifest line counts as a possible new dependency. */
  readonly dependencies?: (path: string, content: string) => ReadonlyArray<string>
  /** Language-specific integrity detectors (ADR 0013). */
  readonly detectors: ReadonlyArray<IntegrityDetector>
  /** Gate implementations by gate name, for the gates in `spec`. */
  readonly gates: Readonly<Record<string, GateImpl>>
  /** Runs a test suite, when `spec.runsSuites`. */
  readonly runSuite?: SuiteImpl
  /**
   * Ends anything the pack's gates left running for one check, such as a build
   * daemon or server shared by its gates (ADR 0020). Called once after the
   * check's gates, with the checkout and the directory its output directories sit in.
   */
  readonly stop?: (check: { readonly dir: string; readonly root: string }) => Effect.Effect<void, never, ProcessRunner | FileSystem.FileSystem | Path.Path>
  /** Whether `runSuite` honours a subset and seed, so flaky tests can be found by running them again (M15). */
  readonly reruns?: boolean
  /** Finds the enclosing symbol of a line, for fingerprints (ADR 0004). */
  readonly locate?: SymbolLocator
  /** Normalises a line before fingerprinting, for example stripping comments. */
  readonly normalise?: LineNormaliser
  /** Checks that the pack's embedded assets work in this build, for `gauntlet doctor`. */
  readonly doctor?: () => ReadonlyArray<DoctorCheck>
  /** Language-specific tamper fixtures for `gauntlet selftest`, built from the project's own files. */
  readonly tamper?: (ctx: TamperContext) => Effect.Effect<ReadonlyArray<Tampering>>
}

/** The packs compiled into this binary (ADR 0006). */
export class PackRegistry extends Context.Service<PackRegistry, {
  readonly packs: ReadonlyArray<Pack>
}>()("@gauntlet/core/PackRegistry") {
  static readonly layer = (packs: ReadonlyArray<Pack>) => Layer.succeed(PackRegistry, { packs })
}

/** The DSL catalog, derived from the installed packs. */
export const CatalogFromPacks = Layer.effect(
  Catalog,
  Effect.gen(function*() {
    const registry = yield* PackRegistry
    return { packs: registry.packs.map((p) => p.spec) }
  }),
)

/** Runner config globs of the packs a policy uses. */
export const runnerConfigFor = (packs: ReadonlyArray<Pack>, used: ReadonlyArray<string>, builds?: ReadonlyArray<Build>): string[] =>
  builds !== undefined
    // Each build's runner configuration sits in its own folder (ADR 0022).
    ? runnerConfigForBuilds(builds.filter((b) => used.includes(b.pack)), (name) => packs.find((p) => p.spec.name === name)?.runnerConfig ?? [])
    : [...new Set(packs.filter((p) => used.includes(p.spec.name)).flatMap((p) => p.runnerConfig))].sort()
