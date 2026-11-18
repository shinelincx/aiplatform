import { constants } from 'node:fs';
import { cp, lstat, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

const cacheLayouts = {
  npm: { jobDirectory: '.npm-cache', content: '_cacache' },
  maven: { jobDirectory: '.maven-cache', content: 'repository' },
} as const;
export const jobCacheDirectories = Object.values(cacheLayouts).map(({ jobDirectory }) => jobDirectory);

export async function copyRepositoryCache(root: string, repository: string, jobRoot: string,
  manager: keyof typeof cacheLayouts, signal: AbortSignal) {
  if (!/^[a-z0-9-]+\/[a-z0-9_.-]+$/i.test(repository) || repository.endsWith('/.') || repository.endsWith('/..')) {
    throw new Error('Invalid repository identity for dependency cache');
  }

  const { jobDirectory, content } = cacheLayouts[manager];
  const source = join(root, repository.toLowerCase(), content);
  let canonical: string;
  try {
    canonical = await realpath(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (canonical !== source) throw new Error('Repository cache uses a symbolic path');
  if (!(await lstat(source)).isDirectory()) throw new Error('Repository cache is not a directory');

  const destination = join(jobRoot, jobDirectory);
  await mkdir(destination, { mode: 0o700 });
  await cp(source, join(destination, content), {
    recursive: true, force: false, errorOnExist: true, mode: constants.COPYFILE_FICLONE,
    async filter(path) {
      signal.throwIfAborted();
      const entry = await lstat(path);
      if (!entry.isDirectory() && !entry.isFile()) throw new Error('Repository cache contains an unsupported entry');
      return true;
    },
  });
  if (manager === 'maven') await mkdir(join(destination, 'tmp'), { mode: 0o700 });
  return destination;
}
