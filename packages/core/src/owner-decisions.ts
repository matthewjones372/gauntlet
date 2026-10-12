// Approving a change is the owner's decision (spec 0015). The agent often
// works under its owner's GitHub account, so GitHub can't tell them apart:
// Claude Code's hook asks this whether a shell command would make an owner's
// decision, and refuses it to the agent. Best effort, like every local guard;
// `gauntlet approve` refuses an agent's session itself too.

const unquote = (command: string) => command.replace(/'[^']*'/g, "''").replace(/"(?:\\.|[^"\\])*"/g, '""')

/** Text run by `sh -c '...'`, `bash -c "..."` or `eval '...'`: a command too, though it's quoted. */
const nested = (command: string): string[] =>
  [...command.matchAll(/(?:\b(?:sh|bash|zsh)\s+-c|\beval)\s+(?:'([^']*)'|"((?:\\.|[^"\\])*)")/g)].map((m) => m[1] ?? m[2] ?? "")

/** Each simple command's words, quoted text left out. */
const commands = (command: string): string[][] =>
  unquote(command).split(/&&|\|\||;|\||\n/).map((part) => part.trim().split(/\s+/).filter((w) => w !== ""))

const OWNER_SUBCOMMANDS = new Set(["approve", "grant"])

/** The program is Gauntlet: the binary by any path, or its source run with bun. */
const isGauntlet = (word: string) => /(^|\/)gauntlet$/.test(word) || /packages\/cli\/src\/main\.ts$/.test(word)

/** The owner's decision a shell command would make, or undefined. */
export const ownerDecision = (command: string): string | undefined => {
  for (const words of commands(command)) {
    const at = words.findIndex(isGauntlet)
    if (at >= 0 && OWNER_SUBCOMMANDS.has(words[at + 1] ?? "")) return `gauntlet ${words[at + 1]}`
    // Writing or pushing the grants' notes by hand is granting too.
    if (words.includes("git") && words.some((w) => w.includes("gauntlet-grants"))) return "a grant"
    const gh = words.indexOf("gh")
    if (gh >= 0 && words[gh + 1] === "pr" && words[gh + 2] === "review" && words.some((w) => w === "--approve" || w === "-a")) return "an approving review"
  }
  // gh posts what's quoted: a comment's text (Gauntlet reads pull request comments), or a review's event.
  const gh = commands(command).filter((w) => w.includes("gh"))
  const comments = gh.some((w) => (w.includes("comment") && (w.includes("pr") || w.includes("issue"))) || (w.includes("api") && w.some((x) => /\/comments\b/.test(x))))
  if (comments && /\/gauntlet\s+approve\b/i.test(command)) return "an approval comment"
  if (gh.some((w) => w.includes("api")) && /\/reviews\b/.test(command) && /\bevent[=\s]+["']?APPROVE\b/i.test(command)) return "an approving review"
  for (const inner of nested(command)) {
    const found = ownerDecision(inner)
    if (found) return found
  }
  return undefined
}
