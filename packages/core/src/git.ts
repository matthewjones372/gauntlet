import { Context, Data, Effect, Layer, Option } from "effect"
import { ProcessFailed, ProcessRunner, ProcessTimedOut } from "./process-runner.ts"

/** Files a working-tree snapshot never includes: `/gauntlet-setup`'s proposal, applied with `gauntlet apply`. */
export const SNAPSHOT_EXCLUDES = ["gauntlet.proposal.gx"]

export class GitError extends Data.TaggedError("GitError")<{
  readonly args: ReadonlyArray<string>
  readonly exitCode: number
  readonly stderr: string
}> {}

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed"

export interface LineCount {
  readonly added: number
  readonly removed: number
}

export interface AddedLine {
  readonly line: number
  readonly text: string
}

export interface FileChange {
  readonly status: ChangeStatus
  readonly path: string
  /** For renames, the path at base. */
  readonly oldPath?: string
}

export type GitFailure = GitError | ProcessFailed | ProcessTimedOut

/** The git operations Gauntlet needs. Every operation names the repository directory it runs in. */
export class Git extends Context.Service<Git, {
  readonly revParse: (repo: string, ref: string) => Effect.Effect<string, GitFailure>
  /** The repository's git directory, absolute. */
  readonly gitDir: (repo: string) => Effect.Effect<string, GitFailure>
  /** A commit's committer date in UTC, as YYYY-MM-DD: "today" for decisions that depend on dates. */
  readonly commitDate: (repo: string, commit: string) => Effect.Effect<string, GitFailure>
  /** Subjects of the most recent commits on HEAD, newest first, as `<short sha> <subject>` lines. */
  readonly logSubjects: (repo: string, limit: number) => Effect.Effect<string, GitFailure>
  /** Creates a repository with the given initial branch. */
  readonly init: (dir: string, branch: string) => Effect.Effect<void, GitFailure>
  /** The working tree's top directory (also right inside a linked worktree). */
  readonly topLevel: (repo: string) => Effect.Effect<string, GitFailure>
  /** A git config value, or none. */
  readonly config: (repo: string, key: string) => Effect.Effect<Option.Option<string>, GitFailure>
  readonly resolve: (repo: string, ref: string) => Effect.Effect<Option.Option<string>, GitFailure>
  readonly mergeBase: (repo: string, a: string, b: string) => Effect.Effect<string, GitFailure>
  /** File contents at a commit, or none when the file doesn't exist there. */
  readonly show: (repo: string, ref: string, path: string) => Effect.Effect<Option.Option<string>, GitFailure>
  /** Every file path in a commit's tree. */
  readonly listTree: (repo: string, ref: string, prefix?: string) => Effect.Effect<ReadonlyArray<string>, GitFailure>
  /** Tracked and untracked (not ignored) files in the working copy. */
  readonly listWorkingFiles: (repo: string) => Effect.Effect<ReadonlyArray<string>, GitFailure>
  /** Blob ids for paths in a commit's tree, keyed by path. */
  readonly blobIds: (repo: string, ref: string, prefix: string) => Effect.Effect<ReadonlyMap<string, string>, GitFailure>
  /** The blob id the working copy file would have, or none when it is missing. */
  readonly hashWorkingFile: (repo: string, path: string) => Effect.Effect<Option.Option<string>, GitFailure>
  readonly diff: (repo: string, base: string, head: string) => Effect.Effect<ReadonlyArray<FileChange>, GitFailure>
  /** Added and removed line counts per path at head. Binary files count as zero. */
  readonly lineCounts: (repo: string, base: string, head: string) => Effect.Effect<ReadonlyMap<string, LineCount>, GitFailure>
  /** Lines added at head, per path, with their head line numbers. */
  readonly addedLines: (repo: string, base: string, head: string) => Effect.Effect<ReadonlyMap<string, ReadonlyArray<AddedLine>>, GitFailure>
  readonly addWorktree: (repo: string, dir: string, commit: string) => Effect.Effect<void, GitFailure>
  readonly removeWorktree: (repo: string, dir: string) => Effect.Effect<void, GitFailure>
  /** Appends a line to the note on a commit under `refs/notes/<ref>`. */
  readonly appendNote: (repo: string, ref: string, commit: string, line: string) => Effect.Effect<void, GitFailure>
  /** Commits that have a note under `refs/notes/<ref>`. */
  readonly notedCommits: (repo: string, ref: string) => Effect.Effect<ReadonlyArray<string>, GitFailure>
  /** The note on a commit under `refs/notes/<ref>`, or none. */
  readonly readNote: (repo: string, ref: string, commit: string) => Effect.Effect<Option.Option<string>, GitFailure>
  /** Stages everything in a worktree and commits it with a fixed identity; returns the commit. */
  readonly commitAll: (worktree: string, message: string) => Effect.Effect<string, GitFailure>
  /**
   * The working tree, uncommitted and untracked (not ignored) files included, as
   * a commit on top of HEAD. Built with a temporary index, so no ref, the real
   * index and the files are untouched. HEAD itself when nothing changed.
   */
  readonly snapshot: (repo: string) => Effect.Effect<{ readonly commit: string; readonly tree: string; readonly dirty: boolean }, GitFailure>
  /** Applies a patch (git format) in a worktree. */
  readonly applyPatch: (worktree: string, patchFile: string) => Effect.Effect<void, GitFailure>
  /** Restore paths in a worktree to their content at `ref`. */
  readonly restore: (worktree: string, ref: string, paths: ReadonlyArray<string>) => Effect.Effect<void, GitFailure>
  /** Removes paths from a worktree and its index, so listings no longer show them. Missing paths are ignored. */
  readonly remove: (worktree: string, paths: ReadonlyArray<string>) => Effect.Effect<void, GitFailure>
}>()("@gauntlet/core/Git") {}

