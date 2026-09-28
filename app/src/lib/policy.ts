// Pure policy-document logic: the first-apply baseline, the publish-key rule
// upsert, and a small diff for the review screen. No network access here.
//
// A nido account's policy is a perch PolicyDoc applied with `apply_doc`, which
// REPLACES the whole rule set. So an update always carries the current
// document forward with one rule merged in, and a fresh account (never
// applied) starts from the same admin baseline nido's own flows use.

import { parsePolicyDoc, requestToPolicyDoc } from '@stellar-registry/perch';
import type { PolicyDoc } from '@stellar-registry/perch';
import { LARGE_WASM_FUNCTION, PUBLISH_FUNCTION, RULE_NAME } from './config';

type SignerDecl = PolicyDoc['signers'][number];
type Rule = PolicyDoc['rules'][number];

export interface AdminPasskey {
  /** WebAuthn verifier the account trusts. */
  verifier: string;
  /** SEC1 uncompressed P-256 public key, hex. */
  publicKeyHex: string;
}

/** The document a fresh nido account is treated as having: its passkey as
 *  the one admin, with policy-free self-admin authority. Byte-identical to
 *  nido's `adminBaseline`, so this dapp and the wallet agree on the diff. */
export function adminBaseline(admin: AdminPasskey, network: string): PolicyDoc {
  return requestToPolicyDoc({
    network,
    signers: [{ id: 'admin', verifier: admin.verifier, key: admin.publicKeyHex.toLowerCase() }],
    permissions: [{ name: 'admin', on: 'self-admin', by: ['admin'] }],
  });
}

export interface PublishKey {
  /** Registry contract the key may publish to. */
  registry: string;
  /** Wasm names the key may publish (checked against `publish_hash` arg 0). */
  wasmNames: string[];
  /** ed25519 verifier contract. */
  verifier: string;
  /** 32-byte ed25519 public key of the CI key, hex. */
  publicKeyHex: string;
  /** Also allow `publish_hash`, which registry-publish needs only for a wasm
   *  too big to `publish` in one transaction. */
  allowPublishHash?: boolean;
}

/** The publish-only rule, as a doc rule. For both `publish` and
 *  `publish_hash`, arg 0 is the wasm name and arg 1 the author; pinning the
 *  author to the account itself means the key can only ever publish AS this
 *  account. */
export function publishRule(
  registry: string,
  wasmNames: string[],
  signerId: string,
  allowPublishHash = false,
): Rule {
  return {
    name: RULE_NAME,
    scope: { type: 'contract', address: registry },
    principals: { type: 'all', signers: [signerId] },
    functions: allowPublishHash ? [PUBLISH_FUNCTION, LARGE_WASM_FUNCTION] : [PUBLISH_FUNCTION],
    args: [
      { index: 0, pred: { type: 'string-in', values: [...wasmNames] } },
      { index: 1, pred: { type: 'is-self' } },
    ],
  };
}

const signerKeyOf = (s: SignerDecl): string =>
  'address' in s ? `delegated:${s.address}` : `external:${s.verifier}:${s.key.toLowerCase()}`;

/**
 * Put the CI key and its publish rule into `base` (the applied document, or
 * the baseline on a first apply). A rule already named `ci-publish` is
 * replaced, so running the dapp again ROTATES the key: the old key's signer
 * declaration is no longer referenced and is dropped with it.
 */
export function upsertPublishKey(base: PolicyDoc, key: PublishKey, network: string): PolicyDoc {
  if (base.network !== undefined && base.network !== network) {
    throw new Error(`The applied document is bound to "${base.network}", not "${network}".`);
  }
  if (key.wasmNames.length === 0) throw new Error('Name at least one wasm the key may publish.');

  const decl: SignerDecl = { id: RULE_NAME, verifier: key.verifier, key: key.publicKeyHex.toLowerCase() };
  const rules = base.rules.filter((r) => r.name !== RULE_NAME);
  // Drop declarations only the replaced rule used (the previous CI key).
  const referenced = new Set(rules.flatMap(signerIdsOf));
  let signers = base.signers.filter((s) => referenced.has(s.id));
  let signerId = signers.find((s) => signerKeyOf(s) === signerKeyOf(decl))?.id;
  if (signerId === undefined) {
    const taken = new Set(signers.map((s) => s.id));
    signerId = RULE_NAME;
    for (let n = 2; taken.has(signerId); n++) signerId = `${RULE_NAME}-${n}`;
    signers = [...signers, { ...decl, id: signerId }];
  }
  rules.push(publishRule(key.registry, key.wasmNames, signerId, key.allowPublishHash));

  // Re-validate through perch's schema so a bad merge fails here, not on-chain.
  return parsePolicyDoc({ ...base, network, signers, rules });
}

const signerIdsOf = (r: Rule): string[] =>
  r.principals.type === 'self-authenticating' ? [] : r.principals.signers;

export interface DocDiff {
  signersAdded: SignerDecl[];
  signersRemoved: SignerDecl[];
  rulesAdded: Rule[];
  rulesRemoved: Rule[];
  rulesChanged: Array<{ before: Rule; after: Rule }>;
}

/** What `apply_doc` changes going from `prev` (null on a first apply) to `next`. */
export function diffDocs(prev: PolicyDoc | null, next: PolicyDoc): DocDiff {
  const before = prev ?? { signers: [], rules: [] };
  const sigKey = (s: SignerDecl) => `${s.id}|${signerKeyOf(s)}`;
  const prevSigners = new Set(before.signers.map(sigKey));
  const nextSigners = new Set(next.signers.map(sigKey));
  const prevRules = new Map(before.rules.map((r) => [r.name, r]));
  const nextRules = new Map(next.rules.map((r) => [r.name, r]));
  return {
    signersAdded: next.signers.filter((s) => !prevSigners.has(sigKey(s))),
    signersRemoved: before.signers.filter((s) => !nextSigners.has(sigKey(s))),
    rulesAdded: next.rules.filter((r) => !prevRules.has(r.name)),
    rulesRemoved: before.rules.filter((r) => !nextRules.has(r.name)),
    rulesChanged: next.rules.flatMap((r) => {
      const old = prevRules.get(r.name);
      return old !== undefined && JSON.stringify(old) !== JSON.stringify(r) ? [{ before: old, after: r }] : [];
    }),
  };
}

/** One line a reviewer can read: what the rule lets its signers do. */
export function describeRule(rule: Rule): string {
  const who = rule.principals.type === 'self-authenticating' ? 'a policy' : signerIdsOf(rule).join(' + ');
  const where = rule.scope.type === 'self-admin' ? 'this account (admin)' : rule.scope.address;
  const fns = rule.functions ? rule.functions.join(', ') : 'any function';
  return `${who} may call ${fns} on ${where}`;
}
