FROM docker.io/cloudflare/sandbox:1.0.3 AS sdk
FROM node:24.11.1-bookworm-slim
COPY --from=sdk /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git time procps && rm -rf /var/lib/apt/lists/* \
 && npm install --global @anthropic-ai/claude-code@2.1.332 @openai/codex@0.172.0 && npm cache clean --force \
 && mkdir -p /workspace/home/.codex /workspace/home/.claude /workspace/repo && chown -R node:node /workspace
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/starling/browsers
RUN npm install --prefix /opt/starling --no-audit --no-fund playwright-core@1.65.1 \
 && /opt/starling/node_modules/.bin/playwright-core install --with-deps --only-shell chromium \
 && rm -rf /var/lib/apt/lists/* && npm cache clean --force
COPY container/preview.mjs /usr/local/lib/starling-preview.mjs
COPY container/project-script.mjs /usr/local/lib/starling-script.mjs
ENV HOME=/workspace/home
CMD ["sleep","infinity"]
