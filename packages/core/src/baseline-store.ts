import { type Baseline, BaselineInvalid, decodeBaseline } from "@gauntlet/sarif"
import { Context, Effect, Layer, Option } from "effect"
import { type FileChange, Git, type GitFailure } from "./git.ts"

export const BASELINE_PATH = ".gauntlet/baseline.sarif"

/** Reads the baseline. In CI it always comes from the base ref, never the head (ADR 0003). */
export class BaselineStore extends Context.Service<BaselineStore, {
  /** The baseline at a commit, or none when that commit has no baseline yet. */
  readonly at: (repo: string, ref: string) => Effect.Effect<Option.Option<Baseline>, BaselineInvalid | GitFailure>
}>()("@gauntlet/core/BaselineStore") {}

export const BaselineStoreLive = Layer.effect(
  BaselineStore,
  Effect.gen(function*() {
    const git = yield* Git
    return {
      at: (repo: string, ref: string) =>
        git.show(repo, ref, BASELINE_PATH).pipe(
          Effect.flatMap((text) => Option.isNone(text) ? Effect.succeed(Option.none<Baseline>()) : decodeBaseline(text.value).pipe(Effect.map(Option.some))),
        ),
    }
  }),
)

/** Old path to new path for every rename in a diff, so baseline findings follow their files. */
export const renamesOf = (changes: ReadonlyArray<FileChange>): ReadonlyMap<string, string> =>
  new Map(changes.flatMap((c) => (c.status === "renamed" && c.oldPath !== undefined ? [[c.oldPath, c.path] as const] : [])))
