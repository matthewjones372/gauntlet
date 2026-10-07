// Builds the gauntlet binary for each release target, with a checksums.txt in
// `sha256sum -c` format (the format `gauntlet connect github` verifies
// against). Usage: bun scripts/build.ts [target ...]
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export const TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64"] as const
export type Target = (typeof TARGETS)[number]

const root = join(import.meta.dir, "..")

/** The target this machine runs natively, if it's a release target. */
export const hostTarget = (): Target | undefined =>
  TARGETS.find((t) => t === `${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`)

/** Compiles each target into `dist` and writes checksums.txt; returns its lines. */
export const build = (targets: ReadonlyArray<Target>, dist: string): string[] => {
  mkdirSync(dist, { recursive: true })
  const sums = targets.map((target) => {
    const name = `gauntlet-${target}`
    const r = Bun.spawnSync(["bun", "build", "--compile", "--minify-syntax", `--target=bun-${target}`, "packages/cli/src/main.ts", "--outfile", join(dist, name)], { cwd: root, stderr: "pipe", stdout: "pipe" })
    if (r.exitCode !== 0) throw new Error(`building ${name} failed:\n${r.stderr.toString()}`)
    return `${createHash("sha256").update(readFileSync(join(dist, name))).digest("hex")}  ${name}`
  })
  writeFileSync(join(dist, "checksums.txt"), `${sums.join("\n")}\n`)
  return sums
}

if (import.meta.main) {
  const wanted = process.argv.slice(2)
  const targets = wanted.length > 0 ? TARGETS.filter((t) => wanted.includes(t)) : TARGETS
  if (targets.length === 0) throw new Error(`unknown target; choose from ${TARGETS.join(", ")}`)
  console.log(build(targets, join(root, "dist")).join("\n"))
}
