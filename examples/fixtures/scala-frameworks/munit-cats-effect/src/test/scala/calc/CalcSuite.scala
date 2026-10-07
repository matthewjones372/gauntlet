package calc

import cats.effect.IO
import munit.CatsEffectSuite

class CalcSuite extends CatsEffectSuite:
  test("adds") {
    IO(Calc.add(1, 2)).assertEquals(3)
  }

  test("adds zero") {
    IO(Calc.add(0, 0)).assertEquals(0)
  }
