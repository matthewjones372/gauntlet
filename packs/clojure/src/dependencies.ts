// Dependencies from deps.edn and project.clj, for the `dependency added`
// condition: `group/artifact {:mvn/version "1.2.3"}` (or :git/tag, :local/root)
// and Leiningen's `[group/artifact "1.2.3"]`.

const DEPS_EDN = /([\w.\-]+\/[\w.\-]+|[\w.\-]+)\s+\{\s*:(mvn\/version|git\/tag|git\/sha|local\/root)\s+"([^"]+)"/g
const LEIN = /\[\s*([\w.\-]+(?:\/[\w.\-]+)?)\s+"([^"]+)"/g

const withoutComments = (text: string) => text.split("\n").map((l) => l.replace(/;.*$/, "")).join("\n")

export const parseDependencies = (path: string, text: string): string[] => {
  const clean = withoutComments(text)
  const found = path.endsWith("project.clj")
    ? [...clean.matchAll(LEIN)].filter((m) => !/^\d/.test(m[1]!)).map((m) => `${m[1]}@${m[2]}`)
    : [...clean.matchAll(DEPS_EDN)].map((m) => `${m[1]}@${m[3]}`)
  return [...new Set(found)].sort()
}
