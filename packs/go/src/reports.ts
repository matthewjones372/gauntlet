import type { Result, Run, TestCounts } from "@gauntlet/sarif"
import { Option, Schema } from "effect"

// Parsers for the Go tools' reports: `go test -json` events, -coverprofile,
// and gremlins' JSON results.

const TestEvent = Schema.Struct({
  Action: Schema.String,
  Package: Schema.optionalKey(Schema.String),
  Test: Schema.optionalKey(Schema.String),
  Output: Schema.optionalKey(Schema.String),
})
const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(TestEvent))

export interface GoTestReport {
  readonly run: Run
  readonly counts: TestCounts
  readonly ids: string[]
}

/** The package directory relative to the module root: `example.com/svc/money` is `money`. */
export const packageRelative = (pkg: string, module: string) => (pkg === module ? "" : pkg.startsWith(`${module}/`) ? pkg.slice(module.length + 1) : pkg)

/**
 * `go test -json` output as a SARIF run. A test's id is `<package>.<Test>`
 * (subtests keep their `/` path). A package that fails without a test, such
 * as one that doesn't compile, is an errored test named after the package,
 * so a broken package can never look like a green suite.
 */
export const convertGoTest = (check: string, stdout: string, module: string): GoTestReport => {
  const outcome = new Map<string, { status: "passed" | "failed" | "skipped"; pkg: string; test: string }>()
  const output = new Map<string, string[]>()
  const packageFailed = new Set<string>()
  const packageOutput = new Map<string, string[]>()
  for (const raw of stdout.split("\n")) {
    const e = Option.getOrUndefined(decodeEvent(raw))
    if (!e?.Package) continue
    const key = e.Test ? `${e.Package}.${e.Test}` : e.Package
    if (e.Action === "output" && e.Output !== undefined) {
      const target = e.Test ? output : packageOutput
      target.set(key, [...(target.get(key) ?? []), e.Output])
    }
    if (e.Test && (e.Action === "pass" || e.Action === "fail" || e.Action === "skip")) {
      outcome.set(key, { status: e.Action === "pass" ? "passed" : e.Action === "fail" ? "failed" : "skipped", pkg: e.Package, test: e.Test })
    }
    if (!e.Test && e.Action === "fail") packageFailed.add(e.Package)
  }
  const results: Result[] = []
  for (const [id, o] of [...outcome].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (o.status !== "failed") continue
    // The first `file_test.go:12: message` line says where it failed.
    const lines = (output.get(id) ?? []).map((l) => l.trim())
    const at = lines.map((l) => /^([\w.-]+_test\.go):(\d+): ?(.*)$/.exec(l)).find((m) => m !== null)
    const dir = packageRelative(o.pkg, module)
    const file = at ? (dir === "" ? at[1]! : `${dir}/${at[1]!}`) : undefined
    const detail = at?.[3] ?? lines.find((l) => l !== "" && !l.startsWith("=== ") && !l.startsWith("--- "))
    results.push({
      ruleId: "test/failed",
      level: "error",
      message: { text: detail ? `${id}: ${detail}` : id },
      locations: [{
        ...(file ? { physicalLocation: { artifactLocation: { uri: file }, region: { startLine: Number(at![2]) } } } : {}),
        logicalLocations: [{ fullyQualifiedName: id, kind: "function" }],
      }],
    })
  }
  const failedPackages = [...packageFailed].filter((pkg) => ![...outcome.values()].some((o) => o.pkg === pkg && o.status === "failed")).sort()
  for (const pkg of failedPackages) {
    const why = (packageOutput.get(pkg) ?? []).map((l) => l.trim()).find((l) => l !== "" && !/^(FAIL|ok)\b/.test(l))
    results.push({ ruleId: "test/errored", level: "error", message: { text: `${pkg}: ${why ?? "the package failed without a failing test (does it compile?)"}` }, locations: [{ logicalLocations: [{ fullyQualifiedName: pkg, kind: "module" }] }] })
  }
  const all = [...outcome.values()]
  const count = (s: string) => all.filter((o) => o.status === s).length
  const counts: TestCounts = {
    executed: all.length - count("skipped") + failedPackages.length,
    passed: count("passed"),
    failed: count("failed"),
    errored: failedPackages.length,
    skipped: count("skipped"),
  }
  return {
    run: { tool: { driver: { name: "go test" } }, results, properties: { gauntlet: { check, tests: counts } } },
    counts,
    ids: [...[...outcome.keys()], ...failedPackages].sort(),
  }
}

export interface FileCoverage {
  readonly path: string
  readonly lines: ReadonlyMap<number, boolean>
}

/** A -coverprofile as line coverage: a line is covered when any statement block over it ran. */
export const parseCoverProfile = (text: string, module: string): FileCoverage[] => {
  const files = new Map<string, Map<number, boolean>>()
  for (const raw of text.split("\n")) {
    const m = /^(.+\.go):(\d+)\.\d+,(\d+)\.\d+ (\d+) (\d+)$/.exec(raw.trim())
    if (!m) continue
    const path = packageRelative(m[1]!, module)
    const lines = files.get(path) ?? new Map<number, boolean>()
    for (let n = Number(m[2]); n <= Number(m[3]); n++) lines.set(n, (lines.get(n) ?? false) || Number(m[5]) > 0)
    files.set(path, lines)
  }
  return [...files].sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, lines]) => ({ path, lines }))
}

const GremlinsReport = Schema.Struct({
  files: Schema.Array(Schema.Struct({
    file_name: Schema.String,
    mutations: Schema.Array(Schema.Struct({ type: Schema.String, status: Schema.String, line: Schema.Number })),
  })),
})

export interface Mutant {
  readonly path: string
  readonly line: number
  readonly type: string
  readonly outcome: "killed" | "survived" | "not-covered" | "timeout" | "other"
}

const OUTCOME: Record<string, Mutant["outcome"]> = { "KILLED": "killed", "LIVED": "survived", "NOT COVERED": "not-covered", "TIMED OUT": "timeout" }

/** gremlins' `-o` JSON. Not-viable and skipped mutants are `other` and don't count. */
export const parseGremlins = (json: string): Option.Option<Mutant[]> =>
  Option.map(Schema.decodeUnknownOption(Schema.fromJsonString(GremlinsReport))(json), (r) =>
    r.files.flatMap((f) => f.mutations.map((m) => ({ path: f.file_name, line: m.line, type: m.type, outcome: OUTCOME[m.status] ?? "other" }))))
