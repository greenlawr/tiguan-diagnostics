// Client side of the shared-household sync. Encrypts local items, pushes them
// to the zero-knowledge server, pulls the merged set, decrypts it. The server
// only ever sees ciphertext plus timestamps (needed to merge).

import { householdId, deriveSharedKey, encryptItem, decryptItem, writeToken } from './household.js';

const endpoint = (serverUrl, id) => serverUrl.replace(/\/+$/, '') + '/' + id;

/**
 * @param localItems map of { itemId: { ...payload, updatedAt, deleted } }
 * @returns merged, decrypted map in the same shape
 */
export async function syncShared(serverUrl, code, localItems, fetchImpl = fetch) {
  const id = await householdId(code);
  const key = await deriveSharedKey(code);

  const payload = {};
  for (const [itemId, item] of Object.entries(localItems)) {
    const { updatedAt = 0, deleted = false, ...rest } = item;
    const blob = await encryptItem(rest, key);
    payload[itemId] = { ...blob, updatedAt, deleted };
  }

  const res = await fetchImpl(endpoint(serverUrl, id), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Evergreen-Token': await writeToken(code) },
    body: JSON.stringify({ items: payload }),
  });
  if (!res.ok) throw new Error(`Sync server returned ${res.status}`);
  const data = await res.json();

  const merged = {};
  for (const [itemId, entry] of Object.entries(data.items || {})) {
    try {
      const rest = await decryptItem(entry, key);
      merged[itemId] = { ...rest, id: itemId, updatedAt: entry.updatedAt, deleted: Boolean(entry.deleted) };
    } catch {
      // Not ours (different household code) — ignore.
    }
  }
  return merged;
}
