import { Context, Layer, Schema } from "effect"
import { FlagCheck, ForbidCheck, RatchetCheck, Unit } from "@gauntlet/ir"

/**
 * What a gate produces, which decides what the DSL may say about it:
 * - outcome: passes or fails, nothing to compare (build)
 * - violations: findings, ratchetable by fingerprint (lint, arch)
 * - metric: a number, comparable with a threshold and ratchetable (coverage)
 */
export const GateSpec = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  produces: Schema.Literals(["outcome", "violations", "metric"]),
  units: Schema.Array(Unit),
  higherIsBetter: Schema.Boolean,
  scopable: Schema.Boolean,
  zoneScopable: Schema.Boolean,
})
export type GateSpec = typeof GateSpec.Type

export const RuleSpec = Schema.Struct({ name: Schema.String, description: Schema.String })
export type RuleSpec = typeof RuleSpec.Type

export const PackSpec = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  gates: Schema.Array(GateSpec),
  rules: Schema.Array(RuleSpec),
  runsSuites: Schema.Boolean,
  integrity: Schema.Array(Schema.Union([RatchetCheck, ForbidCheck, FlagCheck])),
})
export type PackSpec = typeof PackSpec.Type

/** The names a policy can refer to, as provided by the installed packs. */
export class Catalog extends Context.Service<Catalog, {
  readonly packs: ReadonlyArray<PackSpec>
}>()("@gauntlet/dsl/Catalog") {
  static readonly layer = (packs: ReadonlyArray<PackSpec>) => Layer.succeed(Catalog, { packs })
}
