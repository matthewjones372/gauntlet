import type { SelftestPlan } from "@gauntlet/core"
import { jvmSpec } from "@gauntlet/pack-jvm"
import type { PolicyIR } from "@gauntlet/ir"
import { Effect, Layer, Option, Stream } from "effect"
import { LanguageModel } from "effect/ai"
import type { AuthorContext } from "../src/index.ts"

// A scripted LanguageModel: each call takes the next step. A step sees the
// request, so tests can check what Gauntlet sent (tool results, repair notes).

export type Step =
  | { readonly tools: ReadonlyArray<{ readonly name: string; readonly params: unknown }> }
  | { readonly text: string }
  | { readonly object: unknown }

const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } }

export const scripted = (steps: ReadonlyArray<Step>) => {
  const seen: { prompt: string; json: boolean }[] = []
  let i = 0
  const layer = Layer.effect(LanguageModel.LanguageModel, LanguageModel.make({
    generateText: (options) => {
      seen.push({ prompt: JSON.stringify(options.prompt.content), json: options.responseFormat.type === "json" })
      const step = steps[i++]
      if (!step) return Effect.die(new Error(`the model was called ${i} times, but only ${steps.length} steps are scripted`))
      if ("tools" in step) {
        return Effect.succeed([
          ...step.tools.map((t, n) => ({ type: "tool-call" as const, id: `call-${i}-${n}`, name: t.name, params: t.params })),
          { type: "finish" as const, reason: "tool-calls" as const, usage },
        ])
      }
      const text = "text" in step ? step.text : JSON.stringify(step.object)
      return Effect.succeed([{ type: "text" as const, text }, { type: "finish" as const, reason: "stop" as const, usage }])
    },
    streamText: () => Stream.empty,
  }))
  return { layer, seen, calls: () => i }
}

export const FILES: Record<string, string> = {
  "settings.gradle.kts": `rootProject.name = "svc"\n`,
  "build.gradle.kts": `plugins {\n    kotlin("jvm") version "2.4.10"\n    id("info.solidsoft.pitest") version "1.19.0"\n}\n`,
  "src/main/kotlin/svc/settlement/Fx.kt": `package svc.settlement\n\nfun convert(amountMinor: Long, rate: Long): Long = amountMinor * rate / 10_000\n`,
  "src/main/kotlin/svc/domain/Money.kt": `package svc.domain\n\ndata class Money(val minor: Long)\n`,
  "src/test/kotlin/svc/FxTest.kt": `class FxTest\n`,
  "README.md": "# svc\n",
}

export const BASE = `gauntlet "svc"
use jvm
mode shadow
owners @platform

suites { unit "src/test/**" }

gates {
  fast   { build }
  verify { unit }
}

review {
  review when protected changed
  auto   when all gates pass
}
`

/** The selftest plan: deleted-test only applies once tests are protected or in a suite with protection. */
const plan = (ir: PolicyIR): SelftestPlan => {
  const protectsTests = ir.protect.some((g) => g.kind === "tests")
  return {
    fixtures: protectsTests ? [{ fixture: "edited-test-setup", description: "edits test setup", paths: ["src/test/kotlin/svc/FxTest.kt"] }] : [],
    notApplicable: protectsTests ? [] : ["edited-test-setup"],
  }
}

export const context = (files: Record<string, string> = FILES): AuthorContext => ({
  files: Object.keys(files).sort(),
  read: (p) => Effect.succeed(Option.fromNullishOr(files[p])),
  packs: [jvmSpec],
  runnerConfig: ["settings.gradle.kts", "gradle/**"],
  shadow: { runs: 12, shadowRuns: 12, wouldBlock: 3, tiers: { auto: 6, skim: 0, review: 5, owner: 1 }, topReasons: [{ reason: "unit failed: 1 of 9 tests failed", count: 2 }], topMissing: [] },
  selftestPlan: (ir) => Effect.succeed(plan(ir)),
  gitLog: "abc123 Add FX conversion\n",
})

export const MONEY_ZONE = {
  kind: "zone",
  name: "money",
  action: "set",
  text: `zone money {\n  paths "src/main/kotlin/svc/settlement/**"\n  owner @payments\n  rule kotlin.no-floating-money\n}`,
  rationale: "FX conversion handles money.",
  citation: { kind: "sensitive-code", path: "src/main/kotlin/svc/settlement/Fx.kt", line: 3, excerpt: "fun convert(amountMinor: Long, rate: Long)" },
} as const

export const PROTECT_TESTS = {
  kind: "protect",
  action: "set",
  text: `protect {\n  tests "src/test/**"\n}`,
  rationale: "Tests aren't protected, so an agent could edit them to pass.",
  citation: { kind: "unprotected-tests", path: "src/test/kotlin/svc/FxTest.kt" },
} as const
