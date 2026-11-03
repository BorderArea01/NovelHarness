import { installNovelTools } from './novel-tools.mjs';
import { nativeWorkspace, nativeBookTitle } from './native-workspace.mjs';
import { makeDocumentService } from './novel-documents.mjs';

const output = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] };
function compact(result, root) {
  if (!result.run) return result;
  const run = { ...result.run };
  delete run.items;
  delete run.instruction;
  return {
    ...result,
    run,
    ...(result.target ? { target: root + '/' + result.target } : {}),
    ...(result.draft ? { draft: { ...result.draft, path: root + '/' + result.draft.path } } : {}),
    ...(result.previous ? { previous: { ...result.previous, path: root + '/' + result.previous.path } } : {}),
  };
}
export function installWritingRunTools(instance) {
  return installNovelTools(instance.sessions.context, ({ root, agent, assertScope }) => {
    const execute = async (action, args, exec) => {
      if (
        !args ||
        typeof args !== 'object' ||
        Array.isArray(args) ||
        Object.keys(args).some(
          (key) =>
            !(
              action === 'next' ? ['run_id'] : ['run_id', 'chapter', 'expected_hash', 'content', 'complete']
            ).includes(key),
        )
      )
        throw new Error('连写工具参数无效，未写入文件。');
      const bookTitle = await nativeBookTitle(instance, root);
      assertScope(exec);
      const { fs, db } = await nativeWorkspace(instance);
      assertScope(exec);
      const result = makeDocumentService(fs, db, root.slice('/workspace/novels/'.length), {
        runKey: instance.env.DSH_EDGE_ACCESS_KEY,
        runActor: { sessionId: agent.id },
        bookTitle,
      }).run({
        kind: 'writingRun',
        action,
        id: args.run_id,
        chapter: args.chapter,
        expectedHash: args.expected_hash,
        content: args.content,
        complete: args.complete,
      });
      return JSON.stringify(compact(result, root));
    };
    return [
      {
        name: 'novel_run_next',
        description:
          '读取作者已授权连写任务的下一章与已展开模板。只能执行本会话原先授权的范围；不能创建任务或扩大范围。先读取返回的 previous.path 和相关本书资料，再写完整当前章并用 novel_run_submit 提交，不要使用 write 修改正文/候选/检查点。completed 表示候选已生成，不等于都已发布；conflict 或错误时停止并如实报告。',
        parameters: {
          type: 'object',
          properties: { run_id: { type: 'string' } },
          required: ['run_id'],
          additionalProperties: false,
        },
        output,
        isConcurrencySafe: () => false,
        execute: (args, exec) => execute('next', args, exec),
      },
      {
        name: 'novel_run_submit',
        description:
          '提交本次连写当前章的候选正文。content 是完整当前候选，不重复已有标题；未写完时 complete=false 保存检查点，随后可继续当前章，不能伪报完成。complete=true 才进入下一章；只有作者预先明确选择保存新章时才发布原来空白的正文。使用 next 返回的 expected_hash；发生冲突不覆盖，报告保留的候选并停止。然后再次调用 novel_run_next，直到 completed 或冲突；不创建额外模型或任务引擎。',
        parameters: {
          type: 'object',
          properties: {
            run_id: { type: 'string' },
            chapter: { type: 'integer' },
            expected_hash: { type: 'string' },
            content: { type: 'string' },
            complete: { type: 'boolean' },
          },
          required: ['run_id', 'chapter', 'expected_hash', 'content', 'complete'],
          additionalProperties: false,
        },
        output,
        isConcurrencySafe: () => false,
        execute: (args, exec) => execute('submit', args, exec),
      },
    ];
  });
}
