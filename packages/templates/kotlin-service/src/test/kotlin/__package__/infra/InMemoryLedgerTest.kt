package {{package}}.infra

import {{package}}.domain.Currency
import {{package}}.domain.Money
import kotlin.test.Test
import kotlin.test.assertEquals

class InMemoryLedgerTest {
    private val eur = Currency.of("EUR")!!
    private val usd = Currency.of("USD")!!

    @Test
    fun unknownAccountsHoldNothing() {
        assertEquals(Money(0, eur), InMemoryLedger().balance("nobody", Money(1, eur)))
    }

    @Test
    fun keepsEachCurrencySeparately() {
        val ledger = InMemoryLedger().with("alice", Money(5, eur)).with("alice", Money(7, usd))
        assertEquals(Money(5, eur), ledger.balance("alice", Money(0, eur)))
        assertEquals(Money(7, usd), ledger.balance("alice", Money(0, usd)))
    }

    @Test
    fun changesReturnANewLedger() {
        val before = InMemoryLedger()
        before.with("alice", Money(5, eur))
        assertEquals(Money(0, eur), before.balance("alice", Money(0, eur)))
    }
}
