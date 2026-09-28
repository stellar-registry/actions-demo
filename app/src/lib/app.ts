import './polyfill';
import { Keypair } from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';
import { canonicalJson, docHash } from '@stellar-registry/perch';
import type { PolicyDoc } from '@stellar-registry/perch';
import {
  DEFAULT_NIDO_BASE,
  DEFAULT_WASM_NAME,
  EXPLORER,
  NETWORK_PASSPHRASE,
  RULE_NAME,
  UNVERIFIED_REGISTRY,
} from './config';
import {
  buildApplyDocTx,
  fundTestnet,
  isContract,
  readAccountPolicy,
  readRegistry,
  readRules,
  resolveEd25519Verifier,
  short,
  submitSigned,
  waitForTx,
} from './chain';
import type { AccountPolicy } from './chain';
import { connect, signTransaction } from './nido';
import { describeRule, diffDocs, upsertPublishKey } from './policy';

// ------------------------------------------------------------------ dom

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);

type Child = Node | string | null | undefined | false;
function h(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) if (c) el.append(c);
  return el;
}
const code = (s: string) => h('code', {}, s);
const link = (href: string, text: string) => h('a', { href, target: '_blank', rel: 'noopener' }, text);
const contractLink = (id: string) => link(`${EXPLORER}/contract/${id}`, id);
const accountLink = (id: string) => link(`${EXPLORER}/account/${id}`, id);

