#![no_std]
//! The contract the release workflow ships. It is deliberately trivial: the
//! point of this repo is the pipeline around it, not the contract.

use soroban_sdk::{contract, contractimpl, symbol_short, vec, Env, String, Symbol, Vec};

#[contract]
pub struct ActionsDemo;

#[contractimpl]
impl ActionsDemo {
    /// Greet `to`.
    pub fn hello(env: Env, to: Symbol) -> Vec<Symbol> {
        vec![&env, symbol_short!("Hello"), to]
    }

    /// The crate version this wasm was built from. Compiling it into the code
    /// gives every release distinct bytes, and the registry refuses to publish
    /// a hash it has already seen.
    pub fn version(env: Env) -> String {
        String::from_str(&env, env!("CARGO_PKG_VERSION"))
    }
}

#[cfg(test)]
mod test;
