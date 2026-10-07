import { describe, expect, test } from "bun:test"
import { compilePolicy } from "@gauntlet/dsl"
import { goSpec } from "@gauntlet/pack-go"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { github } from "../src/index.ts"

const text = readFileSync(join(import.meta.dir, "..", "..", "..", "examples", "fixtures", "go-service", ".gauntlet", "policy.gx"), "utf8")
const compiled = compilePolicy({ file: ".gauntlet/policy.gx", text }, [goSpec])
if (compiled._tag === "Invalid") throw new Error("the Go fixture's policy doesn't compile")

describe("connect github for a Go module", () => {
  test("sets up Go from go.mod and installs the pinned lint and mutation tools the policy gates", () => {
    const workflow = github({ mode: "repo", ir: compiled.compiled.ir, files: ["go.mod"], gauntletVersion: "0.1.0", downloadUrl: "https://example.invalid/gauntlet" })[0]!.content
    const evidence = (Bun.YAML.parse(workflow) as { jobs: { evidence: { steps: { name?: string; uses?: string; with?: Record<string, unknown>; run?: string }[] } } }).jobs.evidence
    const setup = evidence.steps.find((s) => s.name === "Set up Go")
    expect(setup?.uses).toMatch(/^actions\/setup-go@[0-9a-f]{40}$/)
    expect(setup?.with).toEqual({ "go-version-file": "go.mod", cache: false })
    const tools = evidence.steps.find((s) => s.name === "Install Go tools")?.run ?? ""
    expect(tools).toContain("go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.14.0")
    expect(tools).toContain("go install github.com/go-gremlins/gremlins/cmd/gremlins@v0.6.0")
    expect(tools).toContain(`echo "$(go env GOPATH)/bin" >> "$GITHUB_PATH"`)
  })
})
