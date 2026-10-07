import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { authorConfig, draftProposals, languageModelLayer } from "../src/index.ts"
import { BASE, context } from "./fake.ts"

// One live run against the configured provider (ADR 0010). Opt in with
// GAUNTLET_AUTHOR_LIVE=1 and the usual GAUNTLET_AUTHOR_* variables; it costs a
// few cents and never runs in CI by default.

const LIVE = process.env.GAUNTLET_AUTHOR_LIVE === "1"

describe.skipIf(!LIVE)("authoring agent against a real model", () => {
  test("explores, proposes and every surviving proposal is checked", async () => {
    const config = authorConfig(process.env)
    if (config._tag !== "Config") throw new Error(config.reason)
    const r = await Effect.runPromise(draftProposals({ mode: "review", text: BASE, ctx: context() }).pipe(Effect.provide(languageModelLayer(config.config))))
    for (const p of r.proposals) expect(p._tag).toBe("Valid")
    console.log(`${r.proposals.length} proposals, ${r.dropped.length} dropped, ${r.rounds} rounds`)
  }, 300_000)
})
