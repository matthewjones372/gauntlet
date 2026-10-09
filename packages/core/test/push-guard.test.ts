import { describe, expect, test } from "bun:test"
import { pushTarget } from "../src/index.ts"

// A change reaches the default branch only through a pull request: which
// commands would push to it.

const defaults = ["main", "master"]

describe("pushTarget", () => {
  test("pushing the default branch, by name, by refspec or as the current branch", () => {
    expect(pushTarget("git push origin main", "feature", defaults)).toBe("main")
    expect(pushTarget("git push -u origin HEAD:refs/heads/main", "feature", defaults)).toBe("main")
    expect(pushTarget("git push", "main", defaults)).toBe("main")
    expect(pushTarget("git push --force origin", "master", defaults)).toBe("master")
    expect(pushTarget("git add . && git commit -m x && git push origin +main", "x", defaults)).toBe("main")
    expect(pushTarget("git push --all origin", "feature", defaults)).toBe("main")
    expect(pushTarget("cd repo; git -C . push origin feature:main", "feature", defaults)).toBe("main")
  })

  test("pushing a branch, tags or anything else is fine", () => {
    expect(pushTarget("git push -u origin gauntlet/setup", "gauntlet/setup", defaults)).toBeUndefined()
    expect(pushTarget("git push", "feature", defaults)).toBeUndefined()
    expect(pushTarget("git push origin v1.0.0", "main", defaults)).toBeUndefined()
    expect(pushTarget("echo push main", "main", defaults)).toBeUndefined()
    expect(pushTarget("gh pr create --base main", "feature", defaults)).toBeUndefined()
  })
})
