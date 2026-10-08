import { Effect, FileSystem, Option, Path, Schema } from "effect"
import { Git } from "./git.ts"

// The adoption window (spec 0005): the one time an agent may edit protected
// tests, when a project first adopts Gauntlet and its tests already fail.
// Only a person opens it (`gauntlet adopt`, in a terminal, with a typed
// confirmation). It covers protected tests only, never .gauntlet/ or the
// configuration the deny rules guard, and it closes by itself at the next
// commit: it's tied to the commit HEAD pointed at when it was opened. Every
// protected file the agent edits is recorded for the report. CI is unchanged:
// it still restores protected tests from the base commit.

const Window = Schema.Struct({
  openedAt: Schema.String,
  head: Schema.String,
  edited: Schema.Array(Schema.String),
})
export type AdoptionWindow = typeof Window.Type
const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Window))

const fileOf = (repo: string) =>
  Effect.gen(function*() {
    const path = yield* Path.Path
    return path.join(yield* (yield* Git).gitDir(repo), "gauntlet", "adoption.json")
  })

/** The window as recorded, whether or not it's still open. */
export const readAdoption = (repo: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(yield* fileOf(repo)).pipe(Effect.option)
    return Option.flatMap(text, decode)
  }).pipe(Effect.orElseSucceed(() => Option.none<AdoptionWindow>()))

/** The open window: recorded, and HEAD hasn't moved since it was opened. */
export const openAdoption = (repo: string) =>
  Effect.gen(function*() {
    const w = yield* readAdoption(repo)
    if (Option.isNone(w)) return w
    const head = yield* (yield* Git).revParse(repo, "HEAD").pipe(Effect.orElseSucceed(() => ""))
    return head === w.value.head ? w : Option.none<AdoptionWindow>()
  })

export const startAdoption = (repo: string, now: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const file = yield* fileOf(repo)
    const head = yield* (yield* Git).revParse(repo, "HEAD")
    const w: AdoptionWindow = { openedAt: now, head, edited: [] }
    yield* fs.makeDirectory(path.dirname(file), { recursive: true })
    yield* fs.writeFileString(file, `${JSON.stringify(w, null, 2)}\n`)
    return w
  })

/** Records a protected file the agent edited while the window was open. */
export const recordAdoptionEdit = (repo: string, relative: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const w = yield* readAdoption(repo)
    if (Option.isNone(w) || w.value.edited.includes(relative)) return
    const next: AdoptionWindow = { ...w.value, edited: [...w.value.edited, relative].sort() }
    yield* fs.writeFileString(yield* fileOf(repo), `${JSON.stringify(next, null, 2)}\n`)
  }).pipe(Effect.ignore)

export const endAdoption = (repo: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    yield* fs.remove(yield* fileOf(repo), { force: true })
  }).pipe(Effect.ignore)

/** The report of a window: when it opened, and every protected file the agent edited. */
export const renderAdoptionReport = (w: AdoptionWindow, stillOpen: boolean): string =>
  [
    `Adoption window opened ${w.openedAt} on ${w.head.slice(0, 12)}${stillOpen ? " (still open)" : " (closed by a commit)"}.`,
    w.edited.length === 0
      ? "No protected test was edited."
      : [`Protected tests edited while it was open (${w.edited.length}):`, ...w.edited.map((p) => `  - ${p}`)].join("\n"),
    "In CI these files are still put back to their base versions, so a pull request that changes them needs review.",
  ].join("\n")
