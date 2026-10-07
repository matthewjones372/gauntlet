package svc.settlement

import org.scalatest.funsuite.AnyFunSuite
import svc.domain.Money

class FxSpec extends AnyFunSuite:
  test("converts") {
    assert(Fx.convert(Money(100, "EUR"), 11_000, "USD") == Money(110, "USD"))
  }
