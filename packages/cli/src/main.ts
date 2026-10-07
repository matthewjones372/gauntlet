#!/usr/bin/env bun
import { Cause, Effect, Exit } from "effect"
import { runCli } from "./app.ts"
import { liveLayer } from "./layers.ts"
import { INSTALLED_PACKS } from "./packs.ts"

const exit = await Effect.runPromiseExit(runCli(process.argv.slice(2)).pipe(Effect.provide(liveLayer(INSTALLED_PACKS))))
// Only an interruption ends a run without an exit code: Ctrl-C, or an MCP client closing stdin.
if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) console.error(Cause.pretty(exit.cause))
process.exit(Exit.isSuccess(exit) ? exit.value : Cause.hasInterruptsOnly(exit.cause) ? 0 : 2)
