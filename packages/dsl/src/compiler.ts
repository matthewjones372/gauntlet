import { canonicalize, canonicalJson, type PolicyIR, type SourceLocation, type SourceMap, sha256 } from "@gauntlet/ir"
import { Context, Effect, Layer } from "effect"
import { Catalog, type PackSpec } from "./catalog.ts"
import { compile, SPAN, type Spanned } from "./compile.ts"
import { conflicts } from "./conflicts.ts"
import { type Diagnostic, isError, PolicyInvalid } from "./diagnostic.ts"
import { sortDiagnostics } from "./format.ts"
import { parse } from "./parse.ts"
import { resolve } from "./resolve.ts"

export interface PolicySourceText {
  readonly file: string
  readonly text: string
  /** Repository file list, when known. Makes overlap checks exact instead of conservative. */
  readonly files?: ReadonlyArray<string>
}

export interface Compiled {
  readonly ir: PolicyIR
  readonly hash: string
  readonly sourceMap: SourceMap
  /** Warnings and info. Errors make compilation fail instead. */
  readonly diagnostics: ReadonlyArray<Diagnostic>
}

export type CompileResult =
  | { readonly _tag: "Compiled"; readonly compiled: Compiled }
  | { readonly _tag: "Invalid"; readonly diagnostics: ReadonlyArray<Diagnostic> }

/** Pure compilation: parse, check, canonicalise, hash. */
export const compilePolicy = (source: PolicySourceText, packs: ReadonlyArray<PackSpec>): CompileResult => {
  const parsed = parse(source.file, source.text)
  if (parsed._tag === "SyntaxErrors") return { _tag: "Invalid", diagnostics: parsed.diagnostics }

  const diagnostics: Diagnostic[] = []
  const report = (d: Omit<Diagnostic, "file">) => diagnostics.push({ ...d, file: source.file })
  const draft = compile(parsed.ast, report)
  resolve(draft, packs, report)
  conflicts(draft, report, source.files)
  const sorted = sortDiagnostics(diagnostics)
  // With errors present, info notes are noise: show errors and warnings only.
  if (sorted.some(isError)) return { _tag: "Invalid", diagnostics: sorted.filter((d) => d.severity !== "info") }

  const canonical = canonicalize(draft.ir)
  const sourceMap = { file: source.file, nodes: collectSpans(canonical, source.text) }
  const ir = JSON.parse(canonicalJson(canonical)) as PolicyIR
  return { _tag: "Compiled", compiled: { ir, hash: sha256(canonicalJson(ir)), sourceMap, diagnostics: sorted } }
}

const collectSpans = (root: unknown, text: string): Record<string, SourceLocation> => {
  const lines = text.split(/\r?\n/)
  const nodes: Record<string, SourceLocation> = {}
  const walk = (value: unknown, pointer: string) => {
    if (value === null || typeof value !== "object") return
    const span = (value as Spanned)[SPAN]
    if (span) nodes[pointer] = { ...span, text: (lines[span.line - 1] ?? "").trim() }
    if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${pointer}/${i}`))
    else for (const [k, v] of Object.entries(value)) walk(v, `${pointer}/${k.replaceAll("~", "~0").replaceAll("/", "~1")}`)
  }
  walk(root, "")
  return nodes
}

/** Compiles `.gx` policy text against the installed packs. */
export class Compiler extends Context.Service<Compiler, {
  readonly compile: (source: PolicySourceText) => Effect.Effect<Compiled, PolicyInvalid>
}>()("@gauntlet/dsl/Compiler") {}

export const CompilerLive = Layer.effect(
  Compiler,
  Effect.gen(function*() {
    const catalog = yield* Catalog
    return {
      compile: (source: PolicySourceText) =>
        Effect.suspend(() => {
          const result = compilePolicy(source, catalog.packs)
          return result._tag === "Compiled"
            ? Effect.succeed(result.compiled)
            : Effect.fail(new PolicyInvalid({ file: source.file, text: source.text, diagnostics: result.diagnostics }))
        }),
    }
  }),
)
