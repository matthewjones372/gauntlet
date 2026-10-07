package calc

import weaver.SimpleIOSuite

object CalcSuite extends SimpleIOSuite:
  pureTest("adds") {
    expect(Calc.add(1, 2) == 3)
  }

  pureTest("adds zero") {
    expect(Calc.add(0, 0) == 0)
  }
