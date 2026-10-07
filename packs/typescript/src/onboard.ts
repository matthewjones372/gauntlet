import { globMatches } from "@gauntlet/dsl"
import { directoriesNamed, type Onboarding, type RepoView } from "@gauntlet/core"
import { parseDependencies } from "./dependencies.ts"
import { packageManager, testRunner } from "./toolchain.ts"

// Policy defaults for a TypeScript project (`gauntlet init --template`): a gate
// is proposed only when the project already has its tool.

const RUNNER_CONFIG = /^(vitest\.config\.|vitest\.workspace\.|jest\.config\.|bunfig\.toml$|tsconfig[^/]*\.json$|stryker\.con|\.strykerrc|biome\.jsonc?$|eslint\.config\.|\.eslintrc)/

export const onboard = (repo: RepoView): Onboarding => {
  const deps = new Set(parseDependencies("package.json", repo.read("package.json") ?? "").map((d) => d.slice(0, d.lastIndexOf("@") > 0 ? d.lastIndexOf("@") : d.length)))
  const manager = packageManager(repo.files)
  const runner = testRunner(deps, manager)
  const fast: string[] = []
  const verify: string[] = []
  const setup: string[] = []
  if (repo.files.includes("tsconfig.json")) fast.push("build")
  else setup.push("Add a tsconfig.json at the repository root to gate type checking (build).")
  if (deps.has("@biomejs/biome") || deps.has("eslint")) fast.push("lint ratchet")
  else setup.push("Add @biomejs/biome or eslint to gate lint.")
  const coverageReady = runner._tag === "Some" && (runner.value !== "vitest" || deps.has("@vitest/coverage-v8") || deps.has("@vitest/coverage-istanbul"))
  if (coverageReady) verify.push("coverage ratchet on changed")
  else setup.push(runner._tag === "Some" ? "Add @vitest/coverage-v8 to gate coverage." : "Add vitest or jest (or use bun test) to run tests and gate coverage.")
  if (deps.has("@stryker-mutator/core")) verify.push("mutation ratchet on changed")
  else setup.push("Add @stryker-mutator/core and its test runner plugin to gate mutation.")
  const dirs = directoriesNamed(repo.files, ["test", "tests", "__tests__"])
  const colocated = repo.files.some((f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f) && !dirs.some((d) => globMatches(d, f)))
  const tests = [...dirs, ...(colocated ? ["**/*.test.*", "**/*.spec.*"] : [])]
  const suites = runner._tag === "Some" && tests.length > 0 ? [{ name: "unit", location: tests[0]! }] : []
  return {
    protect: {
      tests,
      fixtures: directoriesNamed(repo.files, ["__snapshots__", "fixtures"]),
      config: [...new Set(repo.files.filter((f) => !f.includes("/") && RUNNER_CONFIG.test(f)))].sort(),
    },
    suites,
    fast,
    verify,
    setup,
  }
}
