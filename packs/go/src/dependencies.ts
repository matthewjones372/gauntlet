// Dependencies from go.mod, for the `dependency added` condition: one
// `module@version` per requirement, in single-line and block form.

export const parseDependencies = (_path: string, text: string): string[] => {
  const out: string[] = []
  let inBlock = false
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.replace(/\/\/.*$/, "").trim()
    if (/^require\s*\($/.test(l)) {
      inBlock = true
      continue
    }
    if (inBlock && l === ")") {
      inBlock = false
      continue
    }
    const m = inBlock ? /^(\S+)\s+(\S+)/.exec(l) : /^require\s+(\S+)\s+(\S+)/.exec(l)
    if (m) out.push(`${m[1]}@${m[2]}`)
  }
  return [...new Set(out)].sort()
}
