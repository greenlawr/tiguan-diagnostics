#!/usr/bin/env node
// Drop Quick Import lines into an Evergreen inbox (used by the morning parcel check).
//   node tools/inbox-send.mjs "<evergreen-inbox:… address>" "delivery: Item | Amazon | 123 | 2026-11-24"
// The lines are sealed with the inbox's public key before they leave this machine.
import { seal, parseInboxAddress } from '../js/inbox.js';

const [addr, lines] = process.argv.slice(2);
if (!addr || !lines) { console.error('usage: inbox-send.mjs <address> <lines>'); process.exit(2); }
const { serverUrl, inboxId, publicKey } = parseInboxAddress(addr);
const res = await fetch(`${serverUrl}/inbox/${inboxId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sealed: await seal(publicKey, lines) }) });
const body = await res.text();
if (!res.ok) { console.error(`inbox refused it: ${res.status} ${body}`); process.exit(1); }
console.log('delivered to Evergreen inbox ✓');
