import type { Pack } from "@gauntlet/core"
import { Deferred, Effect, Layer, Sink, Stdio, Stream } from "effect"
import type { AuthorConfig } from "@gauntlet/author"
import type { LanguageModel } from "effect/ai"
import { appLayer } from "../../cli/src/index.ts"
import { mcpServer } from "../src/index.ts"

// An in-memory MCP client: sends JSON-RPC requests over a test Stdio and
// collects the responses by id. stdin stays open until every request with an
// id has been answered, so slow tools (check) finish before the session ends.

export interface Call { readonly name: string; readonly arguments?: Record<string, unknown> }

export const session = async (calls: ReadonlyArray<Call | { readonly method: string }>, o: {
  readonly repo: string
  readonly packs: ReadonlyArray<Pack>
  readonly env?: Record<string, string>
  readonly model?: (c: AuthorConfig) => Layer.Layer<LanguageModel.LanguageModel>
}) => {
  const requests = [
    { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    ...calls.map((c, i) => ("method" in c
      ? { jsonrpc: "2.0", id: i + 1, method: c.method }
      : { jsonrpc: "2.0", id: i + 1, method: "tools/call", params: { name: c.name, arguments: c.arguments ?? {} } })),
  ]
  const expected = requests.filter((r) => "id" in r).length
  const responses = new Map<number, { result?: any; error?: any }>()
  let buffer = ""
  const program = Effect.gen(function*() {
    const done = yield* Deferred.make<void>()
    const stdio = Stdio.layerTest({
      stdin: Stream.fromIterable(requests.map((r) => new TextEncoder().encode(`${JSON.stringify(r)}\n`))).pipe(Stream.concat(Stream.fromEffectDrain(Deferred.await(done)))),
      stdout: () => Sink.forEach((chunk: string | Uint8Array) => Effect.gen(function*() {
        buffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""
        for (const line of lines.filter((l) => l.trim() !== "")) {
          const m = JSON.parse(line)
          if (typeof m.id === "number") responses.set(m.id, m)
        }
        if (responses.size >= expected) yield* Deferred.succeed(done, undefined)
      })),
    })
    const server = mcpServer({ repo: o.repo, gauntletVersion: "0.1.0-test", env: o.env ?? {}, ...(o.model ? { model: o.model } : {}) }).pipe(Layer.provide(stdio))
    yield* Layer.launch(server).pipe(Effect.raceFirst(Deferred.await(done).pipe(Effect.andThen(Effect.sleep("10 millis")))))
  })
  await Effect.runPromiseExit(program.pipe(Effect.provide(appLayer([...o.packs]))))
  const result = (id: number) => responses.get(id)?.result
  return {
    list: result,
    /** A tool call's result: structured content when present, else the text. */
    tool: (i: number) => {
      const r = result(i + 1)
      return { isError: r?.isError === true, value: r?.structuredContent ?? r?.content?.[0]?.text, text: r?.content?.[0]?.text as string | undefined }
    },
  }
}
