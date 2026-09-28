// The nido wallet's dApp protocol: popup + postMessage, the same round trip
// @nidohq/stellar-wallets-kit-module makes. Implemented here directly because
// the published module (0.1.0) predates the `nido_submitted` return the /sign/
// page now uses for smart-account transactions, which it reports as "no
// result".
//
//   connect: https://<base>/connect/?dapp=<origin>&return=<url>
//            -> posts ?nido_address=C…
//   sign:    https://<c-address>.<base>/sign/?kind=tx&xdr=…&network=…&dapp=…&return=…
//            -> posts ?nido_submitted=<hash> (relayer submitted it)
//               or ?nido_signed=<xdr> (caller submits)
//
// The wallet lives on a per-account subdomain because the passkey's WebAuthn
// rpId is that subdomain, so signing always opens there.

import { StrKey } from '@stellar/stellar-sdk';

const MESSAGE_SOURCE = 'nido-wallet';

function splitScheme(base: string): [string, string] {
  const m = base.match(/^([a-z]+):\/\/(.+?)\/?$/i);
  return m ? [m[1], m[2]] : ['https', base.replace(/\/+$/, '')];
}

export function apexOrigin(base: string): string {
  const [scheme, host] = splitScheme(base);
  return `${scheme}://${host}`;
}

export function accountOrigin(base: string, account: string): string {
  const [scheme, host] = splitScheme(base);
  return `${scheme}://${account.toLowerCase()}.${host}`;
}

function popup(url: string, expectedOrigin: string, timeoutMs = 5 * 60_000): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    const win = window.open(url, 'nido-wallet', 'popup,width=460,height=760');
    if (!win) {
      reject(new Error('The wallet popup was blocked. Allow popups for this page and retry.'));
      return;
    }
    let done = false;
    const finish = () => {
      done = true;
      window.removeEventListener('message', onMessage);
      clearInterval(closed);
      clearTimeout(timer);
    };
    const onMessage = (event: MessageEvent) => {
      // Only the wallet origin we opened may answer.
      if (event.origin !== expectedOrigin) return;
      const data = event.data as { source?: string; search?: string } | null;
      if (!data || data.source !== MESSAGE_SOURCE) return;
      finish();
      try {
        win.close();
      } catch {
        /* already closed */
      }
      resolve(new URLSearchParams(data.search ?? ''));
    };
    window.addEventListener('message', onMessage);
    const closed = setInterval(() => {
      if (!done && win.closed) {
        finish();
        reject(new Error('The wallet window was closed before it finished.'));
      }
    }, 500);
    const timer = setTimeout(() => {
      if (done) return;
      finish();
      reject(new Error('Timed out waiting for the wallet.'));
    }, timeoutMs);
  });
}

const returnUrl = () => window.location.href.split('#')[0];

/** Ask the wallet which smart account to use. */
export async function connect(base: string, previous?: string): Promise<string> {
  const u = new URL('/connect/', apexOrigin(base));
  u.searchParams.set('dapp', window.location.origin);
  u.searchParams.set('return', returnUrl());
  if (previous) u.searchParams.set('previous', previous);
  const p = await popup(u.toString(), apexOrigin(base));
  const address = p.get('nido_address')?.toUpperCase();
  if (address) {
    if (!StrKey.isValidContract(address)) throw new Error(`The wallet returned a non-contract address: ${address}`);
    return address;
  }
  if (p.get('nido_connect') === 'cancelled') throw new Error('Account selection was cancelled.');
  throw new Error(p.get('nido_error') ?? 'The wallet returned no account.');
}

export type SignResult = { submitted: true; hash: string } | { submitted: false; signedXdr: string };

/** Have the account's passkey sign `xdr`. The wallet shows the user what the
 *  transaction does, runs the passkey ceremony, and usually submits it
 *  through the nido relayer itself. */
export async function signTransaction(base: string, account: string, xdr: string, network: string): Promise<SignResult> {
  const u = new URL('/sign/', accountOrigin(base, account));
  u.searchParams.set('kind', 'tx');
  u.searchParams.set('xdr', xdr);
  u.searchParams.set('network', network);
  u.searchParams.set('dapp', window.location.origin);
  u.searchParams.set('return', returnUrl());
  const p = await popup(u.toString(), accountOrigin(base, account));
  const submitted = p.get('nido_submitted');
  if (submitted) return { submitted: true, hash: submitted };
  const signed = p.get('nido_signed');
  if (signed) return { submitted: false, signedXdr: signed };
  const status = p.get('nido_sign');
  if (status === 'cancelled') throw new Error('Signing was cancelled in the wallet.');
  if (status === 'switch-account') throw new Error('The wallet asked to switch accounts. Connect again, then retry.');
  throw new Error(p.get('nido_error') ?? 'The wallet returned no signature.');
}
