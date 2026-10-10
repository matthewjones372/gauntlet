import type { Run } from "@gauntlet/sarif"
import { Context, Effect, FileSystem, Layer, Path, type PlatformError, Schema } from "effect"
import { renderEvidence, renderJson, renderMarkdown } from "./render.ts"
import { type Report, RunRecord } from "./schema.ts"

export const REPORT_FILES = {
  json: "gauntlet-report.json",
  markdown: "gauntlet-report.md",
  evidence: "gauntlet-evidence.sarif",
  run: "gauntlet-run.json",
} as const

/** Writes the report, its markdown, the evidence SARIF and the run record to a directory. */
export class Reporter extends Context.Service<Reporter, {
  readonly write: (dir: string, report: Report, evidence: ReadonlyArray<Run>, run: RunRecord) => Effect.Effect<void, PlatformError.PlatformError>
}>()("@gauntlet/core/Reporter") {}

export const ReporterLive = Layer.effect(
  Reporter,
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    // On GitHub Actions the report links each file it names to the commit on GitHub.
    const server = process.env.GITHUB_SERVER_URL
    const repo = process.env.GITHUB_REPOSITORY
    const repoUrl = server && repo ? `${server}/${repo}` : undefined
    return {
      write: (dir, report, evidence, run) =>
        Effect.gen(function*() {
          yield* fs.makeDirectory(dir, { recursive: true })
          yield* fs.writeFileString(path.join(dir, REPORT_FILES.json), renderJson(report))
          yield* fs.writeFileString(path.join(dir, REPORT_FILES.markdown), renderMarkdown(report, { ...(repoUrl ? { repoUrl } : {}) }))
          yield* fs.writeFileString(path.join(dir, REPORT_FILES.evidence), renderEvidence(evidence))
          yield* fs.writeFileString(path.join(dir, REPORT_FILES.run), `${JSON.stringify(Schema.encodeSync(RunRecord)(run), null, 2)}\n`)
        }),
    }
  }),
)
