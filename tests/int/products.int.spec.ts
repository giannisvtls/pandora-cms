// Localization round trip through the Local API on the run's throwaway database: a product saved
// in English and then in Greek reads back per locale, and a locale with no value stays empty
// (fallback is off, so Italian never receives the English name).
import { getPayload, type Payload } from 'payload';
import { beforeAll, describe, expect, it } from 'vitest';

import config from '@/payload.config';

const ENGLISH = 'Camper V3';
const GREEK = 'Κάμπερ V3 (ελληνικά)';

let payload: Payload;
let id: number;

beforeAll(async () => {
  payload = await getPayload({ config: await config });
  const created = await payload.create({
    collection: 'products',
    locale: 'en',
    data: { name: ENGLISH },
  });
  id = created.id;
  await payload.update({
    collection: 'products',
    id,
    locale: 'el',
    data: { name: GREEK },
  });
});

describe('products: localized name', () => {
  it('reads the English name in en', async () => {
    const product = await payload.findByID({ collection: 'products', id, locale: 'en' });
    expect(product.name).toBe(ENGLISH);
  });

  it('reads the Greek name in el', async () => {
    const product = await payload.findByID({ collection: 'products', id, locale: 'el' });
    expect(product.name).toBe(GREEK);
  });

  it('has no name in it (no English fallback)', async () => {
    const product = await payload.findByID({ collection: 'products', id, locale: 'it' });
    // `name` is typed as a string because it is required, but a locale nobody wrote is empty.
    expect(product.name ?? null).toBeNull();
  });

  it('returns exactly the written locales with locale all', async () => {
    const product = await payload.findByID({ collection: 'products', id, locale: 'all' });
    // With `locale: 'all'` a localized field comes back as a locale-keyed object.
    expect(product.name as unknown).toStrictEqual({ en: ENGLISH, el: GREEK });
  });
});
