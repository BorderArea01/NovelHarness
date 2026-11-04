import { installNovelTools } from './novel-tools.mjs';
import { nativeWorkspace, nativeBookTitle } from './native-workspace.mjs';
import { makeDocumentService } from './novel-documents.mjs';

// One original tool registry and proposal store. This is a bounded commit
// capability, NOT a sandbox for generic filesystem, bash, MCP or other tools.
export function installProposalTools(instance) {
  return installNovelTools(instance.sessions.context, ({ root, agent, assertScope }) => {
    const execute = async (action, args, exec) => {
      const keys =
        action === 'inspect'
          ? ['proposal_id']
          : ['proposal_id', 'expected_hash', 'content', 'complete', 'content_scope'];
      if (
        !args ||
        typeof args !== 'object' ||
        Array.isArray(args) ||
        (action === 'inspect'
          ? Object.keys(args).length !== 1
          : !['proposal_id', 'expected_hash', 'content'].every((key) => Object.hasOwn(args, key))) ||
        Object.keys(args).some((key) => !keys.includes(key)) ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(args.proposal_id ?? '') ||
        (action === 'submit' &&
          (typeof args.content !== 'string' ||
            !/^[a-f0-9]{64}$/.test(args.expected_hash ?? '') ||
            (args.complete !== undefined && typeof args.complete !== 'boolean') ||
            (args.content_scope !== undefined &&
              !['document', 'append', 'selection'].includes(args.content_scope))))
      )
        throw new Error('候选工具参数无效，未写入文件。');
      const { fs, db } = await nativeWorkspace(instance);
      assertScope(exec);
      const value = makeDocumentService(fs, db, root.slice('/workspace/novels/'.length), {
        proposalActor: { sessionId: agent.id },
      }).run({
        kind: 'agentProposal',
        action,
        id: args.proposal_id,
        expectedHash: args.expected_hash,
        content: args.content,
        complete: args.complete,
        contentScope: args.content_scope,
      });
      return JSON.stringify({ ...value, target: root + '/' + value.target, draft: root + '/' + value.draft });
    };
    const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] };
    const id = { type: 'string', description: '本次创作任务提供的 proposal_id，不得猜测其他提案。' };
    return [
      {
        name: 'novel_illustration',
        description:
          '管理本书已上传的插图。list 返回图片路径与图注（不含图像数据），带 path 取得 chapter.expectedHash 和现有位置；原文用 read 读取。place 在 after 的唯一原文所在段落后插入或移动，remove 移除本章插图，expected_hash 用 list 返回版本。只改插图位置及图注，保存旧版。按作者要求挑选合适段落，勿密集插图，不猜图片内容。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'place', 'remove'] },
            cursor: { type: 'string', description: 'list 返回 nextCursor 时继续读取下一页。' },
            path: { type: 'string', description: '本书 chapters/ 逻辑路径。' },
            image_path: { type: 'string' },
            expected_hash: { type: 'string' },
            after: { type: 'string', description: '插图前的唯一原文，位于对应段落，最多 2000 字。' },
            caption: { type: 'string', maxLength: 160 },
          },
          required: ['action'],
          additionalProperties: false,
        },
        output,
        isConcurrencySafe: (args) => args.action === 'list',
        presentCall: (args) => ({
          card: 'generic',
          title: args.action === 'list' ? '读取本书插图' : '调整章节插图',
          kind: args.action === 'list' ? 'read' : 'edit',
        }),
        execute: async (args, exec) => {
          if (
            !args ||
            Object.keys(args).some(
              (key) =>
                !['action', 'cursor', 'path', 'image_path', 'expected_hash', 'after', 'caption'].includes(
                  key,
                ),
            ) ||
            !['list', 'place', 'remove'].includes(args.action)
          )
            throw new Error('插图参数无效。');
          const { fs, db } = await nativeWorkspace(instance);
          assertScope(exec);
          return JSON.stringify(
            makeDocumentService(fs, db, root.slice('/workspace/novels/'.length)).run({
              kind: 'illustrations',
              action: args.action,
              path: args.path,
              cursor: args.cursor,
              imagePath: args.image_path,
              expectedHash: args.expected_hash,
              after: args.after,
              caption: args.caption,
            }),
          );
        },
      },
      {
        name: 'novel_proposal_prepare',
        description:
          '作者要求写作、修改或规划时，创建可保存的本书任务；讨论不创建任务。正文省略 mode，path 或 chapter 指定目标；outline 规划，canon 整理资料。返回 task 含冻结模板、资料路径、范围和版本；生成前读取并应用 task.template 正文，不只读取保存参数，没有额外执行提示词。对话已提供 proposal_id 时用 inspect 读取原任务，不重复创建。新章缺章纲会返回 prerequisite 和 continuation；完成前置任务后以 continuation.arguments 继续原请求。工具权限不因写作意图变化。',
        parameters: {
          type: 'object',
          properties: {
            mode: {
              type: 'string',
              enum: ['write', 'outline', 'new-chapter', 'begin', 'continue', 'rewrite', 'canon'],
              description: '可省略，默认 write；正文意图不改变工具权限或保存范围。',
            },
            instruction: {
              type: 'string',
              description: '保留作者本次目标、篇幅和限制；补大纲后仍需继续完成原写作要求。',
            },
            chapter: { type: 'integer', minimum: 1, maximum: 10000 },
            without_outline: {
              type: 'boolean',
              description: '仅作者明确要求跳过大纲直接写正文时为 true；修改已有正文无需先补大纲。',
            },
            path: {
              type: 'string',
              description: '本书 chapters/ 逻辑路径，接受本书绝对路径并规范为相对路径。',
            },
            range: {
              type: 'object',
              properties: { start: { type: 'integer' }, end: { type: 'integer' } },
              required: ['start', 'end'],
              additionalProperties: false,
            },
            selection: {
              type: 'object',
              properties: { start: { type: 'integer' }, end: { type: 'integer' } },
              required: ['start', 'end'],
              additionalProperties: false,
            },
            sources: { type: 'array', maxItems: 32, items: { type: 'string' } },
            template_key: { type: 'string', enum: ['write', 'deai', 'ending'] },
          },
          required: ['instruction'],
          additionalProperties: false,
        },
        output,
        isConcurrencySafe: () => false,
        presentCall: () => ({ card: 'generic', title: '准备书稿任务', kind: 'read' }),
        execute: async (args, exec) => {
          const { fs, db } = await nativeWorkspace(instance);
          const bookTitle = await nativeBookTitle(instance, root);
          assertScope(exec);
          const value = makeDocumentService(fs, db, root.slice('/workspace/novels/'.length), {
            bookTitle,
            proposalActor: { sessionId: agent.id },
          }).run({ kind: 'agentPrepare', request: args, requestKey: exec.callId });
          return JSON.stringify({
            ...value,
            target: root + '/' + value.target,
            draft: root + '/' + value.draft,
          });
        },
      },
      {
        name: 'novel_outline_update',
        description:
          '作者明确要求清空规划、删除指定章纲或修改全篇方向时使用，不用把删除伪装成分批规划。先 inspect 取得两个 hash，再 apply。clear=true 同时清空章纲和全篇方向；remove_chapters 只删指定章纲；story_plan 替换方向（可空）。不删除正文，不改其他书，不需转交作者手动删；保存原版本历史，可在原大纲/方向历史恢复。并发更新返回冲突，重新读取比较，不盲目重试。没有明确授权不要主动清空；已有正文修改完成后直接保存并保留旧版。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['inspect', 'apply'] },
            expected_outline_hash: { type: ['string', 'null'] },
            expected_direction_hash: { type: ['string', 'null'] },
            clear: { type: 'boolean' },
            remove_chapters: {
              type: 'array',
              maxItems: 10000,
              items: { type: 'integer', minimum: 1, maximum: 10000 },
            },
            story_plan: { type: 'string' },
            reason: { type: 'string', description: '作者明确要求的修改；apply 必填。' },
          },
          required: ['action'],
          additionalProperties: false,
        },
        output,
        isConcurrencySafe: () => false,
        presentCall: (args) => ({
          card: 'generic',
          title: args.action === 'inspect' ? '读取规划版本' : '更新本书规划',
          kind: args.action === 'inspect' ? 'read' : 'edit',
        }),
        execute: async (args, exec) => {
          const allowed = [
            'action',
            'expected_outline_hash',
            'expected_direction_hash',
            'clear',
            'remove_chapters',
            'story_plan',
            'reason',
          ];
          if (
            !args ||
            typeof args !== 'object' ||
            Array.isArray(args) ||
            Object.keys(args).some((key) => !allowed.includes(key))
          )
            throw new Error('规划操作参数无效。');
          const { fs, db } = await nativeWorkspace(instance);
          assertScope(exec);
          return JSON.stringify(
            makeDocumentService(fs, db, root.slice('/workspace/novels/'.length), {
              proposalActor: { sessionId: agent.id },
            }).run({ ...args, kind: 'agentOutline' }),
          );
        },
      },
      {
        name: 'novel_proposal_inspect',
        description:
          '读取本书、本发起对话的任务、冻结模板、资料目录、最新 expectedHash 及 characters（编辑器去空白字数），不返回整部正文。write/edit 草稿后用它取新 hash 和字数，无需 shell 计数。task.materials 中 author-setting 是作者设定，planned-chapters 是未来规划，retrieval-notes 只是检索线索；canon 中 trust=manual/confirmed 或 confirmed=true 且 trust!=auto 才是人工确认，其余不冒充定稿。正文按 outline.json 的 chapterPath 关联，不从文件名猜章序。task.template 是本次唯一任务模板。原文用原生 read 读取，分片按 parts 顺序。已处理任务只读。',
        parameters: {
          type: 'object',
          properties: { proposal_id: id },
          required: ['proposal_id'],
          additionalProperties: false,
        },
        output,
        isConcurrencySafe: () => true,
        presentCall: () => ({ card: 'generic', title: '读取写作版本', kind: 'read' }),
        execute: (args, exec) => execute('inspect', args, exec),
      },
      {
        name: 'novel_proposal_submit',
        description:
          '使用 inspect 返回的 expectedHash 原子保存同一任务，不用通用文件工具绕过版本和历史。正文 document=完整章文（可混合修改与续写），append=仅新增，selection=原选段替换；省略则使用 contentScope，不能把全文当新增追加。大纲 content 为 {storyPlan?,chapters:[{title,summary,plotPoints}]}，数量与 task.plan.range 一致；已有方向可省略 storyPlan。资料 content 为完整 canon JSON，新增建议用 trust=auto、唯一 id 及 evidenceSources:[{path,quote}]，引用仅来自 task.sources，不改人工确认项。complete=false 保存部分，true 最终校验并按 publication 保存、备份旧版；published=true 才是入书。冲突保留双方。',
        parameters: {
          type: 'object',
          properties: {
            proposal_id: id,
            expected_hash: { type: 'string', description: 'inspect 或上次成功 submit 返回的 expectedHash。' },
            content: {
              type: 'string',
              description:
                '完整当前候选正文或候选 JSON，不含解释和代码围栏。改写时保留原文已有的 illustrations/ 插图链接；需要调位置时用 novel_illustration。',
            },
            complete: { type: 'boolean', description: '仅最终完整交付时为 true。部分保存不得为 true。' },
            content_scope: {
              type: 'string',
              enum: ['document', 'append', 'selection'],
              description:
                '正文内容范围，可在同一未完成任务中明确调整。document=完整章文；append=只有新增段落；selection=只有原选段替换。不是权限模式。',
            },
          },
          required: ['proposal_id', 'expected_hash', 'content'],
          additionalProperties: false,
        },
        output,
        isConcurrencySafe: () => false,
        presentCall: (args) => ({
          card: 'diff',
          title: '正在写作',
          diffs: [
            {
              path: root + '/drafts/' + (args.proposal_id ?? '') + '.md',
              oldText: null,
              newText: args.content ?? '',
            },
          ],
        }),
        execute: (args, exec) => execute('submit', args, exec),
      },
    ];
  });
}
