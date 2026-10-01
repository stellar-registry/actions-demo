#!/usr/bin/env node
// Check what the CI publish key can and cannot authorize, by enforce-mode
// simulation against testnet. Nothing is submitted and nothing is spent.
//
//   CI_PUBLISH_SECRET_KEY=S... AUTHOR_ADDRESS=C... REGISTRY_CONTRACT_ID=C... \
//     node app/scripts/check-key-scope.mjs [wasm-name]
//
// For each call the key signs the author account's auth entry exactly the way
// the stellar-cli fork in registry-publish.yml does (OZ AuthPayload with one
// External(ed25519 verifier, pubkey) signer over the rule-bound digest) and
// asks the RPC to run it with auth enforced.

import {
  Address,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  hash,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';

const RPC_URL = process.env.STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org';
const PASSPHRASE = Networks.TESTNET;
const NATIVE_SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

const need = (k) => process.env[k] ?? (console.error(`set ${k}`), process.exit(2));
const key = Keypair.fromSecret(need('CI_PUBLISH_SECRET_KEY'));
const account = need('AUTHOR_ADDRESS');
const registry = need('REGISTRY_CONTRACT_ID');
const wasmName = process.argv[2] ?? 'actions-demo';
const server = new rpc.Server(RPC_URL);

const str = (s) => nativeToScVal(s, { type: 'string' });
const addr = (a) => Address.fromString(a).toScVal();
const u32 = (n) => xdr.ScVal.scvU32(n);

async function view(contract, fn, args = []) {
  const src = await server.getAccount(key.publicKey());
  const tx = new TransactionBuilder(src, { fee: '100', networkPassphrase: PASSPHRASE })
    .addOperation(Operation.invokeContractFunction({ contract, function: fn, args }))
    .setTimeout(0)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`${fn}: ${sim.error.split('\n')[0]}`);
  return scValToNative(sim.result.retval);
}

// The rule that holds this key: its id and verifier, found the way the fork
// discovers it (scan the account's rules for External(verifier, our pubkey)).
async function findRule() {
  const pubkey = Buffer.from(key.rawPublicKey()).toString('hex');
  for (const id of (await view(account, 'doc_rule_ids')).map(Number)) {
    const rule = await view(account, 'get_context_rule', [u32(id)]);
    for (const s of rule.signers) {
      if (s[0] === 'External' && Buffer.from(s[2]).toString('hex') === pubkey) {
        return { id, name: rule.name, verifier: s[1] };
      }
    }
  }
  throw new Error(`no rule on ${account} lists this key as a signer`);
}

function sign(entry, ruleId, verifier, expiration) {
  const signed = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR());
  const creds = signed.credentials().address();
  creds.signatureExpirationLedger(expiration);
  const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: hash(Buffer.from(PASSPHRASE)),
      nonce: creds.nonce(),
      signatureExpirationLedger: expiration,
      invocation: signed.rootInvocation(),
    }),
  );
  const ids = xdr.ScVal.scvVec([u32(ruleId)]);
  const digest = hash(Buffer.concat([hash(preimage.toXDR()), ids.toXDR()]));
  const signer = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol('External'),
    addr(verifier),
    xdr.ScVal.scvBytes(key.rawPublicKey()),
  ]);
  creds.signature(
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('context_rule_ids'), val: ids }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol('signers'),
        val: xdr.ScVal.scvMap([new xdr.ScMapEntry({ key: signer, val: xdr.ScVal.scvBytes(key.sign(digest)) })]),
      }),
    ]),
  );
  return signed;
}

async function attempt(rule, contract, fn, args) {
  const src = await server.getAccount(key.publicKey());
  const tx = new TransactionBuilder(src, { fee: '10000000', networkPassphrase: PASSPHRASE })
    .addOperation(Operation.invokeContractFunction({ contract, function: fn, args }))
    .setTimeout(300)
    .build();
  const recorded = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(recorded)) return `fails before auth: ${code(recorded.error)}`;
  const assembled = rpc.assembleTransaction(tx, recorded).build();
  const op = assembled.operations[0];
  const expiration = recorded.latestLedger + 60;
  const entries = op.auth.map((e) =>
    e.credentials().switch().name === 'sorobanCredentialsAddress' ? sign(e, rule.id, rule.verifier, expiration) : e,
  );
  op.auth.splice(0, op.auth.length, ...entries);
  const enforced = await server.simulateTransaction(assembled, undefined, 'enforce');
  return rpc.Api.isSimulationError(enforced) ? `refused: ${code(enforced.error)}` : 'AUTHORIZED';
}

const code = (e) => e.match(/Error\(\w+, #?\w+\)/)?.[0] ?? e.split('\n')[0];

// Valid wasm with a hash the registry has not seen: the currently published
// code plus a custom section, so `publish` gets past its upload to the auth check.
async function freshWasm() {
  const current = Buffer.from(await view(registry, 'fetch_hash', [str(wasmName), xdr.ScVal.scvVoid()]));
  const code = await server.getContractWasmByHash(current);
  const name = Buffer.from('scope-check');
  const body = Buffer.concat([Buffer.from([name.length]), name, Buffer.from(String(Date.now()))]);
  return xdr.ScVal.scvBytes(Buffer.concat([code, Buffer.from([0, body.length]), body]));
}

const rule = await findRule().catch((e) => {
  // A rotated-out key lands here: apply_doc dropped its signer declaration.
  console.error(e.message);
  process.exit(1);
});
const fresh = () => xdr.ScVal.scvBytes(Buffer.from(crypto.getRandomValues(new Uint8Array(32))));
const cases = [
  ['publish, allowed name, author = account (expected: AUTHORIZED)', registry, 'publish', [str(wasmName), addr(account), await freshWasm(), str('999.0.0')]],
  ['publish, another name', registry, 'publish', [str(`${wasmName}-other`), addr(account), await freshWasm(), str('999.0.0')]],
  ['publish_hash (authorized only if the rule opted in for wasms over 60 KiB)', registry, 'publish_hash', [str(wasmName), addr(account), fresh(), str('999.0.0')]],
  ['XLM transfer out of the account', NATIVE_SAC, 'transfer', [addr(account), addr(key.publicKey()), nativeToScVal(1n, { type: 'i128' })]],
  // Re-applying the account's own current document: valid input, so only auth decides.
  ['apply_doc (rewrite the account policy)', account, 'apply_doc', [xdr.ScVal.scvBytes(Buffer.from(await view(account, 'get_applied_doc')))]],
];

console.log(`key ${key.publicKey()} holds rule #${rule.id} "${rule.name}" on ${account}\n`);
for (const [label, contract, fn, args] of cases) {
  console.log(`${label}\n  -> ${await attempt(rule, contract, fn, args)}`);
}
