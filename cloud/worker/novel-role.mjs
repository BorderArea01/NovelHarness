// Pinned dsh-edge 0.30.0 / upstream SystemPrompt presentation waterfall.
// No transport/history rewrite, forked agent loop, tool restriction or VFS edit.
export const EDGE_CODING_IDENTITY =
  'You are dsh-edge, a coding agent powered by the {{model}} model, running in a Cloudflare Worker. ';
export const NOVEL_IDENTITY = '你是小说创作搭档与编辑，由 DeepSeek Harness 驱动，运行在 Cloudflare Worker。';

export function novelRoot(directory) {
  if (typeof directory !== 'string' || /[\\\u0000-\u001f\u007f]/.test(directory)) return null;
  const match = /^(\/workspace\/novels\/b-[a-f0-9]{32})(?:\/(.*))?$/.exec(directory);
  if (!match) return null;
  if (match[2] && match[2].split('/').some((part) => !part || part === '.' || part === '..')) return null;
  return match[1];
}

export function withNovelRole(assembly, directory, identity) {
  const root = novelRoot(directory);
  if (!root) return assembly;
  const prefix = assembly.sections.find((section) => section.name === 'deployment:persona-prefix');
  // An explicit custom persona belongs to its author. Never search/replace
  // arbitrary prompt text or touch a registered complete-prompt contribution.
  if (typeof prefix?.text !== 'string' || !prefix.text.startsWith(EDGE_CODING_IDENTITY)) return assembly;
  return {
    ...assembly,
    sections: assembly.sections.map((section) =>
      section !== prefix
        ? section
        : {
            ...section,
            text:
              NOVEL_IDENTITY +
              '\n\n运行环境与能力说明（沿用原生设置）：\n' +
              prefix.text.slice(EDGE_CODING_IDENTITY.length),
          },
    ),
    ...(identity
      ? {
          contexts: [
            ...(assembly.contexts ?? []),
            ...(identity
              ? [
                  {
                    name: 'novel:book-identity',
                    interpolate: false,
                    text: JSON.stringify({
                      id: root.slice('/workspace/novels/'.length),
                      root,
                      ...(typeof identity.title === 'string' && identity.title.trim()
                        ? { title: identity.title }
                        : {}),
                    }),
                  },
                ]
              : []),
          ],
        }
      : {}),
  };
}

export function installNovelRole(context, { readBookTitle } = {}) {
  if (typeof context?.on !== 'function' || typeof context?.get !== 'function')
    throw new Error('Native system-prompt integration is unavailable.');
  return context.on(
    'system-prompt/assemble',
    async (_assembly, details, next) => {
      const assembly = await next();
      if (!details.agent) return assembly; // Auxiliary/non-Agent assemblies unchanged.
      // Native workingDirectory owns the CURRENT directory. The original Session
      // header can be stale after working_directory or replay; never cache it here.
      const agent = details.agent;
      // Resolve via the original Host context, not an Agent scope that has not
      // declared this Cordis dependency. No new service or permissions are added.
      const workingDirectory = context.get('workingDirectory');
      if (typeof workingDirectory?.get !== 'function')
        throw new Error('Native working-directory service is unavailable.');
      const directory = workingDirectory.get(agent.session);
      const scoped = withNovelRole(assembly, directory);
      if (scoped === assembly) return scoped;
      const root = novelRoot(directory);
      const title = readBookTitle ? await readBookTitle(root) : undefined;
      if (novelRoot(workingDirectory.get(agent.session)) !== root)
        throw new Error(
          'Novel workspace changed while assembling context; no mixed-book request was prepared.',
        );
      // Book identity is dynamic runtime context, not a cached system section.
      // Harness owns its context projection/history update between native turns.
      return withNovelRole(assembly, directory, readBookTitle ? { title } : undefined);
    },
    { prepend: true },
  );
}
