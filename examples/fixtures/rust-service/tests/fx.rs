use svc::domain::money::Money;
use svc::settlement::fx::convert;

#[test]
fn converts() {
    assert_eq!(convert(&Money::new(100, "EUR"), 11_000, "USD"), Money::new(110, "USD"));
}
