import type { PolicyIR } from "@gauntlet/ir"
import { Option, Schema } from "effect"
import type { GeneratedFile } from "./files.ts"

// `gauntlet connect claude-code`: early feedback inside the agent. The merge
// gate in CI is the guarantee; these make the agent hit the same wall sooner
// and give it a legitimate way out (`report_blocked`).
//
// The hook generator works from a neutral description, so other agents'
// renderers (Codex, Cursor, Copilot) can follow; only Claude Code ships now.

export interface HookSpec {
  readonly event: "stop" | "before-write"
  readonly command: string
  readonly toolMatcher?: string
}

export const HOOKS: ReadonlyArray<HookSpec> = [
  { event: "stop", command: "gauntlet hook stop" },
  { event: "before-write", command: "gauntlet hook pre-tool-use", toolMatcher: "Edit|Write|MultiEdit|NotebookEdit" },
]

const WRITE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"] as const

/** Deny rules for every protected glob, for each tool that writes files (a rule names one tool). */
export const denyRules = (ir: PolicyIR, runnerConfig: ReadonlyArray<string>): string[] => {
  // New test files may be added (they run in CI); existing ones are guarded by the hook, not a blanket rule.
  const guarded = [...ir.protect.filter((g) => g.kind !== "tests").flatMap((g) => g.globs), ...runnerConfig]
  // Holdouts (ADR 0019) are out of the agent's reach altogether: Read rules also cover Grep and Glob.
  const holdouts = ir.suites.flatMap((s) => (s.kind === "holdout" ? s.globs ?? [] : []))
  return [
    ...[...new Set([...guarded, ...holdouts])].sort().flatMap((glob) => WRITE_TOOLS.map((tool) => `${tool}(${glob})`)),
    ...[...new Set(holdouts)].sort().map((glob) => `Read(${glob})`),
  ]
}

const claudeHooks = () => ({
  // The check runs the project's build and tests, so it says what it's doing and gets longer than the 10-minute default.
  Stop: [{ hooks: [{ type: "command", command: HOOKS[0]!.command, statusMessage: "Gauntlet is checking the change (build, tests, coverage)…", timeout: 1800 }] }],
  PreToolUse: [{ matcher: HOOKS[1]!.toolMatcher, hooks: [{ type: "command", command: HOOKS[1]!.command }] }],
})

