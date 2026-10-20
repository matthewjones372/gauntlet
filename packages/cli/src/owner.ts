import { CODING_AGENT_MARKERS } from "@gauntlet/author"
import { Context, Data, Effect, Option, Schema } from "effect"
import { existsSync, statSync } from "node:fs"
import { dirname, join } from "node:path"

// The owner's commands (spec 0015): `gauntlet approve` and `gauntlet grant`
// make decisions only an owner may make. They run in the owner's own terminal,
// never in a coding agent's session (the same separation as ADR 0009), and
// reach GitHub through `gh` as the owner.

/** Who is at the keyboard: the environment and whether there's a terminal. Tests supply their own. */
export const OwnerSession = Context.Reference<{ readonly env: Readonly<Record<string, string | undefined>>; readonly interactive: boolean }>("@gauntlet/cli/OwnerSession", {
  defaultValue: () => ({ env: process.env, interactive: process.stdin.isTTY === true && process.stdout.isTTY === true }),
})

/**
 * Why an owner's decision can't be made from here, or undefined. A coding
 * agent's marker in the environment means the agent is asking; no terminal
 * means nobody is there to decide.
 */
export const notTheOwner = (what: string, env: Readonly<Record<string, string | undefined>>, interactive: boolean): string | undefined => {
  const marker = CODING_AGENT_MARKERS.find((m) => env[m] !== undefined && env[m] !== "")
  if (marker) return `${what} is the owner's decision, and ${marker} is set, so this looks like a coding agent's session. The owner runs it from their own terminal.`
  if (!interactive) return `${what} is the owner's decision and needs the owner at a terminal.`
  return undefined
}

export const PullRequest = Schema.Struct({
  number: Schema.Number,
  state: Schema.String,
  title: Schema.String,
  url: Schema.String,
  headRefOid: Schema.String,
  headRefName: Schema.String,
  baseRefOid: Schema.String,
  baseRefName: Schema.String,
})
export type PullRequest = typeof PullRequest.Type

export class ForgeFailed extends Data.TaggedError("ForgeFailed")<{ readonly message: string }> {}

/** GitHub and the remote, as the owner's `gh` and git reach them. */
export interface ForgeShape {
  readonly pullRequest: (repo: string, pr: number) => Effect.Effect<PullRequest, ForgeFailed>
  /** The login `gh` is signed in as: whose approval a comment is. */
  readonly login: (repo: string) => Effect.Effect<string, ForgeFailed>
  readonly comment: (repo: string, pr: number, body: string) => Effect.Effect<void, ForgeFailed>
  readonly fetch: (repo: string, refspecs: ReadonlyArray<string>) => Effect.Effect<void, ForgeFailed>
  readonly push: (repo: string, refspec: string) => Effect.Effect<void, ForgeFailed>
}

const insideGit = (dir: string): boolean => existsSync(join(dir, ".git")) || (dirname(dir) !== dir && insideGit(dirname(dir)))

/**
 * Why `dir`, resolved from `--repo <given>`, can't be where the owner's
 * commands run gh and git, or undefined. Checked before anything is spawned:
 * a missing working directory makes the spawn fail as if gh itself were missing.
 */
export const checkoutProblem = (given: string, dir: string): string | undefined => {
  if (!existsSync(dir)) {
    return /^[\w.-]+\/[\w.-]+$/.test(given)
      ? `--repo takes a local checkout directory, not owner/name: ${given} doesn't exist here.`
      : `--repo takes a local checkout directory: ${dir} doesn't exist.`
  }
  if (!statSync(dir).isDirectory()) return `--repo takes a local checkout directory: ${dir} isn't a directory.`
  if (!insideGit(dir)) return `--repo takes a local checkout directory: ${dir} isn't a git checkout.`
  return undefined
}

/** What a failed spawn means: Bun blames the command for a missing working directory too. */
const spawnFailure = (cwd: string, command: string, e: unknown): string => {
  if ((e as { readonly code?: unknown }).code !== "ENOENT") return `${command} couldn't run: ${String(e)}`
  if (!existsSync(cwd)) return `${command} couldn't run: its working directory ${cwd} doesn't exist.`
  return command.includes("/") ? `${command} couldn't run: there's no such file.` : `${command} couldn't run: ${command} isn't on PATH.`
}

const run = (cwd: string, cmd: ReadonlyArray<string>) =>
  Effect.tryPromise({
    try: async () => {
      const p = Bun.spawn([...cmd], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" })
      const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
      return { code, stdout, stderr }
    },
    catch: (e) => new ForgeFailed({ message: spawnFailure(cwd, cmd[0]!, e) }),
  }).pipe(Effect.flatMap((r) => r.code === 0 ? Effect.succeed(r.stdout) : Effect.fail(new ForgeFailed({ message: `${cmd.join(" ")} failed: ${r.stderr.trim() || r.stdout.trim()}` }))))

const decodePr = Schema.decodeUnknownOption(Schema.fromJsonString(PullRequest))

/** The forge through the `gh` at `gh` and git's `origin`. */
export const ghForge = (gh = "gh"): ForgeShape => ({
  pullRequest: (repo, pr) =>
    run(repo, [gh, "pr", "view", String(pr), "--json", "number,state,title,url,headRefOid,headRefName,baseRefOid,baseRefName"]).pipe(
      Effect.flatMap((text) => Option.match(decodePr(text), { onNone: () => Effect.fail(new ForgeFailed({ message: `gh pr view ${pr} printed something unexpected` })), onSome: Effect.succeed })),
    ),
  login: (repo) => run(repo, [gh, "api", "user", "--jq", ".login"]).pipe(Effect.map((s) => s.trim())),
  comment: (repo, pr, body) => run(repo, [gh, "pr", "comment", String(pr), "--body", body]).pipe(Effect.asVoid),
  fetch: (repo, refspecs) => run(repo, ["git", "fetch", "--no-tags", "origin", ...refspecs]).pipe(Effect.asVoid),
  push: (repo, refspec) => run(repo, ["git", "push", "origin", refspec]).pipe(Effect.asVoid),
})

export const Forge = Context.Reference<ForgeShape>("@gauntlet/cli/Forge", { defaultValue: () => ghForge() })
