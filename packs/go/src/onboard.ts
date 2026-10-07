import { directoriesNamed, type Onboarding, type RepoView } from "@gauntlet/core"

// Policy defaults for a Go module (`gauntlet init --template`). Tests and
// coverage come with Go; lint and mutation are proposed when the project has
// configured golangci-lint or gremlins.

const LINT_CONFIG = [".golangci.yml", ".golangci.yaml", ".golangci.toml", ".golangci.json"]
const MUTATION_CONFIG = [".gremlins.yaml", ".gremlins.yml"]

export const onboard = (repo: RepoView): Onboarding => {
  const has = (names: ReadonlyArray<string>) => names.filter((n) => repo.files.includes(n))
  const fast = ["build"]
  const verify = ["coverage ratchet on changed"]
  const setup: string[] = []
  if (has(LINT_CONFIG).length > 0) fast.push("lint ratchet")
  else setup.push("Add a .golangci.yml (golangci-lint v2) to gate lint.")
  if (has(MUTATION_CONFIG).length > 0) verify.push("mutation ratchet on changed")
  else setup.push("Install gremlins and add a .gremlins.yaml to gate mutation.")
  const tests = repo.files.some((f) => f.endsWith("_test.go")) ? ["**/*_test.go"] : []
  return {
    protect: { tests, fixtures: directoriesNamed(repo.files, ["testdata"]), config: [...has(LINT_CONFIG), ...has(MUTATION_CONFIG)].sort() },
    suites: tests.length > 0 ? [{ name: "unit", location: "**/*_test.go" }] : [],
    fast,
    verify,
    setup,
  }
}
