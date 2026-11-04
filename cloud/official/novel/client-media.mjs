import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';

const MEDIA = /data:image\/(webp|png|jpeg);base64,([A-Za-z0-9+/=]{16384,})/g;
const ADDRESS = '/__host-assets/client-media/';

// Build-owned UI illustrations only. Original plugin code, uploaded images,
// model input, session attachments and source text outside the literals stay intact.
export function externalizeClientMedia(source) {
  const media = new Map();
  const next = source.replace(MEDIA, (literal, type, encoded) => {
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) return literal;
    const name = createHash('sha256').update(bytes).digest('hex') + '.' + type;
    media.set(name, bytes);
    return ADDRESS + name;
  });
  return { source: next, media };
}

export function clientMediaFile(path) {
  const match = /^\/__host-assets\/client-media\/([a-f0-9]{64})\.(webp|png|jpeg)$/.exec(path);
  return match ? { name: match[1] + '.' + match[2], type: 'image/' + match[2] } : null;
}

export async function stageClientMedia(modules, assets) {
  const scope = join(modules, '@deepseek-ai');
  const entries = await readdir(scope, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('dsh-client-ui-')) continue;
    const file = join(scope, entry.name, 'lib/client.js');
    let source;
    try {
      source = await readFile(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const next = externalizeClientMedia(source);
    // A later startup must never silently keep dangling static URLs.
    for (const match of source.matchAll(/\/__host-assets\/client-media\/[a-f0-9]{64}\.(?:webp|png|jpeg)/g))
      await access(join(assets, clientMediaFile(match[0]).name));
    if (!next.media.size) continue;
    // Purge owns these backups. Do not rebase or overwrite a patched module.
    try {
      await access(file + '.dshpurge.bak');
      continue;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await mkdir(assets, { recursive: true });
    for (const [name, bytes] of next.media) await writeFile(join(assets, name), bytes);
    // The ORIGINAL registry hashes this staged source and advertises a NEW
    // combo revision. Never mutate a response behind an old immutable URL.
    await writeFile(file, next.source);
  }
}
