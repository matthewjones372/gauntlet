import { directoriesNamed, type Onboarding, type RepoView } from "@gauntlet/core"
import { parseDependencies } from "./dependencies.ts"
import { manager } from "./toolchain.ts"

// Policy defaults for a Python project (`gauntlet init --template`): a gate is
// proposed only when the project declares its tool as a dependency.

const MANIFESTS = /^(pyproject\.toml|requirements[^/]*\.txt)$/
const CONFIG = /^(pyproject\.toml|pytest\.ini|setup\.cfg|tox\.ini|\.coveragerc|mypy\.ini|\.mypy\.ini|ruff\.toml|\.ruff\.toml|pyrightconfig\.json)$/

const nameOf = (requirement: string) => requirement.trim().split(/[\s<>=!~;[(@]/)[0]!.toLowerCase().replaceAll("_", "-")

export const onboard = (repo: RepoView): Onboarding => {
  const declared = new Set(repo.files.filter((f) => MANIFESTS.test(f)).flatMap((f) => parseDependencies(f, repo.read(f) ?? "")).map(nameOf))
  const fast: string[] = []
  const verify: string[] = []
  const setup: string[] = []
  // The dev dependencies that would add the missing gates.
  const missing: string[] = []
  if (declared.has("mypy") || declared.has("pyright")) fast.push("build")
  else {
    setup.push("Add mypy or pyright as a dev dependency to gate type checking (build).")
    missing.push("mypy")
  }
  if (declared.has("ruff")) fast.push("lint ratchet")
  else {
    setup.push("Add ruff as a dev dependency to gate lint.")
    missing.push("ruff")
  }
  if (!declared.has("pytest")) {
    setup.push("Add pytest as a dev dependency to run the suites (it also runs unittest tests).")
    missing.push("pytest")
  }
  if (declared.has("coverage") || declared.has("pytest-cov")) verify.push("coverage ratchet on changed")
  else {
    setup.push("Add coverage as a dev dependency to gate coverage.")
    missing.push("coverage")
  }
  if (declared.has("mutmut")) verify.push("mutation ratchet on changed")
  else {
    setup.push("Add mutmut as a dev dependency to gate mutation.")
    missing.push("mutmut")
  }
  // uv and Poetry add a dev dependency with one command; a pip project's requirements files are the person's to edit.
  const by = manager(repo.files)
  const install = missing.length === 0 ? [] : by === "uv" ? [["uv", "add", "--dev", ...missing]] : by === "poetry" ? [["poetry", "add", "--group", "dev", ...missing]] : []
  const tests = directoriesNamed(repo.files, ["tests", "test"])
  return {
    protect: {
      tests,
      fixtures: [],
      config: [...repo.files.filter((f) => CONFIG.test(f)), ...(repo.files.some((f) => f.endsWith("conftest.py")) ? ["**/conftest.py"] : [])].sort(),
    },
    suites: declared.has("pytest") && tests.length > 0 ? [{ name: "unit", location: tests[0]! }] : [],
    fast,
    verify,
    setup,
    ...(install.length > 0 ? { install } : {}),
  }
}
