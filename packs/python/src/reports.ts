import { relativeUri } from "@gauntlet/sarif"
import { Option, Schema } from "effect"

// Parsers for the Python tools' reports. lcov comes from `coverage lcov`.

export interface FileCoverage {
  readonly path: string
  readonly lines: ReadonlyMap<number, boolean>
}

export const parseLcov = (text: string, repoRoot: string): FileCoverage[] => {
  const out: FileCoverage[] = []
  let current: { path: string; lines: Map<number, boolean> } | undefined
  for (const raw of text.split(/\r?\n/)) {
    if (raw.startsWith("SF:")) current = { path: relativeUri(raw.slice(3).trim(), repoRoot), lines: new Map() }
    else if (raw.startsWith("DA:") && current) {
      const [nr, hits] = raw.slice(3).split(",")
      current.lines.set(Number(nr), (current.lines.get(Number(nr)) ?? false) || Number(hits) > 0)
    } else if (raw === "end_of_record" && current) {
      out.push(current)
      current = undefined
    }
  }
  return out
}

const Meta = Schema.Struct({ exit_code_by_key: Schema.Record(Schema.String, Schema.NullOr(Schema.Number)) })

export interface Mutant {
  readonly path: string
  /** The function the mutant is in, as mutmut names it: `add`, or `Money.convert` for methods. */
  readonly function: string
  readonly outcome: "killed" | "survived" | "no-tests" | "timeout" | "skipped" | "other"
}

// mutmut 3's exit codes for a mutant's test run (mutmut/stats.py). A mutant
// the type checker rejects counts as killed: the code can't be broken that way.
const OUTCOME: Record<number, Mutant["outcome"]> = {
  1: "killed", 3: "killed", 37: "killed",
  0: "survived",
  5: "no-tests", 33: "no-tests",
  34: "skipped",
  36: "timeout", 24: "timeout", [-24]: "timeout", 152: "timeout", 255: "timeout",
}

/** A mutmut 3 `<source>.meta` file: one exit code per mutant of that source file. */
export const parseMutmutMeta = (sourcePath: string, json: string): Option.Option<Mutant[]> =>
  Option.map(Schema.decodeUnknownOption(Schema.fromJsonString(Meta))(json), (meta) =>
    Object.entries(meta.exit_code_by_key).map(([key, code]) => {
      // svc.domain.money.x_add__mutmut_3, or svc.domain.money.xǁMoneyǁconvert__mutmut_1 for methods
      const local = key.split(".").pop() ?? key
      const fn = local.replace(/__mutmut_\d+$/, "").replace(/^x_/, "").replace(/^xǁ/, "").replaceAll("ǁ", ".")
      return { path: sourcePath, function: fn, outcome: code === null ? "other" : OUTCOME[code] ?? "other" }
    }))
