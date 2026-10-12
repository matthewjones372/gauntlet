import { afterEach, describe, expect, test } from "bun:test"
import { compilePolicy, formatDiagnostics } from "@gauntlet/dsl"
import { jvmSpec } from "@gauntlet/pack-jvm"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { github } from "../src/index.ts"

// Stacks on GitHub (spec 0015). When a stack's pull request merges, the
// workflow moves the pull requests based on its branch onto the branch it
// merged into, and only then deletes its branch: deleting it first closes
// them. And a reopened pull request is judged against its base branch as it
// is now, not the base its event still names from when it was opened.

const root = join(import.meta.dir, "..", "..", "..")
const text = readFileSync(join(root, "examples/fixtures/kotlin-service/.gauntlet/policy.gx"), "utf8")
const compiled = compilePolicy({ file: ".gauntlet/policy.gx", text }, [jvmSpec])
if (compiled._tag === "Invalid") throw new Error(formatDiagnostics(compiled.diagnostics, text))

type Step = { name: string; id?: string; if?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> }
type Job = { if?: string; permissions?: Record<string, string>; env?: Record<string, string>; steps: Step[] }
const workflow = Bun.YAML.parse(github({
  mode: "repo",
  ir: compiled.compiled.ir,
  files: ["settings.gradle.kts"],
  gauntletVersion: "0.1.0",
  downloadUrl: "https://example.invalid/gauntlet-linux-x64",
  sha256: "a".repeat(64),
})[0]!.content) as { on: { pull_request_target: { types: string[] } }; jobs: Record<string, Job> }

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

/** Runs a step's script with a `gh` that logs its calls and answers from `answers` (by its arguments). */
const runStep = (script: string, env: Record<string, string>, answers: Record<string, string>, cwd?: string) => {
  const dir = mkdtempSync(join(tmpdir(), "gauntlet-wf-"))
  dirs.push(dir)
  const log = join(dir, "gh.log")
  const cases = Object.entries(answers).map(([args, out]) => `  "${args}") printf '%s\\n' '${out}' ;;`).join("\n")
  // Once a pull request is moved, listing the ones based on the merged branch finds none.
  const moved = `case "$*" in "pr list"*) grep -q "^api -X PATCH" "${log}" 2>/dev/null && exit 0 ;; esac`
  writeFileSync(join(dir, "gh"), `#!/bin/sh\n${moved}\nprintf '%s\\n' "$*" >> "${log}"\ncase "$*" in\n${cases}\n  *) ;;\nesac\n`)
  chmodSync(join(dir, "gh"), 0o755)
  const output = join(dir, "output")
  writeFileSync(output, "")
  const r = Bun.spawnSync(["bash", "-e", "-c", script], { cwd: cwd ?? dir, env: { PATH: `${dir}:${process.env.PATH}`, GITHUB_REPOSITORY: "o/r", GITHUB_OUTPUT: output, ...env } })
  const calls = (() => {
    try {
      return readFileSync(log, "utf8").trim().split("\n").filter((l) => l !== "")
    } catch {
      return []
    }
  })()
  return { code: r.exitCode, calls, output: readFileSync(output, "utf8"), stderr: r.stderr.toString() }
}

