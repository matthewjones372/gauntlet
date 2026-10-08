import { describe, expect, test } from "bun:test"
import { uvSync } from "../src/toolchain.ts"

// uv projects whose dependency groups can't all be installed together (cpu and
// gpu builds, for example) choose their own groups; Gauntlet installs those.

describe("uv sync", () => {
  test("installs every group when the project doesn't choose", () => {
    expect(uvSync(undefined)).toEqual(["uv", "sync", "--frozen", "--all-groups"])
    expect(uvSync(`[project]\nname = "svc"\n\n[dependency-groups]\ndev = ["pytest"]\n`)).toEqual(["uv", "sync", "--frozen", "--all-groups"])
  })

  test("uses uv's default selection when the project names its default groups", () => {
    const pyproject = `[project]\nname = "svc"\n\n[tool.uv]\ndefault-groups = ["dev", "cpu"]\n\n[tool.ruff]\nline-length = 100\n`
    expect(uvSync(pyproject)).toEqual(["uv", "sync", "--frozen"])
  })

  test("uses uv's default selection when groups conflict", () => {
    const pyproject = `[tool.uv]\nconflicts = [\n  [{ group = "cpu" }, { group = "gpu" }],\n]\n`
    expect(uvSync(pyproject)).toEqual(["uv", "sync", "--frozen"])
  })

  test("a default-groups key outside [tool.uv] doesn't count", () => {
    expect(uvSync(`[tool.other]\ndefault-groups = ["x"]\n\n[tool.uv]\npackage = true\n`)).toEqual(["uv", "sync", "--frozen", "--all-groups"])
  })
})
