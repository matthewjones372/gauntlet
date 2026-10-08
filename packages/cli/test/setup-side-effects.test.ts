import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { TempRepo } from "../../core/test/temp-repo.ts"
import { ignoreInKnip, Output } from "../src/index.ts"
import { INSTALLED_PACKS } from "../src/packs.ts"
import { cli } from "./harness.ts"

// gauntlet setup cleans up after itself, so the project's own checks don't
// fail on what it added (and trap the agent in a loop).

const dirs: string[] = []
const repos: TempRepo[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  repos.splice(0).forEach((r) => r.cleanup())
})
const quiet = Layer.mergeAll(Layer.succeed(Output, { out: () => Effect.void, err: () => Effect.void }), BunServices.layer)

describe("knip and the tools setup installs", () => {
  test("they're added to knip's ignoreDependencies, keeping what was there", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gauntlet-knip-"))
    dirs.push(dir)
    writeFileSync(join(dir, "knip.json"), JSON.stringify({ entry: ["src/main.ts"], ignoreDependencies: ["@swc/core"] }))
    await Effect.runPromise(ignoreInKnip(dir, ["@stryker-mutator/core", "@swc/core"]).pipe(Effect.provide(quiet)))
    const knip = JSON.parse(readFileSync(join(dir, "knip.json"), "utf8"))
    expect(knip.ignoreDependencies).toEqual(["@swc/core", "@stryker-mutator/core"])
    expect(knip.entry).toEqual(["src/main.ts"])
  })

  test("a project without knip is left alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gauntlet-knip-"))
    dirs.push(dir)
    await Effect.runPromise(ignoreInKnip(dir, ["@stryker-mutator/core"]).pipe(Effect.provide(quiet)))
    expect(() => readFileSync(join(dir, "knip.json"))).toThrow()
  })
})

describe("Claude Code's personal settings", () => {
  test("setup keeps .claude/settings.local.json out of git, once", async () => {
    const r = new TempRepo()
    repos.push(r)
    r.write({ ".gitignore": "node_modules/", "go.mod": "module example.com/svc\n\ngo 1.21\n", "a.go": "package svc\n", "a_test.go": "package svc\n" })
    r.commit("project")
    await cli(["setup", "--repo", r.dir], [...INSTALLED_PACKS])
    await cli(["setup", "--repo", r.dir], [...INSTALLED_PACKS])
    expect(readFileSync(join(r.dir, ".gitignore"), "utf8")).toBe("node_modules/\n.claude/settings.local.json\n")
  }, 60_000)
})
