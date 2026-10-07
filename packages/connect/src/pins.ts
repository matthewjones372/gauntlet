// GitHub Actions used by the generated workflows, pinned to release commits
// so a moved tag can't change what runs (ADR 0015). Update deliberately.
export const ACTIONS = {
  checkout: { uses: "actions/checkout", sha: "3d3c42e5aac5ba805825da76410c181273ba90b1", tag: "v7.0.1" },
  uploadArtifact: { uses: "actions/upload-artifact", sha: "cf430e030ddbb5b0abf93d22962f4752f3646cd9", tag: "v7.0.2" },
  downloadArtifact: { uses: "actions/download-artifact", sha: "9000827ccba6bdab643e8b6fd33ac0654aef8333", tag: "v8.0.2" },
  setupJava: { uses: "actions/setup-java", sha: "de7274f081f381c8f8158605e0321c36c376e2e6", tag: "v6.0.1" },
  setupSbt: { uses: "sbt/setup-sbt", sha: "6158cb0903b8ceeae04f830055f3155e1b6a5ad7", tag: "v1.5.11" },
  setupClojure: { uses: "DeLaGuardo/setup-clojure", sha: "6d46099eae24853c33c0482f2bb54edf4f1a4c74", tag: "13.7.0" },
  setupGradle: { uses: "gradle/actions/setup-gradle", sha: "3f5f9adaf7d9fecd50b5935e54106014257a94e6", tag: "v6.4.0" },
  setupNode: { uses: "actions/setup-node", sha: "820762786026740c76f36085b0efc47a31fe5020", tag: "v7.0.0" },
  setupBun: { uses: "oven-sh/setup-bun", sha: "0c5077e51419868618aeaa5fe8019c62421857d6", tag: "v2.2.0" },
  setupPython: { uses: "actions/setup-python", sha: "5fda3b95a4ea91299a34e894583c3862153e4b97", tag: "v7.0.0" },
  setupUv: { uses: "astral-sh/setup-uv", sha: "c18668ad3cf93ea998bef934396af7bb5c839dc7", tag: "v10.2.0" },
  setupGo: { uses: "actions/setup-go", sha: "b7ad1dad31e06c5925ef5d2fc7ad053ef454303e", tag: "v7.0.0" },
  rustToolchain: { uses: "dtolnay/rust-toolchain", sha: "89b12181fb390509a0842a86cc55eeb8eb928c1d", tag: "stable" },
  installAction: { uses: "taiki-e/install-action", sha: "f7e5d7c961414b23f5b25b2da9294395d08513ad", tag: "v2.87.26" },
} as const

export const pinned = (a: (typeof ACTIONS)[keyof typeof ACTIONS]) => `${a.uses}@${a.sha} # ${a.tag}`

/** Go tools installed with `go install` at pinned versions, when the policy gates lint or mutation. */
export const GO_TOOLS = {
  lint: "github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v2.14.0",
  mutation: "github.com/go-gremlins/gremlins/cmd/gremlins@v0.6.0",
} as const

/** Tool versions setup-clojure installs for the clojure pack. */
export const CLOJURE_TOOLS = { cli: "1.12.6.1673", lein: "2.12.0", cljKondo: "2026.08.04" } as const
