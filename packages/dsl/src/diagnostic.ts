import { Data, Schema } from "effect"
import { Span } from "./span.ts"

export const Severity = Schema.Literals(["error", "warning", "info"])
export type Severity = typeof Severity.Type

/**
 * One validator finding. Agents write policy from these, so every diagnostic
 * says where, what was expected, and how to fix it.
 */
export const Diagnostic = Schema.Struct({
  severity: Severity,
  code: Schema.String,
  file: Schema.String,
  span: Span,
  message: Schema.String,
  expected: Schema.String,
  fix: Schema.String,
  available: Schema.optionalKey(Schema.Array(Schema.String)),
})
export type Diagnostic = typeof Diagnostic.Type

export class PolicyInvalid extends Data.TaggedError("PolicyInvalid")<{
  readonly file: string
  /** The policy text, so diagnostics can be shown with source excerpts. */
  readonly text: string
  readonly diagnostics: ReadonlyArray<Diagnostic>
}> {}

export const isError = (d: Diagnostic) => d.severity === "error"
