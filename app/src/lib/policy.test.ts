import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@stellar-registry/perch';
import { adminBaseline, diffDocs, upsertPublishKey } from './policy';
import { NETWORK_PASSPHRASE, RULE_NAME } from './config';

const WEBAUTHN = 'CACVGSAHYFBXY4LJKWW5B57LAAXHCZVDZOANUTYPLNV6HHQI4Q35EGMY';
const ED25519 = 'CA4G72A6XEIYPORY7UKZB3WFRJYX564UAQB5I7ASZMEAEST7PRHT4PSF';
const REGISTRY = 'CDBL7MNO7UI5OAAIC67UIWKQ4P3S6RVQSFCQXUHUW6TOFCXSYRPNHY4S';
const PASSKEY = `04${'ab'.repeat(64)}`;
const KEY_A = 'aa'.repeat(32);
const KEY_B = 'bb'.repeat(32);

const baseline = () => adminBaseline({ verifier: WEBAUTHN, publicKeyHex: PASSKEY }, NETWORK_PASSPHRASE);
const key = (publicKeyHex: string) => ({
  registry: REGISTRY,
  wasmNames: ['actions-demo'],
  verifier: ED25519,
  publicKeyHex,
});

describe('adminBaseline', () => {
  it('matches the document nido composes a first apply against', () => {
    // nido's adminBaseline (packages/frontend/src/lib/policy/docDraft.ts) via
    // buildPolicyDoc; kept byte-identical so both sides diff the same thing.
    expect(canonicalJson(baseline())).toBe(
      canonicalJson({
        version: 1,
        network: NETWORK_PASSPHRASE,
        signers: [{ id: 'admin', verifier: WEBAUTHN, key: PASSKEY }],
        rules: [{ name: 'admin', scope: { type: 'self-admin' }, principals: { type: 'all', signers: ['admin'] } }],
      }),
    );
  });
});

describe('upsertPublishKey', () => {
  it('adds the key and a publish-only rule pinned to name and author', () => {
    const doc = upsertPublishKey(baseline(), key(KEY_A), NETWORK_PASSPHRASE);
    expect(doc.signers).toContainEqual({ id: RULE_NAME, verifier: ED25519, key: KEY_A });
    const rule = doc.rules.find((r) => r.name === RULE_NAME);
    expect(rule).toEqual({
      name: RULE_NAME,
      scope: { type: 'contract', address: REGISTRY },
      principals: { type: 'all', signers: [RULE_NAME] },
      functions: ['publish'],
      args: [
        { index: 0, pred: { type: 'string-in', values: ['actions-demo'] } },
        { index: 1, pred: { type: 'is-self' } },
      ],
    });
    // The admin rule survives: apply_doc refuses a document without one.
    expect(doc.rules.find((r) => r.name === 'admin')).toBeDefined();
  });

  it('allows publish_hash only when opted in (wasms too big to publish)', () => {
    const doc = upsertPublishKey(baseline(), { ...key(KEY_A), allowPublishHash: true }, NETWORK_PASSPHRASE);
    expect(doc.rules.find((r) => r.name === RULE_NAME)?.functions).toEqual(['publish', 'publish_hash']);
  });

  it('rotates: a second key replaces the first and drops its declaration', () => {
    const first = upsertPublishKey(baseline(), key(KEY_A), NETWORK_PASSPHRASE);
    const second = upsertPublishKey(first, key(KEY_B), NETWORK_PASSPHRASE);
    expect(second.signers.map((s) => ('key' in s ? s.key : s.address))).toEqual([PASSKEY, KEY_B]);
    expect(second.rules.filter((r) => r.name === RULE_NAME)).toHaveLength(1);
    const d = diffDocs(first, second);
    expect(d.signersAdded).toHaveLength(1);
    expect(d.signersRemoved).toHaveLength(1);
    expect(d.rulesChanged).toHaveLength(0);
  });

  it('keeps unrelated rules and signers', () => {
    const base = upsertPublishKey(baseline(), key(KEY_A), NETWORK_PASSPHRASE);
    const withSession = {
      ...base,
      signers: [...base.signers, { id: 'session', address: 'GAMPJROHCBN2DGZVH7TWRDCMWMDYMHYHRXMZUOSGIQEBYTJHJYJUT2HB' }],
      rules: [
        ...base.rules,
        {
          name: 'session',
          scope: { type: 'contract' as const, address: REGISTRY },
          principals: { type: 'all' as const, signers: ['session'] },
        },
      ],
    };
    const doc = upsertPublishKey(withSession, key(KEY_B), NETWORK_PASSPHRASE);
    expect(doc.rules.map((r) => r.name)).toEqual(['admin', 'session', RULE_NAME]);
    expect(doc.signers.map((s) => s.id)).toEqual(['admin', 'session', RULE_NAME]);
  });

  it('refuses a document bound to another network', () => {
    const doc = { ...baseline(), network: 'Public Global Stellar Network ; September 2015' };
    expect(() => upsertPublishKey(doc, key(KEY_A), NETWORK_PASSPHRASE)).toThrow(/bound to/);
  });

  it('refuses an empty name list', () => {
    expect(() => upsertPublishKey(baseline(), { ...key(KEY_A), wasmNames: [] }, NETWORK_PASSPHRASE)).toThrow();
  });
});

describe('diffDocs', () => {
  it('treats a first apply as all-new', () => {
    const doc = upsertPublishKey(baseline(), key(KEY_A), NETWORK_PASSPHRASE);
    const d = diffDocs(null, doc);
    expect(d.rulesAdded.map((r) => r.name)).toEqual(['admin', RULE_NAME]);
    expect(d.signersAdded).toHaveLength(2);
  });
});
