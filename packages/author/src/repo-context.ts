import { Git, PackRegistry, planSelftest, runnerConfigFor, ShadowLog, summariseShadow } from "@gauntlet/core"
import type { PolicyIR } from "@gauntlet/ir"
import { Effect, FileSystem, Path } from "effect"
import type { AuthorContext } from "./context.ts"

/** What the agent may see of the repository, gathered before it runs. */
export const authorContext = (root: string, packNames: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const git = yield* Git
    const registry = yield* PackRegistry
    const services = yield* Effect.context<Git | PackRegistry | FileSystem.FileSystem | Path.Path>()
    const files = yield* git.listWorkingFiles(root)
    const shadow = summariseShadow(yield* (yield* ShadowLog).read(root).pipe(Effect.orElseSucceed(() => [])))
    const emptyPlan = { fixtures: [], notApplicable: [] }
    return {
      files,
      read: (p: string) => fs.readFileString(path.join(root, p)).pipe(Effect.option),
      packs: registry.packs.map((p) => p.spec),
      runnerConfig: runnerConfigFor(registry.packs, packNames),
      shadow,
      selftestPlan: (ir: PolicyIR) => planSelftest({ repo: root, ir }).pipe(Effect.orElseSucceed(() => emptyPlan), Effect.provide(services)),
      gitLog: yield* git.logSubjects(root, 30).pipe(Effect.orElseSucceed(() => "")),
    } satisfies AuthorContext
  })

