import { afterAll } from "bun:test"
import { tmpdir } from "node:os"
import { isolateRun } from "./test-temp-dir.ts"

isolateRun(tmpdir(), afterAll)

// Tests run the same on a laptop and on GitHub Actions: the report links files
// when it sees these, so a test that wants links sets them itself.
delete process.env.GITHUB_SERVER_URL
delete process.env.GITHUB_REPOSITORY
delete process.env.GITHUB_EVENT_PATH
