// Why a tool failed, in its own words (a build that "exited with 1" says
// nothing): the last few meaningful lines it printed, short enough for a
// report cell, with anything that looks like a secret masked.

/** At most this many lines, each at most this long, go into a reason. */
export const SAID_LINES = 5
const LINE_LENGTH = 200

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g")
// Stack frames say where, not why; the exception's own line above them says why.
const NOISE = /^\s*(at [\w$.<>/]+\(.*\)|\.\.\. \d+ more|Caused by: \.\.\.)\s*$/

const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?|AUTH)/i
const MASK = "***"
const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,})\b/g, MASK],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, MASK],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${MASK}`],
  [/(\w+:\/\/)[^\s/:@]+:[^\s/@]+@/g, `$1${MASK}@`],
  // A secret-named key's value (GITHUB_TOKEN=..., password: ...); the word ends the key, so TokenService.scala:12 is kept.
  [/\b([\w-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|credentials?))\b(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, `$1$2${MASK}`],
]

/**
 * Masks secrets in a line: the values of environment variables whose names
 * say they're secret (the tool inherits Gauntlet's), and well-known token shapes.
 */
export const redact = (text: string, env: Readonly<Record<string, string | undefined>> = process.env): string => {
  let out = text
  const values = Object.entries(env)
    .filter(([name, value]) => SECRET_NAME.test(name) && value !== undefined && value.length >= 6)
    .map(([, value]) => value!)
    .sort((a, b) => b.length - a.length)
  for (const v of values) out = out.split(v).join(MASK)
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement)
  return out
}

const meaningful = (output: string) => output.replace(ANSI, "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "" && !NOISE.test(l))
const shortened = (lines: ReadonlyArray<string>, env?: Readonly<Record<string, string | undefined>>) =>
  lines.slice(-SAID_LINES).map((l) => redact(l.length > LINE_LENGTH ? `${l.slice(0, LINE_LENGTH - 1)}…` : l, env))

type Pick = (lines: ReadonlyArray<string>) => ReadonlyArray<string>

/**
 * The last meaningful lines a tool printed, for a reason: `pick` narrows them
 * to the tool's own error lines where it marks them (sbt's `[error]`), and
 * when it finds none, the plain tail is kept. Blank lines and stack frames are
 * dropped; each line is shortened and redacted.
 */
export const toolSaid = (output: string, options: { readonly pick?: Pick; readonly env?: Readonly<Record<string, string | undefined>> } = {}): string[] => {
  const lines = meaningful(output)
  const picked = options.pick ? options.pick(lines).map((l) => l.trim()).filter((l) => l !== "") : []
  return shortened(picked.length > 0 ? picked : lines, options.env)
}

/**
 * Why a failing tool failed, as a GateRun's \`output\`: its marked error lines
 * from either stream (sbt prints them to stdout), else the tail of stderr, or
 * of stdout when stderr is empty (tsc, mypy). Nothing for a run that passed or
 * couldn't start.
 */
export const failingToolSaid = (
  run: { readonly exitCode: number; readonly stdout?: string; readonly stderr: string; readonly error?: string },
  pick?: Pick,
): { readonly output?: ReadonlyArray<string> } => {
  if (run.exitCode === 0 || run.error !== undefined) return {}
  const marked = pick ? pick(meaningful(`${run.stdout ?? ""}\n${run.stderr}`)).map((l) => l.trim()).filter((l) => l !== "") : []
  const said = marked.length > 0 ? shortened(marked) : toolSaid(run.stderr.trim() !== "" ? run.stderr : run.stdout ?? "")
  return said.length > 0 ? { output: said } : {}
}
