// Testnet constants. The demo targets testnet only.

export const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
export const RPC_URL = 'https://soroban-testnet.stellar.org';
export const FRIENDBOT_URL = 'https://friendbot.stellar.org';
export const EXPLORER = 'https://stellar.expert/explorer/testnet';

/** Hosted nido wallet (testnet). The popup ceremonies run on this domain. */
export const DEFAULT_NIDO_BASE = 'nido.fyi';

/** The Stellar Registry's "unverified" registry on testnet: unmanaged, so the
 *  first publish of a name claims it for its author. The default target. */
export const UNVERIFIED_REGISTRY = 'CDBL7MNO7UI5OAAIC67UIWKQ4P3S6RVQSFCQXUHUW6TOFCXSYRPNHY4S';

/** The wasm name the release workflow publishes (the crate name). */
export const DEFAULT_WASM_NAME = 'actions-demo';

/** Rule name and signer id the dapp writes into the policy document. */
export const RULE_NAME = 'ci-publish';

/** The only registry function the CI key may call. stellar-registry/actions
 *  registry-publish.yml uploads the code with a plain host-function op (no
 *  smart-account auth) and then binds name -> hash -> author with
 *  `publish_hash`, so that is all the rule allows. */
export const PUBLISH_FUNCTIONS = ['publish_hash'] as const;

/** perch's ed25519 verifier: `Signer::External(verifier, pubkey)` checks a
 *  raw ed25519 signature over the auth digest. Resolved at runtime as
 *  `unverified` -> `perch` -> `perch-ed25519-verifier`; this pin is the
 *  fallback when the lookup fails. */
export const ED25519_VERIFIER_FALLBACK = 'CA4G72A6XEIYPORY7UKZB3WFRJYX564UAQB5I7ASZMEAEST7PRHT4PSF';
export const ED25519_VERIFIER_PATH = ['perch', 'perch-ed25519-verifier'] as const;

export const REPO_URL = 'https://github.com/stellar-registry/actions-demo';
