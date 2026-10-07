import { describe, expect, test } from "bun:test"
import { onboard } from "../src/onboard.ts"

const view = (files: Record<string, string>) => ({ files: Object.keys(files).sort(), read: (p: string) => files[p] })

describe("python onboarding", () => {
  test("tools declared in pyproject.toml dependency groups", () => {
    const o = onboard(view({
      "pyproject.toml": `[project]\nname = "x"\ndependencies = []\n\n[dependency-groups]\ndev = [\n  "coverage==7.16.2",\n  "mutmut>=3",\n  "mypy",\n  "pytest==9.1.1",\n  "ruff",\n]\n`,
      "uv.lock": "", "src/x/a.py": "", "tests/test_a.py": "", "tests/conftest.py": "",
    }))
    expect(o.fast).toEqual(["build", "lint ratchet"])
    expect(o.verify).toEqual(["coverage ratchet on changed", "mutation ratchet on changed"])
    expect(o.setup).toEqual([])
    expect(o.protect).toEqual({ tests: ["tests/**"], fixtures: [], config: ["**/conftest.py", "pyproject.toml"] })
    expect(o.suites).toEqual([{ name: "unit", location: "tests/**" }])
  })

  test("requirements files count too, and pytest-cov is a coverage tool", () => {
    const o = onboard(view({ "requirements-dev.txt": "pytest\npytest-cov\npyright\n", "app.py": "", "test/test_app.py": "" }))
    expect(o.fast).toEqual(["build"])
    expect(o.verify).toEqual(["coverage ratchet on changed"])
    expect(o.setup).toEqual(["Add ruff as a dev dependency to gate lint.", "Add mutmut as a dev dependency to gate mutation."])
  })

  test("without pytest there are no suites to run", () => {
    const o = onboard(view({ "requirements.txt": "requests\n", "app.py": "", "tests/test_app.py": "" }))
    expect(o.suites).toEqual([])
    expect(o.setup).toContain("Add pytest as a dev dependency to run the suites (it also runs unittest tests).")
  })
})
