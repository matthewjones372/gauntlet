import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { ADD_A_PACK_URL, REQUEST_SUPPORT_URL, unsupportedBuilds, unsupportedNote } from "@gauntlet/core"
import { TempRepo } from "../../core/test/temp-repo.ts"
import { answers, appLayer, ExitStatus, Output, runCli } from "../src/index.ts"
import { INSTALLED_PACKS } from "../src/packs.ts"

// Setup says plainly when part of a project uses a language or build tool
// Gauntlet doesn't support, and how to ask for it or add it. In a project set
// up before its tools were, running setup again offers to install them.

const FAKE_UV = `#!/bin/sh
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

const repo = (files: Record<string, string>) => {
  const r = new TempRepo()
  r.write(files)
  r.commit("project")
  cleanup.push(() => r.cleanup())
  return r
}

const setup = async (dir: string, replies: string[] = []) => {
  const out: string[] = []
  const capture = Layer.succeed(Output, { out: (t) => Effect.sync(() => void out.push(t)), err: (t) => Effect.sync(() => void out.push(t)) })
  const code = await Effect.runPromise(runCli(["setup", "--repo", dir, "--owner", "@me"]).pipe(
    Effect.provide(Layer.mergeAll(appLayer([...INSTALLED_PACKS]), capture, ExitStatus.layer, answers(...replies))),
  ))
  return { code, out: out.join("\n") }
}

const PYTHON = { "pyproject.toml": `[project]\nname = "svc"\nversion = "0.1.0"\n`, "uv.lock": "version = 1\n", "svc/app.py": "def f():\n    return 1\n", "tests/test_app.py": "def test_f():\n    pass\n" }

describe("languages and build tools Gauntlet doesn't support", () => {
  test("are recognised from their build files", () => {
    expect(unsupportedBuilds(["pom.xml", "api/Api.csproj", "node_modules/x/Gemfile", "web/package.json"])).toEqual(["Maven", ".NET"])
    expect(unsupportedNote(["Maven"])).toBe(`Gauntlet doesn't support Maven yet, so that part isn't checked. Ask for it: ${REQUEST_SUPPORT_URL}?title=Support%20Maven. Or add it yourself: ${ADD_A_PACK_URL}`)
  })

  test("a project only in one: setup says so, and how to ask for it or add it", async () => {
    const r = repo({ "pom.xml": "<project/>\n", "src/main/java/App.java": "class App {}\n" })
    const { code, out } = await setup(r.dir)
    expect(code).not.toBe(0)
    expect(out).toContain("Gauntlet doesn't support Maven yet, so that part isn't checked.")
    expect(out).toContain(ADD_A_PACK_URL)
  })

  test("a project partly in one: setup drafts for the rest, and says which part isn't checked", async () => {
    const r = repo({ ...PYTHON, "legacy/pom.xml": "<project/>\n" })
    const { out } = await setup(r.dir, ["n"])
    expect(out).toContain("Drafted .gauntlet/policy.gx for python")
    expect(out).toContain("Gauntlet doesn't support Maven yet, so that part isn't checked.")
  })
})

describe("a project set up before its tools were", () => {
  test("running setup again offers to install them, and says how their checks join the policy", async () => {
    const r = repo({ ...PYTHON, ".gauntlet/policy.gx": `gauntlet "svc"\nuse python\nmode shadow\nowners @me\n` })
    const bin = mkdtempSync(join(tmpdir(), "fake-uv-"))
    writeFileSync(join(bin, "uv"), FAKE_UV, { mode: 0o755 })
    const path = process.env.PATH
    process.env.PATH = `${bin}:${path}`
    cleanup.push(() => {
      process.env.PATH = path
      rmSync(bin, { recursive: true, force: true })
    })
    const { out } = await setup(r.dir, ["y"])
    expect(out).toContain(".gauntlet/policy.gx already exists; keeping it.")
    expect(out).toContain("Gauntlet could check more here with tools the project doesn't have yet.")
    expect(out).toContain("I'll install these for you:")
    expect(out).toContain("To add their checks to the policy, run /gauntlet-setup in Claude Code.")
  })
})
