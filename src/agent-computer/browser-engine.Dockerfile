# Separate browser-engine candidate. Build context: src/agent-computer only.
# No Lilly credentials, provider keys, user workspaces or model are included.
# The supervisor must supply private profile storage and enforced sandbox policy.
FROM docker.io/library/node@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

WORKDIR /opt/lilly-browser
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/lilly-browser/browsers \
    NODE_PATH=/opt/lilly-browser/node_modules \
    HOME=/tmp
COPY install-browser-driver.js ./install-browser-driver.js
RUN node install-browser-driver.js \
    && node node_modules/playwright-core/cli.js install --with-deps chromium \
    && node -e "const fs=require('fs'); const p=require('playwright-core'); fs.accessSync(p.chromium.executablePath(),fs.constants.X_OK);" \
    && chmod -R a+rX /opt/lilly-browser

LABEL lilly.browser-runtime="bundled-playwright" \
      lilly.playwright-version="1.63.0"
COPY runtime.js profile-lease.js stdio-channel.js remote-runtime.js stdio-worker.js ./worker/
RUN cd worker && sha256sum runtime.js profile-lease.js stdio-channel.js remote-runtime.js stdio-worker.js > source-sha256.txt \
    && chmod -R a+rX /opt/lilly-browser/worker
LABEL lilly.private-computer-transport="stdio-v1"
USER 10001:10001
# No self-starting agent. Deployment supplies the private browser transport.
CMD ["node", "-e", "console.log('Lilly browser engine requires its private supervisor transport.'); process.exitCode=2"]
