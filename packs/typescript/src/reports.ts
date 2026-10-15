import type { Result, Run, TestCounts } from "@gauntlet/sarif"
import { relativeUri } from "@gauntlet/sarif"
import { Option, Schema } from "effect"

// Parsers for the TypeScript tools' reports.

export interface FileCoverage {
  readonly path: string
  readonly lines: ReadonlyMap<number, boolean>
}

/** lcov: `SF:` starts a file, `DA:<line>,<hits>` gives each executable line. */
export const parseLcov = (text: string, repoRoot: string): FileCoverage[] => {
  const out: FileCoverage[] = []
  let current: { path: string; lines: Map<number, boolean> } | undefined
  for (const raw of text.split(/\r?\n/)) {
    if (raw.startsWith("SF:")) current = { path: relativeUri(raw.slice(3).trim(), repoRoot), lines: new Map() }
    else if (raw.startsWith("DA:") && current) {
      const [nr, hits] = raw.slice(3).split(",")
      const n = Number(nr)
      current.lines.set(n, (current.lines.get(n) ?? false) || Number(hits) > 0)
    } else if (raw === "end_of_record" && current) {
      out.push(current)
      current = undefined
    }
  }
  return out
}

const JestResults = Schema.Struct({
  testResults: Schema.Array(Schema.Struct({
    name: Schema.String,
    assertionResults: Schema.Array(Schema.Struct({
      fullName: Schema.String,
      status: Schema.String,
      failureMessages: Schema.optionalKey(Schema.Array(Schema.String)),
    })),
  })),
})

/** Jest's `--json` output as a SARIF run plus counts. Counts come from the test entries, not the summary fields. */
export const convertJestJson = (check: string, json: string, repoRoot: string): Option.Option<{ run: Run; counts: TestCounts; ids: string[]; skipped: string[] }> =>
  Option.map(Schema.decodeUnknownOption(Schema.fromJsonString(JestResults))(json), (r) => {
    const tests = r.testResults.flatMap((file) => file.assertionResults.map((a) => ({ file: relativeUri(file.name, repoRoot), ...a })))
    const failed = tests.filter((t) => t.status === "failed")
    const skipped = tests.filter((t) => ["pending", "skipped", "todo", "disabled"].includes(t.status))
    const results: Result[] = failed.map((t) => ({
      ruleId: "test/failed",
      level: "error",
      message: { text: `${t.fullName}: ${(t.failureMessages ?? [])[0]?.split("\n")[0] ?? "failed"}` },
      locations: [{ physicalLocation: { artifactLocation: { uri: t.file } }, logicalLocations: [{ fullyQualifiedName: `${t.file} > ${t.fullName}`, kind: "function" }] }],
    }))
    const counts: TestCounts = { executed: tests.length - skipped.length, passed: tests.length - skipped.length - failed.length, failed: failed.length, errored: 0, skipped: skipped.length }
    return {
      run: { tool: { driver: { name: "jest" } }, results, properties: { gauntlet: { check, tests: counts } } },
      counts,
      ids: tests.map((t) => `${t.file} > ${t.fullName}`).sort(),
      skipped: skipped.map((t) => `${t.file} > ${t.fullName}`).sort(),
    }
  })

const StrykerReport = Schema.Struct({
  files: Schema.Record(Schema.String, Schema.Struct({
    mutants: Schema.Array(Schema.Struct({
      status: Schema.String,
      mutatorName: Schema.optionalKey(Schema.String),
      replacement: Schema.optionalKey(Schema.String),
      statusReason: Schema.optionalKey(Schema.String),
      killedBy: Schema.optionalKey(Schema.Array(Schema.String)),
      coveredBy: Schema.optionalKey(Schema.Array(Schema.String)),
      location: Schema.Struct({
        start: Schema.Struct({ line: Schema.Number, column: Schema.optionalKey(Schema.Number) }),
        end: Schema.optionalKey(Schema.Struct({ line: Schema.Number })),
      }),
    })),
  })),
  /** The tests Stryker ran, by file, when its runner reports them (Vitest, Jest): ids to names. */
  testFiles: Schema.optionalKey(Schema.Record(Schema.String, Schema.Struct({
    tests: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  }))),
})

export interface Mutant {
  readonly path: string
  readonly line: number
  readonly status: string
  readonly mutator: string
  /** Where the mutant starts on its line, telling apart mutants on the same line. */
  readonly column?: number
  /** The line the mutant ends on, when it spans several. */
  readonly endLine?: number
  /**
   * The tests that killed it and every test that ran it, as \`<file> > <name>\`,
   * when the runner reports tests (spec 0016). Absent with Bun's command runner.
   */
  readonly killedBy?: ReadonlyArray<string>
  readonly coveredBy?: ReadonlyArray<string>
  /** What Stryker put in the code's place, and what the killing test said (spec 0012). */
  readonly replacement?: string
  readonly statusReason?: string
}

/** Statuses that count towards the score: detected over all that ran. */
export const DETECTED = new Set(["Killed", "Timeout"])
export const UNDETECTED = new Set(["Survived", "NoCoverage"])

/** Stryker's mutation-testing-report JSON. */
export const parseStryker = (json: string, repoRoot: string): Option.Option<Mutant[]> =>
  Option.map(Schema.decodeUnknownOption(Schema.fromJsonString(StrykerReport))(json), (r) => {
    const named = new Map(Object.entries(r.testFiles ?? {}).flatMap(([file, f]) => f.tests.map((t) => [t.id, `${relativeUri(file, repoRoot)} > ${t.name}`] as const)))
    const name = (id: string) => named.get(id) ?? id
    return Object.entries(r.files).flatMap(([file, f]) =>
      f.mutants.map((m) => ({
        path: relativeUri(file, repoRoot),
        line: m.location.start.line,
        status: m.status,
        mutator: m.mutatorName ?? "mutant",
        ...(m.location.start.column !== undefined ? { column: m.location.start.column } : {}),
        ...(m.location.end ? { endLine: m.location.end.line } : {}),
        ...(m.replacement !== undefined ? { replacement: m.replacement } : {}),
        ...(m.statusReason !== undefined ? { statusReason: m.statusReason } : {}),
        // Per-test results: a killed mutant names its killers, and every mutant the tests that ran it.
        ...(r.testFiles ? { killedBy: (m.killedBy ?? []).map(name), coveredBy: (m.coveredBy ?? []).map(name) } : {}),
      }))
    )
  })

const EslintResults = Schema.Array(Schema.Struct({
  filePath: Schema.String,
  messages: Schema.Array(Schema.Struct({
    ruleId: Schema.NullOr(Schema.String),
    message: Schema.String,
    line: Schema.optionalKey(Schema.Number),
    severity: Schema.Number,
  })),
}))

/** eslint's built-in JSON formatter, as SARIF (no extra formatter package needed). */
export const convertEslintJson = (json: string, repoRoot: string): Option.Option<Run> =>
  Option.map(Schema.decodeUnknownOption(Schema.fromJsonString(EslintResults))(json), (files) => ({
    tool: { driver: { name: "eslint" } },
    results: files.flatMap((f) =>
      f.messages.map((m): Result => ({
        ruleId: m.ruleId ?? "eslint/parse-error",
        level: m.severity >= 2 ? "error" : "warning",
        message: { text: m.message },
        locations: [{ physicalLocation: { artifactLocation: { uri: relativeUri(f.filePath, repoRoot) }, ...(m.line ? { region: { startLine: m.line } } : {}) } }],
      }))
    ),
  }))
