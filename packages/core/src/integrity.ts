import { globMatches } from "@gauntlet/dsl"
import type { FlagCheck, ForbidCheck, PolicyIR, RatchetCheck } from "@gauntlet/ir"
import { compareMetrics, type Metric, type TestCounts } from "@gauntlet/sarif"
import { Effect, type FileSystem, type Option, type Path } from "effect"
import type { DiffFacts } from "./diff-facts.ts"

// Integrity checks: is the verification itself intact? (ADR 0013)
// Core implements what needs no language knowledge; packs supply detectors
// for the rest. A check in the policy that nothing implemented, or that had
// no data to work from, is reported as not executed: missing evidence.

export type IntegrityCheck = RatchetCheck | ForbidCheck | FlagCheck
export type IntegrityKind = "ratchet" | "forbid" | "flag"

export interface IntegrityFinding {
  readonly check: IntegrityCheck
  readonly kind: IntegrityKind
  readonly message: string
  readonly path?: string
  readonly line?: number
  /** Which detector found it: "core" or a pack detector's name. */
  readonly detector: string
}

export interface TestRecord {
  readonly counts: TestCounts
  readonly ids: ReadonlyArray<string>
}

export interface DetectorInput {
  readonly ir: PolicyIR
  readonly facts: DiffFacts
  readonly readBase: (path: string) => Effect.Effect<Option.Option<string>>
  readonly readHead: (path: string) => Effect.Effect<Option.Option<string>>
  /** Paths that hold tests, from the policy's suites and `tests` protect groups. */
  readonly isTestPath: (path: string) => boolean
  /** Every file at head, for detectors that measure the whole project. */
  readonly headFiles: ReadonlyArray<string>
  /** The judged checkout, for reading many files quickly. Protected files there are at their base content. */
  readonly dir: string
}

export interface DetectorOutput {
  readonly findings: ReadonlyArray<IntegrityFinding>
  /** Ratchet values the detector measured at head, keyed `integrity/<check>`. */
  readonly metrics: Readonly<Record<string, Metric>>
}

/** A pack's language-specific integrity detector. */
export interface IntegrityDetector {
  readonly name: string
  readonly checks: ReadonlyArray<IntegrityCheck>
  readonly run: (input: DetectorInput) => Effect.Effect<DetectorOutput, never, FileSystem.FileSystem | Path.Path>
}

export interface IntegrityInput extends DetectorInput {
  /** Ratchet values recorded in the baseline. */
  readonly baselineMetrics: Readonly<Record<string, Metric>>
  /** Tests that ran at head, when suites ran. */
  readonly headTests?: TestRecord
  /** Test ids recorded at base, when the baseline has them. */
  readonly baseTestIds?: ReadonlyArray<string>
}

export interface IntegrityResult {
  readonly findings: ReadonlyArray<IntegrityFinding>
  readonly metrics: Readonly<Record<string, Metric>>
  /** Policy checks nothing evaluated. */
  readonly notExecuted: ReadonlyArray<IntegrityCheck>
}

export const metricKey = (check: RatchetCheck) => `integrity/${check}`

const RATCHET_DIRECTION: Record<RatchetCheck, boolean> = {
  "executed-tests": true,
  "assertions-per-test": true,
  "skipped-tests": false,
  "suppressions": false,
  "quarantined-tests": false,
  "property-tests": true,
}

