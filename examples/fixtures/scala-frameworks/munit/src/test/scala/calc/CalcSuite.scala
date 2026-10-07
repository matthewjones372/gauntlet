package calc

class CalcSuite extends munit.FunSuite:
  test("adds") {
    assertEquals(Calc.add(1, 2), 3)
  }

  test("adds zero") {
    assertEquals(Calc.add(0, 0), 0)
  }
