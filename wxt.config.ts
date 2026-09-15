import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  manifest: {
    name: 'Highlight Explainer',
    description:
      'Highlight text in an AI chat answer and get a streamed plain-language explanation, right on the page.',
    permissions: ['storage', 'offscreen'],
    // huggingface.co is where the offscreen document downloads the embedding model's files
    // from (transformers.js's default `env.remoteHost`); huggingface.co then 302-redirects
    // the actual weight bytes to its CDN on *.hf.co (observed: us.aws.cdn.hf.co). Declaring
    // both makes those a permission-backed fetch instead of relying on HF happening to send
    // permissive CORS headers.
    host_permissions: ['https://claude.ai/*', 'https://huggingface.co/*', 'https://*.hf.co/*'],
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  },
});
