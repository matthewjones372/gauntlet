// What the project's own CI already ran isn't run again (ADR 0024). Its build
// jobs keep their test and coverage reports as artifacts, under paths from the
// repository's root, for Gauntlet's GitHub check to read. `gauntlet connect
// github` adds the steps that do it to the project's workflows, after each
// job's build step, and asks the build to write coverage while its tests run.

/** The artifact name every kept report set starts with. */
export const CI_REPORTS_PREFIX = "gauntlet-reports-"

/** Report files a build tool writes by default: JUnit, Kover, JaCoCo, sbt, scoverage. */
const FIND = [
  "'*/build/test-results/*.xml'",
  "'*/build/reports/kover/*.xml'",
  "'*/build/reports/jacoco/*.xml'",
  "'*/target/test-reports/*.xml'",
  "'*/coverage-report/cobertura.xml'",
].map((p) => `-path ${p}`).join(" -o ")

const keepSteps = (job: string, indent: string) =>
  [
    "- name: Keep the test and coverage reports for Gauntlet",
    "  if: always()",
    "  run: |",
    `    mkdir -p "$RUNNER_TEMP/gauntlet-reports"`,
    `    find . \\( ${FIND} \\) -not -path './.git/*' | while read -r f; do mkdir -p "$RUNNER_TEMP/gauntlet-reports/$(dirname "$f")"; cp "$f" "$RUNNER_TEMP/gauntlet-reports/$f"; done`,
    "- name: Upload the reports for Gauntlet",
    "  if: always()",
    "  uses: actions/upload-artifact@v4",
    "  with:",
    `    name: ${CI_REPORTS_PREFIX}${job}`,
    "    path: ${{ runner.temp }}/gauntlet-reports",
    "    if-no-files-found: ignore",
    "    retention-days: 7",
  ].map((l) => `${indent}${l}`)

const indentOf = (line: string) => line.length - line.trimStart().length

/** Asks a build step's tool to write coverage too: Kover's XML for Gradle, scoverage's report for sbt. */
const withCoverage = (lines: string[], from: number, to: number, coverage: { readonly gradle: boolean; readonly sbt: boolean }) => {
  for (let i = from; i < to; i++) {
    if (coverage.gradle && /\.\/gradlew\b/.test(lines[i]!) && !/koverXmlReport/.test(lines[i]!)) {
      let end = i
      while (end + 1 < to && /\\\s*$/.test(lines[end]!)) end++
      lines[end] = `${lines[end]!.replace(/\s+$/, "")} koverXmlReport`
      return true
    }
    if (coverage.sbt && /\bsbt\b/.test(lines[i]!) && /\btest\b/.test(lines[i]!) && !/coverageReport/.test(lines[i]!)) {
      lines[i] = lines[i]!.replace(/\btest\b/, "coverage test coverageReport")
      return true
    }
  }
  return false
}

export interface WiredWorkflow {
  readonly text: string
  /** The jobs that now keep their reports. */
  readonly jobs: ReadonlyArray<string>
  /** The jobs whose build step now also writes coverage. */
  readonly coverage: ReadonlyArray<string>
}

/**
 * A workflow with steps after each build job's build step that keep its
 * reports for Gauntlet, and coverage asked of its build tool where the build
 * has Kover or scoverage. Undefined when there's nothing to add (no build
 * step found by name, or it's already done).
 */
export const keepCiReports = (text: string, buildDirs: ReadonlyArray<string>, coverageOf: (dir: string) => { readonly gradle: boolean; readonly sbt: boolean }): WiredWorkflow | undefined => {
  if (text.includes(CI_REPORTS_PREFIX)) return undefined
  let doc: unknown
  try {
    doc = Bun.YAML.parse(text)
  } catch {
    return undefined
  }
  const jobs = (doc as { jobs?: Record<string, { steps?: Array<Record<string, unknown>> }> } | null)?.jobs ?? {}
  const lines = text.split("\n")
  const kept: string[] = []
  const covered: string[] = []
  for (const [job, def] of Object.entries(jobs)) {
    const steps = Array.isArray(def?.steps) ? def.steps : []
    const dirOf = (s: Record<string, unknown>) => (typeof s["working-directory"] === "string" ? (s["working-directory"] as string).replace(/^\.\//, "").replace(/\/$/, "") : ".")
    const build = steps.filter((s) => typeof s.run === "string" && /(\.\/gradlew|\bsbt\b|\bmvn\b)/.test(s.run) && buildDirs.includes(dirOf(s))).at(-1)
    if (!build || typeof build.name !== "string") continue
    // The job's own block, then its build step's line by name.
    const jobAt = lines.findIndex((l) => new RegExp(`^\\s+${job.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*$`).test(l))
    if (jobAt < 0) continue
    const jobIndent = indentOf(lines[jobAt]!)
    let jobEnd = lines.length
    for (let i = jobAt + 1; i < lines.length; i++) if (lines[i]!.trim() !== "" && indentOf(lines[i]!) <= jobIndent) { jobEnd = i; break }
    const name = build.name as string
    const stepAt = lines.findIndex((l, i) => i > jobAt && i < jobEnd && l.trim().replace(/^- /, "").replace(/^name:\s*/, "").replace(/^["']|["']$/g, "") === name && /^\s*- name:/.test(l))
    if (stepAt < 0) continue
    const stepIndent = indentOf(lines[stepAt]!)
    let stepEnd = jobEnd
    for (let i = stepAt + 1; i < jobEnd; i++) if (lines[i]!.trim() !== "" && indentOf(lines[i]!) <= stepIndent) { stepEnd = i; break }
    while (stepEnd > stepAt + 1 && lines[stepEnd - 1]!.trim() === "") stepEnd--
    // Coverage only from a build that has its tool: asking for it otherwise would break the project's CI.
    if (withCoverage(lines, stepAt, stepEnd, coverageOf(dirOf(build)))) covered.push(job)
    lines.splice(stepEnd, 0, ...keepSteps(job, " ".repeat(stepIndent)))
    kept.push(job)
  }
  return kept.length > 0 ? { text: lines.join("\n"), jobs: kept, coverage: covered } : undefined
}
