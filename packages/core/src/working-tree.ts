import { Effect, FileSystem, Option, Path, Schema } from "effect"
import { BASELINE_PATH } from "./baseline-store.ts"
import { blockedFor } from "./blocked.ts"
import { type CheckResult, runCheck } from "./check.ts"
import { Git } from "./git.ts"
import { REPORT_FILES } from "./report/reporter.ts"
import { ProcessRunner } from "./process-runner.ts"
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
    // Just after setup, the remote trunk is from before Gauntlet: it has no baseline.
    // Judge from the local commit that recorded it instead, so findings the
    // baseline grandfathers aren't reported as new until setup is pushed.
    let baseRef: string | undefined
    if (base !== "") {
      const recordedAtBase = yield* git.show(request.repo, base, BASELINE_PATH).pipe(Effect.orElseSucceed(() => Option.none<string>()))
      if (Option.isNone(recordedAtBase)) {
        const since = yield* git.lastChange(request.repo, base, snapshot.commit, BASELINE_PATH).pipe(Effect.orElseSucceed(() => Option.none<string>()))
        if (Option.isSome(since)) baseRef = since.value
      }
    }
    const key = `${snapshot.tree} ${baseRef ?? base} ${request.gauntletVersion}${request.adoption ? " adoption" : ""}`
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
    // Tests already run here since the last edit aren't run again (ADR 0024).
    const local = base === "" ? [] : yield* localReports(request.repo, baseRef ?? base, snapshot.commit)
    const result = yield* runCheck({
      repo: request.repo,
      head: snapshot.commit,
      ...(baseRef !== undefined ? { baseRef } : {}),
      outDir: request.outDir,
      gauntletVersion: request.gauntletVersion,
      record: false,
      ...(request.agent ? { agent: request.agent } : {}),
      ...(request.adoption ? { adoption: true } : {}),
      ...(Option.isSome(blocked) ? { blocked: { reason: blocked.value.reason } } : {}),
      ...(local.length > 0 ? { ciReports: { files: local, source: "your local run" } } : {}),
    })
    if (Option.isNone(blocked)) yield* fs.writeFileString(keyFile, key).pipe(Effect.orElseSucceed(() => undefined))
    return { ...result, snapshot, blocked: Option.getOrUndefined(blocked), cached: false }
  })

/** Report files a build tool writes by default: JUnit, Kover, JaCoCo, sbt, scoverage. */
const LOCAL_REPORT = /(^|\/)(build\/test-results\/[^/]+\/[^/]+\.xml|build\/reports\/(kover|jacoco)\/.+\.xml|target\/test-reports\/[^/]+\.xml|target\/scala-[^/]+\/coverage-report\/cobertura\.xml)$/

/**
 * Test and coverage reports a run on this machine wrote after the last change
 * (ADR 0024): files git ignores, newer than every file the change touches. An
 * agent could write such a file, so this only spares the local check a run;
 * the GitHub check judges the pull request from the CI's own run.
 */
export const localReports = (repo: string, base: string, head: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const runner = yield* ProcessRunner
    const git = (args: ReadonlyArray<string>) => runner.run({ command: "git", args, cwd: repo }).pipe(Effect.map((r) => (r.exitCode === 0 ? r.stdout : "")), Effect.orElseSucceed(() => ""))
    const candidates = (yield* git(["ls-files", "--others", "--ignored", "--exclude-standard"])).split("\n").filter((f) => LOCAL_REPORT.test(f))
    if (candidates.length === 0) return []
    const mtime = (f: string) => fs.stat(path.join(repo, f)).pipe(Effect.map((s) => Option.getOrElse(s.mtime, () => new Date(0)).getTime()), Effect.orElseSucceed(() => 0))
    let newest = 0
    for (const f of (yield* git(["diff", "--name-only", base, head])).split("\n").filter(Boolean)) newest = Math.max(newest, yield* mtime(f))
    const out: { path: string; content: string }[] = []
    for (const f of candidates) {
      if ((yield* mtime(f)) < newest) continue
      const content = yield* fs.readFileString(path.join(repo, f)).pipe(Effect.option)
      if (Option.isSome(content)) out.push({ path: f, content: content.value })
    }
    return out
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
