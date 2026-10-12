import { Effect, Layer } from "effect"
import { scriptPack } from "../../core/test/script-pack.ts"
import { appLayer, ExitStatus, Output, runCli } from "../src/index.ts"
import { Forge, ForgeFailed, type ForgeShape, OwnerSession, type PullRequest } from "../src/owner.ts"

/** What the fake forge was asked to do, in order. */
export type ForgeCall =
  | { readonly op: "comment"; readonly pr: number; readonly body: string }
  | { readonly op: "fetch"; readonly refspecs: ReadonlyArray<string> }
  | { readonly op: "push"; readonly refspec: string }

/** A forge that serves one pull request, signed in as `login`, and records every call. */
export const fakeForge = (pr: PullRequest, login: string, calls: ForgeCall[]): ForgeShape => ({
  pullRequest: (_repo, n) => n === pr.number ? Effect.succeed(pr) : Effect.fail(new ForgeFailed({ message: `no pull request #${n}` })),
  login: () => Effect.succeed(login),
  comment: (_repo, n, body) => Effect.sync(() => void calls.push({ op: "comment", pr: n, body })),
  fetch: (_repo, refspecs) => Effect.sync(() => void calls.push({ op: "fetch", refspecs })),
  push: (_repo, refspec) => Effect.sync(() => void calls.push({ op: "push", refspec })),
})

export const OWNER_AT_TERMINAL = { env: {}, interactive: true }

/** Runs the CLI in-process with the given forge, session and other layers, and captures what it prints. */
export const ownerCli = async (args: string[], options: { forge: ForgeShape; session?: { env: Record<string, string>; interactive: boolean }; extra?: Layer.Layer<never> }) => {
  const out: string[] = []
  const err: string[] = []
  const capture = Layer.succeed(Output, {
    out: (t) => Effect.sync(() => void out.push(t)),
    err: (t) => Effect.sync(() => void err.push(t)),
  })
  const layers = Layer.mergeAll(
    appLayer([scriptPack]),
    capture,
    ExitStatus.layer,
    Layer.succeed(Forge, options.forge),
    Layer.succeed(OwnerSession, options.session ?? OWNER_AT_TERMINAL),
    options.extra ?? Layer.empty,
  )
  const code = await Effect.runPromise(runCli(args).pipe(Effect.provide(layers)))
  return { code, out: out.join("\n"), err: err.join("\n") }
}
