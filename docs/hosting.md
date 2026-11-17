# Hosting

The completed `dist/` directory is the release. Visitors download precompiled WASM and run the analysis locally. Static file delivery is sufficient for the default gtfsrt.io source.

## Railway production

[Transit Almanac](https://transitalmanac.app/) is served by the `transit-almanac` Railway service. Railway builds and deploys commits pushed to the GitHub `main` branch. The `Dockerfile` builds the Rust and JavaScript release using the pinned toolchain, runs `verify:release`, and packages it in a Caddy image. The image serves precompressed files and applies the security headers in `scripts/security.mjs` to the page and workers.

After a deployment, check that Railway reports `SUCCESS` and that the site loads and analyzes an archive day. The service health check uses `/`.

### Private GTFS-RT archive

Set these variables on the Almanac service. The reader runs in the same Railway
project and environment. The viewer signs in over HTTPS, and Caddy proxies the
compatible objects over Railway's private network.

| Variable | Value |
| --- | --- |
| `ALMANAC_ARCHIVES` | `railway` |
| `GTFSRT_ARCHIVE_GATEWAY` | `${{gtfsrt-archive-reader.RAILWAY_PRIVATE_DOMAIN}}:${{gtfsrt-archive-reader.PORT}}` |
| `ARCHIVE_GATEWAY_TOKEN` | `${{gtfsrt-archive-reader.ARCHIVE_GATEWAY_TOKEN}}` |
| `ALMANAC_ARCHIVE_USER` | Viewer username |
| `ALMANAC_ARCHIVE_PASSWORD_HASH` | Viewer password hashed with `caddy hash-password --algorithm bcrypt` |

This profile serves the source registry in `deploy/archives/railway/` with
schedule joins enabled. Verify that an unsigned request for the archive
inventory receives HTTP 403 and the sign-in page sends an HTTP 401 challenge.
After sign-in, analyze a day and check that a
ranged `HEAD` and a ranged `GET` on a Parquet object both return HTTP 206.

## Register additional archives

Serve `archive-sources.json` beside `index.html`. The shipped file is an empty list. Add one entry per compatible archive with a stable ID and a display label. Set `timezones` to the agencies' IANA time zones from GTFS `agency.txt` where available.

```json
[
  {
    "id": "gtfsrt-archive",
    "label": "GTFS-RT Archive",
    "timezones": {"mbta": "America/New_York"}
  }
]
```

The source picker appears when at least two sources are configured, including gtfsrt.io. Shared links use `?source=gtfsrt-archive`. Keep the ID stable for the same archive because it scopes saved results and shared links.

Serve the following resources from `archives/<id>/compat/v1/` relative to the app directory. A local mirror behind a range-capable static server can also use this layout.

| Resource | Purpose |
| --- | --- |
| `inventory.json` | GTFS-RT-compatible vehicle-position feed inventory |
| `commits/agency={id}/date={UTC}/manifest.json` | Version 1 commit for the agency and UTC date |
| `generations/{generation}/vehicle_positions/date={UTC}/base64url={key}/data.parquet` | Immutable position file referenced by the commit |

For a private B2 bucket, serve these paths through a same-origin, authenticated read-only route. Keep B2 authorization on the server and preserve `HEAD`, `GET`, `Content-Length` and `206 Partial Content` for byte ranges. Reserve `404` for absent objects and return `401` or `403` when access is denied. Apply the same access policy to the inventory, manifests and Parquet files.

For a host that uses browser sign-in, set `"signIn": true` and protect
`archives/<id>/sign-in` with the same credentials as the objects. After
authentication, redirect back to the app with the original query string.

The current B2 archive stores original GTFS ZIPs. For schedule-based reports, publish the compatible `feeds.parquet`, `schedules.json` and `schedules/` tables under the same prefix, then set `"schedules": true` for the source. While those tables are unavailable, Almanac uses the configured time zone and its GPS-only method. It estimates the time zone from positions when no time zone is supplied.

## Alternative website integration

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
       add_header Content-Security-Policy "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self' https://storage.googleapis.com/parquet.gtfsrt.io/ https://tiles.openfreemap.org; worker-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'" always;
       add_header Cache-Control "public, no-cache, no-transform" always;
   }
   ```

   The policy text must match `scripts/security.mjs`. Confirm `.wasm` is served as `application/wasm`, and `.js` and `.mjs` as JavaScript. The same location and policy must cover the DuckDB worker, the map worker and the extensions, because workers don't inherit a page's policy. Cross-origin isolation is unnecessary for the single-threaded DuckDB bundle.

5. Build the website image and validate the nginx configuration. Commit the website integration separately.
6. Verify on HTTPS: page and worker headers, a real archive load, switching views, stop and reload, clearing results, and that the only outside connections are the archive bucket and the basemap.

## Release consistency

Vite gives every asset a content-hashed filename, and `index.html` names the exact files. Deploy the whole directory atomically in the website image so old pages never load new workers. Browser and nginx ETags avoid retransferring unchanged assets. DuckDB's WASM is 34 MB, or about 8 MB with gzip or Brotli, so make sure compression is on for `.wasm`.

The build pins extension SHA-256 hashes in `scripts/extensions.mjs` and mirrors the signed Parquet and ICU extensions into the release at `engine/extensions/v2.0.0/wasm_eh/`. In the browser, signature checks stay on, community extensions and automatic installation are off, and DuckDB's extension repository points at the release itself.

## Other hosts

Any static host works if it can set the response headers above, including on worker scripts. Without them the app still runs, but loses the protection the policy provides. The build uses relative paths, so it can live under any directory.