/** Merges Gauntlet's hooks, deny rules and nothing else into an existing settings object. */
export const mergeSettings = (existing: Record<string, unknown>, ir: PolicyIR, runnerConfig: ReadonlyArray<string>): Record<string, unknown> => {
  const hooks = (existing.hooks ?? {}) as Record<string, unknown[]>
  const isGauntlet = (entry: unknown) => JSON.stringify(entry).includes("gauntlet hook ")
  const ours = claudeHooks()
  const mergedHooks: Record<string, unknown[]> = { ...hooks }
  for (const [event, entries] of Object.entries(ours)) mergedHooks[event] = [...(hooks[event] ?? []).filter((e) => !isGauntlet(e)), ...entries]
  const permissions = (existing.permissions ?? {}) as Record<string, unknown>
  const deny = ((permissions.deny ?? []) as string[]).filter((r) => !/^(Edit|Write|MultiEdit|NotebookEdit|Read)\(/.test(r) || !denyRules(ir, runnerConfig).includes(r))
  const allow = [...new Set([...((permissions.allow ?? []) as string[]), ...ALLOWED_TOOLS])].sort()
  return { ...existing, hooks: mergedHooks, permissions: { ...permissions, allow, deny: [...new Set([...deny, ...denyRules(ir, runnerConfig)])].sort() } }
}

/** Gauntlet's MCP tools that only read (and `check`, which the agent is told to run), allowed without a prompt. */
export const ALLOWED_TOOLS = ["mcp__gauntlet__check", "mcp__gauntlet__explain", "mcp__gauntlet__get_examples", "mcp__gauntlet__get_grammar", "mcp__gauntlet__validate"] as const

export const mergeMcp = (existing: Record<string, unknown>): Record<string, unknown> => ({
  ...existing,
  mcpServers: { ...(existing.mcpServers as Record<string, unknown> | undefined), gauntlet: { type: "stdio", command: "gauntlet", args: ["mcp"] } },
})

export const AGENT_INSTRUCTIONS = `## Gauntlet

This repository's pull requests are judged by Gauntlet (\`.gauntlet/policy.gx\`).

- Run the \`check\` MCP tool (or \`gauntlet check --working-tree\`) before saying a task is done. A failing gate, a forbidden integrity finding or a review flag is a stop sign: fix the cause, never the check.
- Never edit protected paths to make a check pass: \`.gauntlet/\`, protected tests, test setup and build configuration. In CI they are put back to the base version, so such edits don't help and they need a human.
- Never skip, delete or weaken tests, add suppressions, or special-case tests in main code. Gauntlet detects these and blocks the change.
- If the task can't be done without changing protected tests or policy, stop and call the \`report_blocked\` MCP tool (or run \`gauntlet report blocked --reason "..."\`) with the reason. That is the right outcome, not a failure.
`

/** A managed-settings snippet for teams that want hooks agents can't switch off. */
/** The proposal `/gauntlet-setup` writes and `gauntlet init --apply` applies. */
export const PROPOSAL_FILE = "gauntlet.proposal.gx"

/**
 * `/gauntlet-setup` in Claude Code: the agent goes through the drafted policy
 * with the person one decision at a time, then writes a proposal the person
 * applies with `gauntlet init --apply`. The agent never writes .gauntlet/
 * itself (its deny rules forbid it), so the person keeps the final say over
 * the rules that judge the agent's own work (ADR 0009).
 */
export const SETUP_COMMAND = `---
description: Set up Gauntlet's policy with me, one decision at a time
---
Help me set up Gauntlet's policy for this repository. Gauntlet checks AI-written changes before they're merged; the policy in \`.gauntlet/policy.gx\` decides what every change must pass, including yours.

1. Read \`.gauntlet/policy.gx\`, the draft \`gauntlet init\` wrote. If it doesn't exist, tell me to run \`gauntlet init\` and stop.
2. Call Gauntlet's \`get_grammar\` and \`get_examples\` tools so you only propose what the policy language supports.
3. Read enough of the codebase to know where these live: money and payments; authentication, permissions and secrets; personal data; contracts other systems depend on (APIs, schemas, events, generated clients); data stores and migrations. Also note the layers (modules or packages, and what imports what) and the test layout.
4. Find what the project already has set up, from its build files, tool configuration, CI workflows and any CLAUDE.md or contributing notes: the build tool, the test frameworks, the coverage tool and any minimum it already enforces, the linter and its configuration, mutation testing, and what CI runs. Start by telling me what you found, in plain words and with specifics, for example: "You build with Gradle and test with JUnit 5. Kover already requires 80% line coverage, detekt runs with your config, and CI runs the tests on every pull request. There's no mutation testing." Build on what's there: where the project already enforces something, recommend Gauntlet matches it rather than picking a new number ("Kover already requires 80%, so I recommend an 80% floor for new code"), and say when Gauntlet would add something the project doesn't do yet.
5. Go through the decisions below **one at a time**. For each one, say what you found (with file paths), what you recommend and why, and what it will mean day to day (for example "changes here will need your review" or "every change must keep this passing"). Then ask me, with your recommendation first and a way to skip. Use the AskUserQuestion tool if you have it. Never ask about several decisions at once.
   - **Owner**: who approves sensitive changes and edits to the policy. Ask for my GitHub username or team (written like @my-username or @my-org/my-team).
   - **Zones**: a zone marks code where a change needs the owner's review, and can switch on stricter rules there. Go through the draft's zones first, then any areas you found that folder names missed. Suggest the language's rules that fit (for example no floating-point money).
   - **Layers**: which parts must never import which (for example the domain never imports the web layer).
   - **Tests and coverage**: how much of the new and changed code must be tested (match what the project already enforces; otherwise 80% recommended, 70%, or only "never less than today"), and a mutation score if a mutation tool is set up.
   - **Missing tools**: if lint, coverage or mutation can't run because a tool isn't set up, say what to add. Don't install anything.
   - **When to block**: stay in shadow mode, which only reports (recommended to start), or block failing changes now.
6. Never make the policy weaker than the draft without saying so plainly ("this removes …, which makes the policy weaker") and getting my yes. Don't restate what Gauntlet already does by default: its integrity checks (new skips, weakened tests, suppressions and so on) are always on.
7. Write the whole policy to \`${PROPOSAL_FILE}\` in the repository root, then check it with Gauntlet's \`validate\` tool, passing \`file: "${PROPOSAL_FILE}"\` (not the text). Fix any problem until it's valid. You can't and mustn't edit \`.gauntlet/\` yourself.
8. Show me a short summary headed "This will be applied:", one plain line per change from the draft, and mark anything that loosens it. Don't paste the whole policy.
9. Tell me to apply it by running \`gauntlet apply\` myself. It shows the changes again, then writes the policy, commits it and records the baseline. Don't run it for me.
`

export const managedSettings = (ir: PolicyIR, runnerConfig: ReadonlyArray<string>) => `${JSON.stringify({
  allowManagedHooksOnly: true,
  hooks: claudeHooks(),
  permissions: { deny: denyRules(ir, runnerConfig) },
}, null, 2)}\n`

export interface ClaudeCodeInputs {
  readonly ir: PolicyIR
  readonly runnerConfig: ReadonlyArray<string>
  readonly existingSettings?: string
  readonly existingMcp?: string
}

const decodeObject = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))

/** Parses an existing JSON object file. None means it exists but isn't a JSON object, so it mustn't be overwritten. */
const parseObject = (text: string | undefined): Option.Option<Record<string, unknown>> =>
  text === undefined || text.trim() === "" ? Option.some({}) : decodeObject(text)

export type ClaudeCodeResult =
  | { readonly _tag: "Files"; readonly files: ReadonlyArray<GeneratedFile> }
  | { readonly _tag: "Unreadable"; readonly path: string }

export const claudeCode = (i: ClaudeCodeInputs): ClaudeCodeResult => {
  const settings = parseObject(i.existingSettings)
  if (Option.isNone(settings)) return { _tag: "Unreadable", path: ".claude/settings.json" }
  const mcp = parseObject(i.existingMcp)
  if (Option.isNone(mcp)) return { _tag: "Unreadable", path: ".mcp.json" }
  return {
    _tag: "Files",
    files: [
      { path: ".claude/settings.json", content: `${JSON.stringify(mergeSettings(settings.value, i.ir, i.runnerConfig), null, 2)}\n`, mode: "replace" },
      { path: ".mcp.json", content: `${JSON.stringify(mergeMcp(mcp.value), null, 2)}\n`, mode: "replace" },
      { path: "CLAUDE.md", content: AGENT_INSTRUCTIONS, mode: "block" },
      { path: "AGENTS.md", content: AGENT_INSTRUCTIONS, mode: "block" },
      { path: ".claude/gauntlet-managed-settings.example.json", content: managedSettings(i.ir, i.runnerConfig), mode: "replace" },
      { path: ".claude/commands/gauntlet-setup.md", content: SETUP_COMMAND, mode: "replace" },
    ],
  }
}
