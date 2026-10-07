from svc.domain.money import Money


def convert(amount: Money, rate_basis_points: int, target: str) -> Money:
    """Converts with an integer rate in basis points, avoiding floating point."""
    return Money(amount.minor * rate_basis_points // 10_000, target)
