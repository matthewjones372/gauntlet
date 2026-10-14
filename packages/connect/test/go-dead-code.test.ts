import { describe, expect, test } from "bun:test"
import { compilePolicy } from "@gauntlet/dsl"
import { DEADCODE_MODULE, goSpec } from "@gauntlet/pack-go"
import { github } from "../src/index.ts"

// Spec 0017 §4: a Go policy with a dead-code gate gets deadcode installed in CI,
// at the version the Go pack's missing-tool message names.

describe("connect github for a Go module with a dead-code gate", () => {
  test("installs deadcode at the pinned version the Go pack names", () => {
    const policy = compilePolicy({ file: ".gauntlet/policy.gx", text: `gauntlet "svc"\nuse go\nmode enforce\nowners @p\ngates { fast { build, dead-code ratchet } }\nreview { auto when all gates pass }\n` }, [goSpec])
    if (policy._tag === "Invalid") throw new Error("the policy doesn't compile")
    const workflow = github({ mode: "repo", ir: policy.compiled.ir, files: ["go.mod"], gauntletVersion: "0.1.0", downloadUrl: "https://example.invalid/gauntlet" })[0]!.content
    const evidence = (Bun.YAML.parse(workflow) as { jobs: { evidence: { steps: { name?: string; run?: string }[] } } }).jobs.evidence
    const tools = evidence.steps.find((s) => s.name === "Install Go tools")?.run ?? ""
    expect(tools).toContain(`go install ${DEADCODE_MODULE}`)
    expect(tools).not.toContain("golangci-lint")
  })
})
