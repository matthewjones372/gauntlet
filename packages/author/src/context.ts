import type { SelftestPlan, ShadowSummary } from "@gauntlet/core"
import type { PackSpec } from "@gauntlet/dsl"
import type { PolicyIR } from "@gauntlet/ir"
import type { Effect, Option } from "effect"

/**
 * Everything the authoring agent can see, gathered by Gauntlet before the
 * model runs. Tools read from it and citations are checked against it, so a
 * citation is only valid when Gauntlet itself can find the cited fact.
 */
export interface AuthorContext {
  readonly files: ReadonlyArray<string>
  readonly read: (path: string) => Effect.Effect<Option.Option<string>>
  readonly packs: ReadonlyArray<PackSpec>
  /** Runner config of the used packs, which is protected even when no group names it. */
  readonly runnerConfig: ReadonlyArray<string>
  readonly shadow: ShadowSummary
  /** The selftest dry run under a policy. */
  readonly selftestPlan: (ir: PolicyIR) => Effect.Effect<SelftestPlan>
  readonly gitLog: string
}
