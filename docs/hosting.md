# Hosting the static MVP

The completed `dist/` directory is the release. Visitors download precompiled Rust/WASM and run DuckDB locally. The host needs no Rust server, database, data volume, environment variables, credentials, ingestion job, or query API.

The intended URL is `https://michaelmclean.me/gtfsrt-dashboard/`. The existing website is an nginx Docker image deployed on Railway. This MVP has been prepared and tested locally; production integration is a separate publication step.

## Website integration

1. Copy `dist/` into `gtfsrt-dashboard/` in `/Users/mmclean/dev/website/mclean-website`. Review the destination before replacing a previous release. Do not copy caches, `target/`, `node_modules/`, development configuration, or local evidence downloads.
2. Add this line to the website Dockerfile:

   ```dockerfile
   COPY gtfsrt-dashboard/ /usr/share/nginx/html/gtfsrt-dashboard/
   ```

3. Add these locations to the existing nginx server. `^~` keeps the generic trailing-slash location from taking this subtree. nginx header inheritance requires repeating the security headers here; setting only CSP would discard inherited headers.

   ```nginx
   location = /gtfsrt-dashboard {
       return 308 /gtfsrt-dashboard/$is_args$args;
   }

   location ^~ /gtfsrt-dashboard/ {
       try_files $uri $uri/index.html =404;
       add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
       add_header X-Content-Type-Options "nosniff" always;
       add_header X-Frame-Options "DENY" always;
       add_header Referrer-Policy "no-referrer" always;
       add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=()" always;
       add_header Content-Security-Policy "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self' https://storage.googleapis.com/parquet.gtfsrt.io/; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'" always;
       add_header Cache-Control "public, no-cache, no-transform" always;
   }
   ```

   Confirm `.wasm` is served as `application/wasm` and `.js` as JavaScript. The same location and CSP must cover the DuckDB worker and signed extensions. Cross-origin isolation is unnecessary for the single-threaded base bundle.

4. Build the existing website image and validate nginx configuration. Commit website integration separately. Use the existing Railway project/service; do not provision a data store or another service.
5. Verify on HTTPS: page and worker headers, a real archive load, local route filtering, cancel/reload, provenance, and all executable-asset destinations. The only external data destination allowed by policy is the public archive bucket.

## Release consistency

Application JS, Rust WASM, and CSS use content-based filenames. The DuckDB directory hashes the engine, worker, and both extensions together. Deploy the complete directory atomically in the website image. Browser/nginx ETags can avoid retransferring unchanged assets with revalidation enabled.

The build pins extension SHA-256 hashes. The browser leaves signature verification enabled, disables community extensions and automatic installation/loading, and explicitly loads the mirrored Parquet and ICU modules. The tested package reports engine `v2.0.0`, platform `wasm_eh`, and uses extension paths `/v2.0.0/wasm_eh/`; older documentation includes an extra `/duckdb-wasm/` prefix. See [DuckDB’s signed-extension mirror model](https://duckdb.org/docs/2.0/clients/wasm/extensions).

The wrapper is a pinned prerelease. Chromium was exercised; Safari, Firefox, Edge, constrained devices, peak tab memory, and HTTPS website integration remain gates before broader support or capacity claims.
