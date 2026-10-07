import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import { OpenAiClient as CompatClient, OpenAiLanguageModel as CompatLanguageModel } from "@effect/ai-openai-compat"
import { Layer, Redacted } from "effect"
import type { LanguageModel } from "effect/ai"
import { FetchHttpClient } from "effect/http"

// Which model the authoring agent uses (ADR 0010), and the separation from
// coding agents (ADR 0009). Only GAUNTLET_AUTHOR_* variables are read; a
// provider's usual key variable never is.

export type Provider = "anthropic" | "openai" | "openai-compat"

export interface AuthorConfig {
  readonly provider: Provider
  readonly model: string
  readonly apiKey: Redacted.Redacted<string>
  readonly baseUrl?: string
}

const DEFAULT_MODEL: Partial<Record<Provider, string>> = { anthropic: "claude-opus-5-5" }

type Env = Readonly<Record<string, string | undefined>>

/** The configuration, or why there isn't a usable one. */
export const authorConfig = (env: Env): { readonly _tag: "Config"; readonly config: AuthorConfig } | { readonly _tag: "Missing"; readonly reason: string } => {
  const provider = (env.GAUNTLET_AUTHOR_PROVIDER ?? "anthropic") as Provider
  if (!["anthropic", "openai", "openai-compat"].includes(provider)) {
    return { _tag: "Missing", reason: `GAUNTLET_AUTHOR_PROVIDER must be anthropic, openai or openai-compat, not '${provider}'` }
  }
  const key = env.GAUNTLET_AUTHOR_API_KEY
  if (!key) return { _tag: "Missing", reason: "GAUNTLET_AUTHOR_API_KEY isn't set (the authoring agent never uses a provider's usual key variable)" }
  const model = env.GAUNTLET_AUTHOR_MODEL ?? DEFAULT_MODEL[provider]
  if (!model) return { _tag: "Missing", reason: `set GAUNTLET_AUTHOR_MODEL to ${provider === "anthropic" ? "an anthropic" : "an openai"} model id` }
  const baseUrl = env.GAUNTLET_AUTHOR_BASE_URL
  if (provider === "openai-compat" && !baseUrl) return { _tag: "Missing", reason: "openai-compat needs GAUNTLET_AUTHOR_BASE_URL (for example http://localhost:11434/v1)" }
  return { _tag: "Config", config: { provider, model, apiKey: Redacted.make(key), ...(baseUrl ? { baseUrl } : {}) } }
}

/** Environment variables coding agents set. While one is present the authoring agent won't run. */
export const CODING_AGENT_MARKERS = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED", "CURSOR_AGENT", "GEMINI_CLI", "GAUNTLET_AGENT"] as const

/** Why authoring must not run here, or undefined. Best effort: the real guarantee is that policy changes merge only after review (ADR 0003). */
export const isolationProblem = (env: Env, interactive: boolean): string | undefined => {
  const marker = CODING_AGENT_MARKERS.find((m) => env[m] !== undefined && env[m] !== "")
  if (marker) return `${marker} is set, so this looks like a coding agent's session. Run authoring yourself, from a separate shell with its own credentials.`
  if (!interactive) return "authoring needs an interactive terminal: every proposal is accepted or rejected by a person."
  return undefined
}

export const languageModelLayer = (c: AuthorConfig): Layer.Layer<LanguageModel.LanguageModel> => {
  const options = { apiKey: c.apiKey, ...(c.baseUrl ? { apiUrl: c.baseUrl } : {}) }
  switch (c.provider) {
    case "anthropic":
      return AnthropicLanguageModel.layer({ model: c.model }).pipe(Layer.provide(AnthropicClient.layer(options)), Layer.provide(FetchHttpClient.layer))
    case "openai":
      return OpenAiLanguageModel.layer({ model: c.model }).pipe(Layer.provide(OpenAiClient.layer(options)), Layer.provide(FetchHttpClient.layer))
    case "openai-compat":
      return CompatLanguageModel.layer({ model: c.model }).pipe(Layer.provide(CompatClient.layer(options)), Layer.provide(FetchHttpClient.layer))
  }
}
