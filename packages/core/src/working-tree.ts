import { Effect, FileSystem, Option, Path, Schema } from "effect"
import { blockedFor } from "./blocked.ts"
import { type CheckResult, runCheck } from "./check.ts"
import { Git } from "./git.ts"
import { REPORT_FILES } from "./report/reporter.ts"
import { Report, type ReportAgent } from "./report/schema.ts"

// The check a coding agent gets while it works (Stop hook, MCP `check`): the
// working tree as it is, uncommitted and new files included, judged like a
// commit. Never recorded in the shadow history, since it isn't a real change.

/** The refs a working-tree check is compared with, most specific first (as PolicySource resolves them). */
const BASE_CANDIDATES = ["origin/HEAD", "origin/main", "origin/master", "main", "master"]
const CACHE_KEY_FILE = "working-tree.key"
const decodeReport = Schema.decodeUnknownOption(Schema.fromJsonString(Report))

export const checkWorkingTree = (request: { readonly repo: string; readonly outDir: string; readonly gauntletVersion: string; readonly agent?: ReportAgent; readonly adoption?: boolean }) =>
  Effect.gen(function*() {
    const git = yield* Git
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const snapshot = yield* git.snapshot(request.repo)
    const blocked = yield* blockedFor(request.repo, snapshot.tree)
    // The same tree against the same base and Gauntlet gives the same decision, so a
    // repeat (an agent stopping again without changing anything) reuses the last report.
    let base = ""
    for (const ref of BASE_CANDIDATES) {
      const sha = yield* git.resolve(request.repo, ref).pipe(Effect.orElseSucceed(() => Option.none<string>()))
      if (Option.isSome(sha)) {
        base = sha.value
        break
      }
    }
    const key = `${snapshot.tree} ${base} ${request.gauntletVersion}${request.adoption ? " adoption" : ""}`
    const keyFile = path.join(request.outDir, CACHE_KEY_FILE)
    const previous = yield* fs.readFileString(keyFile).pipe(Effect.option)
    if (Option.isSome(previous) && previous.value === key && Option.isNone(blocked)) {
      const cached = yield* fs.readFileString(path.join(request.outDir, REPORT_FILES.json)).pipe(Effect.map(decodeReport), Effect.orElseSucceed(() => Option.none<Report>()))
      if (Option.isSome(cached)) {
        const result: CheckResult = { report: cached.value, exitCode: cached.value.decision.blocking ? 1 : 0 }
        return { ...result, snapshot, blocked: undefined, cached: true }
      }
    }
    yield* fs.remove(keyFile, { force: true }).pipe(Effect.orElseSucceed(() => undefined))
    const result = yield* runCheck({
      repo: request.repo,
      head: snapshot.commit,
      outDir: request.outDir,
      gauntletVersion: request.gauntletVersion,
      record: false,
      ...(request.agent ? { agent: request.agent } : {}),
      ...(request.adoption ? { adoption: true } : {}),
      ...(Option.isSome(blocked) ? { blocked: { reason: blocked.value.reason } } : {}),
    })
    if (Option.isNone(blocked)) yield* fs.writeFileString(keyFile, key).pipe(Effect.orElseSucceed(() => undefined))
    return { ...result, snapshot, blocked: Option.getOrUndefined(blocked), cached: false }
  })

/** Files Gauntlet's own setup writes; a change to nothing else has no code to judge. */
const SETUP_FILE = /^(gauntlet\.proposal\.gx|\.mcp\.json|CLAUDE\.md|AGENTS\.md|\.claude\/.+)$/

/**
 * Whether the working tree changes nothing but Gauntlet's own setup files (or
 * nothing at all) compared with its base. Then there's no code to judge, and
 * the Stop hook mustn't hold an agent to failures that were already there:
 * during /gauntlet-setup, for example, the agent has only written a proposal.
 */
export const nothingToJudge = (repo: string) =>
  Effect.gen(function*() {
    const git = yield* Git
    const snapshot = yield* git.snapshot(repo)
    for (const ref of BASE_CANDIDATES) {
      const sha = yield* git.resolve(repo, ref).pipe(Effect.orElseSucceed(() => Option.none<string>()))
      if (Option.isNone(sha)) continue
      const base = yield* git.mergeBase(repo, sha.value, snapshot.commit)
      const changes = yield* git.diff(repo, base, snapshot.commit)
      return changes.every((c) => SETUP_FILE.test(c.path) && (c.oldPath === undefined || SETUP_FILE.test(c.oldPath)))
    }
    return false
  }).pipe(Effect.orElseSucceed(() => false))
