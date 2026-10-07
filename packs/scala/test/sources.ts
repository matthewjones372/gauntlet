// Copies of the Scala fixtures the unit tests read, kept inline so the tests
// pass in a judged checkout, where fixtures a change adds are removed. The
// end-to-end test runs the fixtures themselves.

export const SOURCES: Record<string, string> = {
  "scala-service/build.sbt": "ThisBuild / scalaVersion := \"3.10.0\"\n\nlazy val root = (project in file(\".\"))\n  .settings(\n    name := \"scala-service\",\n    libraryDependencies ++= Seq(\n      \"org.scalatest\" %% \"scalatest\" % \"3.2.20\" % Test,\n      \"org.scalatestplus\" %% \"scalacheck-1-18\" % \"3.2.19.0\" % Test,\n    ),\n  )\n",
  "scala-service/project/plugins.sbt": "addSbtPlugin(\"ch.epfl.scala\" % \"sbt-scalafix\" % \"0.14.9\")\naddSbtPlugin(\"org.scoverage\" % \"sbt-scoverage\" % \"2.4.4\")\naddSbtPlugin(\"io.stryker-mutator\" % \"sbt-stryker4s\" % \"1.1.1\")\n",
  "scala-service/src/main/scala/svc/domain/Money.scala": "package svc.domain\n\n/** An amount in minor units (cents), so money never goes through floating point. */\nfinal case class Money(minor: Long, currency: String)\n\nobject Money:\n  def add(a: Money, b: Money): Either[String, Money] =\n    if a.currency != b.currency then Left(s\"currency mismatch: ${a.currency} vs ${b.currency}\")\n    else Right(Money(a.minor + b.minor, a.currency))\n\n  def isPositive(m: Money): Boolean = m.minor > 0\n",
  "scala-service/src/test/scala/svc/domain/MoneySpec.scala": "package svc.domain\n\nimport org.scalatest.funsuite.AnyFunSuite\n\nclass MoneySpec extends AnyFunSuite:\n  test(\"adds\") {\n    assert(Money.add(Money(100, \"EUR\"), Money(200, \"EUR\")) == Right(Money(300, \"EUR\")))\n  }\n\n  test(\"refuses mixed currencies\") {\n    assert(Money.add(Money(1, \"EUR\"), Money(1, \"USD\")).isLeft)\n  }\n\n  test(\"knows when positive\") {\n    assert(Money.isPositive(Money(1, \"EUR\")))\n    assert(!Money.isPositive(Money(0, \"EUR\")))\n  }\n",
  "scala-service/src/test/scala/svc/settlement/FxSpec.scala": "package svc.settlement\n\nimport org.scalatest.funsuite.AnyFunSuite\nimport svc.domain.Money\n\nclass FxSpec extends AnyFunSuite:\n  test(\"converts\") {\n    assert(Fx.convert(Money(100, \"EUR\"), 11_000, \"USD\") == Money(110, \"USD\"))\n  }\n",
  "scala-frameworks/munit/src/test/scala/calc/CalcSuite.scala": "package calc\n\nclass CalcSuite extends munit.FunSuite:\n  test(\"adds\") {\n    assertEquals(Calc.add(1, 2), 3)\n  }\n\n  test(\"adds zero\") {\n    assertEquals(Calc.add(0, 0), 0)\n  }\n",
  "scala-frameworks/munit-cats-effect/src/test/scala/calc/CalcSuite.scala": "package calc\n\nimport cats.effect.IO\nimport munit.CatsEffectSuite\n\nclass CalcSuite extends CatsEffectSuite:\n  test(\"adds\") {\n    IO(Calc.add(1, 2)).assertEquals(3)\n  }\n\n  test(\"adds zero\") {\n    IO(Calc.add(0, 0)).assertEquals(0)\n  }\n",
  "scala-frameworks/zio-test/src/test/scala/calc/CalcSpec.scala": "package calc\n\nimport zio.test.*\n\nobject CalcSpec extends ZIOSpecDefault:\n  def spec = suite(\"calc\")(\n    test(\"adds\") {\n      assertTrue(Calc.add(1, 2) == 3)\n    },\n    test(\"adds zero\") {\n      assertTrue(Calc.add(0, 0) == 0)\n    },\n  )\n",
  "scala-frameworks/weaver/src/test/scala/calc/CalcSuite.scala": "package calc\n\nimport weaver.SimpleIOSuite\n\nobject CalcSuite extends SimpleIOSuite:\n  pureTest(\"adds\") {\n    expect(Calc.add(1, 2) == 3)\n  }\n\n  pureTest(\"adds zero\") {\n    expect(Calc.add(0, 0) == 0)\n  }\n",
}

export const fixture = (p: string) => {
  const text = SOURCES[p]
  if (text === undefined) throw new Error(`no inline copy of ${p}`)
  return text
}
