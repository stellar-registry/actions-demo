# Changelog

Versions are on-chain wasm publishes to the Stellar Registry (testnet).
The format follows [Keep a Changelog](https://keepachangelog.com).

## [0.1.2] - 2026-09-28

### Other

- Third release: published with a single smart-account-signed `publish`
  (stellar-registry/actions#15) under a `ci-publish` rule that allows
  `publish` only. The only change is the version the contract reports.

## [0.1.1] - 2026-09-28

### Other

- Second release: publishes a new version of the already-published
  `actions-demo` wasm through the CI publish key. The only change is the
  version the contract reports.

## [0.1.0] - 2026-09-28

### Features

- Demo contract workspace for registry releases (`hello`, `version`).
