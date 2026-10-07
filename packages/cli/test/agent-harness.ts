import { Effect, Layer } from "effect"
import { scriptPack } from "../../core/test/script-pack.ts"
import { appLayer, ExitStatus, Output, runCli, stdinText } from "../src/index.ts"

/** Runs the CLI in-process with the given standard input, as a coding agent's hook would. */
export const hookCli = async (args: string[], stdin: string, packs = [scriptPack]) => {
  const out: string[] = []
  const err: string[] = []
  const capture = Layer.succeed(Output, {
    out: (t) => Effect.sync(() => void out.push(t)),
    err: (t) => Effect.sync(() => void err.push(t)),
  })
  const code = await Effect.runPromise(runCli(args).pipe(Effect.provide(Layer.mergeAll(appLayer(packs), capture, ExitStatus.layer, stdinText(stdin)))))
  return { code, out: out.join("\n"), err: err.join("\n") }
}
