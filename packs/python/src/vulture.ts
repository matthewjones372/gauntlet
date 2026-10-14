import { relativeUri, type Result, type Run } from "@gauntlet/sarif"
import { Option } from "effect"
import { isPython, isTestFile } from "./toolchain.ts"

// vulture's report as dead-code findings (spec 0017 §4). vulture has no JSON
// output: each finding is a line `path:line: unused function 'x' (60%
// confidence)`, or `path:line: unreachable code after 'return' (100%
// confidence)` for code that can't run.

export const DEAD_CODE = "dead-code"

/**
 * The confidence below which a finding isn't reported, unless the project sets
 * its own `min_confidence` in `[tool.vulture]`. vulture is sure (90% or more)
 * only of unused imports, unused arguments and unreachable code; an unused
 * function, class, method, attribute or property is 60%, because a framework
 * (a route, a fixture, an ORM field) or `getattr` may call it by name. At 80
 * a ratchet doesn't fail a change over a new route; a project that wants the
 * 60% findings sets `min_confidence = 60` and lists what's used by name in a
 * whitelist.
 */
export const MIN_CONFIDENCE = 80

/** vulture whitelists: Python files naming what's used where vulture can't see it. Runner configuration. */
export const VULTURE_WHITELISTS = ["vulture_whitelist.py", ".vulture_whitelist.py", "**/vulture_whitelist.py"]

const FINDING = /^(.+?):(\d+): (.+) \((\d+)% confidence(?:, \d+ lines?)?\)$/
const UNUSED = /^unused (import|function|class|variable|attribute|method|property) '/
const UNREACHABLE = /^(unreachable code after '|unsatisfiable '|redundant if-condition)/

/** `[tool.vulture]` in pyproject.toml, if the project configures vulture there. */
const vultureSection = (pyproject: string | undefined): string | undefined =>
  /^\[tool\.vulture\]\s*$([\s\S]*?)(?=^\[(?!\[)|(?![\s\S]))/m.exec(pyproject ?? "")?.[1]

/**
 * vulture's arguments. A project that sets `paths` or `min_confidence` in
 * `[tool.vulture]` keeps its own; otherwise every top-level directory or file
 * with Python in it is read (tests too, so code only they call isn't unused,
 * and a whitelist next to the code is read with it), at {@link MIN_CONFIDENCE}.
 */
export const vultureArgs = (pyproject: string | undefined, files: ReadonlyArray<string>): string[] => {
  const section = vultureSection(pyproject) ?? ""
  const confidence = /^\s*min_confidence\s*=/m.test(section) ? [] : ["--min-confidence", String(MIN_CONFIDENCE)]
  const paths = /^\s*paths\s*=/m.test(section) ? [] : [...new Set(files.filter(isPython).map((f) => f.split("/")[0]!))].sort()
  return [...confidence, ...paths]
}

/**
 * vulture's report as a SARIF run named `vulture`, each finding
 * `dead-code/<kind>` with its file and line. Findings in test files aren't
 * reported: pytest calls test functions and fixtures by name, and a fixture
 * asked for only for what it sets up is an argument the test doesn't use.
 * None when a line isn't one of vulture's findings.
 */
export const parseVulture = (text: string, repoRoot: string): Option.Option<Run> => {
  const results: Result[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (line === "") continue
    const m = FINDING.exec(line)
    if (!m) return Option.none()
    const [, file, nr, message] = m as unknown as [string, string, string, string]
    const unused = UNUSED.exec(message)
    const kind = unused ? `unused-${unused[1]}` : UNREACHABLE.test(message) ? "unreachable-code" : "unused-code"
    const uri = relativeUri(file, repoRoot)
    if (isTestFile(uri)) continue
    results.push({
      ruleId: `${DEAD_CODE}/${kind}`,
      level: "warning",
      message: { text: message },
      locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: Number(nr) } } }],
    })
  }
  return Option.some({ tool: { driver: { name: "vulture" } }, results })
}

/** What vulture said about code it couldn't read (a syntax error, a missing path), from its stderr. */
export const vultureCouldNotRead = (stderr: string): string | undefined =>
  stderr.split(/\r?\n/).map((l) => l.trim()).find((l) => /: invalid (syntax|source code)|could not be found|^Error:/.test(l))
