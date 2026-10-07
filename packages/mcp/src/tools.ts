import {
  type AuthorConfig, authorConfig, authorContext, Citation, describeCitation, draftProposals, label, languageModelLayer,
} from "@gauntlet/author"
import {
  agentSummary, type BaselineStore, BLOCKED_ACK, checkWorkingTree, coverage, explainPolicy, Git, type Overrides, type PackRegistry, PolicySource, type ProcessRunner,
  recordBlocked, renderAgentSummary, renderCoverage, type Reporter, type ShadowLog, templateDraft, type Workspace,
} from "@gauntlet/core"
import { Compiler, DEFAULT_POLICY_FILE, type Diagnostic, formatDiagnostics, POLICY_REFERENCE, PolicyInvalid } from "@gauntlet/dsl"
import { Effect, FileSystem, Layer, Option, Path, Schema, Semaphore } from "effect"
import { type LanguageModel, Tool, Toolkit } from "effect/ai"
import { EXAMPLES } from "./generated/examples.ts"

// Gauntlet's MCP tools for coding agents (PLAN section 14). They read the
// policy and judge the working tree; none changes the policy, the baseline or
// protected files. `report_blocked` only records the agent's reason, which can
// add caution and never removes any.

const readOnly = <T extends Tool.Any>(t: T): T => t.annotate(Tool.Readonly, true).annotate(Tool.Destructive, false).annotate(Tool.OpenWorld, false) as T

const Validate = readOnly(Tool.make("validate", {
  description: "Compile Gauntlet policy text and return its diagnostics. Pass `file` (a path in the repository, such as gauntlet.proposal.gx) or `text`; with neither, the repository's .gauntlet/policy.gx.",
  parameters: Schema.Struct({ text: Schema.optionalKey(Schema.String), file: Schema.optionalKey(Schema.String) }),
  success: Schema.Struct({ valid: Schema.Boolean, irHash: Schema.optionalKey(Schema.String), diagnostics: Schema.String }),
  failure: Schema.String,
  failureMode: "return",
}))

const Check = Tool.make("check", {
  description: "Judge the working tree (uncommitted and new files included) with the repository's Gauntlet policy: build, tests, lint, coverage, mutation and test-integrity checks. Run it before saying a task is done. Slow: it runs the project's tools.",
  success: Schema.Struct({
    summary: Schema.String,
    tier: Schema.String,
    wouldBlock: Schema.Boolean,
    blocking: Schema.Array(Schema.String),
    review: Schema.Array(Schema.String),
    failedChecks: Schema.Array(Schema.Struct({ check: Schema.String, status: Schema.String, reason: Schema.optionalKey(Schema.String) })),
    fixes: Schema.Array(Schema.Struct({ check: Schema.String, fix: Schema.String })),
    report: Schema.String,
    blockedReported: Schema.Boolean,
  }),
  failure: Schema.String,
  failureMode: "return",
}).annotate(Tool.Destructive, false).annotate(Tool.OpenWorld, false)

const Explain = readOnly(Tool.make("explain", {
  description: "Explain what the policy enforces: the whole policy, or one block (mode, protect, zones, gates, integrity, review). With coverage, list what covers each file.",
  parameters: Schema.Struct({ block: Schema.optionalKey(Schema.String), coverage: Schema.optionalKey(Schema.Boolean) }),
  success: Schema.String,
  failure: Schema.String,
  failureMode: "return",
}))

const GetGrammar = readOnly(Tool.make("get_grammar", {
  description: "A compact reference to the Gauntlet policy language.",
  success: Schema.String,
}))

const GetExamples = readOnly(Tool.make("get_examples", {
  description: "Example Gauntlet policies.",
  success: Schema.Struct({ examples: Schema.Array(Schema.Struct({ name: Schema.String, text: Schema.String })) }),
}))

