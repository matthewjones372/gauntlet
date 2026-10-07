# 0018. Clojure: a built-in reader, Gauntlet's own runners, and no mutation gate

Status: accepted (implemented in M8g)

## Context
Every other pack reads source through a vendored tree-sitter grammar built to WASM. The maintained Clojure grammar publishes no WASM build, and building one means a tree-sitter CLI and an emscripten toolchain, plus a binary nobody else has checked. Clojure projects also run tests in many ways (cognitect's test-runner, kaocha, `lein test`), and none of them writes JUnit XML unless configured to. Clojure has no mutation testing tool that is maintained and works on current Clojure.

## Decision
- **A built-in reader.** Clojure's syntax is s-expressions, so the pack reads source with a small reader written in TypeScript (`packs/clojure/src/syntax.ts`). It handles the reader macros, metadata, `#_` discards and `(comment ...)` blocks, and never evaluates anything. Unbalanced input reads as far as it can.
- **Gauntlet brings its runners.** The suite always runs under kaocha with its JUnit plugin, and coverage under cloverage, at versions pinned in the pack. They are added only for the one invocation: an alias passed with `-Sdeps` for deps.edn (after the project's `:test` alias, so Gauntlet's main wins), or `lein update-in :dependencies conj` for Leiningen. Project files are never edited. kaocha runs every clojure.test test, whatever runner the project uses day to day.
- **Order.** The main run uses `--no-randomize`; reruns shuffle with the seed derived from the judged commit, like the other packs.
- **No mutation gate.** The pack lists `mutation` so a policy can name it, but doesn't implement it. The gate runner reports it not executed, which is missing evidence and nominates review. `gauntlet init` leaves it out and says why.

## Consequences
- A project's kaocha `tests.edn` is honoured, and is runner configuration put back to base.
- Projects whose test roots aren't `test/` need a `tests.edn` that names them.
- A future Clojure mutation tool can be added as a gate without a policy change.
