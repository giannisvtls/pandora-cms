import type { CollectionConfig } from 'payload';

// The product catalogue. Phase 0 holds only the localized name; the content model adds the rest.
export const Products: CollectionConfig = {
  slug: 'products',
  admin: {
    useAsTitle: 'name',
  },
  fields: [
    {
      name: 'name',
      type: 'text',
      // Each locale stores its own value; with fallback off, a locale without one reads as empty.
      localized: true,
      // Required per locale: a save in a locale must carry that locale's name (no English filler),
      // and a product is never nameless in the locale it was created in.
      required: true,
    },
  ],
};
