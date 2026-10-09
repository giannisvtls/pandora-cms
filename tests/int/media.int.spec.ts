// Media round trip through MinIO: a PNG uploaded with the Local API lands in the run's throwaway
// bucket (listed through the S3 API) with exactly the uploaded bytes, at the key the document
// records. tests/int/setup.ts empties and deletes the bucket after the run.
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getPayload, type Payload } from 'payload';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';

import config from '@/payload.config';
import { s3ClientConfig } from '@/env';

const FIXTURE = fileURLToPath(new URL('../fixtures/pixel.png', import.meta.url));

const testEnv = inject('testEnv');
const s3 = new S3Client(s3ClientConfig(testEnv));

let payload: Payload;

beforeAll(async () => {
  payload = await getPayload({ config: await config });
});

afterAll(() => {
  s3.destroy();
});

describe('media: upload through the S3 storage adapter', () => {
  it('stores the uploaded PNG in the run bucket, byte for byte', async () => {
    const fixture = await readFile(FIXTURE);

    const doc = await payload.create({
      collection: 'media',
      data: { alt: 'One transparent pixel' },
      filePath: FIXTURE,
    });
    expect(doc.filename).toBe('pixel.png');
    expect(doc.mimeType).toBe('image/png');
    expect(doc.filesize).toBe(fixture.length);

    // The object's key is the document's `_objectKey` folder (empty for a server-side upload)
    // joined with its filename; the adapter writes to the configured bucket, the run's one.
    const key = [doc._objectKey, doc.filename].filter(Boolean).join('/');
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: testEnv.S3_BUCKET }));
    expect((listed.Contents ?? []).map((object) => object.Key)).toContain(key);

    const object = await s3.send(new GetObjectCommand({ Bucket: testEnv.S3_BUCKET, Key: key }));
    expect(object.ContentType).toBe('image/png');
    const stored = Buffer.from((await object.Body?.transformToByteArray()) ?? []);
    expect(stored.equals(fixture)).toBe(true);
  });
});
