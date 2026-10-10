// Gauntlet's own speed, for the policy's performance budgets (spec 0006). Each
// measures one thing that runs all the time, so a change that makes Gauntlet
// slower for everyone fails a budget instead of reaching people:
//
//   startup      the CLI starting and exiting
//   hook         the pre-tool-use hook Claude Code runs before every shell command
//   needs-build  CI's first step, deciding whether a change needs building at all
//   check        a whole check's own work on a small repository whose only check
//                is instant: worktree, diff facts, integrity, the decision, the report
//
//   bun scripts/bench.ts <startup|hook|needs-build|check> <out.json>
//
// Writes Gauntlet's budget JSON: p50, p95, max and mean in milliseconds.
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const MAIN = join(import.meta.dir, "..", "packages", "cli", "src", "main.ts")
export const RUNS = { startup: 7, hook: 7, "needs-build": 7, check: 5 } as const
export type What = keyof typeof RUNS

const timed = async (run: () => unknown | Promise<unknown>) => {
  const start = performance.now()
  await run()
  return performance.now() - start
}

const run = (command: string, args: string[], cwd?: string, input?: string) => {
  const r = spawnSync(command, args, { cwd, input: input ?? "", encoding: "utf8" })
  if (r.status !== 0) throw new Error(`${command} ${args.join(" ")} exited ${r.status}: ${r.stderr}`)
  return r.stdout.trim()
}
const gauntlet = (args: string[], input?: string) => run("bun", [MAIN, ...args], undefined, input)

// A small repository with a policy whose only check is an instant budget, and a change on top.
const POLICY = `gauntlet "bench"
use typescript
mode enforce
owners @bench
budget instant {
  command "sh instant.sh {json}"
  p95 < 1s
}
gates { fast { budget instant } }
review { auto when all gates pass }
`
const repo = () => {
  const dir = mkdtempSync(join(tmpdir(), "gauntlet-bench-"))
  const write = (files: Record<string, string>) => {
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true })
      writeFileSync(join(dir, p), text)
    }
  }
  const git = (...args: string[]) => run("git", ["-c", "user.name=bench", "-c", "user.email=bench@example.com", "-c", "commit.gpgsign=false", ...args], dir)
  git("init", "-q", "-b", "main")
  write({ ".gauntlet/policy.gx": POLICY, "instant.sh": "echo '{\"p95\": 1}' > \"$1\"\n", "src/app.ts": "export const add = (a: number, b: number) => a + b\n", "test/app.test.ts": "import { add } from \"../src/app\"\n" })
  git("add", "-A")
  git("commit", "-q", "-m", "base")
  const base = git("rev-parse", "HEAD")
  write({ "src/app.ts": "export const add = (a: number, b: number) => a + b\nexport const sub = (a: number, b: number) => a - b\n" })
  git("commit", "-qam", "change")
  return { dir, base, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** How long each of `runs` runs of one thing took, in milliseconds. */
export const measure = async (what: What, runs: number = RUNS[what]): Promise<number[]> => {
  const times: number[] = []
  if (what === "startup") {
    for (let i = 0; i < runs; i++) times.push(await timed(() => gauntlet(["--version"])))
    return times
  }
  const r = repo()
  try {
    if (what === "hook") {
      const input = JSON.stringify({ tool_name: "Bash", tool_input: { command: "git status" }, cwd: r.dir })
      for (let i = 0; i < runs; i++) times.push(await timed(() => gauntlet(["hook", "pre-tool-use"], input)))
    } else if (what === "needs-build") {
      for (let i = 0; i < runs; i++) times.push(await timed(() => gauntlet(["needs-build", "--repo", r.dir, "--policy-ref", r.base, "--head", "HEAD"])))
    } else {
      for (let i = 0; i < runs; i++) {
        const out = join(r.dir, `out-${i}`)
        times.push(await timed(() => gauntlet(["check", "--repo", r.dir, "--base", r.base, "--out", out, "--no-record"])))
        // Measure a check that went all the way: its check ran and passed.
        const checks = (JSON.parse(readFileSync(join(out, "gauntlet-report.json"), "utf8")) as { checks: { check: string; status: string; reason?: string }[] }).checks
        const notPassed = checks.filter((c) => c.status !== "passed")
        if (checks.length === 0 || notPassed.length > 0) throw new Error(`the benchmark's check didn't pass: ${JSON.stringify(notPassed)}`)
      }
    }
    return times
  } finally {
    r.cleanup()
  }
}

const percentile = (sorted: ReadonlyArray<number>, p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!
const round = (n: number) => Math.round(n * 10) / 10

/** Gauntlet's budget JSON for a set of timings. */
export const summarise = (times: ReadonlyArray<number>) => {
  const sorted = [...times].sort((a, b) => a - b)
  return {
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    max: round(sorted.at(-1)!),
    mean: round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
  }
}

if (import.meta.main) {
  const [what, out] = process.argv.slice(2) as [What | undefined, string | undefined]
  if (!what || !(what in RUNS) || !out) {
    console.error(`usage: bun scripts/bench.ts <${Object.keys(RUNS).join("|")}> <out.json>`)
    process.exit(2)
  }
  // One run first, unmeasured: the first start pays for loading files from disk.
  await measure(what, 1)
  const result = summarise(await measure(what))
  writeFileSync(out, JSON.stringify(result))
  console.log(`${what}: ${JSON.stringify(result)}`)
}
