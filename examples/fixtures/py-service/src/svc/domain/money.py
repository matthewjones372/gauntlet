"""An amount in minor units (cents), so money never goes through floating point."""

from dataclasses import dataclass


@dataclass(frozen=True)
class Money:
    minor: int
    currency: str


def add(a: Money, b: Money) -> Money:
    if a.currency != b.currency:
        raise ValueError(f"currency mismatch: {a.currency} vs {b.currency}")
    return Money(a.minor + b.minor, a.currency)


def is_positive(m: Money) -> bool:
    return m.minor > 0
