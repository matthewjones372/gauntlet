import { describe, expect, test } from "bun:test"
import { pushTarget } from "../src/index.ts"

// Quoted text, such as a commit message or a pull request's body, is never a
// command, whatever it says: only the command itself can push.

const defaults = ["main", "master"]

describe("pushTarget and quoted text", () => {
  test("words in a quoted message or body don't count as a push", () => {
    expect(pushTarget(`git commit -m "a git push to main is refused" && git push -u origin guard`, "guard", defaults)).toBeUndefined()
    expect(pushTarget(`gh pr create --body 'never git push origin main'`, "guard", defaults)).toBeUndefined()
    expect(pushTarget(`git commit -m "say \\"git push origin main\\"" && git push -u origin guard`, "guard", defaults)).toBeUndefined()
  })

  test("a real push to the default branch next to quoted text is still caught", () => {
    expect(pushTarget(`git commit -m "tidy" && git push origin main`, "feature", defaults)).toBe("main")
  })
})
