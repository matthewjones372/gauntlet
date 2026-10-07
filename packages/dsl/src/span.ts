import { Schema } from "effect"

/** A range in a policy file. Lines and columns are 1-based; `endColumn` is exclusive. */
export const Span = Schema.Struct({
  line: Schema.Number,
  column: Schema.Number,
  endLine: Schema.Number,
  endColumn: Schema.Number,
})
export type Span = typeof Span.Type
