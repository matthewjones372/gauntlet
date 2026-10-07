import { Schema } from "effect"

/** Where an IR node came from. Lines and columns are 1-based; `endColumn` is exclusive. */
export const SourceLocation = Schema.Struct({
  line: Schema.Number,
  column: Schema.Number,
  endLine: Schema.Number,
  endColumn: Schema.Number,
  text: Schema.String,
})
export type SourceLocation = typeof SourceLocation.Type

/** IR node locations keyed by JSON pointer into the canonical IR, such as `/zones/0`. */
export const SourceMap = Schema.Struct({
  file: Schema.String,
  nodes: Schema.Record(Schema.String, SourceLocation),
})
export type SourceMap = typeof SourceMap.Type

/** Lets a decision cite the DSL line behind an IR node. */
export const SourceRef = Schema.Struct({
  file: Schema.String,
  line: Schema.Number,
  column: Schema.Number,
  text: Schema.String,
})
export type SourceRef = typeof SourceRef.Type

export const sourceRef = (map: SourceMap, pointer: string): SourceRef | undefined => {
  const at = map.nodes[pointer]
  return at ? { file: map.file, line: at.line, column: at.column, text: at.text } : undefined
}
