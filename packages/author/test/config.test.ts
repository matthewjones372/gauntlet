import { describe, expect, test } from "bun:test"
import { authorConfig, isolationProblem } from "../src/index.ts"

describe("author configuration", () => {
  test("only GAUNTLET_AUTHOR_* is read; a provider's usual key never is", () => {
    expect(authorConfig({ ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk" })._tag).toBe("Missing")
    const c = authorConfig({ GAUNTLET_AUTHOR_API_KEY: "k" })
    if (c._tag !== "Config") throw new Error(c.reason)
    expect(c.config.provider).toBe("anthropic")
    expect(c.config.model).toBe("claude-opus-5-5")
    expect(JSON.stringify(c.config)).not.toContain(`"k"`)
  })

  test("openai providers need a model id, and openai-compat a base URL", () => {
    expect(authorConfig({ GAUNTLET_AUTHOR_API_KEY: "k", GAUNTLET_AUTHOR_PROVIDER: "openai" })).toEqual({ _tag: "Missing", reason: "set GAUNTLET_AUTHOR_MODEL to an openai model id" })
    expect(authorConfig({ GAUNTLET_AUTHOR_API_KEY: "k", GAUNTLET_AUTHOR_PROVIDER: "openai-compat", GAUNTLET_AUTHOR_MODEL: "llama" })._tag).toBe("Missing")
    expect(authorConfig({ GAUNTLET_AUTHOR_API_KEY: "k", GAUNTLET_AUTHOR_PROVIDER: "openai-compat", GAUNTLET_AUTHOR_MODEL: "llama", GAUNTLET_AUTHOR_BASE_URL: "http://localhost:11434/v1" })._tag).toBe("Config")
    expect(authorConfig({ GAUNTLET_AUTHOR_API_KEY: "k", GAUNTLET_AUTHOR_PROVIDER: "gemini" })._tag).toBe("Missing")
  })

  test("refuses inside a coding agent's session or without a terminal", () => {
    expect(isolationProblem({ CLAUDECODE: "1" }, true)).toContain("CLAUDECODE is set")
    expect(isolationProblem({ CODEX_SANDBOX: "seatbelt" }, true)).toContain("CODEX_SANDBOX")
    expect(isolationProblem({}, false)).toContain("interactive terminal")
    expect(isolationProblem({ CLAUDECODE: "" }, true)).toBeUndefined()
  })
})
