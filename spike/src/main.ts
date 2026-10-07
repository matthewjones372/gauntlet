// Spike: prove Langium, effect/ai + Anthropic, effect/cli, the MCP SDK and
// web-tree-sitter all load and run inside a `bun build --compile` binary.
import { Config, Context, Data, Effect, Layer, Option, Schema } from "effect"
import { Argument, Command } from "effect/cli"
import { FetchHttpClient } from "effect/http"
import { LanguageModel } from "effect/ai"
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { BunRuntime, BunServices } from "@effect/platform-bun"
import {
  createDefaultCoreModule,
  createDefaultSharedCoreModule,
  EmptyFileSystem,
  inject,
  URI,
} from "langium"
import { HarnessGeneratedModule, HarnessGeneratedSharedModule } from "./language/generated/module.ts"
import type { Policy } from "./language/generated/ast.ts"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { z } from "zod"

// ---------- Langium behind an Effect service ----------

class ParseError extends Data.TaggedError("ParseError")<{ readonly messages: ReadonlyArray<string> }> {}

const PolicySummary = Schema.Struct({
  name: Schema.String,
  packs: Schema.Array(Schema.String),
  mode: Schema.String,
  zones: Schema.Array(Schema.String),
})

class Validator extends Context.Service<Validator, {
  readonly validate: (text: string) => Effect.Effect<typeof PolicySummary.Type, ParseError>
}>()("Validator") {}

const ValidatorLive = Layer.sync(Validator, () => {
  const shared = inject(createDefaultSharedCoreModule(EmptyFileSystem), HarnessGeneratedSharedModule)
  const lang = inject(createDefaultCoreModule({ shared }), HarnessGeneratedModule)
  shared.ServiceRegistry.register(lang)
  let n = 0
  return {
    validate: (text) =>
      Effect.gen(function*() {
        const doc = shared.workspace.LangiumDocumentFactory.fromString<Policy>(text, URI.parse(`memory:///p${n++}.hx`))
        yield* Effect.promise(() => shared.workspace.DocumentBuilder.build([doc], { validation: true }))
        const errs = (doc.diagnostics ?? []).filter((d) => d.severity === 1)
        if (errs.length > 0) {
          return yield* new ParseError({
            messages: errs.map((d) => `${d.range.start.line + 1}:${d.range.start.character + 1} ${d.message}`),
          })
        }
        const p = doc.parseResult.value
        return { name: p.name, packs: p.packs, mode: p.mode ?? "shadow", zones: p.zones.map((z) => z.name) }
      }),
  }
})

const SAMPLE = `harness "trade-reporting"
use jvm, kotlin
mode shadow
protect "src/test/**", "harness/**"
zone money { paths "src/**/settlement/**" owner @payments }
`

// ---------- MCP SDK in-process round trip ----------

const mcpSelfTest = Effect.gen(function*() {
  const validator = yield* Validator
  const server = new McpServer({ name: "harness-spike", version: "0.0.0" })
  server.registerTool(
    "validate",
    { description: "Validate a harness.hx source", inputSchema: { source: z.string() } },
    async ({ source }) => {
      const r = await Effect.runPromise(Effect.result(validator.validate(source)))
      return { content: [{ type: "text", text: JSON.stringify(r) }] }
    },
  )
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "spike-client", version: "0.0.0" })
  yield* Effect.promise(() => Promise.all([server.connect(a), client.connect(b)]))
  const tools = yield* Effect.promise(() => client.listTools())
  const res = yield* Effect.promise(() => client.callTool({ name: "validate", arguments: { source: SAMPLE } }))
  yield* Effect.promise(() => client.close())
  return { tools: tools.tools.map((t) => t.name), result: res.content }
})

// ---------- web-tree-sitter WASM ----------

import wasmPath from "web-tree-sitter/web-tree-sitter.wasm" with { type: "file" }

const treeSitterSelfTest = Effect.tryPromise({
  try: async () => {
    const { Parser } = await import("web-tree-sitter")
    await Parser.init({ locateFile: () => wasmPath })
    return "web-tree-sitter runtime initialised"
  },
  catch: (e) => String(e),
})

// ---------- effect/ai + Anthropic ----------

const ModelName = Config.String("HARNESS_MODEL").pipe(Config.withDefault("claude-sonnet-5-5"))

const aiSelfTest = Effect.gen(function*() {
  const key = yield* Config.option(Config.Redacted("ANTHROPIC_API_KEY"))
  const model = yield* ModelName
  const AnthropicLive = AnthropicLanguageModel.layer({ model }).pipe(
    Layer.provide(AnthropicClient.layerConfig({
      apiKey: Config.Redacted("ANTHROPIC_API_KEY"),
      apiUrl: Config.String("ANTHROPIC_BASE_URL").pipe(Config.withDefault("https://api.anthropic.com")),
    })),
    Layer.provide(FetchHttpClient.layer),
  )
  if (Option.isNone(key)) {
    // Build the layer graph without a key to prove the modules wire up.
    yield* Effect.scoped(Layer.build(AnthropicLive)).pipe(Effect.ignore)
    return `layer built for ${model}; no ANTHROPIC_API_KEY so no request sent`
  }
  const r = yield* LanguageModel.generateText({ prompt: "Reply with the single word: pong" }).pipe(
    Effect.provide(AnthropicLive),
  )
  return `${model} replied: ${r.text.trim()}`
})

// ---------- CLI ----------

const selftest = Command.make("selftest", {}, () =>
  Effect.gen(function*() {
    const validator = yield* Validator
    const parsed = yield* validator.validate(SAMPLE)
    console.log("langium     ok", JSON.stringify(parsed))
    const bad = yield* Effect.flip(validator.validate(`harness "x"\nmode lax\n`))
    console.log("langium err ok", bad.messages.join(" | "))
    const mcp = yield* mcpSelfTest
    console.log("mcp         ok", JSON.stringify(mcp))
    console.log("tree-sitter", yield* Effect.match(treeSitterSelfTest, { onFailure: (e) => `FAIL ${e}`, onSuccess: (s) => `ok ${s}` }))
    console.log("ai         ", yield* Effect.match(aiSelfTest, { onFailure: (e) => `FAIL ${String(e)}`, onSuccess: (s) => `ok ${s}` }))
  }))

const validate = Command.make("validate", { file: Argument.String("file") }, ({ file }) =>
  Effect.gen(function*() {
    const text = yield* Effect.promise(() => Bun.file(file).text())
    const v = yield* Validator
    const r = yield* v.validate(text)
    console.log(JSON.stringify(r))
  }))

const root = Command.make("harness-spike").pipe(Command.withSubcommands([selftest, validate]))

Command.run(root, { version: "0.0.0" }).pipe(
  Effect.provide(ValidatorLive),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain,
)
