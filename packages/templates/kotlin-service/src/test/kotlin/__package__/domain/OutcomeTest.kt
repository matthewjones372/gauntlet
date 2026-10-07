package {{package}}.domain

import kotlin.test.Test
import kotlin.test.assertEquals

class OutcomeTest {
    private val ok: Outcome<String, Int> = Outcome.Success(2)
    private val failed: Outcome<String, Int> = Outcome.Failure("no")

    @Test
    fun mapsSuccessesOnly() {
        assertEquals(Outcome.Success(4), ok.map { it * 2 })
        assertEquals(Outcome.Failure("no"), failed.map { it * 2 })
    }

    @Test
    fun chainsSuccessesOnly() {
        assertEquals(Outcome.Success(3), ok.flatMap { Outcome.Success(it + 1) })
        assertEquals(Outcome.Failure("later"), ok.flatMap { Outcome.Failure("later") })
        assertEquals(Outcome.Failure("no"), failed.flatMap { Outcome.Success(it + 1) })
    }

    @Test
    fun mapsErrorsOnly() {
        assertEquals(Outcome.Success(2), ok.mapError { it.length })
        assertEquals(Outcome.Failure(2), failed.mapError { it.length })
    }
}
