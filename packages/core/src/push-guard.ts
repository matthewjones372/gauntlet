// The point of Gauntlet is that a change reaches the default branch only
// through a pull request, where the checks run. Claude Code's Bash hook asks
// this whether a command pushes to that branch; if it does, it's refused.

const strip = (ref: string) => ref.replace(/^\+/, "").replace(/^refs\/heads\//, "")

/**
 * The default branch a shell command would push to, or undefined. Looks at
 * every `git push` in the command: a refspec's destination, or with none the
 * current branch; `--all` and `--mirror` push every branch.
 */
export const pushTarget = (command: string, current: string, defaults: ReadonlyArray<string>): string | undefined => {
  for (const part of command.split(/&&|\|\||;|\||\n/)) {
    const words = part.trim().split(/\s+/)
    const at = words.findIndex((w, i) => w === "push" && words.slice(0, i).includes("git"))
    if (at < 0) continue
    const args = words.slice(at + 1)
    if (args.some((a) => a === "--all" || a === "--mirror")) {
      const hit = defaults.find(Boolean)
      if (hit) return hit
    }
    const positional = args.filter((a) => !a.startsWith("-"))
    const refspecs = positional.slice(1)
    const targets = refspecs.length === 0
      ? [current]
      : refspecs.map((r) => {
        const dest = r.includes(":") ? r.slice(r.indexOf(":") + 1) : r
        return strip(dest === "HEAD" || dest === "" ? current : dest)
      })
    const hit = targets.find((t) => defaults.includes(t))
    if (hit) return hit
  }
  return undefined
}
