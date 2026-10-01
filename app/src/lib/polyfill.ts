// stellar-sdk's XDR code expects a global Buffer in the browser.
import { Buffer } from 'buffer';

const g = globalThis as { Buffer?: typeof Buffer };
g.Buffer ??= Buffer;