const splitZ = (out: string) => out.split("\0").filter((s) => s !== "")

const chunks = <A>(xs: ReadonlyArray<A>, size: number): A[][] =>
  Array.from({ length: Math.ceil(xs.length / size) }, (_, i) => xs.slice(i * size, (i + 1) * size))

// Each snapshot gets its own temporary index, so concurrent snapshots never share one.
let snapshots = 0

export const GitLive = Layer.effect(
  Git,
  Effect.gen(function*() {
    const runner = yield* ProcessRunner
    // A fixed, minimal environment so user config can't change what git prints.
    // Literal pathspecs so a file named ":(glob)**" is just a file name.
    const env = { GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_LITERAL_PATHSPECS: "1", LC_ALL: "C" }
    const raw = (repo: string, args: ReadonlyArray<string>) =>
      runner.run({ command: "git", args: ["-c", "core.quotepath=off", ...args], cwd: repo, env })
    const git = (repo: string, args: ReadonlyArray<string>) =>
      raw(repo, args).pipe(
        Effect.flatMap((r) => r.exitCode === 0 ? Effect.succeed(r.stdout) : Effect.fail(new GitError({ args, exitCode: r.exitCode, stderr: r.stderr.trim() }))),
      )

    return {
      revParse: (repo, ref) => git(repo, ["rev-parse", "--verify", `${ref}^{commit}`]).pipe(Effect.map((s) => s.trim())),
      gitDir: (repo) => git(repo, ["rev-parse", "--absolute-git-dir"]).pipe(Effect.map((s) => s.trim())),
      commitDate: (repo, commit) =>
        git(repo, ["show", "-s", "--format=%ct", commit]).pipe(Effect.map((s) => new Date(Number(s.trim()) * 1000).toISOString().slice(0, 10))),
      logSubjects: (repo, limit) => git(repo, ["log", `-${limit}`, "--format=%h %s"]).pipe(Effect.map((s) => s.trim())),
      init: (dir, branch) => git(dir, ["init", "-q", "-b", branch]).pipe(Effect.asVoid),
      topLevel: (repo) => git(repo, ["rev-parse", "--show-toplevel"]).pipe(Effect.map((s) => s.trim())),
      config: (repo, key) =>
        raw(repo, ["config", "--get", key]).pipe(Effect.map((r) => (r.exitCode === 0 && r.stdout.trim() !== "" ? Option.some(r.stdout.trim()) : Option.none()))),
      resolve: (repo, ref) =>
        raw(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).pipe(
          Effect.map((r) => (r.exitCode === 0 ? Option.some(r.stdout.trim()) : Option.none())),
        ),
      mergeBase: (repo, a, b) => git(repo, ["merge-base", a, b]).pipe(Effect.map((s) => s.trim())),
      show: (repo, ref, path) =>
        Effect.gen(function*() {
          // `cat-file -e` tells "missing" apart from real errors.
          const exists = yield* raw(repo, ["cat-file", "-e", `${ref}:${path}`])
          if (exists.exitCode !== 0) return Option.none()
          return Option.some(yield* git(repo, ["cat-file", "blob", `${ref}:${path}`]))
        }),
      listTree: (repo, ref, prefix) =>
        git(repo, ["ls-tree", "-r", "-z", "--name-only", ref, ...(prefix ? ["--", prefix] : [])]).pipe(Effect.map(splitZ)),
      listWorkingFiles: (repo) =>
        git(repo, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).pipe(Effect.map((s) => [...new Set(splitZ(s))].sort())),
      blobIds: (repo, ref, prefix) =>
        git(repo, ["ls-tree", "-r", "-z", ref, "--", prefix]).pipe(
          Effect.map((s) =>
            new Map(splitZ(s).map((entry) => {
              // "<mode> blob <id>\t<path>"
              const [meta, path] = entry.split("\t") as [string, string]
              return [path, meta.split(" ")[2]!] as const
            }))
          ),
        ),
      hashWorkingFile: (repo, path) =>
        raw(repo, ["hash-object", "--", path]).pipe(
          Effect.map((r) => (r.exitCode === 0 ? Option.some(r.stdout.trim()) : Option.none())),
        ),
      diff: (repo, base, head) =>
        git(repo, ["-c", "diff.renameLimit=0", "diff", "--name-status", "-z", "-M", base, head]).pipe(Effect.map(parseNameStatus)),
      lineCounts: (repo, base, head) =>
        git(repo, ["-c", "diff.renameLimit=0", "diff", "--numstat", "-z", "-M", base, head]).pipe(Effect.map(parseNumstat)),
      addedLines: (repo, base, head) =>
        git(repo, ["-c", "diff.renameLimit=0", "diff", "-U0", "-M", "--no-color", "--no-ext-diff", base, head]).pipe(Effect.map(parseAddedLines)),
      // Notes are Gauntlet's records, committed with its own identity so a machine without one (a CI runner) can still record.
      appendNote: (repo, ref, commit, line) =>
        Effect.gen(function*() {
          const args = ["notes", `--ref=${ref}`, "append", "-m", line, commit]
          const identity = { GIT_AUTHOR_NAME: "gauntlet", GIT_AUTHOR_EMAIL: "gauntlet@gauntlet.invalid", GIT_COMMITTER_NAME: "gauntlet", GIT_COMMITTER_EMAIL: "gauntlet@gauntlet.invalid" }
          const r = yield* runner.run({ command: "git", args: ["-c", "core.quotepath=off", ...args], cwd: repo, env: { ...env, ...identity } })
          if (r.exitCode !== 0) return yield* new GitError({ args, exitCode: r.exitCode, stderr: r.stderr.trim() })
        }),
      notedCommits: (repo, ref) =>
        raw(repo, ["notes", `--ref=${ref}`, "list"]).pipe(
          Effect.map((r) => (r.exitCode === 0 ? r.stdout.split("\n").flatMap((l) => (l.trim() === "" ? [] : [l.trim().split(" ")[1]!])).sort() : [])),
        ),
      readNote: (repo, ref, commit) =>
        raw(repo, ["notes", `--ref=${ref}`, "show", commit]).pipe(Effect.map((r) => (r.exitCode === 0 ? Option.some(r.stdout) : Option.none()))),
      commitAll: (worktree, message) =>
        Effect.gen(function*() {
          yield* git(worktree, ["add", "-A"])
          const identity = { GIT_AUTHOR_NAME: "gauntlet selftest", GIT_AUTHOR_EMAIL: "selftest@gauntlet.invalid", GIT_COMMITTER_NAME: "gauntlet selftest", GIT_COMMITTER_EMAIL: "selftest@gauntlet.invalid" }
          const r = yield* runner.run({ command: "git", args: ["-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "--no-verify", "-m", message], cwd: worktree, env: { ...env, ...identity } })
          if (r.exitCode !== 0) return yield* new GitError({ args: ["commit"], exitCode: r.exitCode, stderr: r.stderr.trim() })
          return (yield* git(worktree, ["rev-parse", "HEAD"])).trim()
        }),
      snapshot: (repo) =>
        Effect.gen(function*() {
          const head = (yield* git(repo, ["rev-parse", "HEAD"])).trim()
          const headTree = (yield* git(repo, ["rev-parse", "HEAD^{tree}"])).trim()
          const dir = (yield* git(repo, ["rev-parse", "--absolute-git-dir"])).trim()
          const index = { ...env, GIT_INDEX_FILE: `${dir}/gauntlet-snapshot-index-${process.pid}-${++snapshots}-${Math.random().toString(36).slice(2)}` }
          const inIndex = (args: ReadonlyArray<string>, extra: Record<string, string> = {}) =>
            runner.run({ command: "git", args: ["-c", "core.quotepath=off", ...args], cwd: repo, env: { ...index, ...extra } }).pipe(
              Effect.flatMap((r) => r.exitCode === 0 ? Effect.succeed(r.stdout.trim()) : Effect.fail(new GitError({ args, exitCode: r.exitCode, stderr: r.stderr.trim() }))),
            )
          const tree = yield* Effect.gen(function*() {
            yield* inIndex(["read-tree", "HEAD"])
            yield* inIndex(["add", "-A", "--", "."])
            // Scratch files that aren't part of any change (setup's policy proposal) are left out.
            yield* inIndex(["rm", "-q", "--cached", "--ignore-unmatch", "--", ...SNAPSHOT_EXCLUDES])
            return yield* inIndex(["write-tree"])
          }).pipe(Effect.ensuring(runner.run({ command: "rm", args: ["-f", index.GIT_INDEX_FILE], cwd: repo, env }).pipe(Effect.ignore)))
          if (tree === headTree) return { commit: head, tree, dirty: false }
          const identity = { GIT_AUTHOR_NAME: "gauntlet", GIT_AUTHOR_EMAIL: "gauntlet@gauntlet.invalid", GIT_COMMITTER_NAME: "gauntlet", GIT_COMMITTER_EMAIL: "gauntlet@gauntlet.invalid" }
          const commit = yield* inIndex(["commit-tree", tree, "-p", head, "-m", "gauntlet: working tree"], identity)
          return { commit, tree, dirty: true }
        }),
      applyPatch: (worktree, patchFile) => git(worktree, ["apply", "--whitespace=nowarn", patchFile]).pipe(Effect.asVoid),
      addWorktree: (repo, dir, commit) => git(repo, ["worktree", "add", "--detach", "--quiet", dir, commit]).pipe(Effect.asVoid),
      removeWorktree: (repo, dir) => git(repo, ["worktree", "remove", "--force", dir]).pipe(Effect.asVoid),
      restore: (worktree, ref, paths) =>
        Effect.forEach(chunks(paths, 200), (batch) => git(worktree, ["checkout", ref, "--", ...batch]), { discard: true }),
      remove: (worktree, paths) =>
        Effect.forEach(chunks(paths, 200), (batch) => git(worktree, ["rm", "-r", "-q", "-f", "--ignore-unmatch", "--", ...batch]), { discard: true }),
    }
  }),
)

/** Parses `git diff --name-status -z` output. */
export const parseNameStatus = (out: string): FileChange[] => {
  const parts = splitZ(out)
  const changes: FileChange[] = []
  for (let i = 0; i < parts.length;) {
    const code = parts[i++]!
    if (code.startsWith("R")) {
      const oldPath = parts[i++]!
      const path = parts[i++]!
      changes.push({ status: "renamed", path, oldPath })
    } else if (code.startsWith("C")) {
      i++ // copied: the source is unchanged
      changes.push({ status: "added", path: parts[i++]! })
    } else {
      const path = parts[i++]!
      changes.push({ status: code === "A" ? "added" : code === "D" ? "deleted" : "modified", path })
    }
  }
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** Parses `git diff --numstat -z`. Renames appear as an empty path followed by old and new paths. */
export const parseNumstat = (out: string): Map<string, LineCount> => {
  const parts = out.split("\0")
  const counts = new Map<string, LineCount>()
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (!entry) continue
    const [added, removed, path] = entry.split("\t") as [string, string, string]
    const target = path === "" ? (i += 2, parts[i]!) : path
    counts.set(target, { added: added === "-" ? 0 : Number(added), removed: removed === "-" ? 0 : Number(removed) })
  }
  return counts
}

/** Parses `git diff -U0` into the added lines of each file at head. */
export const parseAddedLines = (out: string): Map<string, AddedLine[]> => {
  const files = new Map<string, AddedLine[]>()
  let current: AddedLine[] | undefined
  let next = 0
  for (const raw of out.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const target = raw.slice(4)
      current = target === "/dev/null" ? undefined : []
      if (current) files.set(target.replace(/^b\//, ""), current)
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (hunk) {
      next = Number(hunk[1])
      continue
    }
    if (current && raw.startsWith("+")) current.push({ line: next++, text: raw.slice(1) })
  }
  return files
}
