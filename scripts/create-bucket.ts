// Creates the media bucket (S3_BUCKET) on the S3 endpoint (S3_ENDPOINT) if it does not exist yet.
// Idempotent: when the bucket is already there it changes nothing. Talks plain S3, so the same
// script serves local MinIO, CI and the server.
//
//   npm run create-bucket
import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';

import { loadDotEnvFile, requireEnv, s3ClientConfig } from '../src/env';

loadDotEnvFile();
const env = requireEnv(['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']);
const bucket = env.S3_BUCKET;
const s3 = new S3Client(s3ClientConfig(env));

try {
  if (await bucketExists(s3, bucket)) {
    console.log(`Bucket "${bucket}" already exists; nothing to do.`);
  } else {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    console.log(`Created bucket "${bucket}".`);
  }
} finally {
  s3.destroy();
}

async function bucketExists(client: S3Client, name: string): Promise<boolean> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: name }));
    return true;
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404) return false;
    throw error;
  }
}
