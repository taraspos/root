import os from 'os';
import path from 'path';

import * as cache from '@actions/cache';
import * as core from '@actions/core';
import * as tc from '@actions/tool-cache';
import semver from 'semver';

const State = {
  CacheKey: 'CACHE_KEY',
  CacheResult: 'CACHE_RESULT',
  CachePath: 'CACHE_PATH',
};

function getPlatform(rawPlatform: string): string {
  switch (rawPlatform) {
    case 'linux': {
      return 'linux';
    }
  }
  throw new Error(`platform ${rawPlatform} not supported`);
}

function getArch(rawArch: string): string {
  switch (rawArch) {
    case 'x64': {
      return 'amd64';
    }
    case 'arm': {
      return 'arm';
    }
    case 'arm64': {
      return 'arm64';
    }
  }
  throw new Error(`architecture ${rawArch} not supported`);
}

/**
 * versionString converts a requested version, OS and architecture to a format
 * which can be used to fetch a bundle from the Teleport download site.
 */
function versionString(
  rawPlatform: string,
  rawArch: string,
  version: string
): string {
  const platform = getPlatform(rawPlatform);
  const arch = getArch(rawArch);

  return `v${version}-${platform}-${arch}`;
}

interface Inputs {
  version: string;
  enterprise: boolean;
  proxyAddr: string;
  cacheEnabled: boolean;
}

function getInputs(): Inputs {
  const version = core.getInput('version');
  if (version === '') {
    throw new Error("'version' input must be non-empty");
  }

  const enterprise = core.getBooleanInput('enterprise');
  const proxyAddr = core.getInput('proxy');

  if (version !== 'auto') {
    if (version.startsWith('v')) {
      throw new Error("'version' input should not be prefixed with 'v'");
    }
    const versionRegex =
      /^([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+)?$/i;

    if (!versionRegex.test(version)) {
      throw new Error(
        "incorrect 'version' specified, it should include all parts of the version e.g 11.0.1 or be set to 'auto'"
      );
    }
  } else {
    if (proxyAddr === '') {
      throw new Error(
        "'proxy' input must be non-empty when 'version' is set to 'auto'"
      );
    }
  }

  const cacheEnabled = core.getBooleanInput('cache');

  return {
    version,
    enterprise,
    proxyAddr,
    cacheEnabled,
  };
}

async function fetchVersionFromProxy(proxyAddr: string): Promise<string> {
  const resp = await fetch(`https://${proxyAddr}/webapi/find`);
  const data = await resp.json();
  const version = data?.auto_update?.tools_version;
  if (!version) {
    throw new Error(
      `malformed response from proxy missing version: ${JSON.stringify(data)}`
    );
  }
  return version;
}

function isGhes(): boolean {
  const ghUrl = new URL(
    process.env['GITHUB_SERVER_URL'] || 'https://github.com'
  );
  const hostname = ghUrl.hostname.trimEnd().toUpperCase();
  const isGitHubHost = hostname === 'GITHUB.COM';
  const isGheCloudHost = hostname.endsWith('.GHE.COM');
  const isLocalHost = hostname.endsWith('.LOCALHOST');
  return !isGitHubHost && !isGheCloudHost && !isLocalHost;
}

function isCacheFeatureAvailable(): boolean {
  if (cache.isFeatureAvailable()) return true;

  if (isGhes()) {
    core.warning(
      'Cache action is only supported on GHES version >= 3.5. If you are on version >=3.5 Please check with GHES admin if Actions cache service is enabled or not.'
    );
    return false;
  }

  core.warning(
    'The runner was not able to contact the cache service. Caching will be skipped'
  );
  return false;
}

function getToolCachePath(toolName: string, version: string): string {
  const toolCacheDir = process.env['RUNNER_TOOL_CACHE'] || '';
  if (!toolCacheDir) {
    return '';
  }
  // Match the path that tc.cacheDir/tc.find produce internally
  const cleanVersion = semver.clean(version) || version;
  return path.join(toolCacheDir, toolName, cleanVersion, os.arch());
}

async function run(): Promise<void> {
  const inputs = getInputs();

  if (inputs.version === 'auto') {
    core.info(`Fetching version from proxy: ${inputs.proxyAddr}`);
    const proxyVersion = await fetchVersionFromProxy(inputs.proxyAddr);
    core.info(`Fetched version: ${proxyVersion}`);
    inputs.version = proxyVersion;
  }

  const version = versionString(os.platform(), os.arch(), inputs.version);
  const toolName = inputs.enterprise ? 'teleport-ent' : 'teleport';
  core.info(`Installing ${toolName} ${version}`);

  // Check tool cache first (local to the runner)
  const toolPath = tc.find(toolName, version);
  if (toolPath !== '') {
    core.info('Teleport binaries found in tool cache.');
    core.addPath(toolPath);
    return;
  }

  // Try GitHub Cache (shared between runs)
  if (inputs.cacheEnabled && isCacheFeatureAvailable()) {
    const cacheKey = `teleport-setup-${toolName}-${version}`;
    core.saveState(State.CacheKey, cacheKey);

    const toolCachePath = getToolCachePath(toolName, version);
    if (toolCachePath) {
      try {
        core.info('Attempting to restore from GitHub Actions cache...');
        const matchedKey = await cache.restoreCache([toolCachePath], cacheKey);
        if (matchedKey) {
          core.info(`Cache restored from key: ${matchedKey}`);
          core.saveState(State.CacheResult, matchedKey);
          core.setOutput('cache-hit', true);
          const cachedPath = await tc.cacheDir(toolCachePath, toolName, version);
          core.addPath(cachedPath);
          return;
        }
        core.info('GitHub Actions cache miss.');
      } catch (error) {
        core.warning(`Cache restore failed, falling back to download: ${(error as Error).message}`);
      }
    }
    core.setOutput('cache-hit', false);
  }

  core.info('Could not find Teleport binaries in cache. Fetching...');
  core.debug('Downloading tar');
  const actionRepo = process.env['GITHUB_ACTION_REPOSITORY'] || 'teleport-actions/setup';
  const actionVersion = process.env['GITHUB_ACTION_REF'] || 'unknown';
  const downloadPath = await tc.downloadTool(
    `https://cdn.teleport.dev/${toolName}-${version}-bin.tar.gz`,
    undefined,
    undefined,
    { Referer: `${actionRepo}@${actionVersion}` }
  );

  core.debug('Extracting tar');
  const extractedPath = await tc.extractTar(downloadPath, undefined, [
    'xz',
    '--strip',
    '1',
  ]);

  core.info('Fetched binaries from Teleport. Writing them back to cache...');
  const cachedPath = await tc.cacheDir(extractedPath, toolName, version);
  core.addPath(cachedPath);

  if (inputs.cacheEnabled) {
    core.saveState(State.CachePath, cachedPath);
  }
}
run().catch(core.setFailed);
