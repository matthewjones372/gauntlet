import { Option, Schema } from "effect"

// Dependencies from package.json, for the `dependency added` condition.

const Manifest = Schema.Struct({
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  peerDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  optionalDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
})

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Manifest))

export const parseDependencies = (_path: string, text: string): string[] =>
  Option.match(decode(text), {
    // An unreadable manifest yields nothing; the diff still shows the file as changed.
    onNone: () => [],
    onSome: (m) =>
      [...new Set([m.dependencies, m.devDependencies, m.peerDependencies, m.optionalDependencies].flatMap((d) => Object.entries(d ?? {}).map(([k, v]) => `${k}@${v}`)))].sort(),
  })
