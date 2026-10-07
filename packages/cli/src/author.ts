import {
  Acceptor, type AuthorConfig, describeCitation, type Dropped, label, languageModelLayer, type Loosening, type Presented,
} from "@gauntlet/author"
import { Context, Effect, Layer } from "effect"
import type { LanguageModel } from "effect/ai"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline/promises"
import { Output } from "./output.ts"

// The authoring agent's runtime in the CLI: environment, terminal, model and
// the person who accepts proposals. Tests replace it with a scripted model and
// acceptor; the default is the real terminal and the configured provider.

export interface AuthorRuntimeShape {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly interactive: boolean
  readonly model: (c: AuthorConfig) => Layer.Layer<LanguageModel.LanguageModel>
  readonly acceptor: Layer.Layer<Acceptor, never, Output>
}

const ask = (question: string) =>
  Effect.promise(async () => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    try {
      return (await rl.question(question)).trim()
    } finally {
      rl.close()
    }
  })

/** Opens the block in $EDITOR and returns what the person saved. */
const editInEditor = (text: string) =>
  Effect.sync(() => {
    const dir = mkdtempSync(join(tmpdir(), "gauntlet-edit-"))
    const file = join(dir, "block.gx")
    try {
      writeFileSync(file, `${text}\n`)
      spawnSync(process.env.VISUAL ?? process.env.EDITOR ?? "vi", [file], { stdio: "inherit" })
      return readFileSync(file, "utf8")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

const show = (p: Presented) =>
  [
    "",
    `[${p.index}/${p.total}] ${label(p.proposal)}`,
    `Why: ${p.proposal.rationale}`,
    `Evidence: ${describeCitation(p.proposal.citation)}`,
    "--- now",
    p.before ?? "(no such block)",
    "+++ proposed",
    p.proposal.action === "remove" ? "(removed)" : p.proposal.text ?? "",
  ].join("\n")

export const terminalAcceptor = Layer.effect(Acceptor, Effect.gen(function*() {
  const output = yield* Output
  return Acceptor.of({
    decide: (p) =>
      Effect.gen(function*() {
        yield* output.out(show(p))
        for (;;) {
          const answer = (yield* ask("Accept, edit, reject or quit? [a/e/r/q] ")).toLowerCase()
          if (answer === "a") return { _tag: "Accept" } as const
          if (answer === "r") return { _tag: "Reject" } as const
          if (answer === "q") return { _tag: "Quit" } as const
          if (answer === "e") return { _tag: "Edit", text: yield* editInEditor(p.proposal.text ?? p.before ?? "") } as const
        }
      }),
    confirmLoosening: (_p, loosenings: ReadonlyArray<Loosening>) =>
      Effect.gen(function*() {
        yield* output.out(["This loosens the policy:", ...loosenings.map((l) => `  - ${l.what}`)].join("\n"))
        return (yield* ask("Type 'loosen' to apply it anyway, or press Enter to skip it: ")) === "loosen"
      }),
    note: (m) => output.out(m),
  })
}))

export const AuthorRuntime = Context.Reference<AuthorRuntimeShape>("@gauntlet/cli/AuthorRuntime", {
  defaultValue: () => ({
    env: process.env,
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    model: languageModelLayer,
    acceptor: terminalAcceptor,
  }),
})

export const renderDropped = (dropped: ReadonlyArray<Dropped>) =>
  dropped.length === 0 ? [] : [`Dropped ${dropped.length} proposal${dropped.length === 1 ? "" : "s"} before review:`, ...dropped.map((d) => `  - ${label(d.proposal)}: ${d.reason}`)]

