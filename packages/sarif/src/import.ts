import { Data, Effect, Schema } from "effect"
import { Log, type Result, type Run } from "./schema.ts"

// Generic SARIF import for external scanners (Semgrep, Snyk, Codacy...). The
// SARIF here always comes from a command Gauntlet ran itself (ADR 0012).

export class SarifInvalid extends Data.TaggedError("SarifInvalid")<{ readonly source: string; readonly reason: string }> {}

/** Makes a SARIF artifact URI relative to the repository root, as Gauntlet's paths are. */
export const relativeUri = (uri: string, repoRoot: string): string => {
  let p = uri
  if (p.startsWith("file://")) p = decodeURIComponent(p.slice("file://".length))
  const root = repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`
  if (p.startsWith(root)) p = p.slice(root.length)
  return p.replace(/^\.\//, "")
}

const withRelativePaths = (r: Result, repoRoot: string): Result => ({
  ...r,
  ...(r.locations
    ? {
      locations: r.locations.map((l) => {
        const uri = l.physicalLocation?.artifactLocation?.uri
        return uri === undefined
          ? l
          : { ...l, physicalLocation: { ...l.physicalLocation, artifactLocation: { uri: relativeUri(uri, repoRoot) } } }
      }),
    }
    : {}),
})

/**
 * Decodes an external SARIF log into runs. Results from a `caution` source
 * (any LLM reviewer) are marked so they can only raise the tier (ADR 0011).
 */
export const importSarif = (source: string, json: string, options: { readonly trust: "evidence" | "caution"; readonly repoRoot: string; readonly check: string }) =>
  Effect.gen(function*() {
    const raw = yield* Effect.try({ try: () => JSON.parse(json) as unknown, catch: (e) => new SarifInvalid({ source, reason: `not JSON: ${String(e)}` }) })
    const log = yield* Schema.decodeUnknownEffect(Log)(raw).pipe(Effect.mapError((e) => new SarifInvalid({ source, reason: String(e) })))
    return log.runs.map((run): Run => ({
      ...run,
      results: run.results.map((r) => {
        const relative = withRelativePaths(r, options.repoRoot)
        return options.trust === "caution"
          ? { ...relative, properties: { ...relative.properties, gauntlet: { ...relative.properties?.gauntlet, caution: true } } }
          : relative
      }),
      properties: { ...run.properties, gauntlet: { ...run.properties?.gauntlet, check: options.check, trust: options.trust } },
    }))
  })

/** Decodes a SARIF log as-is, for packs that convert their own tool output. */
export const decodeLog = (json: string) =>
  Effect.try({ try: () => JSON.parse(json) as unknown, catch: (e) => new SarifInvalid({ source: "log", reason: `not JSON: ${String(e)}` }) }).pipe(
    Effect.flatMap((raw) => Schema.decodeUnknownEffect(Log)(raw).pipe(Effect.mapError((e) => new SarifInvalid({ source: "log", reason: String(e) })))),
  )
