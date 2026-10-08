import { afterEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { scriptPack } from "../../core/test/script-pack.ts"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { answers, appLayer, ExitStatus, Output, runCli, stdinText } from "../src/index.ts"
import { baseRepo } from "./harness.ts"

// Spec 0005. The Stop hook doesn't hold an agent to failures it didn't cause,
// and the adoption window is the one time an agent may fix protected tests.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

const run = async (args: string[], opts: { stdin?: string; replies?: string[] } = {}) => {
  const out: string[] = []
  const capture = Layer.succeed(Output, { out: (t) => Effect.sync(() => void out.push(t)), err: (t) => Effect.sync(() => void out.push(t)) })
  const code = await Effect.runPromise(runCli(args).pipe(Effect.provide(Layer.mergeAll(appLayer([scriptPack]), capture, ExitStatus.layer, stdinText(opts.stdin ?? ""), answers(...(opts.replies ?? []))))))
  return { code, out: out.join("\n") }
}
const stop = (r: TempRepo) => run(["hook", "stop"], { stdin: JSON.stringify({ cwd: r.dir }) })
const edit = (r: TempRepo, file: string) => run(["hook", "pre-tool-use"], { stdin: JSON.stringify({ cwd: r.dir, tool_name: "Edit", tool_input: { file_path: join(r.dir, file) } }) })
const denied = (res: { out: string }) => res.out !== "" && JSON.parse(res.out).hookSpecificOutput.permissionDecision === "deny"

/** A project whose own tests already fail on main, as one adopting Gauntlet might. */
const failingProject = () => {
  const s = baseRepo()
  repos.push(s.r)
  s.r.git("checkout", "-q", "main")
  writeFileSync(join(s.r.dir, "src/main/behaviour.txt"), "broken round\n")
  s.r.commit("already failing")
  return s.r
}

describe("the Stop hook and failures the agent didn't cause", () => {
  test("only Gauntlet's setup files changed: nothing to judge, the agent may stop", async () => {
    const r = failingProject()
    writeFileSync(join(r.dir, "gauntlet.proposal.gx"), "gauntlet \"svc\"\n")
    writeFileSync(join(r.dir, "CLAUDE.md"), "notes\n")
    expect((await stop(r)).out).toBe("")
  })

  test("a change to the code is judged as before", async () => {
    const r = failingProject()
    writeFileSync(join(r.dir, "src/main/App.kt"), "class App2\n")
    expect(JSON.parse((await stop(r)).out).decision).toBe("block")
  })
})

describe("the adoption window", () => {
  test("only a person at a terminal can open it", async () => {
    const r = failingProject()
    const res = await run(["adopt", "--repo", r.dir])
    expect(res.code).toBe(2)
    expect(res.out).toContain("needs you at a terminal")
    expect(denied(await edit(r, "src/test/AddTest.txt"))).toBe(true)
  })

  test("open: protected tests may be edited and each one is recorded; the next commit closes it", async () => {
    const r = failingProject()
    const opened = await run(["adopt", "--repo", r.dir], { replies: ["adopt"] })
    expect(opened.out).toContain("Open.")
    expect((await edit(r, "src/test/AddTest.txt")).out).toBe("")
    // Configuration and Gauntlet's own files stay locked.
    expect(denied(await edit(r, ".gauntlet/policy.gx"))).toBe(true)
    expect(denied(await edit(r, ".git/gauntlet/adoption.json"))).toBe(true)
    expect((await run(["adopt", "--repo", r.dir, "--status"])).out).toContain("  - src/test/AddTest.txt")
    writeFileSync(join(r.dir, "src/test/AddTest.txt"), "add\n")
    r.commit("fixed the test")
    expect(denied(await edit(r, "src/test/AddTest.txt"))).toBe(true)
    const closed = await run(["adopt", "--repo", r.dir, "--close"])
    expect(closed.out).toContain("closed by a commit")
    expect(closed.out).toContain("src/test/AddTest.txt")
  })

  test("anything but the typed word leaves it shut", async () => {
    const r = failingProject()
    expect((await run(["adopt", "--repo", r.dir], { replies: ["yes"] })).out).toContain("Not opened.")
    expect(denied(await edit(r, "src/test/AddTest.txt"))).toBe(true)
  })
})
