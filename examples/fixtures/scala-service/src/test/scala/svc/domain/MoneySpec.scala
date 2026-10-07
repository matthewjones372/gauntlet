package svc.domain

import org.scalatest.funsuite.AnyFunSuite

class MoneySpec extends AnyFunSuite:
  test("adds") {
    assert(Money.add(Money(100, "EUR"), Money(200, "EUR")) == Right(Money(300, "EUR")))
  }

  test("refuses mixed currencies") {
    assert(Money.add(Money(1, "EUR"), Money(1, "USD")).isLeft)
  }

  test("knows when positive") {
    assert(Money.isPositive(Money(1, "EUR")))
    assert(!Money.isPositive(Money(0, "EUR")))
  }
