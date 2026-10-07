import { describe, expect, test } from "bun:test"
import { compilePolicy } from "@gauntlet/dsl"
import { rustSpec } from "@gauntlet/pack-rust"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { github } from "../src/index.ts"

const text = readFileSync(join(import.meta.dir, "..", "..", "..", "examples", "fixtures", "rust-service", ".gauntlet", "policy.gx"), "utf8")
const compiled = compilePolicy({ file: ".gauntlet/policy.gx", text }, [rustSpec])
if (compiled._tag === "Invalid") throw new Error("the Rust fixture's policy doesn't compile")

describe("connect github for a Cargo project", () => {
  test("sets up Rust with clippy and llvm-tools, and installs the cargo tools the policy needs, all pinned", () => {
    const workflow = github({ mode: "repo", ir: compiled.compiled.ir, files: ["Cargo.toml"], gauntletVersion: "0.1.0", downloadUrl: "https://example.invalid/gauntlet" })[0]!.content
    const steps = (Bun.YAML.parse(workflow) as { jobs: { evidence: { steps: { name?: string; uses?: string; with?: Record<string, unknown> }[] } } }).jobs.evidence.steps
    const rust = steps.find((s) => s.name === "Set up Rust")
    expect(rust?.uses).toMatch(/^dtolnay\/rust-toolchain@[0-9a-f]{40}$/)
    expect(rust?.with).toEqual({ components: "clippy, llvm-tools-preview" })
    const tools = steps.find((s) => s.name === "Install cargo tools")
    expect(tools?.uses).toMatch(/^taiki-e\/install-action@[0-9a-f]{40}$/)
    expect(tools?.with).toEqual({ tool: "cargo-nextest,cargo-llvm-cov,cargo-mutants" })
  })
})
