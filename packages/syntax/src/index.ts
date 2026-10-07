import { Language, type Node, Parser, type Tree } from "web-tree-sitter"
import runtimeWasm from "web-tree-sitter/web-tree-sitter.wasm" with { type: "file" }

// Shared tree-sitter plumbing for the language packs (ADR 0013). The runtime
// WASM is embedded in the binary and initialised once, when this module is
// first imported; grammars are loaded by each pack from its own vendored file.

await Parser.init({ locateFile: () => runtimeWasm })

export type { Node, Tree }

/** Loads a grammar and returns a parse function for it. */
export const grammar = async (wasmPath: string): Promise<(text: string) => Tree> => {
  const language = await Language.load(wasmPath)
  const parser = new Parser()
  parser.setLanguage(language)
  // A parse always returns a tree; syntax errors become ERROR nodes detectors skip over.
  return (text) => parser.parse(text)!
}

export const line = (n: Node) => n.startPosition.row + 1

/** Every named node under `root`, depth first, in source order. */
export const descendants = function*(root: Node): Generator<Node> {
  const stack: Node[] = [root]
  while (stack.length > 0) {
    const n = stack.pop()!
    yield n
    for (let i = n.namedChildCount - 1; i >= 0; i--) {
      const c = n.namedChild(i)
      if (c) stack.push(c)
    }
  }
}

export const ofType = (root: Node, ...types: string[]) => [...descendants(root)].filter((n) => types.includes(n.type))

/** Whether any line within `distance` of `at` is in `lines`. */
export const near = (lines: ReadonlySet<number>, at: number, distance: number) => {
  for (let d = -distance; d <= distance; d++) if (lines.has(at + d)) return true
  return false
}