describe("a stack pull request merges", () => {
  const job = workflow.jobs.stack!
  const step = job.steps.find((s) => s.run !== undefined)!
  const env = { ...job.env, MERGED: "stack-1", MERGED_SHA: "1".repeat(40), INTO: "main", SAME_REPO: "true", DEFAULT_BRANCH: "main" }
  const list = "pr list --repo o/r --state open --base stack-1 --json number --jq .[].number"
  const ref = "api repos/o/r/git/ref/heads/stack-1 --jq .object.sha"

  test("runs on a merge only, and may edit pull requests and delete branches", () => {
    expect(workflow.on.pull_request_target.types).toContain("closed")
    expect(job.if).toBe("github.event_name == 'pull_request_target' && github.event.action == 'closed' && github.event.pull_request.merged")
    expect(job.permissions).toEqual({ contents: "write", "pull-requests": "write" })
    // Branch names reach the script as variables, never pasted into it.
    expect(step.run).not.toContain("${{")
  })

  test("the pull requests above move onto the branch it merged into, then its branch goes", () => {
    const first = runStep(step.run!, env, { [list]: "8\n9", [ref]: "1".repeat(40) })
    expect(first.code).toBe(0)
    expect(first.calls.filter((c) => c.startsWith("api -X PATCH"))).toEqual(["api -X PATCH repos/o/r/pulls/8 -f base=main", "api -X PATCH repos/o/r/pulls/9 -f base=main"])
    expect(first.calls.findIndex((c) => c.startsWith("api -X DELETE"))).toBeGreaterThan(first.calls.lastIndexOf("api -X PATCH repos/o/r/pulls/9 -f base=main"))
    expect(first.calls.at(-1)).toBe("api -X DELETE repos/o/r/git/refs/heads/stack-1")
  })

  test("the branch stays while a pull request is still based on it", () => {
    // The move didn't happen (the edit is left out), so the next pull request is still based on the branch.
    const stuck = runStep(step.run!.replace(/gh api -X PATCH[^\n]*/, "true"), env, { [list]: "8", [ref]: "1".repeat(40) })
    expect(stuck.calls.some((c) => c.includes("DELETE"))).toBe(false)
  })

  test("the branch stays when it moved on, is another repository's, or is the default branch", () => {
    expect(runStep(step.run!, env, { [ref]: "2".repeat(40) }).calls.some((c) => c.includes("DELETE"))).toBe(false)
    expect(runStep(step.run!, { ...env, SAME_REPO: "false" }, { [ref]: "1".repeat(40) }).calls.some((c) => c.includes("DELETE"))).toBe(false)
    expect(runStep(step.run!, { ...env, MERGED: "main" }, { "api repos/o/r/git/ref/heads/main --jq .object.sha": "1".repeat(40) }).calls.some((c) => c.includes("DELETE"))).toBe(false)
  })

  test("the jobs that judge a change don't run for it", () => {
    expect(workflow.jobs.evidence!.if).toContain("github.event.action != 'closed'")
    expect(workflow.jobs.status!.if).toContain("github.event.action != 'closed'")
  })
})

describe("a reopened pull request", () => {
  /** A clone whose origin's main has moved past the base the event names. */
  const clone = () => {
    const dir = mkdtempSync(join(tmpdir(), "gauntlet-wf-repo-"))
    dirs.push(dir)
    const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@e.invalid", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@e.invalid" } }).stdout.toString().trim()
    git("init", "-q", "-b", "main")
    git("commit", "-q", "--allow-empty", "-m", "old base")
    const stale = git("rev-parse", "HEAD")
    git("commit", "-q", "--allow-empty", "-m", "main moved on")
    const tip = git("rev-parse", "HEAD")
    git("update-ref", "refs/remotes/origin/main", tip)
    return { dir, stale, tip }
  }

  test("the evidence job judges it against its base branch's tip", () => {
    const job = workflow.jobs.evidence!
    const base = job.steps.find((s) => s.id === "base")!
    expect(job.steps.indexOf(base)).toBe(1)
    const { dir, stale, tip } = clone()
    const env = { EVENT_BASE: stale, BASE_REF: "main" }
    expect(runStep(base.run!, { ...env, ACTION: "reopened" }, {}, dir).output).toBe(`sha=${tip}\n`)
    expect(runStep(base.run!, { ...env, ACTION: "synchronize" }, {}, dir).output).toBe(`sha=${stale}\n`)
    const check = job.steps.find((s) => s.name === "Check the change with the base commit's policy")!
    expect(check.env?.BASE).toBe("${{ steps.base.outputs.sha }}")
  })

  test("the status job does too", () => {
    const job = workflow.jobs.status!
    const step = job.steps.find((s) => s.if === "github.event_name == 'pull_request_target' && github.event.action == 'reopened'")!
    expect(job.steps.indexOf(step)).toBe(1)
    const { dir, tip } = clone()
    const env = join(dir, "env")
    writeFileSync(env, "")
    runStep(step.run!, { BASE_REF: "main", GITHUB_ENV: env }, {}, dir)
    expect(readFileSync(env, "utf8")).toBe(`BASE=${tip}\n`)
  })
})
