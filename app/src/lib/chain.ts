// Testnet reads and the apply_doc transaction. Reads are read-only simulations
// (no signature, no fee); the only write this dapp builds is apply_doc, which
// the nido wallet signs.

import {
  Account,
  Contract,
  Keypair,
  Operation,
  StrKey,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';
import { docHash, parsePolicyDocJson } from '@stellar-registry/perch';
import type { PolicyDoc } from '@stellar-registry/perch';
import {
  ED25519_VERIFIER_FALLBACK,
  ED25519_VERIFIER_PATH,
  FRIENDBOT_URL,
  NETWORK_PASSPHRASE,
  RPC_URL,
  UNVERIFIED_REGISTRY,
} from './config';
import { adminBaseline } from './policy';

const server = new rpc.Server(RPC_URL);

/** Simulations need a well-formed source, not a funded one. */
const READ_SOURCE = new Account(Keypair.fromRawEd25519Seed(Buffer.alloc(32)).publicKey(), '0');

export const isContract = (s: string) => StrKey.isValidContract(s.trim());

/** Call a view function by simulation and return its result, or throw with the
 *  host error (e.g. `Error(Contract, #1)`). */
export async function view(contract: string, fn: string, args: xdr.ScVal[] = []): Promise<xdr.ScVal> {
  const tx = new TransactionBuilder(READ_SOURCE, { fee: '100', networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(new Contract(contract).call(fn, ...args))
    .setTimeout(0)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(firstLine(sim.error));
  if (!sim.result) throw new Error(`${fn}: no result`);
  return sim.result.retval;
}

function firstLine(error: string): string {
  const m = error.match(/Error\(\w+, #?\w+\)/);
  return m ? m[0] : error.split('\n')[0];
}

const str = (s: string) => xdr.ScVal.scvString(s);

// ---------------------------------------------------------------- registry

export interface RegistryFacts {
  /** null = unmanaged: the first publish of a name claims it for its author. */
  manager: string | null;
  /** Current published version per wasm name, or null when unpublished. */
  versions: Record<string, string | null>;
}

export async function readRegistry(registry: string, wasmNames: string[]): Promise<RegistryFacts> {
  const manager = scValToNative(await view(registry, 'manager')) as string | null;
  const versions: Record<string, string | null> = {};
  for (const name of wasmNames) {
    try {
      versions[name] = scValToNative(await view(registry, 'current_version', [str(name)])) as string;
    } catch (e) {
      // #1 NoSuchWasmPublished: the name is still free.
      if (String(e).includes('#1')) versions[name] = null;
      else throw e;
    }
  }
  return { manager, versions };
}

/** perch's ed25519 verifier, resolved by name through the unverified
 *  registry (`perch` sub-registry -> `perch-ed25519-verifier`). */
export async function resolveEd25519Verifier(): Promise<{ address: string; resolved: boolean }> {
  try {
    let registry = UNVERIFIED_REGISTRY;
    for (const name of ED25519_VERIFIER_PATH) {
      registry = scValToNative(await view(registry, 'fetch_contract_id', [str(name)])) as string;
    }
    return { address: registry, resolved: true };
  } catch {
    return { address: ED25519_VERIFIER_FALLBACK, resolved: false };
  }
}

// ---------------------------------------------------------------- account

export interface AccountPolicy {
  /** The document the next apply starts from. */
  base: PolicyDoc;
  /** The applied document, or null when this account never applied one. */
  applied: PolicyDoc | null;
  appliedHash: string | null;
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** Read the account's current policy document. Fresh accounts (constructor
 *  rule only) get the passkey-admin baseline, as in nido. */
export async function readAccountPolicy(account: string): Promise<AccountPolicy> {
  let stored: Uint8Array | null;
  try {
    stored = scValToNative(await view(account, 'applied_doc_hash')) as Uint8Array | null;
  } catch {
    throw new Error(
      'This account has no apply_doc entry point, so it predates nido\'s doc-only accounts. Create a new nido account and retry.',
    );
  }
  if (stored === null || stored === undefined) {
    const rule = scValToNative(await view(account, 'get_context_rule', [xdr.ScVal.scvU32(0)])) as {
      signers: Array<[string, string, Uint8Array]>;
    };
    const passkey = rule.signers.find((s) => s[0] === 'External');
    if (!passkey) throw new Error('Could not find the account passkey on its default rule.');
    return {
      base: adminBaseline({ verifier: passkey[1], publicKeyHex: hex(passkey[2]) }, NETWORK_PASSPHRASE),
      applied: null,
      appliedHash: null,
    };
  }
  const bytes = scValToNative(await view(account, 'get_applied_doc')) as Uint8Array;
  const doc = parsePolicyDocJson(Buffer.from(bytes).toString('utf8'));
  const storedHex = hex(stored);
  // apply_doc stores canonical bytes, so the parsed doc must hash to the stored hash.
  if (docHash(doc) !== storedHex) throw new Error('The stored document does not match its stored hash.');
  return { base: doc, applied: doc, appliedHash: storedHex };
}

export interface ChainRule {
  id: number;
  name: string;
  scope: string;
  signers: string[];
  policies: number;
}

/** The account's doc-managed rules as they sit on-chain. */
export async function readRules(account: string): Promise<ChainRule[]> {
  const ids = (scValToNative(await view(account, 'doc_rule_ids')) as number[]).map(Number);
  const rules: ChainRule[] = [];
  for (const id of ids) {
    const r = scValToNative(await view(account, 'get_context_rule', [xdr.ScVal.scvU32(id)])) as {
      name: string;
      context_type: [string, string?];
      signers: Array<[string, string, Uint8Array?]>;
      policies?: unknown[];
      policy_ids?: unknown[];
    };
    rules.push({
      id,
      name: r.name,
      scope: r.context_type[0] === 'CallContract' ? (r.context_type[1] ?? '') : r.context_type[0],
      signers: r.signers.map((s) => (s[0] === 'External' ? `External(${short(s[1])}, ${hex(s[2] ?? new Uint8Array())})` : `${s[0]}(${s[1]})`)),
      policies: (r.policies ?? r.policy_ids ?? []).length,
    });
  }
  return rules;
}

export const short = (s: string, n = 4) => (s.length > 2 * n + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s);

// ---------------------------------------------------------------- CI key

/** Fund a fresh testnet account. The CI key is the fee source of every
 *  publish, so it needs a balance; friendbot gives 10,000 test XLM. */
export async function fundTestnet(publicKey: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT_URL}/?addr=${encodeURIComponent(publicKey)}`);
  if (res.ok) return;
  // Already funded is fine.
  if (await accountExists(publicKey)) return;
  throw new Error(`Friendbot refused to fund ${publicKey} (${res.status}).`);
}

export async function accountExists(publicKey: string): Promise<boolean> {
  try {
    await server.getAccount(publicKey);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- apply_doc

/**
 * Build and preflight the `apply_doc` transaction. The simulation runs the
 * whole apply (perch compiler cross-call, anti-brick check) without the
 * account's signature, so a document the account would refuse fails here,
 * before the wallet opens. `source` only has to exist: the nido wallet
 * re-simulates, signs the account's auth entry with the passkey and submits
 * through its relayer.
 */
export async function buildApplyDocTx(account: string, canonical: string, source: string): Promise<string> {
  const src = await server.getAccount(source);
  const tx = new TransactionBuilder(src, { fee: '1000000', networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(
      Operation.invokeContractFunction({
        contract: account,
        function: 'apply_doc',
        args: [xdr.ScVal.scvBytes(Buffer.from(canonical, 'utf8'))],
      }),
    )
    .setTimeout(600)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`The account would refuse this document: ${firstLine(sim.error)}`);
  }
  // Hand the wallet the bare invocation: it re-simulates and assembles it
  // itself, and the XDR travels in the popup URL, so smaller is safer.
  return tx.toXDR();
}

/** Submit a transaction the wallet returned signed-but-unsubmitted. The CI
 *  key is the envelope source, so it signs the envelope. */
export async function submitSigned(signedXdr: string, source: Keypair): Promise<string> {
  const tx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
  tx.sign(source);
  const sent = await server.sendTransaction(tx);
  if (sent.status === 'ERROR') throw new Error('The network rejected the transaction.');
  return sent.hash;
}

export async function waitForTx(hash: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const res = await server.getTransaction(hash);
    if (res.status === rpc.Api.GetTransactionStatus.SUCCESS) return;
    if (res.status === rpc.Api.GetTransactionStatus.FAILED) throw new Error(`Transaction ${hash} failed.`);
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`Timed out waiting for ${hash}.`);
}
