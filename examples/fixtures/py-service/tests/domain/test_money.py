import pytest

from svc.domain.money import Money, add, is_positive


def test_adds():
    assert add(Money(100, "EUR"), Money(200, "EUR")) == Money(300, "EUR")


def test_refuses_mixed_currencies():
    with pytest.raises(ValueError, match="currency mismatch"):
        add(Money(1, "EUR"), Money(1, "USD"))


def test_knows_when_positive():
    assert is_positive(Money(1, "EUR"))
    assert not is_positive(Money(0, "EUR"))
