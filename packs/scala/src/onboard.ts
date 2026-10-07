import { directoriesNamed, type Onboarding, type RepoView } from "@gauntlet/core"

// Policy defaults for an sbt project (`gauntlet init --template`): a gate is
// proposed when project/plugins.sbt applies its plugin; otherwise the hint
// gives the line to add.

const PLUGINS = [
  { id: "sbt-scalafix", line: `addSbtPlugin("ch.epfl.scala" % "sbt-scalafix" % "0.14.9") (and a .scalafix.conf)`, gate: "lint ratchet", tier: "fast" },
  { id: "sbt-scoverage", line: `addSbtPlugin("org.scoverage" % "sbt-scoverage" % "2.4.4")`, gate: "coverage ratchet on changed", tier: "verify" },
  { id: "sbt-stryker4s", line: `addSbtPlugin("io.stryker-mutator" % "sbt-stryker4s" % "1.1.1")`, gate: "mutation ratchet on changed", tier: "verify" },
] as const

export const onboard = (repo: RepoView): Onboarding => {
  const plugins = repo.files.filter((f) => /^project\/[^/]+\.sbt$/.test(f)).map((f) => repo.read(f) ?? "").join("\n")
  const fast = ["build"]
  const verify: string[] = []
  const setup: string[] = []
  for (const p of PLUGINS) {
    if (plugins.includes(p.id)) (p.tier === "fast" ? fast : verify).push(p.gate)
    else setup.push(`Add ${p.line} to project/plugins.sbt to gate ${p.gate.split(" ")[0]}.`)
  }
  const tests = directoriesNamed(repo.files, ["src/test", "src/it"])
  return {
    protect: {
      tests: tests.filter((t) => !t.includes("resources")),
      fixtures: directoriesNamed(repo.files, ["src/test/resources"]),
      config: ["*.sbt", ...(repo.files.some((f) => f.startsWith("project/")) ? ["project/**"] : [])],
    },
    suites: tests.length > 0 ? [{ name: "unit", location: tests[0]! }] : [],
    fast,
    verify,
    setup,
  }
}
