'use strict';

const fs = require('node:fs');
const path = require('node:path');

test('browser package includes only private runtime code after pinned engine installation', () => {
  const recipe = fs.readFileSync(path.join(__dirname, 'browser-engine.Dockerfile'), 'utf8');
  const ignore = fs.readFileSync(path.join(__dirname, '.dockerignore'), 'utf8');
  expect(recipe).toMatch(/FROM docker\.io\/library\/node@sha256:[a-f0-9]{64}/);
  expect(recipe).toContain('COPY runtime.js profile-lease.js stdio-channel.js remote-runtime.js stdio-worker.js ./worker/');
  expect(recipe).toContain('sha256sum runtime.js profile-lease.js stdio-channel.js remote-runtime.js stdio-worker.js > source-sha256.txt');
  expect(recipe).toContain('USER 10001:10001');
  expect(recipe).not.toMatch(/^EXPOSE /m);
  expect(ignore.trim().split(/\r?\n/)).toEqual(['*', '!browser-engine.Dockerfile', '!install-browser-driver.js',
    '!runtime.js', '!profile-lease.js', '!stdio-channel.js', '!remote-runtime.js', '!stdio-worker.js']);
  // This is a build-recipe contract, not evidence that an image was built.
});
