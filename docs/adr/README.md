# Architecture decision records

| # | Decision | Status |
|---|---|---|
| 0001 | Use Effect 4 | proposed |
| 0002 | The DSL compiles to a canonical Policy IR | proposed (rev 2) |
| 0003 | Load policy from the base ref and materialise protected files from it | proposed (rev 2) |
| 0004 | SARIF 2.1.0 is the evidence and baseline format | proposed (rev 2) |
| 0005 | Review tiers: most cautious wins | proposed (rev 2) |
| 0006 | Packs are compiled into the binary | proposed |
| 0007 | Inject JVM tooling through Gradle init scripts | proposed |
| 0008 | Use Effect's MCP server | accepted |
| 0009 | Keep the authoring agent apart from coding agents | accepted |
| 0010 | The model provider is pluggable | accepted |
| 0011 | Probabilistic signals are caution-only | proposed |
| 0012 | Gauntlet produces its own evidence, and a silent green fails | proposed |
| 0013 | Integrity checks: generic in core, language detectors in packs | proposed |
| 0014 | Overrides are explicit, recorded and approved; no comment commands | proposed |
| 0015 | Layered enforcement on GitHub | accepted |
| 0016 | Onboarding: pack defaults for existing projects, strict templates for new ones | accepted |
| 0017 | Flaky tests are caught where they enter, and excused only by an owner until a date | accepted |
| 0018 | Clojure: a built-in reader, Gauntlet's own runners, and no mutation gate | accepted |
| 0019 | Holdouts name their files in the policy and run only in the evidence job, from base | accepted |
| 0020 | One warm Gradle daemon or sbt server per check, never shared across checks | accepted |
| 0021 | An edited protected test runs as edited and needs review | accepted |
| 0022 | Several builds in one repository | accepted |
| 0023 | A change to comments or documentation only runs no checks | accepted |
| 0024 | What the project's CI, or a local run, already ran isn't run again | accepted |
