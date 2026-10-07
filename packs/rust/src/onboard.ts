import { directoriesNamed, type Onboarding, type RepoView } from "@gauntlet/core"

// Policy defaults for a Cargo project (`gauntlet init --template`). Build,
// clippy and coverage come with the usual toolchain; mutation is proposed
// when the project has configured cargo-mutants.

const CONFIG = ["clippy.toml", ".clippy.toml", ".config/nextest.toml", ".cargo/config.toml", ".cargo/mutants.toml", "rust-toolchain.toml", "rust-toolchain"]

export const onboard = (repo: RepoView): Onboarding => {
  const fast = ["build", "lint ratchet"]
  const verify = ["coverage ratchet on changed"]
  const setup: string[] = []
  if (repo.files.includes(".cargo/mutants.toml")) verify.push("mutation ratchet on changed")
  else setup.push("Install cargo-mutants and add a .cargo/mutants.toml to gate mutation.")
  const tests = directoriesNamed(repo.files, ["tests", "benches"])
  return {
    protect: { tests, fixtures: directoriesNamed(repo.files, ["testdata", "fixtures"]), config: CONFIG.filter((c) => repo.files.includes(c)) },
    // Inline #[cfg(test)] tests run with the suite too; the location says where whole test files live.
    suites: [{ name: "unit", location: "tests/**" }],
    fast,
    verify,
    setup,
  }
}
