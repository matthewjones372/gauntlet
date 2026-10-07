import { coverage } from "@gauntlet/core"
import { formatDiagnostics } from "@gauntlet/dsl"
import type { PolicyIR } from "@gauntlet/ir"
import { Effect, Option, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import type { AuthorContext } from "./context.ts"
import { looseningsBetween } from "./loosening.ts"
import { compileText } from "./validate.ts"

// The authoring agent's tools. All of them read; none writes, runs the
// project's code or reaches the network (ADR 0009).

const MAX_FILE = 64 * 1024
const MAX_HITS = 200

const ListFiles = Tool.make("list_files", {
  description: "List repository files, optionally under a directory prefix.",
  parameters: Schema.Struct({ prefix: Schema.optionalKey(Schema.String) }),
  success: Schema.Array(Schema.String),
})

const ReadFile = Tool.make("read_file", {
  description: "Read a repository file (truncated at 64 KB).",
  parameters: Schema.Struct({ path: Schema.String }),
  success: Schema.String,
})

const Search = Tool.make("search", {
  description: "Find lines matching a regular expression, for example code that handles money, credentials or personal data. Returns path, line number and text.",
  parameters: Schema.Struct({ pattern: Schema.String, pathPrefix: Schema.optionalKey(Schema.String) }),
  success: Schema.Array(Schema.Struct({ path: Schema.String, line: Schema.Number, text: Schema.String })),
})

const CoverageTool = Tool.make("coverage", {
  description: "What the current policy covers: files no zone, protect group or suite covers, and how many files each zone and protect group covers.",
  success: Schema.Struct({
    uncovered: Schema.Array(Schema.String),
    zones: Schema.Record(Schema.String, Schema.Number),
    protect: Schema.Record(Schema.String, Schema.Number),
  }),
})

const Catalog = Tool.make("catalog", {
  description: "The installed packs: their gates, rules and integrity checks.",
  success: Schema.String,
})

const ShadowHistory = Tool.make("shadow_history", {
  description: "What the policy would have done during the shadow period: runs, tiers and the most frequent blocking reasons.",
  success: Schema.String,
})

const SelftestPlan = Tool.make("selftest_plan", {
  description: "A dry run of gauntlet selftest under the current policy: which built-in tamper fixtures apply, and which can't be applied (gaps).",
  success: Schema.String,
})

const ValidatePolicy = Tool.make("validate_policy", {
  description: "Compile complete policy text. Returns diagnostics, or the changes that would loosen the current policy.",
  parameters: Schema.Struct({ text: Schema.String }),
  success: Schema.String,
})

const GitLog = Tool.make("git_log", {
  description: "Recent commit subjects, newest first.",
  success: Schema.String,
})

export const AuthorToolkit = Toolkit.make(ListFiles, ReadFile, Search, CoverageTool, Catalog, ShadowHistory, SelftestPlan, ValidatePolicy, GitLog)

const count = (names: ReadonlyArray<string>) => names.reduce<Record<string, number>>((m, n) => ({ ...m, [n]: (m[n] ?? 0) + 1 }), {})

export const catalogText = (ctx: AuthorContext) =>
  ctx.packs.map((p) => [
    `pack ${p.name}: ${p.description}`,
    `  gates: ${p.gates.map((g) => `${g.name} (${g.description}; ${g.produces}${g.scopable ? ", can be scoped `on changed`" : ""}${g.zoneScopable ? ", can be scoped `in zone`" : ""})`).join("; ")}`,
    `  rules: ${p.rules.length > 0 ? p.rules.map((r) => `${r.name} (${r.description})`).join("; ") : "none"}`,
    `  integrity: ${p.integrity.join(", ")}`,
  ].join("\n")).join("\n")

export const authorHandlers = (ctx: AuthorContext, current: () => PolicyIR) =>
  AuthorToolkit.toLayer({
    list_files: ({ prefix }) => Effect.succeed(ctx.files.filter((f) => prefix === undefined || f.startsWith(prefix)).slice(0, 2000)),
    read_file: ({ path }) =>
      ctx.files.includes(path)
        ? ctx.read(path).pipe(Effect.map((t) => Option.match(t, { onNone: () => `${path} can't be read`, onSome: (s) => s.slice(0, MAX_FILE) })))
        : Effect.succeed(`${path} isn't in the repository`),
    search: ({ pattern, pathPrefix }) =>
      Effect.gen(function*() {
        const re = Option.getOrUndefined(Option.liftThrowable(() => new RegExp(pattern))())
        if (!re) return []
        const hits: { path: string; line: number; text: string }[] = []
        for (const path of ctx.files) {
          if (hits.length >= MAX_HITS) break
          if (pathPrefix !== undefined && !path.startsWith(pathPrefix)) continue
          const text = Option.getOrUndefined(yield* ctx.read(path))
          if (text === undefined || text.length > 4 * MAX_FILE || text.includes("\u0000")) continue
          text.split(/\r?\n/).forEach((l, i) => {
            if (hits.length < MAX_HITS && re.test(l)) hits.push({ path, line: i + 1, text: l.trim().slice(0, 200) })
          })
        }
        return hits
      }),
    coverage: () =>
      Effect.sync(() => {
        const c = coverage(current(), ctx.files)
        return {
          uncovered: c.uncovered.slice(0, 500),
          zones: count(c.files.flatMap((f) => f.zones)),
          protect: count(c.files.flatMap((f) => f.protect)),
        }
      }),
    catalog: () => Effect.succeed(catalogText(ctx)),
    shadow_history: () =>
      Effect.succeed(ctx.shadow.runs === 0
        ? "No shadow history yet."
        : [
          `${ctx.shadow.runs} checks, ${ctx.shadow.wouldBlock} would have blocked. Tiers: ${Object.entries(ctx.shadow.tiers).map(([t, n]) => `${t} ${n}`).join(", ")}.`,
          "Most frequent blocking reasons (cite one exactly as written):",
          ...ctx.shadow.topReasons.map((r) => `- ${r.reason} (${r.count})`),
        ].join("\n")),
    selftest_plan: () =>
      ctx.selftestPlan(current()).pipe(Effect.map((p) => [
        "Fixtures that apply:",
        ...p.fixtures.map((f) => `- ${f.fixture}: ${f.description}`),
        `Not applicable (gaps): ${p.notApplicable.length > 0 ? p.notApplicable.join(", ") : "none"}`,
      ].join("\n"))),
    validate_policy: ({ text }) =>
      Effect.sync(() => {
        const r = compileText(text, ctx)
        if (r._tag === "Invalid") return formatDiagnostics(r.diagnostics, text)
        const loose = looseningsBetween(current(), r.compiled.ir)
        return loose.length === 0 ? "Valid, and it loosens nothing." : `Valid, but it loosens the policy:\n${loose.map((l) => `- ${l.what}`).join("\n")}`
      }),
    git_log: () => Effect.succeed(ctx.gitLog),
  })
