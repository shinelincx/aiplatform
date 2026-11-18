import { constants } from 'node:fs';
import { cp, lstat, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

export const jobNpmCacheDir = '.npm-cache';

export async function copyRepositoryNpmCache(root: string, repository: string, jobRoot: string, signal: AbortSignal) {
  if (!/^[a-z0-9-]+\/[a-z0-9_.-]+$/i.test(repository) || repository.endsWith('/.') || repository.endsWith('/..')) {
    throw new Error('Invalid repository identity for npm cache');
  }

  const source = join(root, repository.toLowerCase(), '_cacache');
  let canonical: string;
  try {
    canonical = await realpath(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (canonical !== source) throw new Error('Repository npm cache uses a symbolic path');
  if (!(await lstat(source)).isDirectory()) throw new Error('Repository npm cache is not a directory');

  const destination = join(jobRoot, jobNpmCacheDir);
  await mkdir(destination, { mode: 0o700 });
  await cp(source, join(destination, '_cacache'), {
    recursive: true, force: false, errorOnExist: true, mode: constants.COPYFILE_FICLONE,
    async filter(path) {
      signal.throwIfAborted();
      const entry = await lstat(path);
      if (!entry.isDirectory() && !entry.isFile()) throw new Error('Repository npm cache contains an unsupported entry');
      return true;
    },
  });
  return destination;
}