const literalPrefix = (glob: string) => glob.split("/").filter((_, i, all) => !all.slice(0, i + 1).some((s) => /[*?[{]/.test(s))).join("/")

const TEST_STEM = /(Test|Tests|Spec|IT|Fixture|Fake|Stub)$/
// Data, documentation and lockfiles aren't code that can special-case tests.
// Files that aren't code, so naming a test path in them isn't main code referring to tests.
// Ownership and ignore files list paths, test paths included, by design (gauntlet connect github writes CODEOWNERS).
const NOT_CODE = /\.(md|markdown|txt|json|jsonc|lock|lockb|toml|ya?ml|xml|svg|sarif|gx|csv|properties)$|(^|\/)(bun\.lock|yarn\.lock|pnpm-lock\.yaml|package-lock\.json)$|(^|\/)(CODEOWNERS|\.gitignore|\.gitattributes|\.dockerignore|\.npmignore|\.prettierignore|\.eslintignore|LICENSE|NOTICE)$|^\.github\//
/** The comment part of a line, for the common comment markers. */
const commentOf = (text: string): string | undefined => {
  const trimmed = text.trim()
  if (/^(\*|\/\*|#|--)/.test(trimmed)) return trimmed
  const i = text.indexOf("//")
  return i >= 0 && !/["'`]/.test(text.slice(i)) ? text.slice(i) : undefined
}
const SPECIAL_CASE_COMMENT =
  /\b(?:only\s+(?:in|for|during)\s+tests?|for\s+(?:the\s+)?tests?\s+(?:only|to\s+pass)|make\s+(?:the\s+)?tests?\s+pass|test[- ]only|hack\s+for\s+(?:the\s+)?tests?|if\s+(?:we(?:'re|\s+are)\s+)?(?:running\s+)?(?:in\s+)?tests?\b)/i

/** A test file's name without its extension, lower case, \`_\` as \`-\`: how test ids name it. */
const testFileName = (path: string) => (path.split("/").at(-1) ?? path).replace(/\.[^.]+$/, "").toLowerCase().replaceAll("_", "-")

/** The name of the code a test file is named after: FooTest.kt, foo.test.ts, foo_test.go, test_foo.py and foo_test.clj all test foo. */
export const testedName = (path: string): string => {
  const base = (path.split("/").at(-1) ?? path).replace(/\.[^.]+$/, "")
  return base
    .replace(/[._-](test|spec|tests|specs)$/i, "")
    .replace(/^test[_-]/i, "")
    .replace(/(Test|Tests|Spec|Specs|Suite|IT)$/, "")
    .toLowerCase()
    .replaceAll(/[-_]/g, "")
}

/** The deleted source file a deleted test file was named after, if the change removed it too. */
export const codeUnderTest = (testPath: string, removedMain: ReadonlyArray<string>): string | undefined => {
  const name = testedName(testPath)
  if (name === "") return undefined
  return removedMain.find((p) => (p.split("/").at(-1) ?? p).replace(/\.[^.]+$/, "").toLowerCase().replaceAll(/[-_]/g, "") === name)
}

/** Checks core implements, and what each needs to run. */
const coreDetector = (input: IntegrityInput): { findings: IntegrityFinding[]; metrics: Record<string, Metric>; covered: IntegrityCheck[]; removedWithCode: number } => {
  const findings: IntegrityFinding[] = []
  const metrics: Record<string, Metric> = {}
  const covered: IntegrityCheck[] = []
  const { facts } = input

  // Counts measured from the run Gauntlet produced itself.
  if (input.headTests) {
    metrics[metricKey("executed-tests")] = { value: input.headTests.counts.executed, unit: "count", higherIsBetter: true }
    metrics[metricKey("skipped-tests")] = { value: input.headTests.counts.skipped, unit: "count", higherIsBetter: false }
  }

  // Deleted tests: test files removed by the change, and test ids that ran at base but not now.
  // A test removed together with the code it tested (removing a feature) is
  // flagged for review rather than forbidden; any other removal is forbidden.
  const removedTestFiles = facts.files.flatMap((f) =>
    f.status === "deleted" && input.isTestPath(f.path) ? [f.path]
    : f.status === "renamed" && f.oldPath !== undefined && input.isTestPath(f.oldPath) && !input.isTestPath(f.path) ? [f.oldPath]
    : [])
  const removedMain = facts.files.filter((f) => f.status === "deleted" && !input.isTestPath(f.path)).map((f) => f.path)
  const withCode = new Map<string, string>()
  for (const path of removedTestFiles) {
    const code = codeUnderTest(path, removedMain)
    if (code !== undefined) {
      withCode.set(path, code)
      findings.push({ check: "deleted-tests", kind: "flag", message: `Test file ${path} was removed along with ${code}, the code it tested. Check the feature was meant to go.`, path, detector: "core" })
    } else {
      findings.push({ check: "deleted-tests", kind: "forbid", message: `Test file ${path} was deleted.`, path, detector: "core" })
    }
  }
  let removedWithCode = 0
  if (input.baseTestIds && input.headTests) {
    const now = new Set(input.headTests.ids)
    const names = [...withCode.keys()].map(testFileName)
    for (const id of input.baseTestIds) {
      if (now.has(id)) continue
      const normal = id.toLowerCase().replaceAll("_", "-")
      if (names.some((n) => normal.includes(n))) {
        removedWithCode++
        findings.push({ check: "deleted-tests", kind: "flag", message: `Test ${id} no longer runs: its test file was removed along with the code it tested.`, detector: "core" })
      } else {
        findings.push({ check: "deleted-tests", kind: "forbid", message: `Test ${id} ran at base and no longer runs.`, detector: "core" })
      }
    }
  }
  covered.push("deleted-tests")

  // Main code that names test files, test classes or test paths.
  // Only prefixes that are themselves test locations: `src/test`, not the `packages` of `packages/*/test/**`.
  const suitePrefixes = input.ir.suites.flatMap((s) => (s.kind === "suite" ? [literalPrefix(s.location)] : []))
    .filter((p) => p !== "" && input.isTestPath(`${p}/__gauntlet_probe__`))
  const stems = [...new Set(input.headFiles.filter(input.isTestPath).map((f) => f.split("/").pop()!.replace(/\.[^.]+$/, "")).filter((s) => TEST_STEM.test(s)))]
  const stemPattern = stems.length > 0 ? new RegExp(`\\b(?:${stems.map((s) => s.replace(/[$.]/g, "\\$&")).join("|")})\\b`) : undefined
  for (const [path, lines] of [...facts.addedLines].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (input.isTestPath(path) || path.startsWith(".gauntlet/") || NOT_CODE.test(path)) continue
    for (const { line, text } of lines) {
      const prefix = suitePrefixes.find((p) => text.includes(p))
      const stem = stemPattern?.exec(text)?.[0]
      if (prefix !== undefined || stem !== undefined) {
        findings.push({
          check: "test-refs-in-main",
          kind: "forbid",
          message: prefix !== undefined ? `Main code refers to the test path '${prefix}'.` : `Main code refers to the test class '${stem}'.`,
          path,
          line,
          detector: "core",
        })
      }
      const comment = commentOf(text)
      if (comment !== undefined && SPECIAL_CASE_COMMENT.test(comment)) {
        findings.push({ check: "test-special-case-comments", kind: "flag", message: "This line describes special handling for tests.", path, line, detector: "core" })
      }
    }
  }
  covered.push("test-refs-in-main", "test-special-case-comments")

  // Flaky tests (M15): retries hide them, and some code makes them.
  for (const [path, lines] of [...facts.addedLines].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (path.startsWith(".gauntlet/")) continue
    const test = input.isTestPath(path)
    if (!test && !TEST_CONFIG.test(path)) continue
    // In test code, text inside string literals is data (a fixture, a message), not configuration.
    const code = test && TEST_CODE.test(path)
    for (const { line, text: raw } of lines) {
      const text = code ? withoutStrings(raw) : raw
      const retry = RETRIES.find((r) => r.pattern.test(text))
      if (retry) {
        findings.push({
          check: "added-retries", kind: "forbid", path, line, detector: "core",
          message: `Retry configuration added (${retry.what}): retries hide flaky tests. Fix the flakiness, or quarantine the test in the policy with an owner and a date.`,
        })
      }
      // A URL or a sleep in a snapshot or fixture file is data, not something a test does.
      const risk = test && !TEST_DATA.test(path) ? FLAKY_PATTERNS.find((r) => r.pattern.test(text)) : undefined
      if (risk) findings.push({ check: "flaky-patterns", kind: "flag", path, line, detector: "core", message: `Possible source of flakiness in a test: ${risk.what}.` })
    }
  }
  covered.push("added-retries", "flaky-patterns")
  return { findings, metrics, covered, removedWithCode }
}

const TEST_CODE = /\.(kt|kts|java|scala|groovy|[cm]?[jt]sx?|py|go|rs|rb|php|cs|clj[sc]?)$/
/** Snapshots, fixtures and other data under a test folder: never run, so never a source of flakiness. */
const TEST_DATA = /(^|\/)(golden|__snapshots__|snapshots|testdata)\/|\.(md|markdown|json|ya?ml|snap|golden|xml|html?|csv|svg|png|jpe?g|gif|sarif)$/

/** A line with the contents of its string literals blanked out, for the common quote styles. */
export const withoutStrings = (text: string): string => {
  let out = ""
  let quote: string | undefined
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quote) {
      if (ch === "\\") {
        i++
        continue
      }
      if (ch === quote) {
        quote = undefined
        out += ch
      }
      continue
    }
    if (ch === "\"" || ch === "'" || ch === "`") quote = ch
    out += ch
  }
  return out
}

/** Build and test configuration, where retries are usually switched on. */
const TEST_CONFIG = /(^|\/)(build\.gradle(\.kts)?|settings\.gradle(\.kts)?|libs\.versions\.toml|pom\.xml|package\.json|pyproject\.toml|requirements[^/]*\.txt|setup\.cfg|tox\.ini|pytest\.ini|conftest\.py|(vitest|jest|playwright|cypress)\.config\.[cm]?[jt]s|bunfig\.toml|\.config\/nextest\.toml|\.cargo\/config(\.toml)?|Cargo\.toml)$/

const RETRIES: ReadonlyArray<{ readonly what: string; readonly pattern: RegExp }> = [
  { what: "the Gradle test-retry plugin", pattern: /org\.gradle\.test-retry|\bmaxRetries\b/ },
  { what: "JUnit Pioneer's @RetryingTest", pattern: /@RetryingTest\b/ },
  { what: "jest.retryTimes", pattern: /\bretryTimes\s*\(/ },
  { what: "a test retry count", pattern: /\b(retry|retries)\s*[:=]\s*[1-9]/ },
  { what: "pytest-rerunfailures", pattern: /pytest-rerunfailures|--reruns\b|\breruns\s*=\s*[1-9]/ },
  { what: "a ZIO Test aspect that retries", pattern: /@@\s*(TestAspect\.)?(flaky|retry|retries|eventually)\b/ },
  { what: "ScalaTest's Retries", pattern: /\bwithRetry\b/ },
  { what: "the flaky package", pattern: /^\s*@flaky\b|^\s*["']?flaky\s*([<>=~!]=?|["'],?\s*$)/ },
]

const FLAKY_PATTERNS: ReadonlyArray<{ readonly what: string; readonly pattern: RegExp }> = [
  { what: "a real sleep; wait for the condition instead", pattern: /\bThread\.sleep\s*\(|TimeUnit\.\w+\.sleep\s*\(|\btime\.sleep\s*\(|\basyncio\.sleep\s*\(\s*[0-9]*\.?[1-9]|\bBun\.sleep\s*\(|\bwaitForTimeout\s*\(|\bcy\.wait\s*\(\s*\d|\bsetTimeout\s*\(/ },
  { what: "the wall clock; inject a clock", pattern: /System\.currentTimeMillis\s*\(\)|\b(Instant|LocalDate|LocalDateTime|ZonedDateTime|OffsetDateTime)\.now\s*\(\s*\)|\bDate\.now\s*\(\)|\bnew Date\s*\(\s*\)|\bdatetime\.(now|utcnow|today)\s*\(|\bdate\.today\s*\(|\btime\.time\s*\(\)/ },
  { what: "unseeded randomness; use a fixed seed", pattern: /\bMath\.random\s*\(\)|\bRandom\s*\(\s*\)|\brandom\.(random|randint|choice|shuffle|uniform)\s*\(/ },
  { what: "a real network call; use a local fake", pattern: /https?:\/\/(?!localhost|127\.0\.0\.1|\[::1\]|[\w.-]*\.(?:invalid|test|example|localhost)\b|example\.(?:com|org|net)\b)[\w.-]+|\brequests\.(get|post|put|delete)\s*\(|\burllib\.request\b/ },
]

/**
 * Runs core's integrity checks and the packs' detectors, then compares every
 * ratchet in the policy with the baseline. Ratchets with no baseline value
 * yet are recorded, not compared; ratchets with no head value are not executed.
 */
export const runIntegrity = (input: IntegrityInput, detectors: ReadonlyArray<IntegrityDetector>): Effect.Effect<IntegrityResult, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const core = coreDetector(input)
    const findings = [...core.findings]
    const metrics: Record<string, Metric> = { ...core.metrics }
    const covered = new Set<IntegrityCheck>(core.covered)
    for (const detector of [...detectors].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const out = yield* detector.run(input)
      findings.push(...out.findings)
      Object.assign(metrics, out.metrics)
      for (const c of detector.checks) covered.add(c)
    }

    const notExecuted = new Set<IntegrityCheck>()
    for (const check of input.ir.integrity.ratchet) {
      const key = metricKey(check)
      const head = metrics[key]
      if (!head) {
        notExecuted.add(check)
        continue
      }
      const recorded = input.baselineMetrics[key]
      if (!recorded) continue
      // Tests removed along with the code they tested don't count against the executed-tests ratchet.
      const base = check === "executed-tests" && core.removedWithCode > 0 ? { ...recorded, value: recorded.value - core.removedWithCode } : recorded
      for (const r of compareMetrics({ [key]: { ...base, higherIsBetter: RATCHET_DIRECTION[check] } }, { [key]: head }).regressions) {
        findings.push({
          check,
          kind: "ratchet",
          message: `${check.replaceAll("-", " ")} went from ${r.base} to ${r.head}${r.file ? ` in ${r.file}` : ""}; it may not get worse than the baseline.`,
          ...(r.file ? { path: r.file } : {}),
          detector: "core",
        })
      }
    }
    for (const check of [...input.ir.integrity.forbid, ...input.ir.integrity.flag]) if (!covered.has(check)) notExecuted.add(check)

    const inPolicy = new Set<IntegrityCheck>([...input.ir.integrity.ratchet, ...input.ir.integrity.forbid, ...input.ir.integrity.flag])
    const order = (f: IntegrityFinding) => [f.kind, f.check, f.path ?? "", String(f.line ?? 0).padStart(9, "0"), f.message].join("\0")
    return {
      findings: findings.filter((f) => inPolicy.has(f.check)).sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0)),
      metrics,
      notExecuted: [...notExecuted].sort(),
    }
  })

/** Whether a path holds tests, according to the policy. */
export const testPathMatcher = (ir: PolicyIR) => {
  const globs = [
    ...ir.suites.flatMap((s) => (s.kind === "suite" ? [s.location] : [])),
    ...ir.protect.filter((g) => g.kind === "tests").flatMap((g) => g.globs),
  ]
  return (path: string) => globs.some((g) => globMatches(g, path))
}
