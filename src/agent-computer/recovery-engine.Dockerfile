# Build context: repository root, restricted by the adjacent Dockerfile ignore.
# Private recovery helper only: no browser, model, credentials or exposed ports.
FROM docker.io/library/node@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
WORKDIR /opt/lilly-recovery
COPY src/agent-computer/recovery-worker.js src/agent-computer/profile-recovery.js src/agent-computer/directory-lock.js src/agent-computer/runtime.js src/agent-computer/profile-lease.js src/agent-computer/stop-evidence.js src/agent-computer/node-binding.js src/agent-computer/recovery-helper.js ./src/agent-computer/
COPY src/agent-teams/cgroup-reader.js ./src/agent-teams/
RUN test -x /usr/bin/flock \
    && node -e "require('./src/agent-computer/recovery-worker')" \
    && sha256sum src/agent-computer/*.js src/agent-teams/*.js > source-sha256.txt \
    && chmod -R a+rX /opt/lilly-recovery
ENV HOME=/tmp
LABEL lilly.private-profile-recovery="stdio-v1"
USER 10001:10001
CMD ["node", "-e", "console.log('Lilly recovery helper requires its private supervisor transport.'); process.exitCode=2"]
