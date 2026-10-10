// Languages and build tools Gauntlet has no pack for. Setup says so plainly,
// so nobody assumes those parts are checked, and says how to get support:
// ask for it, or add a pack.

const UNSUPPORTED: ReadonlyArray<{ readonly name: string; readonly file: RegExp }> = [
  { name: "Maven", file: /(^|\/)pom\.xml$/ },
  { name: "Mill", file: /(^|\/)build\.(mill|sc)$/ },
  { name: "Scala CLI", file: /(^|\/)project\.scala$/ },
  { name: "Bazel", file: /(^|\/)(WORKSPACE|WORKSPACE\.bazel|MODULE\.bazel|BUILD\.bazel)$/ },
  { name: ".NET", file: /\.(csproj|fsproj|vbproj|sln)$/ },
  { name: "Ruby", file: /(^|\/)Gemfile$/ },
  { name: "PHP", file: /(^|\/)composer\.json$/ },
  { name: "Swift", file: /(^|\/)Package\.swift$/ },
  { name: "Elixir", file: /(^|\/)mix\.exs$/ },
  { name: "Dart", file: /(^|\/)pubspec\.yaml$/ },
  { name: "Haskell", file: /(^|\/)(stack\.yaml|[^/]+\.cabal)$/ },
  { name: "CMake", file: /(^|\/)CMakeLists\.txt$/ },
  { name: "Zig", file: /(^|\/)build\.zig$/ },
  { name: "OCaml", file: /(^|\/)dune-project$/ },
]

export const REQUEST_SUPPORT_URL = "https://github.com/matthewjones372/gauntlet/issues/new"
export const ADD_A_PACK_URL = "https://github.com/matthewjones372/gauntlet/blob/main/docs/development.md#adding-a-language-pack"

/** The unsupported languages and build tools a repository's files show, in a fixed order. */
export const unsupportedBuilds = (files: ReadonlyArray<string>): string[] =>
  UNSUPPORTED.filter((u) => files.some((f) => !f.includes("node_modules/") && u.file.test(f))).map((u) => u.name)

const listed = (names: ReadonlyArray<string>) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`)

/** What setup says about them: not checked, and how to get support. */
export const unsupportedNote = (names: ReadonlyArray<string>): string =>
  `Gauntlet doesn't support ${listed(names)} yet, so ${names.length === 1 ? "that part isn't" : "those parts aren't"} checked. Ask for it: ${REQUEST_SUPPORT_URL}?title=${encodeURIComponent(`Support ${listed(names)}`)}. Or add it yourself: ${ADD_A_PACK_URL}`
