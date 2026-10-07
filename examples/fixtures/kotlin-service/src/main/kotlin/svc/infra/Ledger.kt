package svc.infra

import svc.domain.Money

class Ledger {
    private val entries = mutableListOf<Money>()

    fun record(amount: Money) {
        entries += amount
    }

    fun total(currency: String): Money = entries.filter { it.currency == currency }.fold(Money(0, currency)) { a, b -> a + b }
}