const AuthorDraft = readOnly(Tool.make("author_draft", {
  description: "Ask Gauntlet's authoring agent for proposed policy changes, each citing evidence Gauntlet verified. Proposals only: nothing is written, and a person applies them with `gauntlet author review`. Needs GAUNTLET_AUTHOR_API_KEY in the MCP server's environment.",
  parameters: Schema.Struct({ mode: Schema.Literals(["init", "review"]) }),
  success: Schema.Struct({
    proposals: Schema.Array(Schema.Struct({
      label: Schema.String,
      text: Schema.optionalKey(Schema.String),
      rationale: Schema.String,
      evidence: Schema.String,
      citation: Citation,
      loosens: Schema.Array(Schema.String),
    })),
    dropped: Schema.Array(Schema.Struct({ label: Schema.String, reason: Schema.String })),
    note: Schema.String,
  }),
  failure: Schema.String,
  failureMode: "return",
}))

const ReportBlocked = Tool.make("report_blocked", {
  description: "Use when the task can't be done without changing protected tests, test setup, build configuration or the Gauntlet policy. Records your reason; the change then needs a person's review, and you should stop and explain. This is the right outcome, not a failure.",
  parameters: Schema.Struct({
    reason: Schema.String.annotate({ description: "what needs to change and why, for the person who reviews it" }),
    paths: Schema.optionalKey(Schema.Array(Schema.String).annotate({ description: "the protected paths the task would need to change" })),
  }),
  success: Schema.String,
  failure: Schema.String,
  failureMode: "return",
}).annotate(Tool.Destructive, false).annotate(Tool.OpenWorld, false).annotate(Tool.Idempotent, true)

export const GauntletTools = Toolkit.make(Validate, Check, Explain, GetGrammar, GetExamples, AuthorDraft, ReportBlocked)

export interface ToolOptions {
  readonly repo: string
  readonly gauntletVersion: string
  readonly env: Readonly<Record<string, string | undefined>>
  /** Builds the authoring model; replaced in tests. */
  readonly model?: (c: AuthorConfig) => Layer.Layer<LanguageModel.LanguageModel>
}

/** The core services the tools run on, provided by the CLI's app layer. */
type Services = Git | PolicySource | Compiler | PackRegistry | ShadowLog | Overrides | BaselineStore | Reporter | Workspace | ProcessRunner | FileSystem.FileSystem | Path.Path

const describe = (e: unknown): string => {
  if (e instanceof PolicyInvalid) return formatDiagnostics(e.diagnostics, e.text)
  const t = e as { readonly _tag?: string; readonly message?: string; readonly stderr?: string }
  if (t._tag === "PolicyNotFound") return `No policy found. A person creates it with \`gauntlet init\`.`
  if (t._tag === "GitError") return `git failed: ${t.stderr ?? ""}`
  return t.message ?? String(e)
}

const failWith = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.mapError(describe))

