FROM node:24-bookworm-slim AS node

FROM rust:1.99.1-bookworm AS build
COPY --from=node /usr/local/ /usr/local/
WORKDIR /app

RUN rustup target add wasm32-unknown-unknown \
    && cargo install wasm-bindgen-cli --version 0.2.105 --locked

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY index.html svelte.config.js tsconfig.json vite.config.ts ./
COPY crates/ crates/
COPY public/ public/
COPY scripts/ scripts/
COPY src/ src/
RUN npm run build \
    && npm run verify:release \
    && node scripts/prepare-hosting.mjs

FROM caddy:2.11.8-alpine
COPY --from=build /app/dist/ /srv/
COPY --from=build /app/.build/hosting/security.caddy /etc/caddy/security.caddy
COPY deploy/ /etc/caddy/
USER 65532:65532
EXPOSE 8080
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
