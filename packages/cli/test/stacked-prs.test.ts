import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { baseRepo, cli } from "./harness.ts"

// A big change over several parts of the repository: the report suggests
// reviewing it as stacked pull requests, and the decision doesn't change.

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

const check = async (files: Record<string, string>) => {
  const s = baseRepo()
  repos.push(s.r)
  s.r.write(files)
  s.r.commit("change")
  const out = join(s.r.dir, "out")
  await cli(["check", "--repo", s.r.dir, "--base", s.base, "--out", out, "--no-record"])
  return { md: readFileSync(join(out, "gauntlet-report.md"), "utf8"), report: JSON.parse(readFileSync(join(out, "gauntlet-report.json"), "utf8")) }
}
const lines = (n: number, word: string) => Array.from({ length: n }, (_, i) => `// ${word} ${i}`).join("\n") + "\nclass X\n"

describe("a big change over several parts", () => {
  test("the report suggests stacked pull requests, lowest first", async () => {
    const { md, report } = await check({ "src/main/App.kt": lines(300, "app"), "tools/gen.kt": lines(200, "gen"), "docs/notes.md": "notes\n" })
    expect(report.stack.steps.map((s: { title: string }) => s.title)).toEqual(["src", "tools", "documentation"])
    expect(md).toContain("### Review it as stacked pull requests")
    expect(md).toContain("It would be easier to review as 3 pull requests, each on top of the one before:")
    expect(md).toContain("1. **src** (1 file, 302 lines): `src/main/App.kt`")
  })

  test("a small change gets no suggestion", async () => {
    const { md, report } = await check({ "src/main/App.kt": "class App { fun x() = 1 }\n" })
    expect(report.stack).toBeUndefined()
    expect(md).not.toContain("stacked pull requests")
  })
})
