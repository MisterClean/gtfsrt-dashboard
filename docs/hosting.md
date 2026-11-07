# Hosting

The completed `dist/` directory is the release. Visitors download precompiled WASM and run everything locally, so the host needs only static file delivery: no Rust server, database, data volume, environment variables, credentials, ingestion job or query API.

The intended URL is `https://michaelmclean.me/gtfsrt-dashboard/`. The website is an nginx Docker image deployed on Railway. Publishing to it is a separate step that this repository does not perform.

## Website integration

1. Build a release with `npm run build && npm run verify:release`.
2. Copy `dist/` into `gtfsrt-dashboard/` in the website repository. Review the destination before replacing a previous release. Do not copy caches, `target/`, `node_modules/` or development configuration.
3. Add this line to the website Dockerfile:

   ```dockerfile
   COPY gtfsrt-dashboard/ /usr/share/nginx/html/gtfsrt-dashboard/
   ```

4. Add these locations to the nginx server. `^~` keeps the generic trailing-slash location from taking this subtree. nginx header inheritance requires repeating the security headers here, because setting only the policy would discard inherited headers.

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
       add_header Content-Security-Policy "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self' https://storage.googleapis.com/parquet.gtfsrt.io/ https://tiles.openfreemap.org https://data.chicagotransitalerts.app/positions/; worker-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'" always;
       add_header Cache-Control "public, no-cache, no-transform" always;
   }
   ```

   The policy text must match `scripts/security.mjs`. Confirm `.wasm` is served as `application/wasm`, and `.js` and `.mjs` as JavaScript. The same location and policy must cover the DuckDB worker, the map worker and the extensions, because workers don't inherit a page's policy. Cross-origin isolation is unnecessary for the single-threaded DuckDB bundle.

5. Build the website image and validate the nginx configuration. Commit the website integration separately.
6. Verify on HTTPS: page and worker headers, a real archive load, switching views, stop and reload, clearing results, and that the outside connections are the archive bucket, Chicago Transit Alerts positions, and the basemap.

## Release consistency

Vite gives every asset a content-hashed filename, and `index.html` names the exact files. Deploy the whole directory atomically in the website image so old pages never load new workers. Browser and nginx ETags avoid retransferring unchanged assets. DuckDB's WASM is 34 MB, or about 8 MB with gzip or Brotli, so make sure compression is on for `.wasm`.

The build pins extension SHA-256 hashes in `scripts/extensions.mjs` and mirrors the signed Parquet and ICU extensions into the release at `engine/extensions/v2.0.0/wasm_eh/`. In the browser, signature checks stay on, community extensions and automatic installation are off, and DuckDB's extension repository points at the release itself.

## Other hosts

Any static host works if it can set the response headers above, including on worker scripts. Without them the app still runs, but loses the protection the policy provides. The build uses relative paths, so it can live under any directory.
