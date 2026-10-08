# Supported languages

Back to the [README](../README.md).

| Language | Build tool | Tests | Lint | Coverage | Mutation |
| --- | --- | --- | --- | --- | --- |
| Kotlin, Java | Gradle | JUnit | detekt | Kover (Gauntlet brings its agent if needed); JaCoCo for Java | PIT |
| TypeScript, JavaScript | Bun, npm, pnpm, yarn | Bun test, Vitest, Jest | ESLint or Biome | the test runner's own | Stryker |
| Python | uv, Poetry, pip | pytest | Ruff (and mypy if configured) | coverage.py | mutmut |
| Go | go | go test | golangci-lint | go cover | gremlins |
| Rust | Cargo | cargo-nextest | clippy | cargo-llvm-cov | cargo-mutants |
| Scala | sbt | ScalaTest, munit, ZIO Test, weaver | scalafix | scoverage | Stryker4s |
| Clojure | Clojure CLI, Leiningen | clojure.test (run by kaocha) | clj-kondo | cloverage | none yet (reported as not executed) |

Each language pack brings its own zone rules, integrity detectors and tamper
fixtures. .NET, Ruby, PHP, Maven and frontend packs are planned.

On Gradle, the gates of one check share one warm daemon that only that check
can use, and it's shut down when the check ends
([ADR 0020](adr/0020-one-build-tool-per-check.md)). Nothing carries over
from one check to the next.

With uv, Gauntlet installs every dependency group, unless the project chooses
its own: set `default-groups` under `[tool.uv]` in pyproject.toml (for example
`["dev", "cpu"]`), or declare `conflicts`, and Gauntlet installs uv's default
selection instead.
