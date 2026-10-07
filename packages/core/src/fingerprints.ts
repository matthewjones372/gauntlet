import { fingerprint, type FingerprintOptions, resultPath, type Run } from "@gauntlet/sarif"
import { Effect, FileSystem, Path } from "effect"

/**
 * Fingerprints every result in the runs against the files in `dir` (the
 * judged checkout), so baseline matching works the same in `check` and in
 * `baseline`. Results whose file can't be read keep no fingerprint and are
 * compared by per-file counts.
 */
export const fingerprintRuns = (runs: ReadonlyArray<Run>, dir: string, options: FingerprintOptions) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const wanted = [...new Set(runs.flatMap((r) => r.results.flatMap((x) => resultPath(x) ?? [])))].sort()
    const files = new Map<string, ReadonlyArray<string>>()
    for (const p of wanted) {
      const full = path.resolve(dir, p)
      // Only files inside the checkout; a result pointing elsewhere gets no fingerprint.
      if (!full.startsWith(`${path.resolve(dir)}/`)) continue
      const text = yield* fs.readFileString(full).pipe(Effect.option)
      if (text._tag === "Some") files.set(p, text.value.split(/\r?\n/))
    }
    return runs.map((r): Run => ({ ...r, results: fingerprint(r.results, (p) => files.get(p), options) }))
  })
