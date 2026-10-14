import { relativeUri, type Result, type Run } from "@gauntlet/sarif"
import { Option } from "effect"

// Knip's `--reporter json` output as dead-code findings (spec 0017 §4). Knip 5
// lists unused files at the top level and enum and class members by their
// parent; Knip 6 lists everything per file. Only what's unused counts:
// unlisted or unresolved imports and missing binaries are mistakes, not dead
// code, and are the build's and lint's to catch.

export const DEAD_CODE = "dead-code"

/** Knip's issue types that are dead code, and the kind each is reported as. */
const KINDS: Readonly<Record<string, { readonly kind: string; readonly what: string }>> = {
  files: { kind: "unused-file", what: "unused file" },
  dependencies: { kind: "unused-dependency", what: "unused dependency" },
  devDependencies: { kind: "unused-dev-dependency", what: "unused devDependency" },
  optionalPeerDependencies: { kind: "unused-peer-dependency", what: "unused optional peer dependency" },
  exports: { kind: "unused-export", what: "unused export" },
  types: { kind: "unused-type", what: "unused exported type" },
  nsExports: { kind: "unused-export", what: "unused export in namespace" },
  nsTypes: { kind: "unused-type", what: "unused exported type in namespace" },
  namespaceMembers: { kind: "unused-namespace-member", what: "unused namespace member" },
  enumMembers: { kind: "unused-enum-member", what: "unused enum member" },
  classMembers: { kind: "unused-class-member", what: "unused class member" },
  duplicates: { kind: "duplicate-export", what: "duplicate export" },
}

interface Found {
  readonly name: string
  readonly line?: number
  readonly col?: number
  readonly parent?: string
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x)

const symbolOf = (x: unknown, parent?: string): Found | undefined => {
  if (typeof x === "string") return { name: x }
  if (!isRecord(x) || typeof x.name !== "string") return undefined
  const ns = typeof x.namespace === "string" ? x.namespace : parent
  return {
    name: x.name,
    ...(typeof x.line === "number" && x.line > 0 ? { line: x.line } : {}),
    ...(typeof x.col === "number" && x.col > 0 ? { col: x.col } : {}),
    ...(ns !== undefined ? { parent: ns } : {}),
  }
}

/** The symbols of one issue type: a list, a list of lists (duplicates), or lists by parent (Knip 5's members). */
const symbolsOf = (value: unknown): Found[][] => {
  if (Array.isArray(value)) {
    return value.flatMap((x): Found[][] => {
      if (Array.isArray(x)) {
        const group = x.map((y) => symbolOf(y)).filter((s): s is Found => s !== undefined)
        return group.length > 0 ? [group] : []
      }
      const s = symbolOf(x)
      return s ? [[s]] : []
    })
  }
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([parent, xs]) => (Array.isArray(xs) ? xs.map((x) => symbolOf(x, parent)).filter((s): s is Found => s !== undefined).map((s) => [s]) : []))
  }
  return []
}

/** The line a dependency is declared on in its manifest, so it's matched by fingerprint rather than by count. */
const declaredOn = (lines: ReadonlyArray<string> | undefined, name: string): number | undefined => {
  if (!lines) return undefined
  const i = lines.findIndex((l) => l.includes(`${JSON.stringify(name)}:`) || l.includes(`${JSON.stringify(name)} :`))
  return i >= 0 ? i + 1 : undefined
}

/**
 * Knip's JSON report as a SARIF run named `knip`, each finding
 * `dead-code/<kind>` with its file and line. `readLines` reads a file of the
 * checkout, for the line a dependency is declared on (Knip doesn't say).
 * None when the report isn't Knip's JSON.
 */
export const parseKnip = (json: string, repoRoot: string, readLines: (path: string) => ReadonlyArray<string> | undefined = () => undefined): Option.Option<Run> => {
  let report: unknown
  try {
    report = JSON.parse(json)
  } catch {
    return Option.none()
  }
  if (!isRecord(report) || !Array.isArray(report.issues)) return Option.none()
  const results: Result[] = []
  const add = (type: string, file: string, symbols: ReadonlyArray<Found>) => {
    const k = KINDS[type]!
    const first = symbols[0]!
    const named = (s: Found) => (s.parent !== undefined ? `${s.parent}.${s.name}` : s.name)
    const dependency = type.endsWith("ependencies")
    const line = first.line ?? (dependency ? declaredOn(readLines(file), first.name) : undefined)
    results.push({
      ruleId: `${DEAD_CODE}/${k.kind}`,
      level: "warning",
      message: { text: type === "files" ? `${k.what}: ${file}` : `${k.what}: ${symbols.map(named).join(", ")}` },
      locations: [{
        physicalLocation: {
          artifactLocation: { uri: file },
          ...(line !== undefined ? { region: { startLine: line, ...(first.line !== undefined && first.col !== undefined ? { startColumn: first.col } : {}) } } : {}),
        },
      }],
    })
  }
  // Knip 5: unused files are a list of paths at the top level.
  if (Array.isArray(report.files)) for (const f of report.files) if (typeof f === "string") add("files", relativeUri(f, repoRoot), [{ name: f }])
  for (const issue of report.issues) {
    if (!isRecord(issue) || typeof issue.file !== "string") continue
    const file = relativeUri(issue.file, repoRoot)
    for (const type of Object.keys(KINDS)) {
      for (const group of symbolsOf(issue[type])) add(type, file, type === "files" ? [{ name: file }] : group)
    }
  }
  return Option.some({ tool: { driver: { name: "knip" } }, results })
}