export const toolHandlers = (o: ToolOptions) =>
  GauntletTools.toLayer(Effect.gen(function*() {
    const services = yield* Effect.context<Services>()
    const run = <A, R extends Services>(effect: Effect.Effect<A, string, R>) => effect.pipe(Effect.provide(services))
    // MCP clients may call tools concurrently; checks and blocked reports read and write repository state, one at a time.
    const exclusive = (yield* Semaphore.make(1)).withPermits(1)
    return GauntletTools.of({
      validate: ({ text, file }) =>
        run(failWith(Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          // A file is read only from inside the repository.
          const target = path.resolve(o.repo, file ?? DEFAULT_POLICY_FILE)
          if (path.relative(o.repo, target).startsWith("..") || path.isAbsolute(path.relative(o.repo, target))) return yield* Effect.fail(`${file} is outside the repository.`)
          const source = text ?? (yield* fs.readFileString(target))
          const files = yield* (yield* Git).listWorkingFiles(o.repo).pipe(Effect.option)
          const result = yield* Effect.exit((yield* Compiler).compile({ file: DEFAULT_POLICY_FILE, text: source, ...(Option.isSome(files) ? { files: files.value } : {}) }))
          const diagnostics: ReadonlyArray<Diagnostic> = result._tag === "Success"
            ? result.value.diagnostics
            : result.cause.reasons.flatMap((r) => (r._tag === "Fail" && r.error instanceof PolicyInvalid ? r.error.diagnostics : []))
          return {
            valid: result._tag === "Success",
            ...(result._tag === "Success" ? { irHash: result.value.hash } : {}),
            diagnostics: diagnostics.length > 0 ? formatDiagnostics(diagnostics, source) : "",
          }
        }))),
      check: () =>
        run(exclusive(failWith(Effect.gen(function*() {
          const outDir = `${yield* (yield* Git).gitDir(o.repo)}/gauntlet/mcp`
          const r = yield* checkWorkingTree({ repo: o.repo, outDir, gauntletVersion: o.gauntletVersion, agent: { agent: o.env.GAUNTLET_AGENT ?? (o.env.CLAUDECODE === "1" ? "claude-code" : "mcp") } })
          const s = agentSummary(r.report, outDir)
          return { ...s, summary: renderAgentSummary(s), blockedReported: r.blocked !== undefined }
        })))),
      explain: ({ block, coverage: withCoverage }) =>
        run(failWith(Effect.gen(function*() {
          const loaded = yield* (yield* PolicySource).load({ repo: o.repo })
          if (withCoverage) return renderCoverage(coverage(loaded.compiled.ir, yield* (yield* Git).listWorkingFiles(o.repo)))
          return explainPolicy(loaded.compiled.ir, block)
        }))),
      get_grammar: () => Effect.succeed(POLICY_REFERENCE),
      get_examples: () => Effect.succeed({ examples: EXAMPLES }),
      author_draft: ({ mode }) =>
        run(failWith(Effect.gen(function*() {
          // The key comes from the server's environment only, never from a request (ADR 0009).
          const config = authorConfig(o.env)
          if (config._tag === "Missing") return yield* Effect.fail(`The authoring agent isn't configured: ${config.reason}`)
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const current = yield* fs.readFileString(path.join(o.repo, DEFAULT_POLICY_FILE)).pipe(Effect.option)
          const base = mode === "review"
            ? (Option.isSome(current) ? { text: current.value, packs: undefined } : yield* Effect.fail("There's no policy to review yet."))
            : yield* templateDraft(o.repo, path.basename(o.repo), []).pipe(Effect.flatMap((d) => d._tag === "Refused" ? Effect.fail(d.reason) : Effect.succeed({ text: d.text, packs: d.packs })))
          const packs = base.packs ?? (yield* (yield* Compiler).compile({ file: DEFAULT_POLICY_FILE, text: base.text })).ir.packs
          const ctx = yield* authorContext(o.repo, packs)
          const r = yield* draftProposals({ mode, text: base.text, ctx }).pipe(Effect.provide((o.model ?? languageModelLayer)(config.config)))
          return {
            proposals: r.proposals.map((p) => ({
              label: label(p.proposal),
              ...(p.proposal.text ? { text: p.proposal.text } : {}),
              rationale: p.proposal.rationale,
              evidence: describeCitation(p.proposal.citation),
              citation: p.proposal.citation,
              loosens: p.loosenings.map((l) => l.what),
            })),
            dropped: r.dropped.map((d) => ({ label: label(d.proposal), reason: d.reason })),
            note: "Proposals only. Show them to the person; they apply them with `gauntlet author review` from their own shell. Don't edit .gauntlet/ yourself.",
          }
        }))),
      report_blocked: ({ reason, paths }) =>
        run(failWith(Effect.gen(function*() {
          if (reason.trim().length < 10) return yield* Effect.fail("Give a reason a person can act on: what needs to change and why.")
          const record = yield* exclusive(recordBlocked(o.repo, { reason: reason.trim(), paths: paths ?? [], at: new Date().toISOString() }))
          return BLOCKED_ACK(record.reason)
        }))),
    })
  }))
