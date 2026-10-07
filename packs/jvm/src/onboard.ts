import { directoriesNamed, type Onboarding, type RepoView } from "@gauntlet/core"

// Policy defaults for a Kotlin or Java Gradle project (`gauntlet init --template`).
// Lint and mutation use the build's own plugins (ADR 0007), so they're proposed
// only when applied; otherwise the hint gives the line to add. Coverage is
// always proposed: without Kover, Gauntlet brings Kover's agent (Kotlin) or
// JaCoCo (Java) itself.

const PLUGINS = {
  detekt: { id: "dev.detekt", line: `id("dev.detekt") version "2.0.0-alpha.6"`, gate: "lint ratchet", tier: "fast" },
  pitest: { id: "info.solidsoft.pitest", line: `id("info.solidsoft.pitest") version "1.19.0"`, gate: "mutation ratchet on changed", tier: "verify" },
} as const

const applies = (scripts: ReadonlyArray<string>, id: string) =>
  scripts.some((s) => s.includes(`id("${id}")`) || s.includes(`id '${id}'`) || s.includes(`id "${id}"`))

export const onboard = (repo: RepoView): Onboarding => {
  const scripts = repo.files.filter((f) => /(^|\/)build\.gradle(\.kts)?$/.test(f) || f === "gradle/libs.versions.toml").map((f) => repo.read(f) ?? "")
  const fast = ["build"]
  const verify: string[] = ["coverage ratchet on changed"]
  const setup: string[] = []
  for (const [name, p] of Object.entries(PLUGINS)) {
    if (applies(scripts, p.id) || (name !== "detekt" && scripts.some((s) => s.includes(p.id)))) (p.tier === "fast" ? fast : verify).push(p.gate)
    else setup.push(`Add ${p.line} to the plugins block of build.gradle.kts to gate ${p.gate.split(" ")[0]}.`)
  }
  if (scripts.some((s) => s.includes("io.gitlab.arturbosch.detekt"))) setup.push("detekt is applied with its old plugin id; Gauntlet's lint gate needs dev.detekt (detekt 2).")
  const tests = directoriesNamed(repo.files, ["src/test"])
  const other = directoriesNamed(repo.files, ["src/integrationTest", "src/acceptance", "src/testFixtures"])
  const config = [
    ...["*.gradle.kts", "*.gradle"].filter((g) => repo.files.some((f) => !f.includes("/") && f.endsWith(g.slice(1)))),
    ...(repo.files.some((f) => f.includes("/") && /\.gradle(\.kts)?$/.test(f)) ? ["**/*.gradle.kts"] : []),
    ...(repo.files.some((f) => f.startsWith("gradle/")) ? ["gradle/**"] : []),
  ]
  return {
    protect: {
      tests: [...tests, ...other.filter((g) => !g.includes("testFixtures"))],
      fixtures: [...directoriesNamed(repo.files, ["src/test/resources"]), ...other.filter((g) => g.includes("testFixtures"))],
      config,
    },
    suites: tests.length > 0 ? [{ name: "unit", location: tests[0]! }] : [],
    fast,
    verify,
    setup,
  }
}
