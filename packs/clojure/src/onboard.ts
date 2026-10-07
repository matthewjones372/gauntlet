import { directoriesNamed, type Onboarding, type RepoView } from "@gauntlet/core"
import { testRoots } from "./toolchain.ts"

// Policy defaults for a Clojure project (`gauntlet init --template`). kaocha
// and cloverage come with Gauntlet, so the suite and coverage are always
// proposed; lint is proposed when the project configures clj-kondo. There is
// no mutation gate to propose.

export const onboard = (repo: RepoView): Onboarding => {
  const tool = repo.files.includes("deps.edn") ? "deps.edn" : "project.clj"
  const kondo = repo.files.some((f) => f.startsWith(".clj-kondo/"))
  const roots = testRoots(repo.files).filter((r) => repo.files.some((f) => f.startsWith(`${r}/`)))
  return {
    protect: {
      tests: roots.map((r) => `${r}/**`),
      fixtures: directoriesNamed(repo.files, ["test-resources", "dev-resources", "test/resources"]),
      config: [tool, ...(repo.files.includes("tests.edn") ? ["tests.edn"] : []), ...(kondo ? [".clj-kondo/**"] : [])],
    },
    suites: roots.length > 0 ? [{ name: "unit", location: `${roots[0]}/**` }] : [],
    fast: ["build", ...(kondo ? ["lint ratchet"] : [])],
    verify: ["coverage ratchet on changed"],
    setup: [
      ...(kondo ? [] : ["Install clj-kondo and add a .clj-kondo/config.edn to gate lint."]),
      "Clojure has no mature mutation tool, so the policy leaves out mutation.",
    ],
  }
}
