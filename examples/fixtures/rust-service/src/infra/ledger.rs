use crate::domain::money::{add, Money};

/// Sums the entries in one currency.
pub fn total(entries: &[Money], currency: &str) -> Money {
    let mut result = Money::new(0, currency);
    for e in entries.iter().filter(|e| e.currency == currency) {
        if let Ok(sum) = add(&result, e) {
            result = sum;
        }
    }
    result
}

/// Whether there are any entries.
pub fn has_entries(entries: &[Money]) -> bool {
    return !entries.is_empty();
}
