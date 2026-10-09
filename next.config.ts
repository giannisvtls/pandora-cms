import { withPayload } from '@payloadcms/next/withPayload';
import type { NextConfig } from 'next';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(__filename);

const nextConfig: NextConfig = {
  // The production image (Dockerfile) runs `.next/standalone/server.js`: only the traced runtime
  // files, no full node_modules.
  output: 'standalone',
  // No `X-Powered-By` header. With this set to false, `withPayload` also skips its own
  // `X-Powered-By: Next.js, Payload` header.
  poweredByHeader: false,
  images: {
    localPatterns: [
      {
        pathname: '/api/media/file/**',
      },
    ],
  },
  // The CMS has no pages of its own (the static site renders every page): `/` goes to the admin.
  // Temporary (307), so browsers do not cache it if a page is ever served here.
  async redirects() {
    return [{ source: '/', destination: '/admin', permanent: false }];
  },
  webpack: (webpackConfig) => {
    webpackConfig.resolve.extensionAlias = {
      '.cjs': ['.cts', '.cjs'],
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
    };

    return webpackConfig;
  },
  turbopack: {
    root: path.resolve(dirname),
  },
};

export default withPayload(nextConfig, { devBundleServerPackages: false });
