#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const LOCK_PATH = path.join(ROOT_DIR, 'package-lock.json');
const INCLUDE_OPTIONAL = process.argv.includes('--include-optional');
const INCLUDE_DEV = process.argv.includes('--include-dev');

const DISALLOWED_DIRECT_PACKAGES = new Map([
  ['ffmpeg-static', 'bundles a GPL ffmpeg binary'],
  ['gsap', 'uses a non-standard no-charge license; keep it as an explicit user/CDN choice'],
  ['kokoro-js', 'pulls in the eSpeak-backed phonemizer path'],
  ['p5', 'uses LGPL-2.1; keep it as an explicit user/CDN choice'],
  ['phonemizer', 'bundles an eSpeak NG-based G2P runtime'],
]);

const LOCK_LICENSE_EXCEPTIONS = new Map([
  [
    'node_modules/png-js',
    {
      effectiveLicense: 'MIT',
      reason: 'package metadata omits license, but the installed package LICENSE file is MIT',
    },
  ],
]);

const PERMISSIVE_LICENSES = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BlueOak-1.0.0',
  'CC-BY-4.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'Python-2.0',
  'Unlicense',
  'Unicode-3.0',
  'Unicode-DFS-2016',
  'Zlib',
]);

const PROHIBITED_PATTERNS = [
  /\bAGPL\b/i,
  /\bBUSL\b/i,
  /\bSSPL\b/i,
  /\bUNLICENSED\b/i,
  /\bSEE LICENSE\b/i,
  /non[- ]?commercial/i,
];

const COPYLEFT_PATTERNS = [
  /\bGPL\b/i,
  /\bLGPL\b/i,
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function packageNameFromPath(packagePath = '') {
  return String(packagePath || '').replace(/^node_modules\//, '');
}

function normalizeLicenseExpression(value = '') {
  return String(value || '')
    .replace(/[()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitLicenseExpression(value = '', operator = 'OR') {
  const escaped = operator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return normalizeLicenseExpression(value)
    .split(new RegExp(`\\s+${escaped}\\s+`, 'i'))
    .map((part) => part.trim())
    .filter(Boolean);
}

function isPermissiveLicensePart(part = '') {
  const licenseIds = splitLicenseExpression(part, 'AND');
  return licenseIds.length > 0 && licenseIds.every((licenseId) => PERMISSIVE_LICENSES.has(licenseId));
}

function hasPermissiveChoice(license = '') {
  const choices = splitLicenseExpression(license, 'OR');
  return choices.some(isPermissiveLicensePart);
}

function hasPattern(patterns = [], value = '') {
  return patterns.some((pattern) => pattern.test(String(value || '')));
}

function shouldSkipPackage(packageMeta = {}) {
  if (!INCLUDE_DEV && packageMeta.dev) {
    return true;
  }
  if (!INCLUDE_OPTIONAL && packageMeta.optional) {
    return true;
  }
  return false;
}

function auditDirectDependencies(rootPackage = {}) {
  const failures = [];
  const directDependencies = {
    ...(rootPackage.dependencies || {}),
    ...(INCLUDE_DEV ? rootPackage.devDependencies || {} : {}),
  };

  for (const packageName of Object.keys(directDependencies)) {
    const reason = DISALLOWED_DIRECT_PACKAGES.get(packageName);
    if (reason) {
      failures.push(`${packageName}: ${reason}`);
    }
  }

  return failures;
}

function auditPackageLicenses(packages = {}) {
  const failures = [];
  const warnings = [];
  let checked = 0;
  let skippedOptional = 0;
  let skippedDev = 0;

  for (const [packagePath, packageMeta] of Object.entries(packages)) {
    if (!packagePath) {
      continue;
    }
    if (!INCLUDE_DEV && packageMeta.dev) {
      skippedDev += 1;
    }
    if (!INCLUDE_OPTIONAL && packageMeta.optional) {
      skippedOptional += 1;
    }
    if (shouldSkipPackage(packageMeta)) {
      continue;
    }

    checked += 1;
    const exception = LOCK_LICENSE_EXCEPTIONS.get(packagePath);
    const license = exception?.effectiveLicense || packageMeta.license || '';
    const packageName = packageMeta.name || packageNameFromPath(packagePath);

    if (exception) {
      warnings.push(`${packageName}: ${exception.reason}`);
    }

    if (!license) {
      failures.push(`${packageName}: missing license metadata`);
      continue;
    }

    if (hasPattern(PROHIBITED_PATTERNS, license)) {
      failures.push(`${packageName}: prohibited license expression "${license}"`);
      continue;
    }

    if (hasPattern(COPYLEFT_PATTERNS, license) && !hasPermissiveChoice(license)) {
      failures.push(`${packageName}: copyleft license expression "${license}"`);
      continue;
    }

    if (!hasPermissiveChoice(license)) {
      failures.push(`${packageName}: unapproved license expression "${license}"`);
    }
  }

  return {
    checked,
    skippedDev,
    skippedOptional,
    warnings,
    failures,
  };
}

function main() {
  const lock = readJson(LOCK_PATH);
  const rootPackage = lock.packages?.[''] || {};
  const directFailures = auditDirectDependencies(rootPackage);
  const packageAudit = auditPackageLicenses(lock.packages || {});
  const failures = [
    ...directFailures.map((failure) => `direct dependency ${failure}`),
    ...packageAudit.failures,
  ];

  console.log(`[License Gate] checked=${packageAudit.checked} skippedOptional=${packageAudit.skippedOptional} skippedDev=${packageAudit.skippedDev}`);
  if (packageAudit.warnings.length > 0) {
    console.log('[License Gate] reviewed exceptions:');
    packageAudit.warnings.forEach((warning) => console.log(`  - ${warning}`));
  }

  if (failures.length > 0) {
    console.error('[License Gate] failed:');
    failures.forEach((failure) => console.error(`  - ${failure}`));
    process.exit(1);
  }

  console.log('[License Gate] passed: no bundled production license blockers found.');
}

if (require.main === module) {
  main();
}

module.exports = {
  auditDirectDependencies,
  auditPackageLicenses,
  hasPermissiveChoice,
};
