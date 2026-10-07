import { Effect } from "effect"
import { LanguageModel } from "effect/ai"

// `gauntlet author explain <block>`: plain language for people new to the
// policy. The model is given Gauntlet's own deterministic explanation and
// the policy text, and told to add nothing they don't say.

export const explainInPlainLanguage = (block: string, policyText: string, facts: string) =>
  LanguageModel.generateText({
    prompt: [
      {
        role: "system",
        content: "You explain a Gauntlet policy to a developer in plain language. Gauntlet judges changes written by coding agents before they merge. Use only the facts and policy text given; if something isn't stated there, don't claim it. Be brief: a short paragraph, then what a change has to do to pass.",
      },
      { role: "user", content: `Explain the ${block} part of this policy.\n\nWhat Gauntlet says it enforces:\n${facts}\n\nThe policy:\n${policyText}` },
    ],
  }).pipe(Effect.map((r) => r.text.trim()))
