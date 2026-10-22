import { afterEach, describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Option } from "effect"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { Git, GitLive, ProcessRunner, ProcessRunnerLive, type RunRequest } from "../src/index.ts"
import { TempRepo } from "./temp-repo.ts"

// A process's argv can't grow with its input: Linux refuses a single argument
// of 128 KiB or more, and all of them together past ARG_MAX, with E2BIG.
// `github-status --record` crashed this way on a large pull request, passing
// the whole shadow record as `git notes append -m <record>`.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

/** The live runner, noting every request it starts. */
const recording = (seen: RunRequest[]) =>
  Layer.effect(
    ProcessRunner,
    Effect.gen(function*() {
      const live = yield* ProcessRunner
      return { run: (request: RunRequest) => (seen.push(request), live.run(request)) }
    }),
  ).pipe(Layer.provide(ProcessRunnerLive), Layer.provide(BunServices.layer))

const run = <A, E>(e: Effect.Effect<A, E, Git>, seen: RunRequest[] = []) =>
  Effect.runPromise(e.pipe(Effect.provide(GitLive.pipe(Layer.provide(recording(seen))))))

const argvBytes = (r: RunRequest) => [r.command, ...r.args].reduce((n, a) => n + Buffer.byteLength(a) + 1, 0)
const longestArg = (r: RunRequest) => Math.max(...r.args.map((a) => Buffer.byteLength(a)))

const repo = () => {
  const r = new TempRepo()
  repos.push(r)
  r.write({ "a.txt": "a\n" })
  return { r, head: r.commit("base") }
}

describe("git argv stays small whatever the input", () => {
  test("a note line over 128 KiB is appended and read back", async () => {
    const { r, head } = repo()
    const line = JSON.stringify({ failed: Array.from({ length: 6000 }, (_, i) => `com.example.suite.SomeLongTestClassName${i}#test_case_${i}`) })
    expect(Buffer.byteLength(line)).toBeGreaterThan(256 * 1024)
    const seen: RunRequest[] = []
    await run(Git.use((git) => git.appendNote(r.dir, "gauntlet", head, line)), seen)
    await run(Git.use((git) => git.appendNote(r.dir, "gauntlet", head, "second")), seen)
    const note = await run(Git.use((git) => git.readNote(r.dir, "gauntlet", head)))
    expect(note).toEqual(Option.some(`${line}\n\nsecond\n`))
    for (const request of seen) expect(longestArg(request)).toBeLessThan(1024)
  })

  test("restoring and removing many long paths keeps every argv small", async () => {
    const { r } = repo()
    // 2000 paths of about 1 KiB each: 2 MiB of paths, more than ARG_MAX on most systems.
    const dirs = Array.from({ length: 4 }, (_, i) => `${String(i).repeat(200)}`).join("/")
    const paths = Array.from({ length: 2000 }, (_, i) => `${dirs}/${"f".repeat(150)}-${i}.txt`)
    r.write(Object.fromEntries(paths.map((p) => [p, `${p}\n`])))
    const base = r.commit("many")
    r.git("rm", "-r", "-q", String(0).repeat(200))
    r.commit("gone")
    const seen: RunRequest[] = []
    await run(Git.use((git) => git.restore(r.dir, base, paths)), seen)
    expect(paths.every((p) => existsSync(join(r.dir, p)))).toBe(true)
    await run(Git.use((git) => git.remove(r.dir, paths)), seen)
    expect(paths.some((p) => existsSync(join(r.dir, p)))).toBe(false)
    expect(await run(Git.use((git) => git.listWorkingFiles(r.dir)))).toEqual(["a.txt"])
    expect(seen.length).toBeGreaterThan(0)
    for (const request of seen) expect(argvBytes(request)).toBeLessThan(4096)
  })

  test("restoring and removing nothing runs nothing", async () => {
    const { r, head } = repo()
    const seen: RunRequest[] = []
    await run(Git.use((git) => Effect.all([git.restore(r.dir, head, []), git.remove(r.dir, [])])), seen)
    expect(seen).toEqual([])
  })
})
