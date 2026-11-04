import { createHash } from 'node:crypto';
import { prepareTemplate, validTemplate, TEMPLATE_LIMIT } from './prompt-templates.mjs';
import { makeWritingRuns, hasProse } from './writing-runs.mjs';
import { chapterHeading, chapterTitle, titleText } from './chapter-titles.mjs';
import {
  imageAsset,
  illustrationPath,
  illustrationEntries,
  placeIllustration,
} from './shared/illustrations.mjs';
import { taskContext } from './shared/writing-prompts.mjs';
import {
  prepareChapterOrder,
  reorderChapterFiles,
  serializeOrderJSON,
  orderReview,
  markOrderReview,
  ORDER_BUDGET,
  ChapterOrderError,
} from './chapter-order.mjs';
import {
  documentStorage,
  logicalPath,
  DOCUMENT_LIMIT,
  PART_LIMIT,
  NATIVE_FILE_LIMIT,
} from './document-storage.mjs';
import { assessCanon, checkCanonBase, evidencePath, mergeCanonSelection } from './canon-proposals.mjs';
import {
  outlineShape,
  planningRange,
  assessOutline,
  mergeOutline,
  STORY_PLAN_PATH,
} from './outline-plans.mjs';

const LIMIT = PART_LIMIT;
const sha = (value) => createHash('sha256').update(value).digest('hex');
const bytes = (value) => new TextEncoder().encode(value);
const DIRECTION = STORY_PLAN_PATH;
const validParts = (parts, path) =>
  parts === undefined ||
  (Array.isArray(parts) &&
    parts.length > 0 &&
    parts.length <= 8 &&
    parts.every((p, i) => p === path + '.part-' + String(i + 1).padStart(4, '0')));
const chapterSourcePath = (path) =>
  typeof path === 'string' &&
  path.length <= 240 &&
  /^chapters\/.+\.(md|txt)(?:\.part-\d{4})?$/.test(path) &&
  !/[\\\u0000-\u001f\u007f]/.test(path) &&
  !path.split('/').some((part) => !part || part === '.' || part === '..');
const validWriting = (value) =>
  value &&
  value.version === 1 &&
  ['begin', 'continue', 'rewrite'].includes(value.mode) &&
  (value.flexible === undefined || typeof value.flexible === 'boolean') &&
  (value.purpose === undefined ||
    (['chapter', 'free-chapter'].includes(value.purpose) && value.mode === 'begin')) &&
  (value.templateKey === undefined ||
    value.templateKey === 'write' ||
    (value.flexible === true && ['deai', 'ending'].includes(value.templateKey)) ||
    (value.templateKey === 'deai' && value.mode === 'rewrite') ||
    (value.templateKey === 'ending' && value.mode === 'continue')) &&
  typeof value.instruction === 'string';
const validOrigin = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
export class DocumentError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
const fault = (status, message, extra) => {
  throw new DocumentError(status, message, extra);
};
export function documentPath(path) {
  return (
    typeof path === 'string' &&
    path.length <= 240 &&
    !/[\\\u0000-\u001f\u007f]/.test(path) &&
    !path.split('/').some((part) => !part || part === '.' || part === '..') &&
    (/^(chapters|drafts|notes)\/.+\.(md|txt)$/.test(path) ||
      ['seed.md', 'setting.md', 'outline.json', 'canon.json', 'memory.json', 'rules.json'].includes(path))
  );
}

