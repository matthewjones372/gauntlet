// Path patterns in policies: validity and overlap.
//
// Semantics follow the usual glob rules: `*` and `?` stay within one path
// segment, `**` spans any number of segments, `{a,b}` is alternation and
// `[...]` a character class. Patterns are relative to the repository root.

export interface GlobProblem {
  readonly message: string
  readonly fix: string
}

export const checkGlob = (glob: string): GlobProblem | undefined => {
  if (glob.trim() === "") return { message: "the pattern is empty.", fix: "Write a pattern such as \"src/test/**\"." }
  if (glob.startsWith("/")) {
    return { message: "patterns are relative to the repository root.", fix: `Remove the leading '/': "${glob.replace(/^\/+/, "")}"` }
  }
  if (glob.includes("\\")) return { message: "use '/' to separate path segments.", fix: `Write "${glob.replaceAll("\\", "/")}".` }
  if (glob.split("/").includes("..")) return { message: "'..' would leave the repository.", fix: "Write a path inside the repository." }
  if (/\*\*\*/.test(glob)) return { message: "'***' is not a valid wildcard.", fix: "Use '**' for any number of directories or '*' within one." }
  for (const segment of glob.split("/")) {
    if (segment.includes("**") && segment !== "**") {
      return { message: `'**' must be a whole path segment, but found '${segment}'.`, fix: `Write '**/${segment.replace("**", "*")}' or '${segment.replace("**", "*")}'.` }
    }
  }
  const balance = (open: string, close: string) => {
    let depth = 0
    for (const ch of glob) {
      if (ch === open) depth++
      if (ch === close && --depth < 0) return false
    }
    return depth === 0
  }
  if (!balance("{", "}")) return { message: "the '{' and '}' don't match.", fix: "Close every '{' with '}', for example \"src/{main,test}/**\"." }
  if (!balance("[", "]")) return { message: "the '[' and ']' don't match.", fix: "Close every '[' with ']'." }
  return undefined
}

const isLiteral = (segment: string) => !/[*?[\]{}]/.test(segment)

const segmentRegex = (segment: string): RegExp => {
  let out = ""
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!
    if (ch === "*") out += "[^/]*"
    else if (ch === "?") out += "[^/]"
    else if (ch === "{") out += "(?:"
    else if (ch === "}") out += ")"
    else if (ch === "," && segment.slice(0, i).lastIndexOf("{") > segment.slice(0, i).lastIndexOf("}")) out += "|"
    else if (ch === "[") {
      const end = segment.indexOf("]", i)
      out += segment.slice(i, end + 1)
      i = end
    } else out += ch.replace(/[.+^$()|\\]/g, "\\$&")
  }
  return new RegExp(`^${out}$`)
}

const segmentsMayMatch = (a: string, b: string, bIsPath: boolean): boolean => {
  if (bIsPath) return isLiteral(a) ? a === b : segmentRegex(a).test(b)
  if (isLiteral(a) && isLiteral(b)) return a === b
  if (isLiteral(a)) return segmentRegex(b).test(a)
  if (isLiteral(b)) return segmentRegex(a).test(b)
  return true
}

/**
 * Whether some path could match both patterns. Conservative: it may answer
 * true for two wildcard segments that can't actually meet, never false for
 * patterns that do overlap.
 */
export const globsMayOverlap = (a: string, b: string): boolean => overlap(a, b, false)

/** Whether a concrete repository path matches a pattern. */
export const globMatches = (glob: string, path: string): boolean => overlap(glob, path, true)

const overlap = (a: string, b: string, bIsPath: boolean): boolean => {
  const as = a.split("/")
  const bs = b.split("/")
  const memo = new Map<string, boolean>()
  const go = (i: number, j: number): boolean => {
    const key = `${i},${j}`
    const hit = memo.get(key)
    if (hit !== undefined) return hit
    let result: boolean
    if (i === as.length && j === bs.length) result = true
    else if (i < as.length && as[i] === "**") result = go(i + 1, j) || (j < bs.length && go(i, j + 1))
    else if (!bIsPath && j < bs.length && bs[j] === "**") result = go(i, j + 1) || (i < as.length && go(i + 1, j))
    else if (i === as.length || j === bs.length) result = false
    else result = segmentsMayMatch(as[i]!, bs[j]!, bIsPath) && go(i + 1, j + 1)
    memo.set(key, result)
    return result
  }
  return go(0, 0)
}

