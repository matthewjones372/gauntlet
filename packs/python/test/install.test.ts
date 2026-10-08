import { describe, expect, test } from "bun:test"
import { onboard } from "../src/onboard.ts"

// What `gauntlet setup` offers to install for a Python project.

const view = (files: Record<string, string>) => ({ files: Object.keys(files).sort(), read: (p: string) => files[p] })

describe("python install offer", () => {
  test("uv and Poetry add the missing tools as dev dependencies", () => {
    const pyproject = `[project]\nname = "svc"\n\n[dependency-groups]\ndev = ["pytest", "ruff", "pytest-cov"]\n`
    expect(onboard(view({ "pyproject.toml": pyproject, "uv.lock": "", "app.py": "" })).install).toEqual([["uv", "add", "--dev", "mypy", "mutmut"]])
    expect(onboard(view({ "pyproject.toml": pyproject, "poetry.lock": "", "app.py": "" })).install).toEqual([["poetry", "add", "--group", "dev", "mypy", "mutmut"]])
  })

  test("a pip project's requirements files are left to the person", () => {
    expect(onboard(view({ "requirements.txt": "requests\n", "app.py": "" })).install).toBeUndefined()
  })
})
