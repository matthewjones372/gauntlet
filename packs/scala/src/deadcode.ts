import type { Run } from "@gauntlet/sarif"

// scalac's unused warnings as dead-code findings (spec 0017 §4), from the
// same compiler output the warnings check reads. Scala 2.12 and 2.13
// (`-Wunused`, `-Ywarn-unused`, or `-Xlint`, which turns them on) say
// "private val rate in object Fx is never used"; Scala 3.3 and later
// (`-Wunused:all`) say "unused private member" under an Unused Symbol Warning.
// scalac only warns about what's private or local: an unused public member
// may be called from outside, and isn't reported.

export const DEAD_CODE = "dead-code"

/** The scalacOption a missing setting's message names: Scala 2.13 and 3.3+ take it. */
export const WUNUSED = "-Wunused:all"

/** scalac's unused (and dead-code) warnings, Scala 2 and 3, and the kind each is reported as. */
const KINDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^unused import\b/i, "unused-import"],
  [/^unused private member\b/, "unused-private"],
  [/^private .+ is never used\b/, "unused-private"],
  [/^unused local definition\b/, "unused-local"],
  [/^local .+ is never used\b/, "unused-local"],
  [/^unused (explicit|implicit) parameter\b/, "unused-parameter"],
  [/^(?:\w+ )?parameter .+ is never used\b/, "unused-parameter"],
  [/^unused pattern variable\b/, "unused-pattern-variable"],
  [/^pattern var .+ is never used\b/, "unused-pattern-variable"],
  [/^dead code following this construct\b/, "unreachable-code"],
]

const kindOf = (message: string) => KINDS.find(([re]) => re.test(message))?.[1]

/**
 * scalac's warnings runs as one SARIF run named `scalac`, keeping the unused
 * family as `dead-code/<kind>`. Other warnings (deprecations, a var never
 * updated) are the warnings check's, not dead code.
 */
export const scalacDeadCode = (runs: ReadonlyArray<Run>): Run => ({
  tool: { driver: { name: "scalac" } },
  results: runs.filter((r) => r.tool.driver.name === "scalac").flatMap((r) => r.results.flatMap((x) => {
    const kind = kindOf(x.message.text)
    return kind ? [{ ...x, ruleId: `${DEAD_CODE}/${kind}`, level: "warning" as const }] : []
  })),
})

/** The build definition's files: every .sbt file, and the Scala under project/. */
export const isBuildDefinition = (p: string) => (/\.sbt$/.test(p) && !/(^|\/)target\//.test(p)) || /^project\/.+\.scala$/.test(p)

/**
 * Whether the build turns scalac's unused warnings on: a `-Wunused` or
 * `-Ywarn-unused` scalacOption, `-Xlint` (which includes them), or the
 * sbt-tpolecat plugin (which adds them). Read from the text, so a setting
 * made some other way isn't seen.
 */
export const unusedWarningsOn = (definition: ReadonlyArray<{ readonly text: string }>): boolean =>
  definition.some((f) => /-Wunused|-Ywarn-unused|-Xlint\b|sbt-tpolecat/.test(f.text.replace(/\/\/.*$/gm, "")))
