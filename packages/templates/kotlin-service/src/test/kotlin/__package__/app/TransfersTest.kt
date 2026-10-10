package {{package}}.app

import {{package}}.domain.Currency
import {{package}}.domain.Money
import {{package}}.domain.MoneyError
import {{package}}.domain.Outcome
import {{package}}.infra.InMemoryLedger
import kotlin.test.Test
import kotlin.test.assertEquals

class TransfersTest {
    private val eur = Currency.of("EUR")!!
    private val usd = Currency.of("USD")!!
    private val funded = InMemoryLedger().with("alice", Money(500, eur))

    private fun balances(result: Outcome<TransferError, Ledger>, vararg accounts: String): List<Long> = when (result) {
        is Outcome.Success -> accounts.map { result.value.balance(it, Money.zero(eur)).minor }
        is Outcome.Failure -> emptyList()
    }

    @Test
    fun movesMoneyBetweenAccounts() {
        assertEquals(listOf(200L, 300L), balances(transfer(funded, "alice", "bob", Money(300, eur)), "alice", "bob"))
    }

    @Test
    fun canEmptyAnAccount() {
        assertEquals(listOf(0L, 500L), balances(transfer(funded, "alice", "bob", Money(500, eur)), "alice", "bob"))
    }

    @Test
    fun refusesOverdrafts() {
        val expected = TransferError.InsufficientFunds("alice", Money(500, eur))
        assertEquals(Outcome.Failure(expected), transfer(funded, "alice", "bob", Money(501, eur)))
    }

    @Test
    fun refusesAmountsThatArentPositive() {
        assertEquals(Outcome.Failure(TransferError.NotPositive), transfer(funded, "alice", "bob", Money(0, eur)))
        assertEquals(Outcome.Failure(TransferError.NotPositive), transfer(funded, "alice", "bob", Money(-5, eur)))
    }

    @Test
    fun refusesTransfersToTheSameAccount() {
        assertEquals(Outcome.Failure(TransferError.SameAccount), transfer(funded, "alice", "alice", Money(1, eur)))
    }

    @Test
    fun keepsCurrenciesApart() {
        val expected = TransferError.InsufficientFunds("alice", Money(0, usd))
        assertEquals(Outcome.Failure(expected), transfer(funded, "alice", "bob", Money(1, usd)))
    }

    @Test
    fun reportsArithmeticOverflow() {
        val full = funded.with("bob", Money(Long.MAX_VALUE, eur))
        val expected = TransferError.Arithmetic(MoneyError.Overflow)
        assertEquals(Outcome.Failure(expected), transfer(full, "alice", "bob", Money(1, eur)))
    }
}
