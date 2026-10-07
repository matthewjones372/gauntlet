package calc

import zio.test.*

object CalcSpec extends ZIOSpecDefault:
  def spec = suite("calc")(
    test("adds") {
      assertTrue(Calc.add(1, 2) == 3)
    },
    test("adds zero") {
      assertTrue(Calc.add(0, 0) == 0)
    },
  )
