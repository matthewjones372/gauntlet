from svc.domain.money import Money
from svc.settlement.fx import convert


def test_converts():
    assert convert(Money(100, "EUR"), 11_000, "USD") == Money(110, "USD")
