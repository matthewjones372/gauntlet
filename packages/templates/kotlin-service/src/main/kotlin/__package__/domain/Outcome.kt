package {{package}}.domain

/** The result of an operation that can fail. Errors are values here, never thrown. */
sealed interface Outcome<out E, out A> {
    data class Success<out A>(val value: A) : Outcome<Nothing, A>

    data class Failure<out E>(val error: E) : Outcome<E, Nothing>
}

fun <E, A, B> Outcome<E, A>.map(f: (A) -> B): Outcome<E, B> =
    when (this) {
        is Outcome.Success -> Outcome.Success(f(value))
        is Outcome.Failure -> this
    }

fun <E, A, B> Outcome<E, A>.flatMap(f: (A) -> Outcome<E, B>): Outcome<E, B> =
    when (this) {
        is Outcome.Success -> f(value)
        is Outcome.Failure -> this
    }

fun <E, F, A> Outcome<E, A>.mapError(f: (E) -> F): Outcome<F, A> =
    when (this) {
        is Outcome.Success -> this
        is Outcome.Failure -> Outcome.Failure(f(error))
    }
