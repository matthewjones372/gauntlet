import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { TempRepo } from "../../core/test/temp-repo.ts"
import { cli, POLICY } from "./harness.ts"

// Files Gauntlet writes go through the project's own formatter, so a project
// whose lint checks formatting doesn't reject them (and block every change).

const FAKE_BIOME = `#!/bin/sh
# Records what it was asked to format, and formats .mcp.json the way Biome would.
echo "$@" >> .format-calls
[ -f .mcp.json ] && printf '{"mcpServers":{"gauntlet":{"type":"stdio","command":"gauntlet","args":["mcp"]}}}\\n' > .mcp.json
exit 0
`

let repos: TempRepo[] = []
afterEach(() => {
  for (const r of repos) r.cleanup()
  repos = []
})

const repoWith = (files: Record<string, string>) => {
  const repo = new TempRepo()
  repos.push(repo)
  repo.write({ ".gauntlet/policy.gx": POLICY, ...files })
  repo.commit("svc")
  return repo
}

const fakeBiome = (dir: string) => {
  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true })
  writeFileSync(join(dir, "node_modules", ".bin", "biome"), FAKE_BIOME, { mode: 0o755 })
}

describe("generated files and the project's formatter", () => {
  test("Biome formats exactly the files Gauntlet wrote", async () => {
    const repo = repoWith({ "biome.json": "{}\n" })
    fakeBiome(repo.dir)
    const r = await cli(["connect", "claude-code", "--repo", repo.dir])
    expect(r.code).toBe(0)
    const calls = readFileSync(join(repo.dir, ".format-calls"), "utf8")
    expect(calls).toStartWith("format --write")
    for (const f of [".mcp.json", ".claude/settings.json", "CLAUDE.md"]) expect(calls).toContain(f)
    expect(calls).not.toContain("biome.json")
    expect(readFileSync(join(repo.dir, ".mcp.json"), "utf8")).toContain(`"args":["mcp"]`)
  })

  test("running again changes nothing and reports nothing for the formatted file", async () => {
    const repo = repoWith({ "biome.json": "{}\n" })
    fakeBiome(repo.dir)
    await cli(["connect", "claude-code", "--repo", repo.dir])
    const r = await cli(["connect", "claude-code", "--repo", repo.dir])
    expect(r.out).not.toContain(".mcp.json")
  })

  test("no formatter configured: files are written as Gauntlet renders them", async () => {
    const repo = repoWith({})
    fakeBiome(repo.dir)
    const r = await cli(["connect", "claude-code", "--repo", repo.dir])
    expect(r.out).toContain("wrote .mcp.json")
    expect(() => readFileSync(join(repo.dir, ".format-calls"), "utf8")).toThrow()
  })
})