function facts(el: HTMLElement, rows: Array<[string, Child]>) {
  el.replaceChildren(...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
  el.classList.remove('hidden');
}

function status(id: string, msg: string, err = false) {
  const el = $(id);
  el.textContent = msg;
  el.classList.toggle('err', err);
}

type StepState = 'locked' | 'active' | 'done';
function step(id: string, state: StepState) {
  $(id).dataset.state = state;
  const ok = $(`${id.replace('step-', '')}-ok`);
  ok?.classList.toggle('hidden', state !== 'done');
}

async function busy(btn: HTMLButtonElement, label: string, fn: () => Promise<void>, statusId: string) {
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try {
    await fn();
  } catch (e) {
    status(statusId, e instanceof Error ? e.message : String(e), true);
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
}

// Per-viewer conveniences only (never the secret).
const remember = (k: string, v: string) => {
  try {
    localStorage.setItem(`actions-demo:${k}`, v);
  } catch {
    /* storage unavailable */
  }
};
const recall = (k: string) => {
  try {
    return localStorage.getItem(`actions-demo:${k}`);
  } catch {
    return null;
  }
};

// ------------------------------------------------------------------ state

let registry = '';
let wasmNames: string[] = [];
let verifier = { address: '', resolved: false };
let account = '';
let policy: AccountPolicy | null = null;
/** Held in memory only between generation and the apply, in case the wallet
 *  returns a signed-but-unsubmitted transaction whose envelope this key (the
 *  source) must sign. Dropped once the apply lands. */
let keypair: Keypair | null = null;
let publicKey = '';
let funded = false;
let nextDoc: PolicyDoc | null = null;

const nidoBase = () => input('nido-base').value.trim() || DEFAULT_NIDO_BASE;
const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

// ------------------------------------------------------------------ 1 · registry

async function checkRegistry() {
  const reg = input('registry').value.trim().toUpperCase();
  const names = input('names')
    .value.split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!isContract(reg)) throw new Error('The registry must be a contract address (C…).');
  if (names.length === 0) throw new Error('List at least one wasm name.');
  const bad = names.find((n) => !NAME_RE.test(n));
  if (bad) throw new Error(`"${bad}" is not a valid registry name (letter first, then letters, digits, - or _).`);

  status('registry-status', 'Reading the registry…');
  const [info, ver] = await Promise.all([readRegistry(reg, names), resolveEd25519Verifier()]);
  registry = reg;
  wasmNames = names;
  verifier = ver;
  remember('registry', reg);
  remember('names', names.join(', '));

  facts($('registry-facts'), [
    ['Registry', contractLink(reg)],
    ['Manager', info.manager ? h('span', {}, contractLink(info.manager), ' (approves first publishes)') : 'none (the first publish of a name claims it)'],
    ...names.map((n): [string, Child] => [
      n,
      info.versions[n] ? `published, current version ${info.versions[n]}` : 'not published yet: the first CI publish claims it for your account',
    ]),
    ['ed25519 verifier', h('span', {}, contractLink(ver.address), ver.resolved ? ' (resolved by name)' : ' (pinned fallback)')],
  ]);
  status(
    'registry-status',
    info.manager
      ? 'This registry is managed: its manager must approve the first publish of a new name before CI can take over.'
      : '',
  );
  input('registry').readOnly = true;
  input('names').readOnly = true;
  $<HTMLButtonElement>('check-registry').classList.add('hidden');
  step('step-registry', 'done');
  step('step-wallet', 'active');
}

// ------------------------------------------------------------------ 2 · wallet

async function connectWallet() {
  remember('nido-base', nidoBase());
  status('wallet-status', 'Waiting for the nido window…');
  const acct = await connect(nidoBase(), account || recall('account') || undefined);
  status('wallet-status', 'Reading the account policy…');
  const p = await readAccountPolicy(acct);
  account = acct;
  policy = p;
  remember('account', acct);

  facts($('wallet-facts'), [
    ['Account', contractLink(acct)],
    ['Policy document', p.appliedHash ? code(`${p.appliedHash.slice(0, 16)}…`) : 'none applied yet'],
  ]);
  $('first-apply').classList.toggle('hidden', p.applied !== null);
  $('current-rules').replaceChildren(
    h('div', { class: 'section-label' }, p.applied ? 'Current rules' : 'Starting point (nido baseline)'),
    ...p.base.rules.map((r) => h('div', { class: 'rule-card' }, h('div', { class: 'rname' }, r.name), h('div', { class: 'rdesc' }, describeRule(r)))),
  );
  status('wallet-status', '');
  step('step-wallet', 'done');
  if ($('step-key').dataset.state === 'locked') step('step-key', 'active');
  if (publicKey) renderReview();
}

// ------------------------------------------------------------------ 3 · key

async function generateKey() {
  keypair = Keypair.random();
  publicKey = keypair.publicKey();
  $('secret-value').textContent = keypair.secret();
  $('secret-box').classList.remove('hidden');
  $('gen-row').classList.add('hidden');
  renderKeyFacts();
  status('key-status', 'Funding the key with test XLM (it pays the publish fees)…');
  await fundTestnet(publicKey);
  funded = true;
  renderKeyFacts();
  status('key-status', '');
  maybeUnlockReview();
}

function renderKeyFacts() {
  facts($('key-facts'), [
    ['Public key', accountLink(publicKey)],
    ['On-chain signer', code(`External(${short(verifier.address)}, ${Buffer.from(Keypair.fromPublicKey(publicKey).rawPublicKey()).toString('hex').slice(0, 16)}…)`)],
    ['Funded', funded ? 'yes, 10,000 test XLM from friendbot' : 'pending…'],
  ]);
}

function secretStored() {
  // Remove the secret from the page for good; there is no way to show it again.
  $('secret-value').textContent = '';
  $('secret-box').remove();
  step('step-key', 'done');
  maybeUnlockReview();
}

function maybeUnlockReview() {
  if (!funded || $('step-key').dataset.state !== 'done' || !policy) return;
  renderReview();
  if ($('step-apply').dataset.state === 'locked') step('step-apply', 'active');
}

// ------------------------------------------------------------------ 4 · review + apply

function signerCard(s: PolicyDoc['signers'][number], cls: string, verb: string): HTMLElement {
  const what = 'address' in s ? `Delegated(${s.address})` : `External(${s.verifier}, ${s.key})`;
  return h('div', { class: `rule-card ${cls}` }, h('div', { class: 'rname' }, `${verb} signer · ${s.id}`), h('div', { class: 'rdesc mono' }, what));
}

function ruleCard(r: PolicyDoc['rules'][number], cls: string, verb: string): HTMLElement {
  const details: Child[] = [];
  if (r.name === RULE_NAME) {
    details.push(
      h(
        'ul',
        {},
        h('li', {}, 'function must be ', code('publish_hash')),
        h('li', {}, 'argument 0 (wasm name) must be one of ', code(wasmNames.join(', '))),
        h('li', {}, 'argument 1 (author) must be this account'),
        h('li', {}, 'checked on every call by the perch interpreter policy'),
      ),
    );
  }
  return h('div', { class: `rule-card ${cls}` }, h('div', { class: 'rname' }, `${verb} rule · ${r.name}`), h('div', { class: 'rdesc' }, describeRule(r)), ...details);
}

function renderReview() {
  if (!policy || !publicKey) return;
  nextDoc = upsertPublishKey(
    policy.base,
    {
      registry,
      wasmNames,
      verifier: verifier.address,
      publicKeyHex: Buffer.from(Keypair.fromPublicKey(publicKey).rawPublicKey()).toString('hex'),
    },
    NETWORK_PASSPHRASE,
  );
  const d = diffDocs(policy.applied, nextDoc);
  const kept = nextDoc.rules.filter((r) => !d.rulesAdded.includes(r) && !d.rulesChanged.some((c) => c.after === r));
  $('diff').replaceChildren(
    h('div', { class: 'section-label' }, 'What changes'),
    ...d.signersAdded.map((s) => signerCard(s, 'added', 'Adds')),
    ...d.signersRemoved.map((s) => signerCard(s, 'removed', 'Removes')),
    ...d.rulesAdded.map((r) => ruleCard(r, 'added', 'Adds')),
    ...d.rulesChanged.map((c) => ruleCard(c.after, 'added', 'Replaces')),
    ...d.rulesRemoved.map((r) => ruleCard(r, 'removed', 'Removes')),
    ...(kept.length ? [h('div', { class: 'section-label' }, 'Unchanged'), ...kept.map((r) => ruleCard(r, '', 'Keeps'))] : []),
  );
  const canonical = canonicalJson(nextDoc);
  facts($('doc-facts'), [
    ['New doc hash', code(docHash(nextDoc))],
    ['Replaces', policy.appliedHash ? code(policy.appliedHash) : 'nothing (first apply)'],
    ['Size', `${new TextEncoder().encode(canonical).length} bytes`],
  ]);
  $('doc-json').textContent = JSON.stringify(JSON.parse(canonical), null, 2);
}

async function applyDoc() {
  if (!nextDoc || !policy) throw new Error('Nothing to apply yet.');
  const canonical = canonicalJson(nextDoc);
  status('apply-status', 'Simulating apply_doc…');
  const xdr = await buildApplyDocTx(account, canonical, publicKey);
  status('apply-status', 'Approve the change with your passkey in the nido window…');
  const res = await signTransaction(nidoBase(), account, xdr, NETWORK_PASSPHRASE);
  let hash: string;
  if (res.submitted) {
    hash = res.hash;
  } else {
    if (!keypair) throw new Error('The wallet returned a signed transaction but the key is gone. Reload and retry.');
    status('apply-status', 'Submitting…');
    hash = await submitSigned(res.signedXdr, keypair);
  }
  status('apply-status', `Waiting for ${short(hash, 6)}…`);
  await waitForTx(hash);
  keypair = null;
  status('apply-status', '');
  step('step-apply', 'done');
  $<HTMLButtonElement>('apply').classList.add('hidden');
  await renderDone(hash);
}

// ------------------------------------------------------------------ 5 · done

async function renderDone(hash: string) {
  const rules = await readRules(account);
  const rule = rules.find((r) => r.name === RULE_NAME);
  const after = await readAccountPolicy(account);
  facts($('done-facts'), [
    ['apply_doc tx', link(`${EXPLORER}/tx/${hash}`, hash)],
    ['Author account', contractLink(account)],
    ['Applied doc hash', code(after.appliedHash ?? '?')],
    ['Rule', rule ? `#${rule.id} ${rule.name}, ${rule.policies} policy (perch interpreter)` : 'not found'],
    ['Rule scope', rule ? contractLink(rule.scope) : '-'],
    ['Rule signer', rule ? code(rule.signers.join(', ')) : '-'],
    ['CI key', accountLink(publicKey)],
  ]);
  const repo = pagesRepo() ?? 'stellar-registry/actions-demo';
  const settings: Array<[string, string, Child]> = [
    ['REGISTRY_CONTRACT_ID', 'variable', code(registry)],
    ['AUTHOR_ADDRESS', 'variable', code(account)],
    ['CI_PUBLISH_SECRET_KEY', 'secret', h('span', {}, 'the S… secret you stored in step 3 (public key ', code(short(publicKey, 6)), ')')],
  ];
  $('settings').replaceChildren(...settings.map(([n, k, v]) => h('tr', {}, h('td', {}, code(n)), h('td', {}, k), h('td', {}, v))));
  $('gh-commands').textContent = [
    `gh variable set REGISTRY_CONTRACT_ID --body ${registry} --repo ${repo}`,
    `gh variable set AUTHOR_ADDRESS --body ${account} --repo ${repo}`,
    `gh secret set CI_PUBLISH_SECRET_KEY --repo ${repo}   # paste the secret when prompted`,
  ].join('\n');
  step('step-done', 'done');
}

/** owner/repo when served from GitHub Pages (<owner>.github.io/<repo>/), so a
 *  fork's page prints commands for the fork. */
function pagesRepo(): string | null {
  const { hostname, pathname } = window.location;
  const repo = pathname.split('/')[1];
  return hostname.endsWith('.github.io') && repo ? `${hostname.split('.')[0]}/${repo}` : null;
}

// ------------------------------------------------------------------ wiring

input('registry').value = recall('registry') ?? UNVERIFIED_REGISTRY;
input('names').value = recall('names') ?? DEFAULT_WASM_NAME;
input('nido-base').value = recall('nido-base') ?? DEFAULT_NIDO_BASE;
const newNido = () => $<HTMLAnchorElement>('new-nido');
const syncNewNido = () => {
  const b = nidoBase();
  newNido().href = `${/^[a-z]+:\/\//i.test(b) ? b : `https://${b}`}/new-account/`;
};
syncNewNido();
input('nido-base').addEventListener('input', syncNewNido);

const btn = (id: string) => $<HTMLButtonElement>(id);
btn('check-registry').addEventListener('click', () => void busy(btn('check-registry'), 'Checking…', checkRegistry, 'registry-status'));
btn('connect').addEventListener('click', () =>
  void busy(btn('connect'), 'Connecting…', connectWallet, 'wallet-status').then(() => {
    if (account) btn('connect').textContent = 'Switch account';
  }),
);
btn('generate').addEventListener('click', () => void busy(btn('generate'), 'Generating…', generateKey, 'key-status'));
btn('copy-secret').addEventListener('click', () => {
  const s = $('secret-value').textContent ?? '';
  void navigator.clipboard.writeText(s).then(
    () => (btn('copy-secret').textContent = 'Copied'),
    () => status('key-status', 'Copy failed: select the secret and copy it by hand.', true),
  );
});
input('stored').addEventListener('change', () => {
  if (input('stored').checked) secretStored();
});
btn('apply').addEventListener('click', () => void busy(btn('apply'), 'Applying…', applyDoc, 'apply-status'));
