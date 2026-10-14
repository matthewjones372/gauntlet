import { afterEach, describe, expect, test } from "bun:test"
import type { TempRepo } from "../../core/test/temp-repo.ts"
import { INSTALLED_PACKS } from "../src/packs.ts"
import { baseRepo, cli } from "./harness.ts"

const repos: TempRepo[] = []
afterEach(() => repos.splice(0).forEach((r) => r.cleanup()))

describe("gauntlet doctor", () => {
  test("every installed pack's embedded grammar and assets work, with the policy's tools listed", async () => {
    const s = baseRepo()
    repos.push(s.r)
    const res = await cli(["doctor", "--repo", s.r.dir], [...INSTALLED_PACKS])
    expect(res.code).toBe(0)
    for (const what of ["git", "jvm: Kotlin grammar", "jvm: Gradle init script", "typescript: TypeScript grammar", "typescript: TSX grammar", "python: Python grammar", "templates", "mcp tools"]) {
      expect(res.out).toMatch(new RegExp(`^ok {4}${what.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} `, "m"))
    }
    expect(res.out).toContain("uses jvm, mode enforce")
    expect(res.out).toMatch(/jvm: java /)
  }, 30_000)

  // Spec 0009 §2: code that looks sensitive in the project as it is, outside every zone, is listed and never fails doctor.
  test("lists code that looks sensitive outside every zone, as a suggestion", async () => {
    const s = baseRepo()
    repos.push(s.r)
    s.r.write({ "src/main/RefundService.kt": "class RefundService\n", "src/money/Ledger.kt": "class Ledger\n" })
    const res = await cli(["doctor", "--repo", s.r.dir], [...INSTALLED_PACKS])
    expect(res.code).toBe(0)
    expect(res.out).toMatch(/^-- {4}outside every zone: money +1 file that looks like money code: src\/main\/RefundService\.kt\. Add to `money`, or make a new zone\?$/m)
    expect(res.out).not.toContain("Ledger.kt")
  }, 30_000)
})
