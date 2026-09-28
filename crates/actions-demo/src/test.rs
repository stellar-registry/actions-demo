use soroban_sdk::{symbol_short, vec, Env, String};

use crate::{ActionsDemo, ActionsDemoClient};

#[test]
fn hello() {
    let env = Env::default();
    let client = ActionsDemoClient::new(&env, &env.register(ActionsDemo, ()));
    assert_eq!(
        client.hello(&symbol_short!("Dev")),
        vec![&env, symbol_short!("Hello"), symbol_short!("Dev")]
    );
}

#[test]
fn version_matches_manifest() {
    let env = Env::default();
    let client = ActionsDemoClient::new(&env, &env.register(ActionsDemo, ()));
    assert_eq!(
        client.version(),
        String::from_str(&env, env!("CARGO_PKG_VERSION"))
    );
}
