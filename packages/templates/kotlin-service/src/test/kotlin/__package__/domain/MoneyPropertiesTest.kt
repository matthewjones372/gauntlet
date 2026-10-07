package {{package}}.domain

import io.kotest.property.Arb
import io.kotest.property.arbitrary.long
import io.kotest.property.checkAll
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals

class MoneyPropertiesTest {
    private val eur = Currency.of("EUR")!!
    private val amounts = Arb.long(-1_000_000_000L..1_000_000_000L)

    @Test
    fun additionCommutes() = runTest {
        checkAll(amounts, amounts) { a, b ->
            assertEquals(Money(a, eur) + Money(b, eur), Money(b, eur) + Money(a, eur))
        }
    }

    @Test
    fun subtractingUndoesAdding() = runTest {
        checkAll(amounts, amounts) { a, b ->
            assertEquals(Outcome.Success(Money(a, eur)), (Money(a, eur) + Money(b, eur)).flatMap { it - Money(b, eur) })
        }
    }
}
