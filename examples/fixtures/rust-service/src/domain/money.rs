//! An amount in minor units (cents), so money never goes through floating point.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Money {
    pub minor: i64,
    pub currency: String,
}

impl Money {
    pub fn new(minor: i64, currency: &str) -> Self {
        Money { minor, currency: currency.to_string() }
    }
}

/// Adds two amounts in the same currency.
pub fn add(a: &Money, b: &Money) -> Result<Money, String> {
    if a.currency != b.currency {
        return Err(format!("currency mismatch: {} vs {}", a.currency, b.currency));
    }
    Ok(Money::new(a.minor + b.minor, &a.currency))
}

/// Whether the amount is above zero.
pub fn is_positive(m: &Money) -> bool {
    m.minor > 0
}