// Runs synchronously inside the SAME native Workspace database transaction.
// Native VFS remains the sole manuscript store; no shadow text database/mirror.
export function makeDocumentService(
  fs,
  db,
  id,
  {
    now = Date.now,
    uuid = () => crypto.randomUUID(),
    isGenerating = () => false,
    bookTitle,
    runKey,
    runActor,
    proposalActor,
  } = {},
) {
  if (!/^b-[a-f0-9]{32}$/.test(id)) fault(400, '小说标识无效。');
  const root = '/workspace/novels/' + id;
  let receipt;
  let proposalCreationScope;
  let validatedDirectories = null;
  function safe(path, missing = false) {
    const parts = path.split('/').filter(Boolean);
    let current = '';
    for (let index = 0; index < parts.length; index++) {
      current += '/' + parts[index];
      if (index < parts.length - 1 && validatedDirectories?.has(current)) continue;
      let stat;
      try {
        stat = fs.lstatSync(current);
      } catch (error) {
        if (error.code === 'ENOENT' && missing) return;
        throw error;
      }
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1))
        fault(409, '文件含链接，未读取或覆盖书外内容。');
      if (index < parts.length - 1 && !stat.isDirectory()) fault(409, '文件父路径不是目录。');
      if (index < parts.length - 1 && stat.isDirectory()) validatedDirectories?.add(current);
    }
  }
  function raw(path) {
    return storage.read(path);
  }
  const storage = documentStorage(fs, safe, fault, {
    legacyParts: (absolute) =>
      (receipt?.files ?? [])
        .map((f) => root + '/' + f.path)
        .filter((p) => logicalPath(p) === absolute && p !== absolute)
        .sort(),
  });
  function read(path) {
    if (!documentPath(path)) fault(400, '不支持的文档路径。');
    const result = raw(root + '/' + path);
    if (!result) fault(404, '文档不存在。');
    return {
      path,
      text: result.text,
      hash: result.hash,
      updatedAt: result.updatedAt,
      ...(result.multipart ? { parts: result.parts.map((part) => part.slice(root.length + 1)) } : {}),
    };
  }
  function writeRaw(path, text) {
    storage.write(path, text);
  }
  function outlineContextHash() {
    const path = root + '/outline.json',
      layout = storage.inspect(path);
    if (!layout) return null;
    // Legacy imports allow 32MiB. A planning file beyond the 2MiB UI editor
    // cap must not make ordinary prose writing depend on aggregate editing.
    if (layout.size > 32 * 1024 * 1024) fault(413, '章纲超过 32 MiB 上下文版本读取上限，未忽略其版本。');
    const hash = createHash('sha256');
    for (const file of layout.files) {
      const content = fs.readFileSync(file.path);
      if (content.length !== file.size) fault(409, '章纲读取期间发生变化，未使用半份上下文。');
      hash.update(content);
    }
    return hash.digest('hex');
  }
  function snapshot(path, current) {
    if (!current) return;
    const history = root + '/.novel-history/' + sha(path) + '/' + current.hash + '.md';
    const existing = raw(history);
    if (existing && existing.hash !== current.hash) fault(409, '历史校验失败，原文未覆盖。');
    if (!existing) writeRaw(history, current.content);
  }
  function chapterPlanning(path) {
    const context = {};
    try {
      context.outlineHash = outlineContextHash();
      const outline = raw(root + '/outline.json');
      if (outline) {
        const index = importedChapters(),
          rows = outlineShape(outline.text).chapters;
        const matches = rows.filter((row) => chapterPaths(row, index).includes(path));
        if (matches.length === 1)
          context.outline = {
            chapter: matches[0].chapter,
            title: matches[0].title,
            summary: matches[0].summary,
            plotPoints: matches[0].plotPoints,
            ...(matches[0].note !== undefined ? { note: matches[0].note } : {}),
          };
        else if (matches.length > 1)
          context.planningWarning = '该正文关联了多个大纲条目，本次未选择其中一个作为唯一规划。';
      }
    } catch {
      context.planningWarning = '大纲或正文关联暂不可用，本次未附加规划；正文仍可编辑。';
    }
    return context;
  }
  function save(path, text, expectedHash) {
    if (!documentPath(path) || typeof text !== 'string') fault(400, '文档内容无效。');
    if (bytes(text).length > DOCUMENT_LIMIT) fault(413, '完整文档超过 2 MiB，未截断保存。');
    if (path.endsWith('.json')) {
      try {
        JSON.parse(text.replace(/^\uFEFF/, ''));
      } catch {
        fault(400, 'JSON 格式不正确，原文未覆盖。');
      }
    }
    if (expectedHash !== null && !/^[a-f0-9]{64}$/.test(expectedHash ?? '')) fault(400, '缺少原文版本。');
    const current = raw(root + '/' + path);
    if (current?.text === text) return read(path); // Safe idempotent retry, no overwrite.
    if ((current?.hash ?? null) !== expectedHash)
      fault(409, '原文已更新，请比较后处理；你的修改仍保留。', {
        current: current ? { path, text: current.text, hash: current.hash } : null,
      });
    if (current?.text !== text) {
      snapshot(path, current);
      writeRaw(root + '/' + path, text);
    }
    return read(path);
  }
  function walk(relative, collected, depth = 0) {
    if (depth > 8) fault(413, '目录层级过深，未显示不完整列表。');
    const absolute = root + (relative ? '/' + relative : '');
    safe(absolute);
    for (const name of fs.readdirSync(absolute)) {
      if (name.startsWith('.')) continue;
      const path = relative ? relative + '/' + name : name;
      if (++collected.scanned > 2048) fault(413, '文件列表超过 2048 项，未静默截断。');
      const stat = fs.lstatSync(root + '/' + path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory() && ['chapters', 'drafts', 'notes'].includes(path.split('/')[0]))
        walk(path, collected, depth + 1);
      else if (stat.isFile() && documentPath(logicalPath(path))) {
        const logical = logicalPath(path);
        if (collected.files.some((file) => file.path === logical)) continue;
        const layout = storage.inspect(root + '/' + logical);
        collected.files.push({
          path: logical,
          size: layout.size,
          updatedAt: layout.updatedAt,
          ...(logical.startsWith('drafts/')
            ? {
                managed:
                  /^drafts\/[a-f0-9-]{36}\.md$/.test(logical) &&
                  !!raw(root + '/' + logical.replace(/\.md$/, '.proposal.json')),
              }
            : {}),
          ...(layout.multipart ? { parts: layout.files.map((f) => f.path.slice(root.length + 1)) } : {}),
          category: path.startsWith('chapters/')
            ? 'chapter'
            : path.startsWith('drafts/')
              ? 'draft'
              : 'reference',
        });
      } else if (stat.isFile() && /^drafts\/[a-f0-9-]+\.proposal\.json$/.test(path)) {
        const original = raw(root + '/' + path);
        const proposal = JSON.parse(original.text);
        if (!validProposal(proposal)) fault(409, '提案记录无效。');
        if (proposal.status === 'pending') {
          // Polling the book catalog must not resend every frozen template body.
          // The original receipt and explicit review retain the complete text.
          const summary = { ...proposal };
          delete summary.promptTemplate;
          collected.proposals.push(summary);
          if (collected.orderFiles) {
            collected.orderBytes += original.content.length;
            if (collected.orderBytes > ORDER_BUDGET)
              fault(413, '此次重排的结构化资料与待处理候选超过 8 MiB 安全总量；未写入文件。');
            collected.orderFiles.push({ path, original, value: proposal });
          }
        }
      }
    }
  }
  function importedChapters() {
    const file = raw(root + '/chapter-index.json');
    if (!file) return [];
    let value;
    try {
      value = JSON.parse(file.text.replace(/^\uFEFF/, ''));
    } catch {
      fault(409, '旧章节索引损坏，未推测正文关联。');
    }
    if (!Array.isArray(value)) fault(409, '旧章节索引格式不兼容，未推测正文关联。');
    return value;
  }
  function chapterOutline() {
    const original = raw(root + '/outline.json');
    const shape = original ? outlineShape(original.text) : null;
    const index = importedChapters();
    const bindings = (shape?.chapters ?? []).map((row) => ({ row, paths: chapterPaths(row, index) }));
    return { original, shape, bindings };
  }
  function prepareWritingChapters(range, expectedHash) {
    const { original, shape, bindings } = chapterOutline();
    if (!original || original.hash !== expectedHash) fault(409, '大纲已变化或不存在，未创建连写空章。');
    const numbers = bindings.map((b) => Number(b.row.chapter));
    if (numbers.some((n) => !Number.isSafeInteger(n) || n < 1) || new Set(numbers).size !== numbers.length)
      fault(409, '章纲编号不唯一或无效，请先核对。');
    const byNumber = new Map(bindings.map((b) => [Number(b.row.chapter), b]));
    const pathCounts = new Map();
    for (const p of bindings.flatMap((b) => b.paths)) pathCounts.set(p, (pathCounts.get(p) ?? 0) + 1);
    const members = [];
    let changed = false;
    for (let n = range.start; n <= range.end; n++) {
      const b = byNumber.get(n);
      if (!b) fault(400, '缺少第 ' + n + ' 章章纲，请先完成规划。');
      if (b.paths.length > 1 || b.paths.some((p) => pathCounts.get(p) !== 1))
        fault(409, '第 ' + n + ' 章正文关联不唯一，未猜测连写目标。');
      let path = b.paths[0];
      if (!path) {
        const title =
          typeof b.row.title === 'string' && b.row.title.trim() ? b.row.title.trim() : '第 ' + n + ' 章';
        if (/[\r\n\u0000-\u001f\u007f]/.test(title) || title.length > 200)
          fault(400, '第 ' + n + ' 章标题过长或含换行，请先核对。');
        path = 'chapters/run-' + uuid() + '.md';
        if (raw(root + '/' + path)) fault(409, '新章节路径冲突，未覆盖已有文件。');
        save(path, '# ' + title + '\n\n', null);
        b.row.chapterPath = path;
        changed = true;
      }
      const body = read(path);
      members.push({
        chapter: n,
        path,
        baseHash: body.hash,
        baseLength: body.text.length,
        skip: hasProse(body.text),
      });
    }
    if (changed)
      save(
        'outline.json',
        (original.text.startsWith('\uFEFF') ? '\uFEFF' : '') +
          JSON.stringify(shape.value, null, 2) +
          (original.text.endsWith('\n') ? '\n' : ''),
        original.hash,
      );
    return { members, outlineHash: read('outline.json').hash };
  }
  const writingRuns = makeWritingRuns({
    root,
    bookId: id,
    key: runKey,
    actor: runActor,
    now,
    uuid,
    fail: fault,
    validPath: documentPath,
    raw,
    read: (path) => run({ kind: 'read', path }),
    write: writeRaw,
    prepare: prepareWritingChapters,
    doc: (op) => run(op),
    proposal,
    hasProposal: (pid) => !!raw(proposalPath(pid)),
    checkpoints: () => {
      const folder = root + '/notes/writing-runs';
      safe(folder, true);
      let names;
      try {
        names = fs.readdirSync(folder);
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
      if (names.length > 2048) fault(413, '连写检查点超过 2048 项，未显示不完整列表。');
      return names
        .filter((name) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/.test(name))
        .map((name) => {
          safe(folder + '/' + name);
          const stat = fs.lstatSync(folder + '/' + name);
          if (!stat.isFile()) fault(409, '连写检查点不是普通文件。');
          return { id: name.slice(0, -5), updatedAt: stat.mtimeMs };
        })
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    },
    createProposal: (pid, op, runId) => {
      if (proposalCreationScope) fault(409, '提案嵌套创建无效。');
      proposalCreationScope = { id: pid, runId };
      try {
        return run(op);
      } finally {
        proposalCreationScope = null;
      }
    },
    saveCandidate: (p, text, expectedHash) => {
      proposal(p.id);
      return save(p.draft, text, expectedHash);
    },
    previousChapter: (chapter) => {
      const previous = chapterOutline()
        .bindings.filter((b) => Number(b.row.chapter) < chapter && b.paths.length === 1)
        .sort((a, b) => Number(b.row.chapter) - Number(a.row.chapter));
      for (const b of previous) {
        const body = read(b.paths[0]);
        if (hasProse(body.text)) return { path: body.path, hash: body.hash, proposalId: null };
      }
      return null;
    },
  });
  function fileHeadingTitle(file) {
    const layout = storage.inspect(root + '/' + file.path);
    if (!layout) fault(409, '章节已删除，未猜测目录。');
    const prefix =
      typeof fs.readRangeSync === 'function'
        ? fs.readRangeSync(layout.files[0].path, 0, 2048)
        : fs.readFileSync(layout.files[0].path).subarray(0, 2048);
    const preview = new TextDecoder('utf-8', { ignoreBOM: true }).decode(prefix);
    return chapterTitle(/[\r\n]/.test(preview) || layout.size <= prefix.length ? preview : '', file.path);
  }
  function chapterOrder(operation) {
    const documents = Object.fromEntries(
      ['outline.json', 'rules.json', 'memory.json', 'canon.json'].map((path) => [
        path,
        raw(root + '/' + path),
      ]),
    );
    const orderBytes = Object.values(documents).reduce((sum, item) => sum + (item?.content.length ?? 0), 0);
    if (orderBytes > ORDER_BUDGET) fault(413, '此次重排的结构化资料超过 8 MiB 安全总量；未写入文件。');
    const collected = { files: [], proposals: [], scanned: 0, orderFiles: [], orderBytes };
    walk('', collected);
    const indexFile = raw(root + '/chapter-index.json');
    const index = importedChapters();
    let shape;
    try {
      shape = documents['outline.json']
        ? outlineShape(documents['outline.json'].text)
        : { value: [], chapters: [] };
    } catch {
      fault(409, '大纲格式不兼容，未转换或重排；请在源文件中核对。');
    }
    const bindings = shape.chapters.map((row) => ({ paths: chapterPaths(row, index) }));
    collected.files.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN', { numeric: true }));
    for (const file of collected.files.filter((f) => f.category === 'chapter'))
      file.title = fileHeadingTitle(file);
    const prepared = prepareChapterOrder(
      shape.value,
      bindings,
      collected.files,
      index.map((item) => ({
        chapter: item?.chapter,
        paths: chapterPaths({ chapter: item?.chapter }, index),
      })),
    );
    const version = sha(
      JSON.stringify({
        documents: Object.entries(documents).map(([path, file]) => [path, file?.hash ?? null]),
        index: indexFile?.hash ?? null,
        chapters: collected.files
          .filter((f) => f.category === 'chapter')
          .map((f) => [f.path, f.title, f.parts ?? []]),
        proposals: collected.orderFiles
          .map((f) => [f.path, f.original.hash])
          .sort((a, b) => a[0].localeCompare(b[0])),
      }),
    );
    const entries = prepared.entries.map(({ row, ...entry }) => entry);
    if (operation.action === undefined) return { version, entries };
    if (!['preview', 'apply'].includes(operation.action)) fault(400, '未知的章节重排操作。');
    if (operation.version !== version) fault(409, '章节或关联资料已更新；原顺序未覆盖，请重新读取重排。');
    const result = reorderChapterFiles(prepared, operation.keys, documents, version);
    const writes = result.writes.map((w) => ({ ...w, original: documents[w.path] }));
    for (const file of collected.orderFiles) {
      const text = serializeOrderJSON(
        markOrderReview(file.value, version, result.remapping),
        file.original.text,
      );
      writes.push({ path: file.path, text, original: file.original, proposal: true });
    }
    const outputBytes = writes.reduce((sum, file) => sum + bytes(file.text).length, 0);
    if (outputBytes > ORDER_BUDGET) fault(413, '重排结果超过 8 MiB 安全总量，原文件未修改。');
    const issues = writes
      .filter(
        (file) =>
          bytes(file.text).length >
          (file.proposal ? LIMIT : file.instruction ? NATIVE_FILE_LIMIT : DOCUMENT_LIMIT),
      )
      .map((file) => file.path + ' 重排结果超出文件上限，未截断。');
    const fingerprint = sha(
      JSON.stringify({
        version,
        keys: operation.keys,
        writes: writes.map((file) => [file.path, sha(bytes(file.text))]),
      }),
    );
    const preview = {
      version,
      fingerprint,
      changes: result.changes,
      issues,
      valid: issues.length === 0,
      files: writes.map((file) => ({
        path: file.path,
        beforeHash: file.original?.hash ?? null,
        afterHash: sha(bytes(file.text)),
      })),
      pendingProposals: collected.orderFiles.length,
      notice:
        '保留原有编号集合；未编号正文补入章纲。正文、文件路径、文字章号、历史与迁移档案不改写。章节视角和已知结构化引用同步，旧记忆、自由文本接力及未接受候选需复核。',
    };
    if (operation.action === 'preview') return preview;
    if (!preview.valid || operation.fingerprint !== fingerprint)
      fault(409, issues.join(' ') || '重排预览已失效，未写入文件。');
    for (const file of writes) {
      if (file.instruction) {
        snapshot(file.path, file.original);
        safe(root + '/' + file.path, true);
        // Native instruction discovery requires these exact physical filenames;
        // do not turn a >512KiB AGENTS/START file into logical document shards.
        fs.writeFileSync(root + '/' + file.path, bytes(file.text));
        storage.reset();
      } else if (file.proposal) {
        snapshot(file.path, file.original);
        writeRaw(root + '/' + file.path, file.text);
      } else save(file.path, file.text, file.original?.hash ?? null);
    }
    return { ok: true, changes: result.changes, pendingProposals: collected.orderFiles.length };
  }
  function chapterPaths(row, index) {
    if (Object.hasOwn(row, 'chapterPath') && row.chapterPath === null) return [];
    if (typeof row.chapterPath === 'string' && row.chapterPath) {
      if (!documentPath(row.chapterPath) || !row.chapterPath.startsWith('chapters/'))
        fault(409, '正文关联路径无效，未读取其他文件。');
      return [row.chapterPath];
    }
    const matches = index.filter((item) => Number(item?.chapter) === Number(row.chapter));
    if (matches.length > 1) fault(409, '旧章节索引有重复编号，未猜测正文关联。');
    const paths = matches[0]?.paths ?? [];
    if (!Array.isArray(paths) || paths.some((path) => !chapterSourcePath(path)))
      fault(409, '旧章节索引含无效路径。');
    return [...new Set(paths.map(logicalPath))];
  }
  function planSources(rows, range) {
    const index = importedChapters(),
      sources = [];
    for (const row of rows.filter(
      (item) => Number(item.chapter) >= Math.max(1, range.start - 1) && Number(item.chapter) <= range.end + 1,
    )) {
      const paths = chapterPaths(row, index);
      for (const path of paths) {
        const file = raw(root + '/' + path);
        if (!file) fault(409, '关联的正文已删除，请先修复关联：' + path);
        sources.push({
          chapter: Number(row.chapter),
          path,
          hash: file.hash,
          ...(file.multipart ? { parts: file.parts.map((p) => p.slice(root.length + 1)) } : {}),
          written: !!file.text.replace(/^\uFEFF?#[^\r\n]*(?:\r?\n|$)/, '').trim(),
        });
      }
    }
    // No outline row is needed for an imported, already-written chapter.
    for (const item of index)
      if (
        Number(item?.chapter) >= Math.max(1, range.start - 1) &&
        Number(item?.chapter) <= range.end + 1 &&
        !rows.some((row) => Number(row.chapter) === Number(item.chapter))
      ) {
        for (const path of chapterPaths({ chapter: item.chapter }, index)) {
          const file = raw(root + '/' + path);
          if (!file) fault(409, '旧正文缺失，请先检查：' + path);
          sources.push({
            chapter: Number(item.chapter),
            path,
            hash: file.hash,
            ...(file.multipart ? { parts: file.parts.map((p) => p.slice(root.length + 1)) } : {}),
            written: !!file.text.replace(/^\uFEFF?#[^\r\n]*(?:\r?\n|$)/, '').trim(),
          });
        }
      }
    return sources;
  }
  function outlineAssessment(baseText, draftText, plan) {
    let direction;
    try {
      direction = raw(root + '/' + DIRECTION);
    } catch {
      return {
        issues: ['全篇方向无法读取或含链接，未使用书外文件。'],
        chapters: [],
        storyPlan: '',
        previousStoryPlan: '',
        valid: false,
      };
    }
    const assessment = assessOutline(baseText, draftText, plan, direction?.text ?? '');
    if (plan) {
      if ((direction?.hash ?? null) !== plan.blueprintHash) {
        assessment.staleSources = true;
        assessment.issues.push('全篇方向版本已变化，请基于新方向重新规划。');
      }
      for (const source of plan.sources ?? []) {
        let current;
        try {
          current = raw(root + '/' + source.path);
        } catch {}
        if (!current || current.hash !== source.hash) {
          assessment.staleSources = true;
          assessment.issues.push('第 ' + source.chapter + ' 章正文有更新，请重新规划；旧候选仍保留。');
        }
      }
      assessment.valid = assessment.issues.length === 0;
    }
    return assessment;
  }
  function proposalPath(proposalId) {
    if (!/^[a-f0-9-]{36}$/.test(proposalId ?? '')) fault(400, '提案标识无效。');
    return root + '/drafts/' + proposalId + '.proposal.json';
  }
  function validProposal(value) {
    return (
      value &&
      value.version === 1 &&
      (value.originSessionId === undefined || validOrigin(value.originSessionId)) &&
      (value.writerSessionId === undefined || validOrigin(value.writerSessionId)) &&
      (value.resolvedDraftHash === undefined || /^[a-f0-9]{64}$/.test(value.resolvedDraftHash)) &&
      /^[a-f0-9-]{36}$/.test(value.id ?? '') &&
      /^[a-f0-9]{64}$/.test(value.baseHash ?? '') &&
      documentPath(value.target) &&
      validParts(value.targetParts, value.target) &&
      (value.writing === undefined ||
        (value.target.startsWith('chapters/') && validWriting(value.writing))) &&
      (value.promptTemplate === undefined || validTemplate(value.promptTemplate)) &&
      (value.contextOutlineHash === undefined ||
        (value.target.startsWith('chapters/') &&
          (value.contextOutlineHash === null || /^[a-f0-9]{64}$/.test(value.contextOutlineHash)))) &&
      (value.edit === undefined ||
        (value.target.startsWith('chapters/') &&
          Number.isSafeInteger(value.edit.start) &&
          Number.isSafeInteger(value.edit.end) &&
          value.edit.start >= 0 &&
          value.edit.end >= value.edit.start &&
          value.edit.end <= DOCUMENT_LIMIT)) &&
      (value.plan === undefined ||
        (planningRange(value.plan?.range) &&
          (value.plan.blueprintHash === null || /^[a-f0-9]{64}$/.test(value.plan.blueprintHash ?? '')) &&
          (value.plan.hasDirection === undefined || typeof value.plan.hasDirection === 'boolean') &&
          Array.isArray(value.plan.sources) &&
          value.plan.sources.length <= 2048 &&
          value.plan.sources.every(
            (source) =>
              Number.isSafeInteger(source?.chapter) &&
              chapterSourcePath(source.path) &&
              validParts(source.parts, source.path) &&
              /^[a-f0-9]{64}$/.test(source.hash ?? '') &&
              typeof source.written === 'boolean',
          ))) &&
      (value.sources === undefined ||
        (Array.isArray(value.sources) &&
          value.sources.length <= 32 &&
          value.sources.every(
            (source) =>
              evidencePath(source?.path) &&
              validParts(source.parts, source.path) &&
              /^[a-f0-9]{64}$/.test(source.hash ?? ''),
          ))) &&
      value.draft === 'drafts/' + value.id + '.md' &&
      ['pending', 'accepted', 'rejected'].includes(value.status)
    );
  }
  function proposal(proposalId, pending = true) {
    const record = raw(proposalPath(proposalId));
    if (!record) fault(404, '提案不存在。');
    const value = JSON.parse(record.text);
    if (
      !validProposal(value) ||
      value.id !== proposalId ||
      !documentPath(value.target) ||
      value.draft !== 'drafts/' + proposalId + '.md' ||
      (pending && value.status !== 'pending')
    )
      fault(409, '提案已处理或格式无效。');
    return value;
  }
  function proposalBase(record) {
    const base = raw(root + '/.novel-history/' + sha(record.target) + '/' + record.baseHash + '.md');
    if (!base || base.hash !== record.baseHash) fault(409, '提案原文快照缺失或损坏，未覆盖。');
    return base;
  }
  function proposalContentScope(record) {
    if (!record.edit) return 'document';
    return record.edit.start === record.edit.end && record.edit.end === proposalBase(record).text.length
      ? 'append'
      : 'selection';
  }
  function candidateContext(path) {
    const id = /^drafts\/([a-f0-9-]{36})\.md$/.exec(path)?.[1];
    if (!id) return null;
    try {
      const file = raw(proposalPath(id));
      if (!file) return null; // A normal author's draft is not a proposal.
      const record = JSON.parse(file.text);
      if (!validProposal(record) || record.id !== id || record.draft !== path)
        throw new Error('invalid proposal');
      return {
        id,
        target: record.target,
        status: record.status,
        editable: record.status === 'pending',
        running: !!isGenerating(),
        sources: record.sources ?? [],
        ...(record.resolvedDraftHash ? { resolvedDraftHash: record.resolvedDraftHash } : {}),
        ...(record.target === 'canon.json' ? { baseText: proposalBase(record).text } : {}),
      };
    } catch {
      // Preserve readable/downloadable draft bytes even if its receipt is bad.
      return {
        id,
        editable: false,
        warning: '候选的提案记录或原资料快照无法安全读取，当前只读；原候选仍保留。',
      };
    }
  }
  function proposalContextWarning(record) {
    if (!Object.hasOwn(record, 'contextOutlineHash')) return null;
    try {
      if (outlineContextHash() === record.contextOutlineHash) return null;
    } catch {
      /* A broken context must not hide the preserved candidate. */
    }
    return '当前章纲或正文关联已更新；此候选基于旧规划，需重新复核。正文和候选均保留。';
  }
  function prepareAgentProposal(operation) {
    if (!validOrigin(proposalActor?.sessionId)) fault(403, '只有本书原生 Agent 可准备候选。');
    let request = operation.request;
    if (request && typeof request === 'object' && !Array.isArray(request)) {
      request = { ...request, mode: request.mode ?? 'write' };
      // Accept the native reader's SAME-book absolute path, never another book.
      if (typeof request.path === 'string' && request.path.startsWith(root + '/'))
        request.path = request.path.slice(root.length + 1);
    }
    const proseFields = ['path', 'template_key', 'chapter', 'without_outline', 'selection'];
    const fields = {
      write: proseFields,
      'new-chapter': proseFields,
      begin: proseFields,
      continue: proseFields,
      rewrite: proseFields,
      outline: ['range'],
      canon: ['sources'],
    };
    if (
      !request ||
      typeof request !== 'object' ||
      Array.isArray(request) ||
      !Object.hasOwn(fields, request.mode) ||
      typeof request.instruction !== 'string'
    )
      fault(400, '准备写作任务需要 instruction 文本；正文 mode 可省略，规划用 outline，资料整理用 canon。');
    const unexpected = Object.keys(request).filter(
      (key) => !['mode', 'instruction', ...fields[request.mode]].includes(key),
    );
    if (unexpected.length)
      fault(
        400,
        '本次任务不使用参数：' +
          unexpected.join('、') +
          '；正文只需 instruction 与 path 或 chapter，可选 selection、template_key、without_outline。',
      );
    if (bytes(request.instruction).length > TEMPLATE_LIMIT)
      fault(413, '单次写作要求超过 64 KiB；请引用原文而非重复整段长对话。');
    if (request.without_outline !== undefined && typeof request.without_outline !== 'boolean')
      fault(400, 'without_outline 需为明确的布尔值。');
    if (
      typeof operation.requestKey !== 'string' ||
      !operation.requestKey ||
      operation.requestKey.length > 512 ||
      /[\u0000-\u001f\u007f]/.test(operation.requestKey)
    )
      fault(400, '缺少原生工具调用标识，未创建候选。');
    const canonical = (value) =>
      Array.isArray(value)
        ? value.map(canonical)
        : value && typeof value === 'object'
          ? Object.fromEntries(
              Object.keys(value)
                .sort()
                .map((key) => [key, canonical(value[key])]),
            )
          : value;
    // All structured arguments are shallow published schema objects, not an
    // arbitrary document. Reject unknown nested fields before fingerprinting.
    for (const key of ['range', 'selection'])
      if (
        Object.hasOwn(request, key) &&
        (!request[key] ||
          typeof request[key] !== 'object' ||
          Array.isArray(request[key]) ||
          Object.keys(request[key]).length !== 2 ||
          Object.keys(request[key]).some((name) => !['start', 'end'].includes(name)) ||
          !Number.isSafeInteger(request[key].start) ||
          !Number.isSafeInteger(request[key].end))
      )
        fault(400, key + ' 需为明确的 start/end 整数范围。');
    if (
      Object.hasOwn(request, 'chapter') &&
      (!Number.isSafeInteger(request.chapter) || request.chapter < 1 || request.chapter > 10000)
    )
      fault(400, '章号需为 1–10000 的整数。');
    if (
      Object.hasOwn(request, 'sources') &&
      (!Array.isArray(request.sources) ||
        request.sources.length > 32 ||
        request.sources.some((p) => typeof p !== 'string' || p.length > 240))
    )
      fault(400, '原文来源需为本书相对路径数组。');
    for (const key of ['title', 'path', 'template_key'])
      if (Object.hasOwn(request, key) && (typeof request[key] !== 'string' || request[key].length > 240))
        fault(400, key + ' 需为文本。');
    const keyHash = sha(JSON.stringify([root, proposalActor.sessionId, operation.requestKey]));
    const argsHash = sha(JSON.stringify(canonical(request)));
    const proposalId = [
      keyHash.slice(0, 8),
      keyHash.slice(8, 12),
      keyHash.slice(12, 16),
      keyHash.slice(16, 20),
      keyHash.slice(20, 32),
    ].join('-');
    let record,
      createdChapter = false,
      reused = false;
    if (raw(proposalPath(proposalId))) {
      record = proposal(proposalId, false);
      if (
        record.agentRequest?.version !== 1 ||
        record.agentRequest.keyHash !== keyHash ||
        record.agentRequest.argsHash !== argsHash ||
        record.agentRequest.actor !== proposalActor.sessionId ||
        record.agentRequest.mode !== request.mode ||
        typeof record.agentRequest.createdChapter !== 'boolean'
      )
        fault(409, '同一次工具调用的参数已变化或身份不匹配，未重建或覆盖候选。');
      reused = true;
      createdChapter = record.agentRequest.createdChapter;
    } else {
      const op = { kind: 'propose', originSessionId: proposalActor.sessionId };
      const outline = raw(root + '/outline.json');
      if (!outline && request.mode !== 'canon') save('outline.json', '[]', null);
      // The default pipeline is enforced by document dependencies, not keyword
      // routing: a request for prose without an approved chapter plan prepares
      // the missing outline first, preserving the author's original request.
      let needsPlan = false;
      const byChapter = ['new-chapter', 'write'].includes(request.mode) && !request.path;
      if (byChapter) {
        const rows = outlineShape(read('outline.json').text).chapters;
        const row = rows.find((r) => Number(r.chapter) === (request.chapter ?? 1));
        needsPlan = !row || !row.summary?.trim() || !Array.isArray(row.plotPoints) || !row.plotPoints.length;
      } else if (proseFields === fields[request.mode]) {
        if (!documentPath(request.path) || !request.path.startsWith('chapters/'))
          fault(400, '请选择本书章节。');
        if (!chapterPlanning(request.path).outline && request.chapter !== undefined) {
          const row = outlineShape(read('outline.json').text).chapters.find(
            (r) => Number(r.chapter) === request.chapter,
          );
          if (row?.summary?.trim() && Array.isArray(row.plotPoints) && row.plotPoints.length)
            run({
              kind: 'outlineChapter',
              chapter: request.chapter,
              path: request.path,
              expectedHash: read('outline.json').hash,
            });
        }
        // Editing existing prose does not depend on re-creating a chapter plan.
        // A new empty chapter still follows outline-first unless opted out.
        needsPlan = !hasProse(read(request.path).text) && !chapterPlanning(request.path).outline;
      }
      if (request.without_outline) needsPlan = false;
      if (needsPlan) {
        op.path = 'outline.json';
        const rows = outlineShape(read('outline.json').text).chapters;
        const chapter = request.chapter ?? Math.max(0, ...rows.map((r) => Number(r.chapter))) + 1;
        op.range = { start: chapter, end: chapter };
      } else if (byChapter) {
        if (request.without_outline) {
          op.path = 'chapters/free-' + proposalId + '.md';
          save(op.path, '', null);
          createdChapter = true;
        } else if (Object.hasOwn(request, 'chapter')) {
          if (
            !Number.isSafeInteger(request.chapter) ||
            request.chapter < 1 ||
            request.chapter > 10000 ||
            Object.hasOwn(request, 'title')
          )
            fault(400, '按纲起草请选择唯一章号，不另传标题。');
          const outline = read('outline.json');
          const linked = run({
            kind: 'outlineChapter',
            chapter: request.chapter,
            expectedHash: outline.hash,
          });
          op.path = linked.path;
          createdChapter = linked.created;
        } else {
          const linked = run({ kind: 'outlineChapter', chapter: 1, expectedHash: read('outline.json').hash });
          op.path = linked.path;
          createdChapter = linked.created;
        }
      } else if (proseFields === fields[request.mode]) {
        if (!documentPath(request.path) || !request.path.startsWith('chapters/'))
          fault(400, '请选择本书的逻辑章节路径，不选择分片或书外路径。');
        op.path = request.path;
      } else op.path = request.mode === 'outline' ? 'outline.json' : 'canon.json';
      const target = run({ kind: 'read', path: op.path });
      op.expectedHash = target.hash;
      if (op.path.startsWith('chapters/')) {
        const mode = ['new-chapter', 'write', 'begin'].includes(request.mode)
          ? hasProse(target.text)
            ? 'rewrite'
            : 'begin'
          : request.mode;
        op.writing = {
          version: 1,
          mode,
          instruction: request.instruction,
          flexible: true,
          ...(mode === 'begin'
            ? { purpose: !request.without_outline && target.outline ? 'chapter' : 'free-chapter' }
            : {}),
          ...(request.template_key ? { templateKey: request.template_key } : {}),
        };
        // Intent never implies an append-only transaction. Whole chapter is
        // the default; a selected text range is explicit and can be widened at
        // submit to combine earlier revisions and continuation in one commit.
        if (request.selection) op.edit = request.selection;
        op.outlineHash = target.outlineHash;
      } else if (op.path === 'outline.json') op.range ??= request.range ?? { start: 1, end: 1 };
      else op.sources = request.sources;
      if (proposalCreationScope) fault(409, '提案准备发生嵌套，未创建重复任务。');
      proposalCreationScope = {
        id: proposalId,
        agentRequest: {
          version: 1,
          keyHash,
          argsHash,
          actor: proposalActor.sessionId,
          mode: request.mode,
          createdChapter,
          ...(request.without_outline ? { withoutOutline: true } : {}),
        },
      };
      try {
        record = run(op);
      } finally {
        proposalCreationScope = null;
      }
    }
    const metadata = run({ kind: 'agentProposal', action: 'inspect', id: record.id });
    const prerequisite = record.target === 'outline.json' && request.mode !== 'outline' ? 'outline' : null;
    return {
      ...metadata,
      bookId: id,
      reused,
      createdChapter,
      prerequisite,
      authorRequest: request.instruction,
      ...(prerequisite
        ? {
            continuation: {
              tool: 'novel_proposal_prepare',
              arguments: {
                mode: request.mode,
                chapter: record.plan.range.start,
                ...(request.path ? { path: request.path } : {}),
                instruction: request.instruction,
              },
            },
          }
        : {}),
    };
  }
  // Manual manuscript management uses the same VFS transaction and snapshots
  // as editing. It is not an Agent identity bypass or a second content store.
  function manageContent(op) {
    const folder = root + '/.novel-trash';
    const validId = (value) => typeof value === 'string' && /^\d{13}-[a-f0-9-]{36}$/.test(value);
    const validHash = (value) =>
      value === null || (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));
    const actions = [
      'clearChapter',
      'deleteChapter',
      'removeOutline',
      'clearOutline',
      'clearDirection',
      'clearPlanning',
    ];
    const receiptPath = (key) => folder + '/' + key + '.json';
    function record(key) {
      if (!validId(key)) fault(400, '恢复记录标识无效。');
      const file = raw(receiptPath(key));
      if (!file) fault(404, '恢复记录不存在。');
      let value;
      try {
        value = JSON.parse(file.text);
      } catch {
        fault(409, '恢复记录损坏，未覆盖任何内容。');
      }
      if (
        value?.format !== 'novel-content-action-v1' ||
        value.bookId !== id ||
        value.id !== key ||
        !actions.includes(value.action) ||
        !Number.isFinite(value.at) ||
        typeof value.title !== 'string' ||
        !['available', 'restored'].includes(value.status) ||
        !Array.isArray(value.changes) ||
        !value.changes.length ||
        value.changes.length > 3 ||
        new Set(value.changes.map((c) => c?.path)).size !== value.changes.length ||
        value.changes.some(
          (c) =>
            !c ||
            !documentPath(c.path) ||
            !(c.path.startsWith('chapters/') || ['outline.json', DIRECTION].includes(c.path)) ||
            !validHash(c.before) ||
            c.before === null ||
            !validHash(c.after),
        )
      )
        fault(409, '恢复记录不兼容，未覆盖任何内容。');
      return value;
    }
    if (!op.action || op.action === 'list') {
      safe(folder, true);
      let names;
      try {
        names = fs.readdirSync(folder);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        names = [];
      }
      if (op.after != null && !validId(op.after)) fault(400, '恢复列表分页标识无效。');
      const keys = names
        .filter((n) => n.endsWith('.json') && validId(n.slice(0, -5)))
        .map((n) => n.slice(0, -5))
        .sort()
        .reverse()
        .filter((key) => !op.after || key < op.after);
      const page = keys.slice(0, 50);
      return {
        items: page.map((key) => {
          try {
            const r = record(key);
            return {
              id: r.id,
              action: r.action,
              title: r.title,
              at: r.at,
              status: r.status,
              paths: r.changes.map((c) => c.path),
            };
          } catch (e) {
            if (!(e instanceof DocumentError)) throw e;
            return { id: key, status: 'unavailable', warning: e.message };
          }
        }),
        hasMore: keys.length > page.length,
        nextCursor: keys.length > page.length ? page.at(-1) : null,
      };
    }
    if (op.action === 'restore') {
      if (isGenerating()) fault(409, '本书 AI 正在生成，请结束后恢复，未中断任务。');
      const r = record(op.id);
      if (r.status === 'restored') return { ok: true, alreadyRestored: true, paths: [] };
      const changes = [];
      let warning;
      for (const c of r.changes) {
        const current = raw(root + '/' + c.path);
        if ((current?.hash ?? null) !== c.after) {
          // Restoring a deleted chapter must not roll back planning edits
          // performed after deletion. Its old body can still be recovered.
          if (r.action === 'deleteChapter' && c.path === 'outline.json') {
            warning = '正文已恢复；大纲之后有更新，未覆盖，请按需重新关联章纲。';
            continue;
          }
          fault(409, '目标已有新内容，未覆盖；可在历史版本中比较后恢复。', { path: c.path });
        }
        const old = raw(root + '/.novel-history/' + sha(c.path) + '/' + c.before + '.md');
        if (!old || old.hash !== c.before) fault(409, '恢复快照缺失或校验失败，未覆盖任何内容。');
        changes.push({ ...c, old, current });
      }
      for (const c of changes) {
        snapshot(c.path, c.current);
        writeRaw(root + '/' + c.path, c.old.content);
      }
      writeRaw(receiptPath(r.id), JSON.stringify({ ...r, status: 'restored', restoredAt: now() }));
      return { ok: true, paths: changes.map((c) => c.path), ...(warning ? { warning } : {}) };
    }
    const action = op.action === 'inspect' ? op.targetAction : op.action;
    if (!actions.includes(action)) fault(400, '未知手动操作。');
    const chapterAction = ['clearChapter', 'deleteChapter'].includes(action);
    if (chapterAction && (!documentPath(op.path) || !op.path.startsWith('chapters/')))
      fault(400, '只能管理本书正式章节。');
    const chapter = chapterAction ? raw(root + '/' + op.path) : null;
    if (chapterAction && !chapter) fault(404, '章节不存在，未执行操作。');
    const needsOutline = ['deleteChapter', 'removeOutline', 'clearOutline', 'clearPlanning'].includes(action);
    const needsDirection = ['clearDirection', 'clearPlanning'].includes(action);
    const outline = needsOutline ? raw(root + '/outline.json') : null;
    const direction = needsDirection ? raw(root + '/' + DIRECTION) : null;
    const expected = {
      document: chapter?.hash ?? null,
      outline: outline?.hash ?? null,
      direction: direction?.hash ?? null,
    };
    if (op.action === 'inspect') {
      let count = 0;
      try {
        count = outlineShape(outline?.text ?? '[]').chapters.length;
      } catch {
        count = null;
      }
      return {
        expected,
        title: chapter ? chapterTitle(chapter.text, op.path) : null,
        outlineCount: count,
        hasDirection: !!direction?.text.trim(),
        generating: isGenerating(),
      };
    }
    if (isGenerating()) fault(409, '本书 AI 正在生成，请结束后再操作，未中断任务。');
    if (
      !op.expected ||
      Object.keys(expected).some((key) => !validHash(op.expected[key]) || expected[key] !== op.expected[key])
    )
      fault(409, '内容已更新，请重新打开操作并核对；未删除或清空。');
    const changes = [];
    const change = (path, before, text) => {
      if (before && (text === null || before.text !== text)) changes.push({ path, before, text });
    };
    const serialize = (value) =>
      (outline.text.startsWith('\uFEFF') ? '\uFEFF' : '') +
      JSON.stringify(value, null, 2) +
      (outline.text.endsWith('\n') ? '\n' : '');
    if (chapterAction) {
      const heading = chapterHeading(chapter.text);
      change(
        op.path,
        chapter,
        action === 'deleteChapter' ? null : heading ? heading[0] + (heading[3] || '\n') : '',
      );
    }
    if (needsOutline && outline) {
      if (action === 'clearOutline' || action === 'clearPlanning') {
        let shape;
        try {
          shape = outlineShape(outline.text);
        } catch {
          /* Explicit clearing may repair malformed JSON; snapshot is retained. */
        }
        change(
          'outline.json',
          outline,
          serialize(shape && !Array.isArray(shape.value) ? { ...shape.value, chapters: [] } : []),
        );
      } else {
        let shape;
        try {
          shape = outlineShape(outline.text);
        } catch {
          fault(409, '大纲格式无效，请先核对或清空大纲；正文未删除。');
        }
        if (action === 'removeOutline') {
          if (!Number.isInteger(op.index) || op.index < 0 || op.index >= shape.chapters.length)
            fault(400, '章纲位置无效，未删除。');
          shape.chapters.splice(op.index, 1);
        } else {
          const index = importedChapters();
          let linked = false;
          for (const row of shape.chapters)
            if (chapterPaths(row, index).includes(op.path)) {
              row.chapterPath = null;
              linked = true;
            }
          if (!linked) return commitChanges();
        }
        change('outline.json', outline, serialize(shape.value));
      }
    } else if (action === 'removeOutline') fault(404, '大纲不存在。');
    if (needsDirection) change(DIRECTION, direction, '');
    return commitChanges();
    function commitChanges() {
      if (!changes.length) return { ok: true, unchanged: true, paths: [] };
      const key = String(now()).padStart(13, '0') + '-' + uuid();
      if (!validId(key) || raw(receiptPath(key))) fault(409, '恢复记录编号冲突，未执行操作。');
      for (const c of changes) {
        snapshot(c.path, c.before);
        if (c.text === null) storage.remove(root + '/' + c.path);
        else writeRaw(root + '/' + c.path, c.text);
      }
      const r = {
        format: 'novel-content-action-v1',
        bookId: id,
        id: key,
        action,
        at: now(),
        status: 'available',
        title: chapter
          ? chapterTitle(chapter.text, op.path).slice(0, 240)
          : {
              removeOutline: '删除章纲',
              clearOutline: '清空大纲',
              clearDirection: '清空全篇方向',
              clearPlanning: '清空大纲与全篇方向',
            }[action],
        changes: changes.map((c) => ({
          path: c.path,
          before: c.before.hash,
          after: c.text === null ? null : sha(bytes(c.text)),
        })),
      };
      writeRaw(receiptPath(key), JSON.stringify(r));
      return {
        ok: true,
        recoveryId: key,
        paths: changes.map((c) => c.path),
        deleted: action === 'deleteChapter' ? op.path : null,
      };
    }
  }
  function run(operation) {
    // Only read-only, synchronous transaction paths reuse validated ancestors.
    // Final files are ALWAYS checked (including links). Never retain this set
    // across requests/writes or use it to weaken a CAS/mutation validation.
    validatedDirectories = ['list', 'read'].includes(operation.kind) ? new Set() : null;
    storage.reset();
    safe(root);
    const book = JSON.parse(raw(root + '/book.json')?.text ?? '{}');
    if (book.id !== id || book.root !== root || book.format !== 'novel-harness-book-v1')
      fault(409, '小说收据不匹配。');
    receipt = book;
    if (operation.kind === 'illustrations') {
      const loadAsset = (path) => {
        if (!illustrationPath(path)) fault(400, '插图路径无效。');
        const asset = raw(root + '/' + path);
        if (!asset) fault(404, '本书插图不存在。');
        if (path !== 'illustrations/' + sha(bytes(asset.text)) + '.json') fault(409, '插图校验失败。');
        try {
          return imageAsset(asset.text);
        } catch (error) {
          fault(400, error.message);
        }
      };
      const action = operation.action ?? 'list';
      if (action === 'read') return loadAsset(operation.imagePath);
      if (action === 'upload') {
        let asset;
        try {
          asset = JSON.stringify(imageAsset(operation.content));
        } catch (error) {
          fault(400, error.message);
        }
        const path = 'illustrations/' + sha(bytes(asset)) + '.json';
        const existing = raw(root + '/' + path);
        if (existing && existing.text !== asset) fault(409, '插图文件冲突，未覆盖。');
        if (!existing) writeRaw(root + '/' + path, asset);
        return { imagePath: path, alreadyUploaded: !!existing };
      }
      if (action === 'list') {
        let chapter;
        if (operation.path !== undefined && operation.path !== null) {
          if (!chapterSourcePath(operation.path) || operation.path.includes('.part-'))
            fault(400, '章节路径无效。');
          const current = read(operation.path);
          chapter = {
            path: current.path,
            expectedHash: current.hash,
            placements: illustrationEntries(current.text),
          };
        }
        const folder = root + '/illustrations';
        safe(folder, true);
        let names = [];
        try {
          names = fs.readdirSync(folder);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        if (names.length > 2048) fault(413, '本书插图目录过大。');
        // No base64 in assistant/tool context. Assets are read only on demand.
        const paths = names.filter((name) => illustrationPath('illustrations/' + name)).sort();
        const start = operation.cursor === undefined ? 0 : paths.indexOf(operation.cursor) + 1;
        if (operation.cursor !== undefined && start === 0) fault(400, '插图分页位置无效。');
        const page = paths.slice(start, start + 24);
        return {
          ...(chapter ? { chapter } : {}),
          images: page.map((name) => {
            const imagePath = 'illustrations/' + name,
              asset = loadAsset(imagePath);
            return { imagePath, label: asset.label, width: asset.width, height: asset.height };
          }),
          nextCursor: start + page.length < paths.length ? page.at(-1) : null,
        };
      }
      if (
        !['place', 'remove'].includes(action) ||
        !chapterSourcePath(operation.path) ||
        operation.path.includes('.part-')
      )
        fault(400, '插图操作或章节路径无效。');
      const current = read(operation.path);
      if (current.hash !== operation.expectedHash)
        fault(409, '正文已更新，未移动插图；请重新读取。', { current });
      loadAsset(operation.imagePath);
      let text;
      try {
        text = placeIllustration(current.text, { ...operation, remove: action === 'remove' });
      } catch (error) {
        fault(400, error.message);
      }
      const saved = save(operation.path, text, current.hash);
      return { path: saved.path, hash: saved.hash, images: illustrationEntries(saved.text), saved: true };
    }
    if (operation.kind === 'content') return manageContent(operation);
    if (operation.kind === 'identity')
      return {
        version: 1,
        id,
        root,
        title: bookTitle ?? book.title,
        titleSource: bookTitle === undefined ? 'receipt' : 'workspace',
      };
    if (operation.kind === 'list') {
      const collected = { files: [], proposals: [], outlineParts: [], scanned: 0 };
      walk('', collected);
      collected.files.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN', { numeric: true }));
      let navigationWarning;
      let bindings = [];
      try {
        bindings = chapterOutline().bindings;
      } catch {
        navigationWarning = '大纲关联不可用，目录暂按文件名排列；未猜测章节顺序。';
      }
      for (const file of collected.files.filter((f) => f.category === 'chapter')) {
        const matches = bindings.filter((b) => b.paths.includes(file.path));
        if (matches.length === 1) {
          const { row } = matches[0];
          if (typeof row.title === 'string' && row.title.trim()) file.title = row.title.trim();
          if (Number.isSafeInteger(Number(row.chapter)) && Number(row.chapter) > 0)
            file.chapter = Number(row.chapter);
        } else if (matches.length > 1) navigationWarning = '有正文关联多个章纲，未猜测唯一编号。';
        if (!file.title) file.title = fileHeadingTitle(file);
      }
      const numbered = collected.files.filter((f) => f.category === 'chapter' && f.chapter);
      if (new Set(numbered.map((f) => f.chapter)).size !== numbered.length) {
        navigationWarning = '章纲编号或正文关联不唯一，目录暂按文件名排列。';
        for (const file of numbered) delete file.chapter;
      }
      collected.files.sort((a, b) =>
        a.category === 'chapter' && b.category === 'chapter'
          ? (a.chapter ?? Infinity) - (b.chapter ?? Infinity) ||
            a.path.localeCompare(b.path, 'zh-CN', { numeric: true })
          : a.path.localeCompare(b.path, 'zh-CN', { numeric: true }),
      );
      return {
        book: { id, title: bookTitle ?? book.title, root, format: book.format, stats: book.stats },
        limits: { documentBytes: DOCUMENT_LIMIT, partBytes: LIMIT, selectionBytes: 32768 },
        documents: collected.files,
        proposals: collected.proposals,
        outlineParts: collected.outlineParts,
        outlineChapterCount: bindings.length,
        ...(navigationWarning ? { navigationWarning } : {}),
      };
    }
    if (operation.kind === 'chapterOrder') {
      try {
        return chapterOrder(operation);
      } catch (error) {
        if (error instanceof DocumentError) throw error;
        if (error instanceof ChapterOrderError) fault(409, error.message);
        if (error instanceof SyntaxError) fault(409, '章节关联 JSON 无效，原顺序未改动。');
        throw error;
      }
    }
    if (operation.kind === 'agentPrepare') return prepareAgentProposal(operation);
    if (operation.kind === 'agentOutline') {
      if (!validOrigin(proposalActor?.sessionId)) fault(403, '只有本书原生 Agent 可执行规划操作。');
      const before = raw(root + '/outline.json');
      const direction = raw(root + '/' + DIRECTION);
      const shape = outlineShape(before?.text ?? '[]');
      if (operation.action === 'inspect')
        return {
          outlineHash: before?.hash ?? null,
          directionHash: direction?.hash ?? null,
          chapterNumbers: shape.chapters.map((row) => Number(row.chapter)),
          hasDirection: !!direction?.text.trim(),
          outlinePath: 'outline.json',
          directionPath: DIRECTION,
        };
      if (
        operation.action !== 'apply' ||
        typeof operation.reason !== 'string' ||
        !operation.reason.trim() ||
        operation.reason.length > 4000
      )
        fault(400, '规划修改需明确操作与作者要求。');
      if (
        (before?.hash ?? null) !== operation.expected_outline_hash ||
        (direction?.hash ?? null) !== operation.expected_direction_hash
      )
        fault(409, '规划已更新，请重新读取并比较；未删除或替换。');
      if (operation.clear !== undefined && typeof operation.clear !== 'boolean')
        fault(400, 'clear 需为布尔值。');
      const removed = operation.remove_chapters ?? [];
      if (
        !Array.isArray(removed) ||
        removed.length > 10000 ||
        removed.some((n) => !Number.isSafeInteger(n) || n < 1 || n > 10000) ||
        new Set(removed).size !== removed.length
      )
        fault(400, '删除章号需为不重复的有效整数。');
      if (operation.story_plan !== undefined && typeof operation.story_plan !== 'string')
        fault(400, '全篇方向需为文本。');
      if (!operation.clear && !removed.length && operation.story_plan === undefined)
        fault(400, '没有指定规划修改。');
      const numbers = new Set(shape.chapters.map((row) => Number(row.chapter)));
      if (!operation.clear && removed.some((n) => !numbers.has(n)))
        fault(409, '部分章号已不存在；请重新读取规划。');
      const chapters = operation.clear
        ? []
        : shape.chapters.filter((row) => !removed.includes(Number(row.chapter)));
      if (operation.clear || removed.length) {
        const value = Array.isArray(shape.value) ? chapters : { ...shape.value, chapters };
        save(
          'outline.json',
          (before?.text.startsWith('\uFEFF') ? '\uFEFF' : '') +
            JSON.stringify(value, null, 2) +
            (before?.text.endsWith('\n') ? '\n' : ''),
          before?.hash ?? null,
        );
      }
      if (operation.clear || operation.story_plan !== undefined)
        save(DIRECTION, operation.story_plan ?? '', direction?.hash ?? null);
      return {
        applied: true,
        bookId: id,
        chaptersRemaining: chapters.length,
        removedChapters: shape.chapters
          .filter((row) => !chapters.includes(row))
          .map((row) => Number(row.chapter)),
        outlineHash: raw(root + '/outline.json')?.hash ?? null,
        directionHash: raw(root + '/' + DIRECTION)?.hash ?? null,
        prosePreserved: true,
        historyPreserved: true,
      };
    }
    if (operation.kind === 'agentProposal') {
      if (!validOrigin(proposalActor?.sessionId))
        fault(403, '候选提交只供原生发起 Agent 使用，不接受浏览器传入身份。');
      if (!['inspect', 'submit'].includes(operation.action)) fault(400, '候选操作无效。');
      let record = proposal(operation.id, false);
      if ((record.writerSessionId ?? record.originSessionId) !== proposalActor.sessionId)
        fault(403, '候选不属于本次发起对话，未写入；需由作者明确从当前对话继续。');
      if (record.nativeWritingRun) fault(409, '连写候选请使用原连写工具，不能绕过连写检查点。');
      if (operation.action === 'submit') {
        if (record.status !== 'pending') fault(409, '候选已经处理，未修改处理时的原稿。');
        if (typeof operation.content !== 'string' || !/^[a-f0-9]{64}$/.test(operation.expectedHash ?? ''))
          fault(400, '提交需要完整候选内容和 inspect 返回的候选版本。');
        if (operation.contentScope !== undefined) {
          if (!record.writing || !['document', 'append', 'selection'].includes(operation.contentScope))
            fault(400, 'content_scope 仅用于正文：document 完整章文，append 新增段落，selection 原选段。');
          const next = { ...record };
          if (operation.contentScope === 'document') delete next.edit;
          else if (operation.contentScope === 'append') {
            const base = proposalBase(record);
            if (hasProse(base.text) && operation.content.startsWith(base.text))
              fault(
                400,
                'append 只接受新增段落；本次包含完整原文，请用 content_scope=document 原子替换，未重复追加。',
              );
            next.edit = { start: base.text.length, end: base.text.length };
          } else if (!record.edit)
            fault(400, '本任务没有 selection 范围；请用 document 提交完整章文，或准备带 selection 的任务。');
          record = next;
        }
        // The only writable destination comes from the existing proposal, never
        // from tool arguments. CAS, multipart layout and history share this one
        // native transaction. Only an explicitly final, validated task may commit.
        save(record.draft, operation.content, operation.expectedHash);
        if (operation.contentScope !== undefined)
          writeRaw(proposalPath(record.id), JSON.stringify(record, null, 2));
      }
      const view = run({ kind: 'review', id: record.id });
      const current = read(record.target);
      const warning =
        view.contextWarning ||
        view.orderWarning ||
        (current.hash !== record.baseHash
          ? '正式文件已更新；候选仍保留，作者需比较后处理，不能直接覆盖新稿。'
          : undefined);
      let published = false,
        publicationIssue;
      if (
        operation.action === 'submit' &&
        operation.complete === true &&
        ['new-only', 'direct'].includes(record.publication?.mode)
      ) {
        const valid =
          record.target === 'outline.json'
            ? view.outline?.valid
            : record.target.startsWith('chapters/') &&
              hasProse(view.draft.text) &&
              !/^\s*```/.test(view.draft.text) &&
              (record.publication.mode === 'direct' || !hasProse(view.current.text)) &&
              (record.publication.mode === 'direct' ||
                !!view.writingContext?.outline ||
                record.agentRequest?.withoutOutline === true);
        if (!valid) publicationIssue = '内容尚未完整，未保存到书稿；草稿已保留，可继续修正后提交。';
        else
          try {
            db.transactionSync(() => run({ kind: 'accept', id: record.id, draftHash: view.draft.hash }));
            published = true;
          } catch (error) {
            if (!(error instanceof DocumentError)) throw error;
            publicationIssue = error.message;
          }
      }
      return {
        version: 1,
        proposalId: record.id,
        task: taskContext(
          { id, root, title: bookTitle ?? receipt.title },
          { ...current, ...(view.writingContext?.outline ? { outline: view.writingContext.outline } : {}) },
          record,
          [
            'seed.md',
            'setting.md',
            'canon.json',
            'rules.json',
            'memory.json',
            'outline.json',
            DIRECTION,
          ].flatMap((path) => {
            const layout = storage.inspect(root + '/' + path);
            return layout
              ? [
                  {
                    path,
                    ...(layout.multipart
                      ? { parts: layout.files.map((file) => file.path.slice(root.length + 1)) }
                      : {}),
                  },
                ]
              : [];
          }),
        ),
        status: published ? 'accepted' : record.status,
        target: record.target,
        draft: record.draft,
        baseHash: record.baseHash,
        expectedHash: view.draft.hash,
        bytes: bytes(view.draft.text).length,
        characters: view.draft.text.replace(/\s/g, '').length,
        editable: !published && record.status === 'pending',
        published,
        ...(record.writing
          ? {
              contentScope: proposalContentScope(record),
            }
          : {}),
        bookId: id,
        ...(publicationIssue ? { publicationIssue } : {}),
        ...(operation.action === 'submit' ? { saved: true } : {}),
        ...(record.edit ? { edit: record.edit } : {}),
        ...(record.writing ? { writing: record.writing, writingContext: view.writingContext } : {}),
        ...(record.plan ? { plan: record.plan } : {}),
        ...(record.sources ? { sources: record.sources } : {}),
        ...(view.outline
          ? { validation: { kind: 'outline', valid: view.outline.valid, issues: view.outline.issues } }
          : {}),
        ...(view.canon
          ? {
              validation: {
                kind: 'canon',
                issues: view.canon.issues,
                usableSuggestions: view.canon.validCount,
                changes: view.canon.changes.map((change) => ({
                  key: change.key,
                  issues: change.issues,
                  warnings: change.warnings,
                })),
              },
            }
          : {}),
        ...(warning ? { warning } : {}),
      };
    }
    if (operation.kind === 'writingRun') return writingRuns.handle(operation);
    if (operation.kind === 'adoptDraft') {
      if (
        !documentPath(operation.path) ||
        !operation.path.startsWith('drafts/') ||
        candidateContext(operation.path)
      )
        fault(400, '请选择未收录的独立草稿；正式候选请通过原比较流程处理。');
      const source = read(operation.path);
      if (source.hash !== operation.expectedHash)
        fault(409, '草稿已更新，未收录旧版本。', { current: source });
      if (!hasProse(source.text)) fault(400, '草稿没有可收录的正文。');
      const path = 'chapters/recovered-' + sha(operation.path).slice(0, 24) + '.md';
      const previous = raw(root + '/' + path);
      if (previous && previous.hash !== source.hash)
        fault(409, '此前已收录该草稿且内容不同；请比较，不覆盖已有章节。');
      const document = save(path, source.text, null);
      return { document, sourcePreserved: true, reused: !!previous };
    }
    if (operation.kind === 'read' || operation.kind === 'save') {
      const candidate = candidateContext(operation.path);
      if (operation.kind === 'save' && candidate) {
        if (!candidate.editable)
          fault(409, candidate.warning || '提案已经处理；未改写原候选，可下载或另存后编辑。');
        if (isGenerating())
          fault(409, '仍有 AI 在运行，请结束或停止后再保存候选；本机修改保留，正式资料未改动。');
      }
      const document =
        operation.kind === 'read'
          ? read(operation.path)
          : save(operation.path, operation.text, operation.expectedHash);
      if (candidate) document.candidate = candidate;
      if (operation.path === 'outline.json') {
        try {
          const index = importedChapters();
          document.bindings = outlineShape(document.text).chapters.map((row) => ({
            chapter: Number(row.chapter),
            paths: chapterPaths(row, index),
          }));
        } catch {
          document.planningWarning = '部分正文关联不可用，可继续编辑大纲；打开正文前请核对。';
        }
      } else if (operation.path.startsWith('chapters/')) {
        document.chapterTitle = chapterTitle(document.text, operation.path);
        document.titleMode = chapterHeading(document.text) ? 'replace' : 'prepend';
        Object.assign(document, chapterPlanning(operation.path));
      }
      if (operation.path.endsWith('.json')) {
        try {
          const review = orderReview(JSON.parse(document.text.replace(/^\uFEFF/, '')));
          if (review) document.orderReview = review;
        } catch {
          /* Invalid JSON remains readable in the original source editor. */
        }
      }
      return document;
    }
    if (operation.kind === 'chapterTitle') {
      if (!documentPath(operation.path) || !operation.path.startsWith('chapters/'))
        fault(400, '只能修改正文标题。');
      const title = typeof operation.title === 'string' ? operation.title.trim().normalize('NFC') : '';
      if (!title || [...title].length > 120 || /[\u0000-\u001f\u007f\u2028\u2029]/.test(title))
        fault(400, '章节标题需为 1–120 字的单行文本。');
      const current = read(operation.path);
      const { original, shape, bindings } = chapterOutline();
      const matches = bindings.filter((b) => b.paths.includes(operation.path));
      if (matches.length > 1 || matches.some((b) => b.paths.length !== 1))
        fault(409, '正文关联不唯一，请先在大纲中明确绑定；原文未改动。');
      if ((original?.hash ?? null) !== operation.outlineHash)
        fault(409, '大纲已更新，未修改标题；请重新读取当前章节后再试。');
      if (current.hash !== operation.expectedHash)
        fault(409, '正文已更新，未修改标题；请比较当前修改。', { current });
      const renamed = titleText(current.text, title);
      // Both saves and both histories use the SAME outer native transaction.
      save(operation.path, renamed, current.hash);
      if (matches.length) {
        matches[0].row.title = title;
        const text =
          (original.text.startsWith('\uFEFF') ? '\uFEFF' : '') +
          JSON.stringify(shape.value, null, 2) +
          (original.text.endsWith('\n') ? '\n' : '');
        save('outline.json', text, original.hash);
      }
      return run({ kind: 'read', path: operation.path });
    }
    if (operation.kind === 'outlineChapter') {
      const original = read('outline.json'),
        chapter = Number(operation.chapter);
      let shape;
      try {
        shape = outlineShape(original.text);
      } catch {
        fault(400, '大纲结构不兼容，请先检查源文件。');
      }
      const matches = shape.chapters.filter((row) => Number(row.chapter) === chapter);
      if (!Number.isSafeInteger(chapter) || chapter < 1 || matches.length !== 1)
        fault(400, '请选择具有唯一正整数编号的大纲章节。');
      const row = matches[0],
        paths = chapterPaths(row, importedChapters());
      if (paths.length > 1 || paths.some((path) => !documentPath(path)))
        fault(409, '该章关联多个不同正文文件，请先核对关联；不会替换为空章。');
      if (paths.length) {
        if (operation.path && operation.path !== paths[0])
          fault(409, '该章已经关联正文，请在大纲中明确修改关联后保存。');
        read(paths[0]);
        return { path: paths[0], outlineHash: original.hash, created: false };
      }
      if (original.hash !== operation.expectedHash)
        fault(409, '大纲刚有更新，未创建重复章节。', { current: original });
      let path = operation.path;
      if (path) {
        if (!documentPath(path) || !path.startsWith('chapters/')) fault(400, '请选择本书已有正文。');
        read(path);
      } else {
        const title =
          typeof row.title === 'string' && row.title.trim() ? row.title.trim() : '第 ' + chapter + ' 章';
        const slug =
          title
            .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, ' ')
            .replace(/^[.\s]+/, '')
            .trim()
            .slice(0, 70) || '新章节';
        path = 'chapters/' + slug + '-' + uuid().slice(0, 8) + '.md';
        save(path, '# ' + title + '\n\n', null);
      }
      row.chapterPath = path;
      const text =
        (original.text.startsWith('\uFEFF') ? '\uFEFF' : '') + JSON.stringify(shape.value, null, 2);
      const updated = save('outline.json', text, original.hash);
      return { path, outlineHash: updated.hash, created: !operation.path };
    }
    if (operation.kind === 'propose' && operation.resumeId !== undefined) {
      if (
        !validOrigin(operation.originSessionId) ||
        !/^[a-f0-9]{64}$/.test(operation.expectedDraftHash ?? '')
      )
        fault(400, '继续候选需要当前原生对话和刚读取的候选版本。');
      const record = proposal(operation.resumeId);
      if (record.nativeWritingRun) fault(409, '连写候选仍使用原连写检查点。');
      const view = run({ kind: 'review', id: record.id });
      if (view.draft.hash !== operation.expectedDraftHash)
        fault(409, '候选已更新，未切换提交对话，请重新核对。');
      if (
        view.current.hash !== record.baseHash ||
        view.contextWarning ||
        view.orderWarning ||
        view.outline?.staleSources
      )
        fault(409, '原文、规划或依据已更新；请基于新版本发起，原候选保留。');
      const next = { ...record, writerSessionId: operation.originSessionId };
      if (record.writerSessionId !== next.writerSessionId)
        writeRaw(proposalPath(record.id), JSON.stringify(next, null, 2));
      return next;
    }
    if (operation.kind === 'propose') {
      if (operation.originSessionId !== undefined && !validOrigin(operation.originSessionId))
        fault(400, '发起对话标识无效，未创建提案。');
      const target = read(operation.path),
        proposalId = proposalCreationScope?.id ?? uuid();
      if (target.hash !== operation.expectedHash)
        fault(409, '原文刚发生变化，请刷新后再发起改稿。', { current: target });
      let contextOutlineHash;
      if (target.path.startsWith('chapters/')) {
        contextOutlineHash = outlineContextHash();
        if (operation.outlineHash !== undefined && operation.outlineHash !== contextOutlineHash)
          fault(409, '章纲或正文关联刚有更新，未基于旧规划创建 AI 任务；请重试读取新版本。');
      }
      if (
        operation.writing !== undefined &&
        (!target.path.startsWith('chapters/') || !validWriting(operation.writing))
      )
        fault(400, '写作要求格式无效，未创建提案。');
      if (operation.writing?.purpose === 'chapter' && !chapterPlanning(target.path).outline)
        fault(409, '正文未唯一关联章纲，未按纲生成；请先在大纲页关联，或选择自由试写。');
      let edit;
      if (operation.edit !== undefined) {
        const { start, end } = operation.edit ?? {};
        const splitSurrogate = (i) =>
          i > 0 &&
          i < target.text.length &&
          /[\uD800-\uDBFF]/.test(target.text[i - 1]) &&
          /[\uDC00-\uDFFF]/.test(target.text[i]);
        if (
          !target.path.startsWith('chapters/') ||
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start < 0 ||
          end < start ||
          end > target.text.length ||
          splitSurrogate(start) ||
          splitSurrogate(end)
        )
          fault(400, '选段范围无效，未创建提案。');
        if (bytes(target.text.slice(start, end)).length > 32768)
          fault(413, '单次 AI 改写选段上限 32 KiB，请缩小选择；完整章文保留。');
        edit = { start, end };
      }
      if (
        target.path.startsWith('chapters/') &&
        bytes(target.text).length > LIMIT &&
        !edit &&
        !operation.writing?.flexible
      )
        fault(400, '长章请选中要改写的段落，或使用续写追加；不会要求模型重写整篇正文。');
      let sources, plan;
      if (target.path === 'outline.json') {
        if (!planningRange(operation.range))
          fault(400, '每次规划 1–12 章，编号范围为 1–10000；长篇请沿用同一方向分批规划。');
        let rows;
        try {
          rows = outlineShape(target.text).chapters;
        } catch {
          fault(400, '原大纲格式不兼容，请先检查源文件。');
        }
        const numbers = rows.map((row) => Number(row.chapter));
        if (
          numbers.some((number) => !Number.isSafeInteger(number) || number < 1) ||
          new Set(numbers).size !== numbers.length
        )
          fault(400, '原大纲有空白、非整数或重复编号，请先修正再规划。');
        const direction = raw(root + '/' + DIRECTION);
        plan = {
          range: operation.range,
          blueprintHash: direction?.hash ?? null,
          hasDirection: !!direction?.text.trim(),
          sources: planSources(rows, operation.range),
        };
        if (direction) snapshot(DIRECTION, direction);
      }
      if (target.path === 'canon.json') {
        try {
          checkCanonBase(target.text);
        } catch {
          fault(400, '现有资料结构不兼容；请先在源文件中检查，不会自动转换它。');
        }
        if (
          !Array.isArray(operation.sources) ||
          !operation.sources.length ||
          operation.sources.length > 32 ||
          new Set(operation.sources).size !== operation.sources.length ||
          operation.sources.some((path) => !evidencePath(path))
        )
          fault(400, '请选择 1–32 份本书原文；不能把 AI 记忆或大纲当成已发生事实的依据。');
        sources = operation.sources.map((path) => {
          const source = read(path);
          if (!source.text.trim()) fault(400, '所选原文为空：' + path);
          return { path, hash: source.hash, ...(source.parts ? { parts: source.parts } : {}) };
        });
      }
      snapshot(target.path, raw(root + '/' + target.path));
      let promptTemplate;
      if (operation.writing || plan) {
        const rules = raw(root + '/rules.json');
        const planning = operation.writing ? chapterPlanning(target.path) : null;
        const rows = plan ? outlineShape(target.text).chapters : [];
        const key = operation.writing
          ? (operation.writing.templateKey ?? 'write')
          : rows.length &&
              !rows.some(
                (row) => Number(row.chapter) >= plan.range.start && Number(row.chapter) <= plan.range.end,
              )
            ? 'outlineContinue'
            : 'outline';
        try {
          promptTemplate = prepareTemplate({
            key,
            rulesText: rules?.text,
            rulesHash: rules?.hash,
            book: { ...receipt, title: bookTitle ?? receipt.title },
            outline: planning?.outline,
            range: plan?.range,
            rows,
            mode: operation.writing?.flexible ? 'write' : operation.writing?.mode,
          });
        } catch (error) {
          fault(
            409,
            error instanceof SyntaxError ? '规则 JSON 无效，原文保留；请先检查 rules.json。' : error.message,
          );
        }
      }
      const record = {
        version: 1,
        id: proposalId,
        target: target.path,
        baseHash: target.hash,
        draft: 'drafts/' + proposalId + '.md',
        createdAt: now(),
        status: 'pending',
        ...(operation.originSessionId !== undefined ? { originSessionId: operation.originSessionId } : {}),
        ...(operation.writing
          ? {
              writing: {
                version: 1,
                mode: operation.writing.mode,
                instruction: operation.writing.instruction,
                ...(operation.writing.flexible ? { flexible: true } : {}),
                ...(operation.writing.purpose ? { purpose: operation.writing.purpose } : {}),
                ...(operation.writing.templateKey ? { templateKey: operation.writing.templateKey } : {}),
              },
            }
          : {}),
        ...(target.parts ? { targetParts: target.parts } : {}),
        ...(contextOutlineHash !== undefined ? { contextOutlineHash } : {}),
        ...(edit ? { edit } : {}),
        ...(sources ? { sources } : {}),
        ...(plan ? { plan } : {}),
        ...(promptTemplate ? { promptTemplate } : {}),
        // Only NEW author-requested tasks gain direct publication. Old stored
        // proposals keep their original policy, including after resume. The
        // existing accept/CAS/history transaction remains the sole commit path.
        ...(plan || operation.writing ? { publication: { version: 1, mode: 'direct' } } : {}),
        ...(proposalCreationScope?.runId
          ? { nativeWritingRun: { version: 1, id: proposalCreationScope.runId } }
          : {}),
        ...(proposalCreationScope?.agentRequest ? { agentRequest: proposalCreationScope.agentRequest } : {}),
      };
      if (bytes(JSON.stringify(record, null, 2)).byteLength > LIMIT)
        fault(413, '本次来源索引过大，请缩小规划范围；未写入半份提案。');
      if (raw(proposalPath(proposalId))) fault(409, '提案标识重复，未覆盖。');
      writeRaw(root + '/' + record.draft, '');
      writeRaw(proposalPath(proposalId), JSON.stringify(record, null, 2));
      return { ...record, ...(record.writing ? { writingContext: chapterPlanning(record.target) } : {}) };
    }
    if (operation.kind === 'review') {
      const record = proposal(operation.id, false);
      let draft;
      if (record.status !== 'pending' && record.resolvedDraftHash) {
        const frozen = raw(
          root + '/.novel-history/' + sha(record.draft) + '/' + record.resolvedDraftHash + '.md',
        );
        if (!frozen || frozen.hash !== record.resolvedDraftHash)
          fault(409, '处理时的候选快照缺失或损坏，未用当前文件冒充旧版本。');
        draft = { path: record.draft, text: frozen.text, hash: frozen.hash, updatedAt: frozen.updatedAt };
      } else draft = read(record.draft);
      const contextWarning = proposalContextWarning(record);
      const base = proposalBase(record);
      return {
        proposal: record,
        ...(contextWarning ? { contextWarning } : {}),
        ...(record.writing
          ? {
              writingContext:
                contextWarning || orderReview(record)
                  ? { planningWarning: '规划版本已变化，不把当前章纲冒充此候选的旧依据。' }
                  : chapterPlanning(record.target),
            }
          : {}),
        ...(orderReview(record)
          ? {
              orderWarning:
                '章节顺序已调整；此候选基于旧接力，需基于新顺序重新发起。旧候选仍保留，可阅读或另存。',
            }
          : {}),
        draft,
        base: record.edit ? base.text.slice(record.edit.start, record.edit.end) : base.text,
        current: read(record.target),
        ...(record.target === 'canon.json'
          ? { canon: assessCanon(base.text, draft.text, record.sources, read) }
          : {}),
        ...(record.target === 'outline.json'
          ? { outline: outlineAssessment(base.text, draft.text, record.plan) }
          : {}),
      };
    }
    if (operation.kind === 'accept' || operation.kind === 'reject') {
      const record = proposal(operation.id),
        draft = read(record.draft);
      if (operation.kind === 'accept') {
        if (record.nativeWritingRun?.version === 1) writingRuns.beforeAccept(record);
        if (orderReview(record)) fault(409, '章节顺序已调整，此候选需重新复核；原文和候选均保留。');
        const contextWarning = proposalContextWarning(record);
        if (contextWarning) fault(409, contextWarning);
        if (!draft.text.trim()) fault(400, '提案正文还是空的。');
        if (draft.hash !== operation.draftHash) fault(409, '提案仍在变化，请刷新比较后再接受。');
        let text = draft.text;
        if (record.edit) {
          const current = read(record.target);
          if (current.hash !== record.baseHash)
            fault(409, '正文已更新，选段提案未套用到新版本；请比较后重新发起。', { current });
          if (record.edit.end > current.text.length) fault(409, '选段范围不匹配，未修改正文。');
          text = current.text.slice(0, record.edit.start) + draft.text + current.text.slice(record.edit.end);
        }
        if (record.target === 'outline.json') {
          const current = read(record.target);
          if (current.hash !== record.baseHash)
            fault(409, '大纲已更新，请比较新版本；原候选仍保留。', { current });
          const assessment = outlineAssessment(current.text, draft.text, record.plan);
          try {
            text = mergeOutline(current.text, assessment, uuid);
          } catch (error) {
            fault(400, error.message);
          }
          save(DIRECTION, assessment.storyPlan, record.plan.blueprintHash);
        }
        if (record.target === 'canon.json') {
          const current = read(record.target);
          if (current.hash !== record.baseHash)
            fault(409, '资料已更新，请比较新版本后重新整理；旧候选仍保留。', { current });
          try {
            text = mergeCanonSelection(
              current.text,
              assessCanon(current.text, draft.text, record.sources, read),
              operation.keys,
            );
          } catch (error) {
            fault(400, error.message);
          }
        }
        save(record.target, text, record.baseHash);
      }
      snapshot(record.draft, raw(root + '/' + record.draft));
      writeRaw(
        proposalPath(record.id),
        JSON.stringify({
          ...record,
          status: operation.kind === 'accept' ? 'accepted' : 'rejected',
          resolvedAt: now(),
          resolvedDraftHash: draft.hash,
          ...(record.target === 'canon.json' && operation.kind === 'accept'
            ? { acceptedKeys: operation.keys }
            : {}),
        }),
      );
      if (record.nativeWritingRun?.version === 1)
        writingRuns.afterResolve(record, operation.kind === 'accept', read(record.target), draft.hash);
      return { ok: true, document: read(record.target) };
    }
    if (operation.kind === 'history') {
      if (!documentPath(operation.path)) fault(400, '不支持的路径。');
      const scope = sha(root + '/' + operation.path);
      let anchor = null;
      if (operation.after !== undefined && operation.after !== null) {
        if (operation.hash || typeof operation.after !== 'string' || operation.after.length > 512)
          fault(400, '历史分页游标无效。');
        try {
          anchor = JSON.parse(operation.after);
        } catch {
          fault(400, '历史分页游标无效。');
        }
        if (
          !anchor ||
          Array.isArray(anchor) ||
          anchor.v !== 1 ||
          anchor.scope !== scope ||
          !/^[a-f0-9]{64}$/.test(anchor.hash) ||
          !Number.isFinite(anchor.at) ||
          anchor.at < 0 ||
          Object.keys(anchor).length !== 4
        )
          fault(400, '历史分页游标不属于此文件或格式无效。');
      }
      const folder = root + '/.novel-history/' + sha(operation.path);
      safe(folder, true);
      let names;
      try {
        names = fs.readdirSync(folder);
      } catch (error) {
        if (error.code === 'ENOENT') {
          if (operation.hash) fault(404, '历史版本不存在。');
          if (anchor) fault(409, '历史列表已变化，请重新打开历史后重试。');
          return { versions: [], hasMore: false, nextCursor: null };
        }
        throw error;
      }
      const versions = [...new Set(names.map(logicalPath))]
        .filter((name) => /^[a-f0-9]{64}\.md$/.test(name))
        .map((name) => {
          const layout = storage.inspect(folder + '/' + name);
          return { hash: name.slice(0, -3), updatedAt: layout.updatedAt };
        })
        .sort((a, b) => b.updatedAt - a.updatedAt || (a.hash < b.hash ? 1 : a.hash > b.hash ? -1 : 0));
      if (operation.hash) {
        if (!versions.some((entry) => entry.hash === operation.hash)) fault(404, '历史版本不存在。');
        const content = raw(folder + '/' + operation.hash + '.md');
        if (content.hash !== operation.hash) fault(409, '历史版本校验失败。');
        return { text: content.text, hash: content.hash };
      }
      let start = 0;
      if (anchor) {
        const index = versions.findIndex((v) => v.hash === anchor.hash && v.updatedAt === anchor.at);
        if (index < 0) fault(409, '历史列表已变化，请重新打开历史后重试。');
        start = index + 1;
      }
      const page = versions.slice(start, start + 50),
        hasMore = start + page.length < versions.length;
      const last = page.at(-1);
      return {
        versions: page,
        hasMore,
        nextCursor: hasMore ? JSON.stringify({ v: 1, scope, hash: last.hash, at: last.updatedAt }) : null,
      };
    }
    fault(400, '未知书稿操作。');
  }
  return { run: (operation) => db.transactionSync(() => run(operation)) };
}
