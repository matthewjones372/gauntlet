// Dependencies from pyproject.toml (PEP 621, dependency groups, optional
// dependencies, Poetry) and requirements files, for `dependency added`.

const PEP508 = /^\s*["']([A-Za-z0-9][A-Za-z0-9._-]*(?:\[[^\]]*\])?\s*[^"']*)["']\s*,?\s*$/

export const parseDependencies = (path: string, text: string): string[] => {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+#.*$/, ""))
  if (/requirements[^/]*\.txt$/.test(path)) {
    return [...new Set(lines.map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#") && !l.startsWith("-")))].sort()
  }
  const out: string[] = []
  let section = ""
  let inArray = false
  for (const l of lines) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(l)
    if (header) {
      section = header[1]!.trim()
      inArray = false
      continue
    }
    const dependencySection = section === "project" || section === "dependency-groups" || section === "project.optional-dependencies"
    if (dependencySection) {
      const start = /^\s*([\w-]+)\s*=\s*\[(.*)$/.exec(l)
      if (start && (section !== "project" || start[1] === "dependencies")) {
        inArray = !start[2]!.includes("]")
        out.push(...[...start[2]!.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]!))
        continue
      }
      if (inArray) {
        if (l.includes("]")) inArray = false
        const m = PEP508.exec(l.replace("]", ""))
        if (m) out.push(m[1]!.trim())
        continue
      }
    }
    if (/^tool\.poetry(\.group\.[\w-]+)?\.(dev-)?dependencies$/.test(section)) {
      const m = /^\s*([A-Za-z0-9._-]+)\s*=\s*(.+)$/.exec(l)
      if (m && m[1] !== "python") out.push(`${m[1]} ${m[2]!.trim()}`)
    }
  }
  return [...new Set(out.map((d) => d.replace(/\s+/g, " ")))].sort()
}
