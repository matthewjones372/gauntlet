import { afterEach, describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { scripted } from "../../author/test/fake.ts"
import { baseRepo } from "../../cli/test/harness.ts"
import { scriptPack } from "../../core/test/script-pack.ts"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { examplesModule } from "../src/examples-module.ts"
import { session } from "./client.ts"

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))
const setup = () => {
  const s = baseRepo()
  repos.push(s.r)
  return s.r
}
const mcp = (r: TempRepo, calls: Parameters<typeof session>[0], o: Partial<Parameters<typeof session>[1]> = {}) => session(calls, { repo: r.dir, packs: [scriptPack], ...o })

describe("gauntlet MCP server", () => {
  test("lists its tools; the ones that only read say so", async () => {
    const r = setup()
    const s = await mcp(r, [{ method: "tools/list" }])
    const tools = s.list(1).tools as { name: string; annotations: { readOnlyHint: boolean; destructiveHint: boolean } }[]
    expect(tools.map((t) => t.name)).toEqual(["validate", "check", "explain", "get_grammar", "get_examples", "author_draft", "report_blocked"])
    expect(tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name)).toEqual(["validate", "explain", "get_grammar", "get_examples", "author_draft"])
    expect(tools.every((t) => t.annotations.destructiveHint === false)).toBe(true)
  })

  test("validate: the repository's policy, or text the agent supplies", async () => {
    const r = setup()
    const s = await mcp(r, [{ name: "validate" }, { name: "validate", arguments: { text: `gauntlet "x"\nuse jvm\ngates { fast { buld } }\n` } }])
    expect(s.tool(0).value).toMatchObject({ valid: true })
    expect(s.tool(1).value.valid).toBe(false)
    expect(s.tool(1).value.diagnostics).toContain("buld")
  })

  test("explain, get_grammar and get_examples", async () => {
    const r = setup()
    const s = await mcp(r, [{ name: "explain", arguments: { block: "protect" } }, { name: "explain", arguments: { coverage: true } }, { name: "get_grammar" }, { name: "get_examples" }])
    expect(s.tool(0).text).toContain("src/test/**")
    expect(s.tool(1).text).toContain("src/money/Fx.kt  zone money")
    expect(s.tool(2).text).toContain("protect {")
    const names = (s.tool(3).value.examples as { name: string }[]).map((e) => e.name)
    expect(names).toContain("trade-reporting")
  })

  test("check judges uncommitted work without touching the branch or the index", async () => {
    const r = setup()
    const before = { head: r.git("rev-parse", "HEAD"), status: r.git("status", "--porcelain") }
    writeFileSync(join(r.dir, "src/main/behaviour.txt"), "broken add\n")
    writeFileSync(join(r.dir, "src/main/New.kt"), "class New\n")
    const s = await mcp(r, [{ name: "check" }])
    const c = s.tool(0).value
    expect(c.wouldBlock).toBe(true)
    expect(c.blocking).toContain("unit failed: 1 of 2 tests failed")
    expect(c.summary).toContain("Fix the cause, not the check.")
    expect(r.git("rev-parse", "HEAD")).toBe(before.head)
    expect(r.git("status", "--porcelain")).toBe(" M src/main/behaviour.txt\n?? src/main/New.kt".trim())
    expect(before.status).toBe("")
  })

  test("report_blocked: recorded for this exact state, raises review, and goes stale on the next edit", async () => {
    const r = setup()
    writeFileSync(join(r.dir, "src/main/App.kt"), "class App { fun a() = 1 }\n")
    const reason = "The task needs src/test/AddTest.txt to expect a new rounding rule."
    const reported = await mcp(r, [{ name: "report_blocked", arguments: { reason, paths: ["src/test/AddTest.txt"] } }, { name: "report_blocked", arguments: { reason: "stuck" } }])
    expect(reported.tool(0).text).toContain("Stop here and tell the person")
    expect(reported.tool(1).isError).toBe(true)
    const checked = await mcp(r, [{ name: "check" }])
    expect(checked.tool(0).value.blockedReported).toBe(true)
    expect(checked.tool(0).value.review).toContain(`The agent reported it was blocked: ${reason}`)
    writeFileSync(join(r.dir, "src/main/App.kt"), "class App { fun a() = 2 }\n")
    const later = await mcp(r, [{ name: "check" }])
    expect(later.tool(0).value.blockedReported).toBe(false)
  })

  test("author_draft needs the server's own key, never one from the request, and only proposes", async () => {
    const r = setup()
    const policy = readFileSync(join(r.dir, ".gauntlet/policy.gx"), "utf8")
    const noKey = await mcp(r, [{ name: "author_draft", arguments: { mode: "review", GAUNTLET_AUTHOR_API_KEY: "from-request" } }], { env: { ANTHROPIC_API_KEY: "sk" } })
    expect(noKey.tool(0).isError).toBe(true)
    expect(noKey.tool(0).text).toContain("GAUNTLET_AUTHOR_API_KEY isn't set")

    const zone = {
      kind: "zone", name: "core", action: "set", text: `zone core {\n  paths "src/main/**"\n  owner @platform\n}`,
      rationale: "Main code needs its owners.", citation: { kind: "uncovered-path", path: "src/main/App.kt" },
    }
    const model = scripted([{ text: "." }, { object: { proposals: [zone] } }])
    const s = await mcp(r, [{ name: "author_draft", arguments: { mode: "review" } }], { env: { GAUNTLET_AUTHOR_API_KEY: "k" }, model: () => model.layer })
    const d = s.tool(0).value
    expect(d.proposals.map((p: { label: string }) => p.label)).toEqual(["set zone core"])
    expect(d.note).toContain("Proposals only")
    expect(readFileSync(join(r.dir, ".gauntlet/policy.gx"), "utf8")).toBe(policy)
  })
})

describe("embedded examples", () => {
  test("match examples/policies/valid (run `bun run generate` after editing them)", () => {
    const dir = join(import.meta.dir, "..", "..", "..", "examples", "policies", "valid")
    const examples = readdirSync(dir).filter((f) => f.endsWith(".gx")).sort().map((f) => ({ name: f.replace(/\.gx$/, ""), text: readFileSync(join(dir, f), "utf8") }))
    expect(readFileSync(join(import.meta.dir, "..", "src", "generated", "examples.ts"), "utf8")).toBe(examplesModule(examples))
  })
})
