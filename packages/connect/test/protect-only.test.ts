import { describe, expect, test } from "bun:test"
import { protectOnlyIr } from "../../core/src/protect-only.ts"
import { compilePolicy } from "@gauntlet/dsl"
import { goSpec } from "@gauntlet/pack-go"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { github } from "../src/index.ts"

// `connect github --protect-only` (spec 0001): both jobs judge with
// --protect-only, and CI sets up only the tools those checks use.

const text = readFileSync(join(import.meta.dir, "..", "..", "..", "examples", "fixtures", "go-service", ".gauntlet", "policy.gx"), "utf8")
const compiled = compilePolicy({ file: ".gauntlet/policy.gx", text }, [goSpec])
if (compiled._tag === "Invalid") throw new Error("the Go fixture's policy doesn't compile")
const ir = compiled.compiled.ir
const workflow = (protectOnly: boolean) =>
  github({ mode: "repo", ir: protectOnly ? protectOnlyIr(ir) : ir, files: ["go.mod"], gauntletVersion: "0.1.0", downloadUrl: "https://example.invalid/gauntlet", ...(protectOnly ? { protectOnly: true } : {}) })[0]!.content

describe("connect github --protect-only", () => {
  test("the evidence job and the status job pass --protect-only, in repo and org mode", () => {
    const w = workflow(true)
    expect(w.match(/--protect-only/g)?.length).toBe(2)
    const org = github({ mode: "org", ir: protectOnlyIr(ir), files: ["go.mod"], gauntletVersion: "0.1.0", downloadUrl: "https://example.invalid/gauntlet", protectOnly: true })
    const orgFlags = org.map((f) => (f.content.match(/--protect-only/g) ?? []).length).reduce((a, b) => a + b, 0)
    expect(orgFlags).toBe(2)
    expect(w).toContain(`check --policy-ref "$BASE" --head "$HEAD" --out gauntlet-out --no-record --protect-only`)
    expect(() => Bun.YAML.parse(w)).not.toThrow()
  })

  test("no mutation tool is installed, and the normal workflow is unchanged", () => {
    expect(workflow(true)).not.toContain("gremlins")
    expect(workflow(false)).toContain("gremlins")
    expect(workflow(false)).not.toContain("--protect-only")
  })
})
