from svc.domain.money import Money, add


def total(entries: list[Money], currency: str) -> Money:
    result = Money(0, currency)
    for e in entries:
        if e.currency == currency:
            result = add(result, e)
    return result


def debug_dump(entries: list[Money], extra=[]) -> str:
    return ",".join(str(e.minor) for e in entries + extra)
