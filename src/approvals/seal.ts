import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Item } from '../store/store.js';

/** The values a person approved, keyed by field. */
export const fieldValues = (item: Pick<Item, 'fields'>) =>
  Object.fromEntries(item.fields.map((f) => [f.key, f.value]));

const sealed = (item: Pick<Item, 'id' | 'kind' | 'title' | 'fields'>) =>
  JSON.stringify([item.kind, item.id, item.title, fieldValues(item)]);

/**
 * HMAC over what was approved (kind, id, title, field values), with a key the agent's user can't read.
 * Executors in another process (a project server) check it before they act; any edit after approval
 * breaks it. Empty when no key is configured.
 */
export function sealItem(
  item: Pick<Item, 'id' | 'kind' | 'title' | 'fields'>,
  key: string | undefined,
): string {
  if (!key) return '';
  return createHmac('sha256', key).update(sealed(item)).digest('hex');
}

export function verifySeal(
  item: Pick<Item, 'id' | 'kind' | 'title' | 'fields' | 'seal'>,
  key: string,
): boolean {
  if (!item.seal) return false;
  const want = Buffer.from(sealItem(item, key), 'hex');
  const got = Buffer.from(item.seal, 'hex');
  return want.length === got.length && timingSafeEqual(want, got);
}
