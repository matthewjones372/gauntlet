use svc::domain::money::{add, is_positive, Money};

#[test]
fn adds() {
    assert_eq!(add(&Money::new(100, "EUR"), &Money::new(200, "EUR")), Ok(Money::new(300, "EUR")));
}

#[test]
fn refuses_mixed_currencies() {
    assert!(add(&Money::new(1, "EUR"), &Money::new(1, "USD")).is_err());
}

#[test]
fn knows_when_positive() {
    assert!(is_positive(&Money::new(1, "EUR")));
    assert!(!is_positive(&Money::new(0, "EUR")));
}
