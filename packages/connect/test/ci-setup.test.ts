import { describe, expect, test } from "bun:test"
import { buildCommand, draftCiConfig, github } from "../src/index.ts"
import { compiled } from "../../core/test/fixtures.ts"

// Gauntlet's GitHub check builds a project as its own CI does: the setup and
// build commands come from the project's workflows.

const WORKFLOW = `name: build
on: pull_request
jobs:
  api:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: cachix/install-nix-action@v31
      - uses: actions/checkout@v5
        with: { repository: acme/lib, path: deps/lib }
      - name: The model's tests
        run: nix flake check
      - name: Build and test
        working-directory: api
        run: nix develop -c ./gradlew -PlibSource=../deps/lib build --stacktrace
      - name: Test reports
        if: failure()
        uses: actions/upload-artifact@v4
        with: { name: reports, path: api/build }
  checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: cachix/install-nix-action@v31
      - name: Build and test
        working-directory: checks
        run: nix develop -c sbt -batch test
`

describe("drafting .gauntlet/ci.yml from the project's workflows", () => {
  test("setup is what comes before each build step, without the repository's checkout, tests or reports", () => {
    const c = draftCiConfig([{ path: ".github/workflows/build.yml", text: WORKFLOW }], ["api", "checks"])!
    expect(c.setup).toEqual([
      { uses: "cachix/install-nix-action@v31" },
      { uses: "actions/checkout@v5", with: { repository: "acme/lib", path: "deps/lib" } },
    ])
    expect(c.builds).toEqual({
      api: { wrap: "nix develop -c", tool: "./gradlew -PlibSource=$GITHUB_WORKSPACE/deps/lib" },
      checks: { wrap: "nix develop -c" },
    })
  })

  test("no job building a build: nothing to draft", () => {
    expect(draftCiConfig([{ path: "x.yml", text: WORKFLOW }], ["elsewhere"])).toBeUndefined()
    expect(buildCommand("echo hello", ".")).toBeUndefined()
  })

  test("the evidence job runs the setup, only when the change needs building, then checks with --ci", () => {
    const ir = compiled(`gauntlet "x"\nuse jvm\nowners @p\ngates { fast { build } }\n`).ir
    const workflow = github({ mode: "repo", ir, files: [], gauntletVersion: "0", downloadUrl: "https://example.invalid/g", ciSetup: [{ uses: "cachix/install-nix-action@v31" }] })[0]!.content
    const steps = (Bun.YAML.parse(workflow) as { jobs: { evidence: { steps: { id?: string; uses?: string; if?: string; run?: string }[] } } }).jobs.evidence.steps
    expect(steps.find((s) => s.uses === "cachix/install-nix-action@v31")?.if).toBe("${{ steps.needs.outputs.build != 'false' }}")
    expect(steps.find((s) => s.id === "needs")?.run).toContain("needs-build")
    expect(steps.find((s) => s.run?.includes("check --policy-ref"))?.run).toContain(" --ci ")
  })
})
