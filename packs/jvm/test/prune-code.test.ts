import { describe, expect, test } from "bun:test"
import { jvmCode } from "../src/prune.ts"

// Spec 0017 §5: how the JVM pack reads main source for `gauntlet prune code`.
// Kotlin by declaration with the pack's grammar; Java whole, by its class name.

const FILE = `package fx

class Fx(private val r: Int) : Base() {
    fun convert(n: Int): Int = n
    private fun hidden() {}
    override fun toString() = "x"
    val scale = 2
    companion object {
        fun of() = Fx(1)
    }
}

private class Hidden

object Registry {
    fun lookup() = 1
}

interface Port {
    fun call()
}

fun topLevel() = 2

val rate = 3
`

describe("jvmCode", () => {
  test("reads main Kotlin and Java source only", () => {
    expect(jvmCode.reads("src/main/kotlin/fx/Fx.kt")).toBe(true)
    expect(jvmCode.reads("app/src/main/java/fx/Fx.java")).toBe(true)
    expect(jvmCode.reads("src/test/kotlin/fx/FxTest.kt")).toBe(false)
  })

  test("Kotlin's public declarations and members, leaving private and override ones out", () => {
    const { declared, leftOut } = jvmCode.survey("src/main/kotlin/fx/Fx.kt", FILE)
    expect(leftOut).toBeUndefined()
    expect(declared.map((d) => `${d.line} ${d.kind} ${d.in ? `${d.in}.` : ""}${d.name}`)).toEqual([
      "3 class Fx",
      "4 method Fx.convert",
      "7 property Fx.scale",
      "9 method Fx.of",
      "15 object Registry",
      "16 method Registry.lookup",
      "19 interface Port",
      "20 method Port.call",
      "23 function topLevel",
      "25 property rate",
    ])
  })

  test("Java is judged whole", () => {
    expect(jvmCode.survey("src/main/java/fx/Fx.java", "package fx;\npublic class Fx { public int a() { return 1; } }\n")).toEqual({ declared: [] })
  })

  test("entry points, framework code and code copied into callers are left out, with why", () => {
    const why = (path: string, text: string) => jvmCode.survey(path, text).leftOut
    expect(why("src/main/kotlin/App.kt", "package a\n\nfun main() {}\n")).toBe("it has a main function")
    expect(why("src/main/java/App.java", "class App { public static void main(String[] args) {} }\n")).toBe("it has a main function")
    expect(why("src/main/kotlin/Api.kt", "package a\n\n@RestController\nclass Api\n")).toContain("@RestController")
    expect(why("src/main/kotlin/K.kt", "package a\n\n@Suppress(\"x\")\nclass K\n")).toBeUndefined()
    expect(why("src/main/kotlin/C.kt", "package a\n\nconst val LIMIT = 3\n")).toContain("copies")
  })
})
