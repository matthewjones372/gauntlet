// Renders the README diagrams (docs/diagrams/*.mmd) to light and dark SVGs.
// GitHub's mobile app doesn't draw Mermaid, so the README embeds these.
// Mermaid sizes an SVG to its container (width="100%"); as an <img> that
// scales it up to the page width, so each one gets its real size instead.
//
//   bun scripts/diagrams.ts

import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const DIR = join(import.meta.dir, "..", "docs", "diagrams")

for (const source of readdirSync(DIR).filter((f) => f.endsWith(".mmd")).sort()) {
  const name = source.slice(0, -".mmd".length)
  for (const [theme, suffix] of [["default", "light"], ["dark", "dark"]] as const) {
    const out = join(DIR, `${name}.${suffix}.svg`)
    const r = Bun.spawnSync(["bunx", "@mermaid-js/mermaid-cli@11", "-i", source, "-o", out, "-b", "transparent", "-t", theme, "-c", "mermaid.json"], { cwd: DIR, stdout: "inherit", stderr: "inherit" })
    if (r.exitCode !== 0) throw new Error(`mermaid-cli failed for ${source} (${theme})`)
    const svg = readFileSync(out, "utf8")
    const box = /viewBox="[\d.]+ [\d.]+ ([\d.]+) ([\d.]+)"/.exec(svg)
    if (!box) throw new Error(`${out} has no viewBox`)
    const [w, h] = [Math.ceil(Number(box[1])), Math.ceil(Number(box[2]))]
    writeFileSync(out, svg.replace(/width="100%"/, `width="${w}" height="${h}"`).replace(/max-width: [\d.]+px; ?/, ""))
    console.log(`${name}.${suffix}.svg: ${w}x${h}`)
  }
}
