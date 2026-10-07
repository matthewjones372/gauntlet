import { BunServices } from "@effect/platform-bun"
import { CompilerLive } from "@gauntlet/dsl"
import { Layer } from "effect"
import { jvm } from "../../dsl/test/fixtures/catalog.ts"
import { BaselineStoreLive, CatalogFromPacks, GitLive, type Pack, PackRegistry, PolicySourceLive, ProcessRunnerLive, WorkspaceLive } from "../src/index.ts"

export const testPacks: ReadonlyArray<Pack> = [
  { spec: jvm, runnerConfig: ["settings.gradle.kts", "gradle/**", "**/junit-platform.properties"], manifests: ["**/*.gradle.kts", "gradle/libs.versions.toml"], detectors: [], gates: {} },
]

const Platform = BunServices.layer
const Runner = ProcessRunnerLive.pipe(Layer.provide(Platform))
const GitLayer = GitLive.pipe(Layer.provide(Runner))
const Compile = CompilerLive.pipe(Layer.provide(CatalogFromPacks), Layer.provide(PackRegistry.layer(testPacks)))

/** Live core services over real git and the real filesystem. */
export const CoreTest = Layer.mergeAll(PolicySourceLive, WorkspaceLive, BaselineStoreLive).pipe(
  Layer.provideMerge(GitLayer),
  Layer.provideMerge(Runner),
  Layer.provide(Compile),
  Layer.provideMerge(Platform),
)
