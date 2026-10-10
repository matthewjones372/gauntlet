import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { renderMarkdown, type Report } from "../src/index.ts"

// The box an owner ticks sits right under the summary, where they're already
// reading, with their names; the other ways to approve come further down.
// A change that needs nobody's approval has no box.

const golden = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, "golden", `${name}.report.json`), "utf8")) as Report

describe("the approve box", () => {
  test("comes straight after the summary, naming the owners, once", () => {
    const md = renderMarkdown(golden("owner-policy-edit"))
    const box = md.indexOf("- [ ] **Approve this change**")
    expect(box).toBeGreaterThan(md.indexOf("> 3. "))
    expect(box).toBeLessThan(md.indexOf("**Tier owner.**"))
    expect(md).toContain("@payments or @platform: tick the box to approve this commit")
    expect(md.split("- [ ] **Approve this change**").length).toBe(2)
    expect(md).toContain("Tick **Approve this change** above, or approve the pull request")
  })

  test("a change that can merge on its own has none", () => {
    expect(renderMarkdown(golden("clean-auto"))).not.toContain("Approve this change")
  })
})
