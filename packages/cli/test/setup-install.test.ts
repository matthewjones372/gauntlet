import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { TempRepo } from "../../core/test/temp-repo.ts"
import { answers, appLayer, ExitStatus, Output, runCli } from "../src/index.ts"
import { INSTALLED_PACKS } from "../src/packs.ts"

// `gauntlet setup` offers to install the tools its draft left out, and drafts
// again with them once they're installed. A fake uv stands in for the real one.

const FAKE_UV = `#!/bin/sh
# uv add --dev a b c: record them as the dev group, as uv would.
[ "$1" = "add" ] && [ "$2" = "--dev" ] || exit 2
shift 2
list=""
for p in "$@"; do list="$list\\"$p\\", "; done
printf '\\n[dependency-groups]\\ndev = [%s"pytest"]\\n' "$list" >> pyproject.toml
`

let cleanup: Array<() => void> = []
afterEach(() => {
  for (const c of cleanup) c()
  cleanup = []
})

const pythonRepo = () => {
  const repo = new TempRepo()
  repo.write({ "pyproject.toml": `[project]\nname = "svc"\nversion = "0.1.0"\n`, "uv.lock": "version = 1\n", "svc/app.py": "def f():\n    return 1\n", "tests/test_app.py": "def test_f():\n    pass\n" })
  repo.commit("svc")
  const bin = mkdtempSync(join(tmpdir(), "gauntlet-fake-uv-"))
  writeFileSync(join(bin, "uv"), FAKE_UV, { mode: 0o755 })
  const path = process.env.PATH
  process.env.PATH = `${bin}:${path}`
  cleanup.push(() => {
    process.env.PATH = path
    rmSync(bin, { recursive: true, force: true })
    repo.cleanup()
  })
  return { repo }
}

const setup = async (dir: string, replies: string[], extra: string[] = []) => {
  const out: string[] = []
  const capture = Layer.succeed(Output, { out: (t) => Effect.sync(() => void out.push(t)), err: (t) => Effect.sync(() => void out.push(t)) })
  const code = await Effect.runPromise(runCli(["setup", "--repo", dir, "--owner", "@me", ...extra]).pipe(
    Effect.provide(Layer.mergeAll(appLayer([...INSTALLED_PACKS]), capture, ExitStatus.layer, answers(...replies))),
  ))
  return { code, out: out.join("\n"), policy: readFileSync(join(dir, ".gauntlet", "policy.gx"), "utf8") }
}

describe("gauntlet setup installs missing tools", () => {
  test("says it'll install them, and on yes installs and drafts the gates in", async () => {
    const { repo } = pythonRepo()
    const r = await setup(repo.dir, ["y"])
    expect(r.out).toContain("I'll install these for you:\n  uv add --dev mypy ruff pytest coverage mutmut")
    expect(r.out).toContain("Installed.")
    expect(r.policy).toContain("build")
    expect(r.policy).toContain("mutation ratchet")
    expect(r.out).not.toContain("Checks still left out")
    expect(r.code).toBe(0)
  })

  test("on no, installs nothing and leaves the gates out, listing them once", async () => {
    const { repo } = pythonRepo()
    const r = await setup(repo.dir, ["n"])
    expect(r.out).toContain("Nothing installed.")
    expect(readFileSync(join(repo.dir, "pyproject.toml"), "utf8")).not.toContain("mypy")
    expect(r.policy).not.toContain("mutation")
    expect(r.out.split("left out until their tools are set up").length - 1).toBe(1)
  })

  test("with nobody to ask, says how to let it install", async () => {
    const { repo } = pythonRepo()
    const r = await setup(repo.dir, [])
    expect(r.out).toContain("Run `gauntlet setup --yes` to install them")
  })

  test("--yes installs without asking", async () => {
    const { repo } = pythonRepo()
    const r = await setup(repo.dir, [], ["--yes"])
    expect(r.out).toContain("Installed.")
    expect(r.policy).toContain("lint ratchet")
  })
})
