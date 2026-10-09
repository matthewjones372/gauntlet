import { afterAll } from "bun:test"
import { tmpdir } from "node:os"
import { isolateRun } from "./test-temp-dir.ts"

isolateRun(tmpdir(), afterAll)
