# 0010. The authoring model provider is pluggable

Status: accepted (2026-10-07)

## Context
Gauntlet judges code no matter which agent wrote it. The authoring agent should not tie users to one model vendor.

## Decision
The authoring agent depends only on `effect/ai`'s `LanguageModel`. Configuration chooses the provider:

- `GAUNTLET_AUTHOR_PROVIDER`: `anthropic` (default), `openai` or `openai-compat`
- `GAUNTLET_AUTHOR_MODEL`: model id. The default is `claude-opus-5-5` for `anthropic`; `openai` and `openai-compat` need it set (M12), so Gauntlet never guesses another vendor's current model names
- `GAUNTLET_AUTHOR_API_KEY`: the key, which is never read from a provider's usual variable (ADR 0009)
- `GAUNTLET_AUTHOR_BASE_URL`: required for `openai-compat` (Ollama, vLLM and similar), optional otherwise

v1 compiles in `@effect/ai-anthropic`, `@effect/ai-openai` and `@effect/ai-openai-compat`. Only the selected provider's layer is built, and only for authoring commands.

## Consequences
- Prompts and the tool loop must not rely on vendor-specific features. Structured output goes through `LanguageModel.generateObject` with Schema.
- Tests use the fake `LanguageModel` layer, so provider count does not multiply the test matrix. One opt-in live test per provider.
- Coding-agent integrations ship Claude Code only in v1. Hooks are generated from a neutral description, so Codex, Cursor and Copilot adapters can follow (PLAN section 14).
- The deferred `advisory` LLM reviewer will use the same provider configuration with its own key.
