import { describe, expect, test } from "bun:test"
import { compilePolicy, formatDiagnostics } from "@gauntlet/dsl"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { jvmSpec } from "@gauntlet/pack-jvm"
import { pythonSpec } from "@gauntlet/pack-python"
import { typescriptSpec } from "@gauntlet/pack-typescript"
import { claudeCode, codeowners, denyRules, github, mergeBlock, mergeSettings, render, toCodeownersPattern } from "../src/index.ts"
import { expectGolden } from "./golden-file.ts"

const root = join(import.meta.dir, "..", "..", "..")
const policyOf = (path: string) => {
  const text = readFileSync(join(root, path), "utf8")
  const r = compilePolicy({ file: ".gauntlet/policy.gx", text }, [jvmSpec, typescriptSpec, pythonSpec])
  if (r._tag === "Invalid") throw new Error(formatDiagnostics(r.diagnostics, text))
  return r.compiled.ir
}
const kotlin = policyOf("examples/fixtures/kotlin-service/.gauntlet/policy.gx")
const trade = policyOf("examples/policies/valid/trade-reporting.gx")
const options = (mode: "repo" | "org") => ({
  mode,
  ir: kotlin,
  files: ["settings.gradle.kts", "build.gradle.kts", "gradlew"],
  gauntletVersion: "0.1.0",
  downloadUrl: "https://example.invalid/gauntlet/v0.1.0/gauntlet-linux-x64",
  sha256: "a".repeat(64),
  javaVersion: "25",
})

describe("connect github", () => {
  for (const mode of ["repo", "org"] as const) {
    test(`${mode} mode files match their snapshots and parse as YAML`, () => {
      for (const f of github(options(mode))) {
        expectGolden(join(import.meta.dir, "golden", mode, f.path.replaceAll("/", "__")), f.content)
        if (f.path.endsWith(".yml")) expect(() => Bun.YAML.parse(f.content)).not.toThrow()
      }
    })
  }

  test("the job that runs the change has no secrets and a read-only token", () => {
    const workflow = Bun.YAML.parse(github(options("repo"))[0]!.content) as { permissions: unknown; jobs: Record<string, { permissions: Record<string, string>; steps: { uses?: string; with?: Record<string, unknown> }[] }> }
    expect(workflow.permissions).toEqual({})
    const evidence = workflow.jobs.evidence!
    expect(evidence.permissions).toEqual({ contents: "read" })
    expect(JSON.stringify(evidence)).not.toContain("secrets.")
    expect(evidence.steps[0]?.with?.["persist-credentials"]).toBe(false)
    const status = workflow.jobs.status!
    expect(status.permissions).toEqual({ contents: "write", "pull-requests": "write", checks: "write", actions: "read" })
    // The trusted job checks out the base, never the change.
    expect(status.steps[0]?.with?.ref).toBe("${{ github.event.pull_request.base.sha }}")
  })

  test("every action is pinned to a commit", () => {
    for (const f of github(options("repo")).concat(github(options("org")))) {
      for (const m of f.content.matchAll(/uses: (\S+)/g)) expect(m[1]).toMatch(/@[0-9a-f]{40}$/)
    }
  })

  test("toolchains follow the policy's packs", () => {
    const ts = policyOf("examples/fixtures/ts-service/.gauntlet/policy.gx")
    const py = policyOf("examples/fixtures/py-service/.gauntlet/policy.gx")
    expect(github({ ...options("repo"), ir: ts, files: ["bun.lock"] })[0]!.content).toContain("oven-sh/setup-bun@")
    expect(github({ ...options("repo"), ir: py, files: ["uv.lock"] })[0]!.content).toContain("astral-sh/setup-uv@")
    expect(github({ ...options("repo"), ir: py, files: ["uv.lock"] })[0]!.content).not.toContain("setup-java")
  })
})

describe("CODEOWNERS", () => {
  test("patterns", () => {
    expect(toCodeownersPattern("src/test/**")).toBe("/src/test/")
    expect(toCodeownersPattern("*.gradle.kts")).toBe("*.gradle.kts")
    expect(toCodeownersPattern("src/**/settlement/**")).toBe("/src/**/settlement/")
  })

  test(".gauntlet/ comes last so it wins, and zones get their owners", () => {
    const content = codeowners(trade).content
    expectGolden(join(import.meta.dir, "golden", "CODEOWNERS-trade-reporting"), content)
    const lines = content.trim().split("\n")
    expect(lines.at(-1)).toBe("/.gauntlet/ @platform")
    expect(content).toContain("/src/**/settlement/ @payments")
  })
})

describe("merging into existing files", () => {
  test("a block replaces its previous version and keeps everything else", () => {
    const once = mergeBlock(".github/CODEOWNERS", "* @everyone\n", "/a/ @x")
    const twice = mergeBlock(".github/CODEOWNERS", once, "/b/ @y")
    expect(twice).toContain("* @everyone")
    expect(twice).toContain("/b/ @y")
    expect(twice).not.toContain("/a/ @x")
    expect(mergeBlock(".github/CODEOWNERS", twice, "/b/ @y")).toBe(twice)
  })

  test("Claude Code settings keep the user's hooks and rules, and reruns don't duplicate ours", () => {
    const user = { model: "x", hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] }, permissions: { deny: ["Bash(rm -rf *)"] } }
    const once = mergeSettings(user, kotlin, ["settings.gradle.kts"])
    const twice = mergeSettings(once, kotlin, ["settings.gradle.kts"])
    expect(twice).toEqual(once)
    expect(JSON.stringify(once)).toContain("say done")
    expect((once.permissions as { deny: string[] }).deny).toContain("Bash(rm -rf *)")
    expect((once.permissions as { deny: string[] }).deny).toContain("Write(settings.gradle.kts)")
    expect(once.model).toBe("x")
  })

  test("new test files stay writable: only non-test groups and runner config get blanket deny rules", () => {
    const rules = denyRules(kotlin, [])
    expect(rules.some((r) => r.includes("src/test"))).toBe(false)
    expect(rules).toContain("Edit(*.gradle.kts)")
  })

  test("an unreadable settings file is never overwritten", () => {
    expect(claudeCode({ ir: kotlin, runnerConfig: [], existingSettings: "{ not json" })).toEqual({ _tag: "Unreadable", path: ".claude/settings.json" })
  })

  test("generated Claude Code files match their snapshots", () => {
    const result = claudeCode({ ir: kotlin, runnerConfig: ["settings.gradle.kts"] })
    expect(result._tag).toBe("Files")
    if (result._tag !== "Files") return
    expect(result.files.map((f) => f.path)).toEqual([".claude/settings.json", ".mcp.json", "CLAUDE.md", "AGENTS.md", ".claude/gauntlet-managed-settings.example.json", ".claude/commands/gauntlet-setup.md"])
    for (const f of result.files) expectGolden(join(import.meta.dir, "golden", "claude-code", f.path.replaceAll("/", "__")), render(f, undefined))
  })
})
