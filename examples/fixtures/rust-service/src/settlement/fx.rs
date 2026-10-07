use crate::domain::money::Money;

/// Converts with an integer rate in basis points, avoiding floating point.
pub fn convert(amount: &Money, rate_basis_points: i64, target: &str) -> Money {
    Money::new(amount.minor * rate_basis_points / 10_000, target)
}
