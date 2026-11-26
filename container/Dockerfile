FROM docker.io/cloudflare/sandbox:1.0.3 AS sdk
FROM node:24.11.1-bookworm-slim
COPY --from=sdk /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git time procps && rm -rf /var/lib/apt/lists/* \
 && npm install --global @anthropic-ai/claude-code@2.1.332 @openai/codex@0.172.0 && npm cache clean --force \
 && mkdir -p /workspace/home/.codex /workspace/home/.claude /workspace/repo && chown -R node:node /workspace
COPY container/project-script.mjs /usr/local/lib/starling-script.mjs
ENV HOME=/workspace/home
CMD ["sleep","infinity"]
