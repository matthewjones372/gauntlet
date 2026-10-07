// Dependencies from Cargo.toml, for the `dependency added` condition: one
// `name@requirement` per entry in [dependencies], [dev-dependencies],
// [build-dependencies] and their target-specific forms.

const SECTION = /^\[(?:target\.[^\]]+\.)?(dependencies|dev-dependencies|build-dependencies)\]$/
const TABLE = /^\[(?:target\.[^\]]+\.)?(?:dependencies|dev-dependencies|build-dependencies)\.([\w-]+)\]$/

export const parseDependencies = (_path: string, text: string): string[] => {
  const out: string[] = []
  let inSection = false
  let table: string | undefined
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.replace(/#.*$/, "").trim()
    if (l.startsWith("[")) {
      inSection = SECTION.test(l)
      table = TABLE.exec(l)?.[1]
      continue
    }
    if (table) {
      const v = /^version\s*=\s*"([^"]+)"/.exec(l)
      if (v) out.push(`${table}@${v[1]}`)
      continue
    }
    if (!inSection) continue
    const m = /^([\w-]+)\s*=\s*(?:"([^"]+)"|\{.*?version\s*=\s*"([^"]+)".*\}|\{.*\})/.exec(l)
    if (m) out.push(`${m[1]}@${m[2] ?? m[3] ?? "*"}`)
  }
  return [...new Set(out)].sort()
}
