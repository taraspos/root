import * as cache from '@actions/cache';
import * as core from '@actions/core';

// Catch and log any unhandled exceptions. These exceptions can leak out of the
// uploadChunk method in @actions/toolkit when a failed upload closes the file
// descriptor causing any in-process reads to throw an uncaught exception.
// Instead of failing the action, just warn.
process.on('uncaughtException', e => {
  core.info(`[warning]${e.message}`);
});

const State = {
  CacheKey: 'CACHE_KEY',
  CacheResult: 'CACHE_RESULT',
  CachePath: 'CACHE_PATH',
};

async function run(): Promise<void> {
  const primaryKey = core.getState(State.CacheKey);
  if (!primaryKey) {
    core.debug('No cache key found. Skipping cache save.');
    return;
  }

  const matchedKey = core.getState(State.CacheResult);
  if (matchedKey === primaryKey) {
    core.info(
      `Cache hit occurred on the primary key ${primaryKey}, not saving cache.`
    );
    return;
  }

  const cachePath = core.getState(State.CachePath);
  if (!cachePath) {
    core.debug('No cache path found. Skipping cache save.');
    return;
  }

  core.info(`Saving cache with key: ${primaryKey}`);
  const cacheId = await cache.saveCache([cachePath], primaryKey);
  if (cacheId === -1) {
    core.debug(`Cache was not saved for the key: ${primaryKey}`);
    return;
  }
  core.info(`Cache saved with the key: ${primaryKey}`);
}

async function main(): Promise<void> {
  try {
    await run();
  } catch (error) {
    core.warning((error as Error).message);
  }
  // Early exit to resolve slow post action step (adopted from setup-node/setup-python)
  process.exit(0);
}

main();
