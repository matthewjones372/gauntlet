import { Schema } from "effect"

// The subset of SARIF 2.1.0 Gauntlet reads and writes (ADR 0004). Decoding
// external logs drops fields outside this subset; Gauntlet's own data lives
// in `properties.gauntlet`.

export const SARIF_VERSION = "2.1.0" as const
export const SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json"

/** Key under `partialFingerprints` for Gauntlet's context fingerprint. */
export const CTX_V1 = "gauntlet/ctx/v1"
export const CTX_V1_NOSYM = "gauntlet/ctx/v1/nosym"

export const Level = Schema.Literals(["none", "note", "warning", "error"])
export type Level = typeof Level.Type

export const BaselineState = Schema.Literals(["new", "unchanged", "updated", "absent"])
export type BaselineState = typeof BaselineState.Type

const Message = Schema.Struct({ text: Schema.String })

export const Region = Schema.Struct({
  startLine: Schema.optionalKey(Schema.Number),
  startColumn: Schema.optionalKey(Schema.Number),
  endLine: Schema.optionalKey(Schema.Number),
  endColumn: Schema.optionalKey(Schema.Number),
  snippet: Schema.optionalKey(Message),
})
export type Region = typeof Region.Type

export const Location = Schema.Struct({
  physicalLocation: Schema.optionalKey(Schema.Struct({
    artifactLocation: Schema.optionalKey(Schema.Struct({ uri: Schema.String })),
    region: Schema.optionalKey(Region),
  })),
  logicalLocations: Schema.optionalKey(Schema.Array(Schema.Struct({
    name: Schema.optionalKey(Schema.String),
    fullyQualifiedName: Schema.optionalKey(Schema.String),
    kind: Schema.optionalKey(Schema.String),
  }))),
})
export type Location = typeof Location.Type

/** Gauntlet's annotations on a single result. */
export const ResultProperties = Schema.Struct({
  gauntlet: Schema.optionalKey(Schema.Struct({
    /** From a probabilistic source: may raise the tier, never lower it (ADR 0011). */
    caution: Schema.optionalKey(Schema.Boolean),
    /** Why the result matched the baseline the way it did. */
    match: Schema.optionalKey(Schema.Literals(["context", "symbol", "line", "count"])),
  })),
})

export const Result = Schema.Struct({
  ruleId: Schema.String,
  level: Schema.optionalKey(Level),
  message: Message,
  locations: Schema.optionalKey(Schema.Array(Location)),
  partialFingerprints: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  baselineState: Schema.optionalKey(BaselineState),
  properties: Schema.optionalKey(ResultProperties),
})
export type Result = typeof Result.Type

export const Metric = Schema.Struct({
  value: Schema.Finite,
  unit: Schema.Literals(["%", "count", "ratio", "ms"]),
  higherIsBetter: Schema.Boolean,
  perFile: Schema.optionalKey(Schema.Record(Schema.String, Schema.Finite)),
})
export type Metric = typeof Metric.Type

/** Proof a check ran (ADR 0012). */
export const Proof = Schema.Struct({
  command: Schema.Array(Schema.String),
  exitCode: Schema.Number,
  /** sha256 of each report file Gauntlet read, keyed by its path in the output directory. */
  reports: Schema.Record(Schema.String, Schema.String),
  /** Tests that actually ran, when the check runs tests. */
  executed: Schema.optionalKey(Schema.Number),
})
export type Proof = typeof Proof.Type

export const TestCounts = Schema.Struct({
  executed: Schema.Number,
  passed: Schema.Number,
  failed: Schema.Number,
  errored: Schema.Number,
  skipped: Schema.Number,
})
export type TestCounts = typeof TestCounts.Type

/** A detekt-style legacy baseline entry: grandfathered by the tool's own id. */
export const LegacyEntry = Schema.Struct({ tool: Schema.String, id: Schema.String })
export type LegacyEntry = typeof LegacyEntry.Type

export const RunProperties = Schema.Struct({
  gauntlet: Schema.optionalKey(Schema.Struct({
    check: Schema.optionalKey(Schema.String),
    proof: Schema.optionalKey(Proof),
    tests: Schema.optionalKey(TestCounts),
    metrics: Schema.optionalKey(Schema.Record(Schema.String, Metric)),
    /** Results from this tool have no stable locations; compare per-file counts instead. */
    unstableLocations: Schema.optionalKey(Schema.Boolean),
    trust: Schema.optionalKey(Schema.Literals(["evidence", "caution"])),
    legacy: Schema.optionalKey(Schema.Array(LegacyEntry)),
    /** Test ids that ran when the baseline was recorded, for the deleted-tests check. */
    testIds: Schema.optionalKey(Schema.Array(Schema.String)),
    /** Present on the `gauntlet` run of a baseline file. */
    baseline: Schema.optionalKey(Schema.Struct({ commit: Schema.String, irHash: Schema.String, gauntletVersion: Schema.String })),
  })),
})
export type RunProperties = typeof RunProperties.Type

export const Run = Schema.Struct({
  tool: Schema.Struct({
    driver: Schema.Struct({
      name: Schema.String,
      version: Schema.optionalKey(Schema.String),
      informationUri: Schema.optionalKey(Schema.String),
    }),
  }),
  invocations: Schema.optionalKey(Schema.Array(Schema.Struct({
    executionSuccessful: Schema.Boolean,
    exitCode: Schema.optionalKey(Schema.Number),
    commandLine: Schema.optionalKey(Schema.String),
  }))),
  results: Schema.Array(Result),
  properties: Schema.optionalKey(RunProperties),
})
export type Run = typeof Run.Type

export const Log = Schema.Struct({
  version: Schema.Literal(SARIF_VERSION),
  $schema: Schema.optionalKey(Schema.String),
  runs: Schema.Array(Run),
})
export type Log = typeof Log.Type

export const resultPath = (r: Result): string | undefined => r.locations?.[0]?.physicalLocation?.artifactLocation?.uri

export const resultRegion = (r: Result): Region | undefined => r.locations?.[0]?.physicalLocation?.region
