import { BunServices } from "@effect/platform-bun"
import {
  BaselineStoreLive, CatalogFromPacks, GitLive, OverridesLive, type Pack, PackRegistry, PolicySourceLive, ProcessRunnerLive, ReporterLive,
  ShadowLogLive, WorkspaceLive,
} from "@gauntlet/core"
import { CompilerLive } from "@gauntlet/dsl"
import { Layer } from "effect"
import { ExitStatus, OutputLive } from "./output.ts"

/** Every service the CLI needs, over the given packs. */
export const appLayer = (packs: ReadonlyArray<Pack>) => {
  const Platform = BunServices.layer
  const Runner = ProcessRunnerLive.pipe(Layer.provide(Platform))
  const GitLayer = GitLive.pipe(Layer.provide(Runner))
  const Registry = PackRegistry.layer(packs)
  const Compile = CompilerLive.pipe(Layer.provide(CatalogFromPacks), Layer.provide(Registry))
  return Layer.mergeAll(PolicySourceLive, WorkspaceLive, BaselineStoreLive, OverridesLive, ReporterLive, ShadowLogLive).pipe(
    Layer.provideMerge(GitLayer),
    Layer.provideMerge(Runner),
    Layer.provideMerge(Compile),
    Layer.provideMerge(Registry),
    Layer.provideMerge(Platform),
  )
}

export const liveLayer = (packs: ReadonlyArray<Pack>) => Layer.mergeAll(appLayer(packs), OutputLive, ExitStatus.layer)
