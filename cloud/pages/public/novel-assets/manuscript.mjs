import {
  makeDocumentClient,
  changedLines,
  nativeTask,
  proposalPrompt,
  writingEdit,
  canonProposalPrompt,
  documentContextRevision,
} from './manuscript-core.mjs';
import { createReferenceEditor } from './reference-editor.mjs';
import { createCanonReview } from './canon-review.mjs';
import { createOutlineEditor, createOutlineReview } from './outline-editor.mjs';
import { outlinePrompt, DIRECTION_PATH } from './outline-core.mjs';
import { createNativeActivity, bookActivities, subscribeBookActivities } from './native-activity.mjs';
import { createConflictEditor } from './merge-editor.mjs';
import { mixedEndings } from './editor-text.mjs';
import { createProseEditor } from './prose-editor.mjs';
import { illustrationEntries } from '../../../worker/shared/illustrations.mjs';
import { readDraft, writeDraft, settleDraft } from './draft-cache.mjs';
import { createChapterNavigation } from './chapter-navigation.mjs';
import { createContentManagement } from './content-management.mjs';
import { createChapterOrderEditor } from './chapter-order-editor.mjs';
import { orderReviewOf, acknowledgeOrderReview } from './chapter-order-core.mjs';
import { createWritingBasis } from './writing-review.mjs';
import { createWritingRunPanel } from './writing-run-panel.mjs';
import { writingRunPrompt, validRunId } from './writing-run-core.mjs';
import { watchBookChanges, wakeBookChanges } from './book-sync.mjs';
import { createChapterFocus, reviewPrompt } from './chapter-focus.mjs';
import { createReadingExport } from './reading-export.mjs';
import { createImportRecords } from './import-records-view.mjs';
import { createDocumentHistory, historyFrameMatches, mergeHistoryPage } from './document-history.mjs';
import { stageImportReference } from './import-records.mjs';
import { observeProposalPresentation } from './proposal-presentation.mjs';
import { proposalToolModel } from './proposal-tool-view.mjs';
import { createTitleEditor, renameBook } from './title-editor.mjs';
import { parseOutline, editOutline } from './outline-core.mjs';
import {
  MANUSCRIPT_ADDRESS,
  validProposalId,
  createProposalOrigin,
  openProposalConversation,
} from './proposal-navigation.mjs';
const TYPE = 'novel-manuscript',
  ADDRESS = MANUSCRIPT_ADDRESS;
export function installManuscript(ctx, React, { navigation: appNavigation, createPortal } = {}) {
  const h = React.createElement,
    { useState, useEffect, useRef } = React;
  const ReferenceEditor = createReferenceEditor(React);
  const TitleEditor = createTitleEditor(React);
  const NativeActivity = createNativeActivity(React);
  const ConflictEditor = createConflictEditor(React);
  const ProseEditor = createProseEditor(React);
  const DocumentHistory = createDocumentHistory(React, ProseEditor);
  const ChapterNavigation = createChapterNavigation(React);
  const ContentManagement = createContentManagement(React);
  const ChapterOrderEditor = createChapterOrderEditor(React);
  const WritingBasis = createWritingBasis(React);
  const WritingRunPanel = createWritingRunPanel(React);
  const ChapterFocus = createChapterFocus(React);
  const ReadingExport = createReadingExport(React);
  const ImportRecords = createImportRecords(React);
  const ProposalOrigin = createProposalOrigin(React, ctx);
  const CanonReview = createCanonReview(React);
  const OutlineEditor = createOutlineEditor(React),
    OutlineReview = createOutlineReview(React);
  if (!appNavigation)
    ctx.effect(
      () =>
        ctx.sidebarRightTabs.register({
          id: TYPE,
          kind: TYPE,
          patterns: [ADDRESS + '**'],
          priority: 'extension',
          title: () => '书稿',
          canOpen: (address) => /^dsh-resource:\/\/novel\/b-[a-f0-9]{32}$/.test(address),
        }),
      'novel: manuscript tab',
    );
  const open = (id) => {
    if (!appNavigation?.reveal(id, {})) ctx.sidebarRight.openResource(ADDRESS + id);
  };
  function Header({ sessionId, useSessions }) {
    const cwd = useSessions((state) => state.byId[sessionId]?.cwd);
    const id = /^\/workspace\/novels\/(b-[a-f0-9]{32})$/.exec(cwd ?? '')?.[1];
    return id
      ? h('button', { type: 'button', className: 'novel-open-manuscript', onClick: () => open(id) }, '书稿')
      : null;
  }
  function Manuscript({ sessionId, useTabInfo }) {
    const info = useTabInfo();
    const navigation = info.tab.navigation;
    return h(ManuscriptBody, {
      key: info.tab.contentId,
      sessionId,
      tab: info.tab,
      sidebar: info.sidebar,
      navigation,
    });
  }
  function WorkspaceEditor({ bookId, sessionId, navigation, onDialogue, actionHost, headingHost }) {
    return h(ManuscriptBody, {
      sessionId,
      tab: { contentId: ADDRESS + bookId },
      sidebar: { fullscreen: false },
      navigation,
      embedded: true,
      onDialogue,
      actionHost,
      headingHost,
    });
  }
  appNavigation?.bindEditor(WorkspaceEditor);
  function ManuscriptBody({
    sessionId,
    tab,
    sidebar,
    navigation,
    embedded = false,
    onDialogue,
    actionHost,
    headingHost,
  }) {
    const renderActions = (node) =>
      embedded && actionHost && createPortal ? createPortal(node, actionHost, 'novel-writing-actions') : node;
    const renderHeading = (node) =>
      embedded && headingHost && createPortal ? createPortal(node, headingHost, 'novel-book-heading') : node;
    const id = tab.contentId.slice(ADDRESS.length);
    const workspaceSource = React.useMemo(
      () => ({
        subscribe: (fn) => ctx.workspaces.list.subscribe(fn),
        getSnapshot: () => ctx.workspaces.list.getSnapshot(),
      }),
      [],
    );
    const workspaces = React.useSyncExternalStore(workspaceSource.subscribe, workspaceSource.getSnapshot);
    const bookWorkspace = workspaces.items.find((row) => row.path === '/workspace/novels/' + id);
    const api = React.useMemo(() => makeDocumentClient(id), [id]);
    const [listing, setListing] = useState(null),
      [document, setDocument] = useState(null),
      [text, setText] = useState('');
    const [message, setMessage] = useState('正在读取书稿…'),
      [busy, setBusy] = useState(false),
      [panel, setPanel] = useState('chapter');
    const [review, setReviewState] = useState(null),
      [history, setHistory] = useState(null),
      [conflict, setConflict] = useState(null);
    const [selection, setSelection] = useState(null);
    const [legacyAlternative, setLegacyAlternative] = useState(null);
    const [draftStatus, setDraftStatus] = useState(null);
    const [newTitle, setNewTitle] = useState(''),
      [adding, setAdding] = useState(false);
    const [renaming, setRenaming] = useState(false),
      [chapterName, setChapterName] = useState('');
    const [opening, setOpening] = useState(null);
    const [documentOptions, setDocumentOptions] = useState(false);
    const [chapterDirectory, setChapterDirectory] = useState(false);
    const [management, setManagement] = useState(null);
    const documentOptionsId = React.useId();
    useEffect(() => {
      setDocumentOptions(false);
      setChapterDirectory(false);
      setManagement(null);
    }, [id, document?.path, panel]);
    const [order, setOrder] = useState(null);
    const [activeRunId, setActiveRunId] = useState(null);
    const [showImportRecords, setShowImportRecords] = useState(false);
    const [liveCandidate, setLiveCandidate] = useState(null);
    const [presentationReady, setPresentationReady] = useState(false);
    const liveOwner = useRef(null),
      followed = useRef(null),
      browsingTurn = useRef(null);
    // Author input is contextual presentation, not a second request buffer.
    // Structural/reference editors need the viewport; the original portal
    // stays mounted and becomes visible again in prose or the assistant.
    const showAuthorInput =
      (panel === 'chapter' || !!liveCandidate) && !order && !history && !opening && !management;
    useEffect(() => {
      if (embedded) appNavigation?.authorInput(showAuthorInput);
      return () => {
        if (embedded) appNavigation?.authorInput(false);
      };
    }, [showAuthorInput, embedded]);
    const [showReviewSource, setShowReviewSource] = useState(false);
    useEffect(() => setShowReviewSource(false), [review?.proposal.id]);
    const selected = useRef(null),
      lastChapter = useRef(null),
      lastReference = useRef(null),
      selectionRequest = useRef(0),
      pendingSelection = useRef(null),
      handledNavigation = useRef(null),
      latestNavigation = useRef(navigation),
      state = useRef({});
    const operation = useRef(false),
      reviewFetch = useRef(0),
      reviewEpoch = useRef(0),
      reviewIdentity = useRef(null);
    const historyOwner = useRef(null),
      body = useRef(null),
      historyPosition = useRef(null),
      historyReturn = useRef(null);
    React.useLayoutEffect(() => {
      if (!history && historyReturn.current !== null && body.current) {
        body.current.scrollTop = historyReturn.current;
        historyReturn.current = null;
      }
    }, [history]);
    function closeHistory(returnToEditor = false) {
      historyOwner.current = null;
      historyReturn.current = returnToEditor ? historyPosition.current : null;
      setHistory(null);
    }
    async function openHistory() {
      const path = state.current.document.path;
      await preserveDraft();
      const owner = { path, selection: selectionRequest.current };
      historyOwner.current = owner;
      browsingTurn.current = liveOwner.current?.turn ?? browsingTurn.current;
      followed.current = null;
      setLiveCandidate(null);
      historyPosition.current = body.current?.scrollTop ?? 0;
      if (body.current) body.current.scrollTop = 0;
      setHistory({ versions: [], path, owner, version: null, loading: true });
      setMessage('历史只读浏览，当前稿未改变');
      fetchHistoryList(owner);
    }
    function ownsHistory(owner) {
      return (
        historyOwner.current === owner &&
        selected.current === owner.path &&
        owner.selection === selectionRequest.current
      );
    }
    async function fetchHistoryList(owner, after = null) {
      const request = (owner.listRead = (owner.listRead ?? 0) + 1);
      setHistory((previous) =>
        previous?.owner === owner ? { ...previous, loading: true, listError: null } : previous,
      );
      try {
        const result = await api('history', null, { path: owner.path, ...(after === null ? {} : { after }) });
        if (!ownsHistory(owner) || owner.listRead !== request) return;
        // Validate outside React's updater so a malformed page is an inline
        // read failure rather than a render error, with earlier rows intact.
        const previous = after === null ? { versions: [] } : history;
        mergeHistoryPage(previous, result, after);
        setHistory((previous) =>
          previous?.owner === owner ? mergeHistoryPage(previous, result, after) : previous,
        );
      } catch (error) {
        if (ownsHistory(owner) && owner.listRead === request)
          setHistory((previous) =>
            previous?.owner === owner ? { ...previous, loading: false, listError: error.message } : previous,
          );
      }
    }
    async function previewHistory(entry) {
      const current = history,
        owner = current?.owner;
      if (!owner || historyOwner.current !== owner) return;
      const request = (owner.read = (owner.read ?? 0) + 1);
      setHistory((previous) =>
        previous?.owner === owner ? { ...previous, pending: entry.hash, error: null } : previous,
      );
      try {
        const version = await api('history', null, { path: current.path, hash: entry.hash });
        if (!ownsHistory(owner) || owner.read !== request) return;
        if (version.hash !== entry.hash || typeof version.text !== 'string')
          throw new Error('历史版本返回内容不完整，当前稿未修改。');
        setHistory((previous) =>
          previous?.owner === owner
            ? { ...previous, pending: null, version: { ...version, updatedAt: entry.updatedAt } }
            : previous,
        );
      } catch (error) {
        if (ownsHistory(owner) && owner.read === request)
          setHistory((previous) =>
            previous?.owner === owner ? { ...previous, pending: null, error: error.message } : previous,
          );
      }
    }
    async function loadHistory(frame) {
      const current = history;
      const matches = () =>
        historyOwner.current === current?.owner &&
        current?.version?.hash === frame.versionHash &&
        historyFrameMatches(state.current.document, state.current.text, frame) &&
        (!state.current.document.candidate || state.current.document.candidate.editable);
      if (!matches()) throw new Error('当前稿或历史选择已变化，请重新比较；未载入旧结果。');
      if (state.current.document.candidate && !state.current.document.candidate.editable)
        throw new Error('候选只读，未载入历史修改。');
      await preserveDraft();
      if (!matches()) throw new Error('当前稿已变化，请重新比较；原修改仍保留。');
      const latest = await api('document', null, { path: frame.path });
      if (!matches()) throw new Error('当前稿已变化，请重新比较；原修改仍保留。');
      if (latest.hash !== frame.hash) {
        const error = new Error('云端版本已更新，当前稿未修改；请返回编辑处理冲突后，再比较历史。');
        error.status = 409;
        error.current = latest;
        error.path = frame.path;
        throw error;
      }
      if (latest.candidate && !latest.candidate.editable) throw new Error('候选已变为只读，当前稿未修改。');
      edit(current.version.text);
      closeHistory(true);
      setMessage('历史版本已载入编辑区；保存后才会恢复正文。');
    }
    const setReview = (value) => {
      const identity = value?.proposal?.id ?? null;
      if (reviewIdentity.current !== identity) reviewEpoch.current++;
      reviewIdentity.current = identity;
      setReviewState(value);
    };
    latestNavigation.current = navigation;
    const dirty = !!document && text !== document.text;
    const candidate = document?.candidate,
      canonCandidate = candidate?.target === 'canon.json';
    const mixedNewlines = React.useMemo(() => mixedEndings(document?.text ?? ''), [document?.text]);
    state.current = { document, text, dirty, conflict, panel, management };
    const draftKey = (path) => 'novel-unsubmitted:' + id + ':' + path;
    const say = (error) =>
      setMessage(
        error.name === 'TimeoutError' ? '请求超时，修改仍保留；可重试或下载本地稿。' : error.message,
      );
    const loadList = async () => {
      const result = await api('documents');
      setListing(result);
      return result;
    };
    useEffect(() => {
      if (!presentationReady) return;
      let alive = true;
      const finish = async (owner, model) => {
        await loadList();
        if (
          !alive ||
          liveOwner.current !== owner ||
          followed.current !== owner ||
          browsingTurn.current === owner.turn ||
          pendingSelection.current !== null ||
          state.current.dirty
        )
          return;
        setLiveCandidate(null);
        followed.current = null;
        if (model.result?.published) {
          setPanel(model.result.target.endsWith('/outline.json') ? 'outline' : 'chapter');
          await select(model.result.target.replace('/workspace/novels/' + id + '/', ''));
          setMessage('已同步到正式书稿');
        } else
          setMessage(
            model.result?.publicationIssue || model.result?.warning || '草稿已保留，尚未保存到正式书稿。',
          );
      };
      const release = observeProposalPresentation(
        ctx,
        { sessionId, root: '/workspace/novels/' + id },
        ({ toolName, block, turn, reset }) => {
          if (reset) {
            liveOwner.current = null;
            followed.current = null;
            setLiveCandidate(null);
            return;
          }
          const model = proposalToolModel(toolName, block);
          if (toolName === 'novel_outline_update') {
            if (
              model.settled &&
              !model.failed &&
              model.result?.applied === true &&
              model.result.bookId === id
            ) {
              const serial = selectionRequest.current;
              loadList()
                .then(async () => {
                  if (
                    !alive ||
                    selectionRequest.current !== serial ||
                    operation.current ||
                    pendingSelection.current !== null
                  )
                    return;
                  if (state.current.dirty || historyOwner.current) {
                    setMessage('AI 已更新规划；你的未保存内容仍保留，保存前请比较新版本。');
                    return;
                  }
                  if (selected.current) await select(selected.current, false);
                  if (alive) setMessage('规划已更新，正文与历史保留');
                })
                .catch((error) => alive && say(error));
            }
            return;
          }
          const pid = block.args?.text?.('proposal_id') ?? model.result?.proposalId;
          if (!validProposalId(pid)) return;
          // Historical settled calls must not move the current manuscript. Only
          // follow a live call after its real receipt proves current book/session.
          if (
            !model.settled &&
            (liveOwner.current?.id !== pid || liveOwner.current?.callId !== block.callId)
          ) {
            const owner = { id: pid, callId: block.callId, turn, block, selection: selectionRequest.current };
            liveOwner.current = owner;
            if (browsingTurn.current === turn) return;
            api('review', null, { id: pid })
              .then(async (value) => {
                if (
                  !alive ||
                  liveOwner.current !== owner ||
                  owner.selection !== selectionRequest.current ||
                  browsingTurn.current === turn ||
                  (value.proposal.writerSessionId ?? value.proposal.originSessionId) !== sessionId ||
                  state.current.dirty ||
                  state.current.management ||
                  historyOwner.current ||
                  operation.current ||
                  pendingSelection.current !== null
                )
                  return;
                setPanel(
                  value.proposal.target === 'outline.json'
                    ? 'outline'
                    : value.proposal.target === 'canon.json'
                      ? 'reference'
                      : 'chapter',
                );
                await select(value.proposal.target);
                if (
                  !alive ||
                  liveOwner.current !== owner ||
                  selected.current !== value.proposal.target ||
                  browsingTurn.current === turn ||
                  state.current.dirty
                )
                  return;
                followed.current = owner;
                const latest = proposalToolModel(toolName, owner.block);
                if (latest.settled) return finish(owner, latest);
                setLiveCandidate({ id: pid, block: owner.block, target: value.proposal.target });
                appNavigation?.manuscript();
              })
              .catch(() => {}); // Other books' tools never become this book's view.
          } else if (!model.settled && followed.current?.callId === block.callId) {
            if (liveOwner.current) liveOwner.current.block = block;
            setLiveCandidate((current) => (current?.id === pid ? { ...current, block } : current));
          }
          if (liveOwner.current?.id === pid && liveOwner.current.callId === block.callId) {
            const owner = liveOwner.current;
            owner.block = block;
            if (model.settled) finish(owner, model).catch(say);
          }
        },
        say,
      );
      return () => {
        alive = false;
        release();
        liveOwner.current = null;
        followed.current = null;
        browsingTurn.current = null;
      };
    }, [id, sessionId, presentationReady]);
    async function preserveDraft() {
      const active = state.current;
      if (active.dirty && active.document) {
        await writeDraft(draftKey(active.document.path), {
          hash: active.document.hash,
          baseText: active.document.text,
          text: active.text,
        });
        if (state.current.text !== active.text || state.current.document?.path !== active.document.path)
          throw new Error('草稿仍在变化，未切换；请稍后再试。');
      }
    }
    async function select(path, preserve = true, request) {
      // Reserve ownership before awaiting local draft persistence. A slower
      // earlier navigation must never become the newest request afterwards.
      const serial = request ?? ++selectionRequest.current;
      pendingSelection.current = serial;
      reviewFetch.current++;
      reviewEpoch.current++;
      try {
        if (preserve) {
          try {
            await preserveDraft();
          } catch (e) {
            if (serial !== selectionRequest.current) return false;
            const active = state.current;
            setPanel(
              panel === 'proposals'
                ? active.document.path.startsWith('chapters/')
                  ? 'chapter'
                  : ['outline.json', DIRECTION_PATH].includes(active.document.path)
                    ? 'outline'
                    : 'reference'
                : panel,
            );
            throw new Error(e.message + ' 当前稿仍保留，未切换文件。');
          }
        }
        if (serial !== selectionRequest.current) return false;
        setOpening(path);
        const [value, local] = await Promise.all([
          api('document', null, { path }),
          readDraft(draftKey(path)).then(
            (saved) => ({ saved }),
            (cacheError) => ({ cacheError }),
          ),
        ]);
        const { saved, cacheError } = local;
        if (serial !== selectionRequest.current) return;
        selected.current = path;
        setShowImportRecords(false);
        if (path.startsWith('chapters/')) lastChapter.current = path;
        else if (
          !['outline.json', 'rules.json', DIRECTION_PATH].includes(path) &&
          !path.startsWith('drafts/')
        )
          lastReference.current = path;
        setDocument(value);
        setText(value.text);
        state.current = { document: value, text: value.text, dirty: false, conflict: null };
        setReview(null);
        setConflict(null);
        closeHistory();
        setSelection(null);
        setRenaming(false);
        setLegacyAlternative(saved?.legacyAlternative ?? null);
        setDraftStatus(saved ? { path, text: saved.text, phase: saved.warning ? 'error' : 'saved' } : null);
        try {
          if (
            saved &&
            typeof saved.text === 'string' &&
            typeof saved.baseText === 'string' &&
            /^[a-f0-9]{64}$/.test(saved.hash) &&
            saved.text !== value.text
          ) {
            setDocument({ ...value, text: saved.baseText, hash: saved.hash });
            setText(saved.text);
            state.current = {
              document: { ...value, text: saved.baseText, hash: saved.hash },
              text: saved.text,
              dirty: saved.text !== saved.baseText,
              conflict: saved.hash !== value.hash ? value : null,
            };
            if (saved.hash !== value.hash) setConflict(value);
            setMessage(saved.warning || '已恢复这台设备未保存的修改。');
          } else setMessage(saved?.warning || (cacheError ? cacheError.message : '已读取'));
        } catch {
          setMessage('已读取；本地草稿不可用，请及时保存。');
        }
        return true;
      } catch (error) {
        if (serial === selectionRequest.current) {
          // Failed reads retain the current document and its only writable
          // draft. The requested panel is committed only after a valid read.
          say(error);
        }
        return false;
      } finally {
        if (pendingSelection.current === serial) {
          pendingSelection.current = null;
          setOpening(null);
        }
      }
    }
    async function browsePanel(key) {
      if (operation.current || !listing) return;
      const serial = ++selectionRequest.current;
      pendingSelection.current = serial;
      setOpening(key);
      browsingTurn.current = liveOwner.current?.turn ?? browsingTurn.current;
      followed.current = null;
      setLiveCandidate(null);
      // Leaving history invalidates its read owner even if the next file
      // fails to load. Return to the preserved editor, not a stale reader.
      closeHistory(true);
      reviewFetch.current++;
      reviewEpoch.current++;
      try {
        await preserveDraft();
        if (serial !== selectionRequest.current || operation.current) return;
        const records = key === 'proposals' ? await loadList() : listing;
        if (serial !== selectionRequest.current || operation.current) return;
        let path;
        if (key === 'prompts') path = 'rules.json';
        else if (key === 'outline') {
          if (listing.documents.some((item) => item.path === 'outline.json')) path = 'outline.json';
        } else if (!['run', 'proposals'].includes(key)) {
          const category = key === 'chapter' ? 'chapter' : 'reference';
          const current = listing.documents.find((item) => item.path === selected.current);
          const remembered = key === 'chapter' ? lastChapter.current : lastReference.current;
          path =
            current?.category === category &&
            !(key === 'reference' && ['outline.json', 'rules.json', DIRECTION_PATH].includes(current.path))
              ? current.path
              : (
                  listing.documents.find(
                    (item) =>
                      item.path === remembered &&
                      item.category === category &&
                      !(
                        key === 'reference' &&
                        ['outline.json', 'rules.json', DIRECTION_PATH].includes(item.path)
                      ),
                  ) ||
                  listing.documents.find(
                    (item) =>
                      item.category === category &&
                      !['outline.json', 'rules.json', DIRECTION_PATH].includes(item.path),
                  ) ||
                  (key === 'chapter'
                    ? listing.documents.find((item) => item.category === 'draft' && !item.managed)
                    : null)
                )?.path;
        }
        if (path && !(await select(path, false, serial))) return;
        if (serial !== selectionRequest.current) return;
        setPanel(key);
        setShowImportRecords(false);
        setReview(null);
        closeHistory();
        setAdding(false);
        setRenaming(false);
        if (key === 'proposals' && records.proposals.length) {
          await showReview(
            (records.proposals.find((item) => item.status === 'pending') ?? records.proposals[0]).id,
            () => serial === selectionRequest.current,
          );
        } else if (!path && !['run', 'proposals'].includes(key)) {
          selected.current = null;
          setDocument(null);
          setText('');
          if (key === 'outline')
            setMessage(
              listing.outlineParts?.length
                ? '导入大纲为长文分片，尚未支持聚合编辑；原分片保留，可在原生文件工具中查看。'
                : '大纲文件不存在，未创建空文件覆盖它。',
            );
        }
      } catch (error) {
        if (serial === selectionRequest.current) say(error);
      } finally {
        if (pendingSelection.current === serial) {
          pendingSelection.current = null;
          setOpening(null);
        }
      }
    }
    async function perform(task, rethrow = false) {
      if (operation.current) return;
      operation.current = true;
      setBusy(true);
      try {
        return await task();
      } catch (error) {
        say(error);
        if (
          error.status === 409 &&
          error.current !== undefined &&
          error.path === state.current.document?.path
        )
          setConflict(error.current ?? { path: error.path, text: '', hash: null, deleted: true });
        if (rethrow) throw error;
      } finally {
        operation.current = false;
        setBusy(false);
      }
    }
    function manage(action, extra = {}) {
      if (operation.current || pendingSelection.current !== null) return;
      const current = state.current;
      if (current.dirty || current.conflict) {
        setMessage('请先保存或解决当前修改，再删除、清空或恢复；未保存稿仍保留。');
        return;
      }
      browsingTurn.current = liveOwner.current?.turn ?? browsingTurn.current;
      followed.current = null;
      setLiveCandidate(null);
      closeHistory();
      setDocumentOptions(false);
      setManagement({
        action,
        ...extra,
        ...(['clearChapter', 'deleteChapter'].includes(action) ? { path: current.document?.path } : {}),
        frame: current.document
          ? { path: current.document.path, hash: current.document.hash, text: current.text }
          : null,
      });
      if (body.current) body.current.scrollTop = 0;
    }
    async function commitManagement(request) {
      return perform(async () => {
        const current = state.current,
          frame = management.frame;
        if (
          current.dirty ||
          current.conflict ||
          (frame && !historyFrameMatches(current.document, current.text, frame))
        )
          throw new Error('当前稿已变化，请返回重新核对；未执行操作。');
        const result = await api('content', request);
        // Mutations have committed here. Never turn a following refresh/cache
        // failure into a false claim that the server operation did not happen.
        let warning = result.warning || '';
        if (current.document && result.paths.includes(current.document.path)) {
          try {
            await settleDraft(draftKey(current.document.path), {
              previousHash: current.document.hash,
              hash: current.document.hash,
              text: current.text,
            });
          } catch {
            warning += ' 本机恢复缓存清理未完成，旧稿缓存仍保留。';
          }
        }
        setManagement(null);
        setChapterDirectory(false);
        if (result.deleted === selected.current) {
          selected.current = null;
          lastChapter.current = null;
          state.current = { document: null, text: '', dirty: false, conflict: null };
          setDocument(null);
          setText('');
          setConflict(null);
          setSelection(null);
        }
        try {
          const next = await loadList();
          const target =
            result.deleted === current.document?.path
              ? next.documents.find((doc) => doc.category === 'chapter')?.path
              : result.paths.includes(current.document?.path)
                ? current.document.path
                : request.action === 'restore'
                  ? result.paths.find((path) => path.startsWith('chapters/'))
                  : null;
          if (target) {
            await select(target, false);
            if (target.startsWith('chapters/')) setPanel('chapter');
          }
        } catch {
          warning += ' 列表刷新未完成，请刷新页面；操作已保存。';
        }
        setMessage(
          (result.alreadyRestored
            ? '此记录已恢复，没有重复覆盖。'
            : result.unchanged
              ? '内容原本为空，无需清空。'
              : request.action === 'restore'
                ? '已恢复。'
                : '已保存操作，可在“回收与恢复”撤销。') + warning,
        );
        return result;
      }, true);
    }
    async function save() {
      const current = state.current;
      setMessage('正在保存…');
      const value = await api('document', {
        path: current.document.path,
        text: current.text,
        expectedHash: current.document.hash,
      });
      if (selected.current === value.path) {
        state.current = {
          ...state.current,
          document: value,
          conflict: null,
          dirty: state.current.text !== value.text,
        };
        setDocument(value);
        setConflict(null);
        setMessage(state.current.text === current.text ? '已保存' : '旧版本已保存，当前新修改尚未保存。');
        // Collapse only the successfully committed view, never a newer draft
        // typed while the request was in flight or a different selection.
        if (!state.current.dirty) {
          setDocumentOptions(false);
          setChapterDirectory(false);
        }
      }
      try {
        await settleDraft(draftKey(value.path), {
          previousHash: current.document.hash,
          hash: value.hash,
          text: current.text,
        });
      } catch {
        setMessage(
          state.current.text === current.text
            ? '云端已保存；本机草稿清理未完成，旧恢复副本仍保留。'
            : '旧版本已保存，当前新修改尚未保存；本机缓存异常，请下载备份。',
        );
      }
      await loadList();
    }
    function edit(value) {
      setText(value);
      const base = state.current.document;
      state.current = { ...state.current, text: value, dirty: value !== base.text };
      if (!busy) setMessage('未保存');
      setDraftStatus({ path: base.path, text: value, phase: 'pending' });
      writeDraft(draftKey(base.path), { hash: base.hash, baseText: base.text, text: value })
        .then(() => {
          if (state.current.document?.path === base.path && state.current.text === value)
            setDraftStatus({ path: base.path, text: value, phase: 'saved' });
        })
        .catch(() => {
          if (state.current.document?.path === base.path && state.current.text === value)
            setDraftStatus({ path: base.path, text: value, phase: 'error' });
        });
    }
    async function adoptMerge(merged, frame, manual = false) {
      const matches = () => {
        const current = state.current;
        return (
          current.document?.path === frame.path &&
          current.document.hash === frame.baseHash &&
          current.text === frame.local &&
          current.conflict?.hash === frame.remoteHash &&
          !current.conflict?.deleted
        );
      };
      if (!matches()) throw new Error('比较已失效，原稿仍保留，请重新对比。');
      const latest = await api('document', null, { path: frame.path });
      if (!matches()) throw new Error('等待期间版本或本机稿发生变化，未应用旧合并。');
      if (latest.hash !== frame.remoteHash) {
        setConflict(latest);
        throw new Error('云端再次更新，未应用旧合并；请重新对比。');
      }
      // Rebase the SAME local-draft record before changing its editor baseline.
      // Refuse on quota errors instead of losing the only restart-safe copy.
      try {
        await writeDraft(draftKey(frame.path), { hash: latest.hash, baseText: latest.text, text: merged });
      } catch {
        throw new Error('本机草稿保存失败，未应用合并；请先下载本机稿。');
      }
      if (!matches()) throw new Error('草稿保存期间版本或本机稿发生变化，未载入旧合并。');
      setDocument(latest);
      setText(merged);
      setDraftStatus({ path: frame.path, text: merged, phase: 'saved' });
      setSelection(null);
      setConflict(null);
      setMessage(
        manual
          ? '已采用云端作为新基线，本机内容保留；手工合并后再保存。'
          : '三方合并结果已载入编辑区，尚未保存。',
      );
    }
    async function createChapter() {
      const title = (newTitle.trim() || '新章节').normalize('NFC');
      const slug =
        title
          .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, ' ')
          .replace(/^[.\s]+/, '')
          .trim()
          .slice(0, 70) || '新章节';
      const path = 'chapters/' + slug + '-' + crypto.randomUUID().slice(0, 8) + '.md';
      await api('document', {
        path,
        text: '# ' + title + '\n\n',
        expectedHash: null,
      });
      setNewTitle('');
      setAdding(false);
      await loadList();
      await select(path);
      return path;
    }
    async function renameChapter() {
      const current = state.current;
      if (current.dirty) throw new Error('请先保存或处理正文修改，再更改标题。');
      const value = await api('chapter-title', {
        path: current.document.path,
        title: chapterName,
        expectedHash: current.document.hash,
        outlineHash: current.document.outlineHash,
      });
      setRenaming(false);
      await applyTitleResult(value, current);
    }
    async function renameOutlineTitle(index, title) {
      const current = state.current;
      if (current.dirty || current.document?.path !== 'outline.json')
        throw new Error('请先保存大纲修改，再更改标题。');
      const row = parseOutline(current.text).rows[index];
      if (!row) throw new Error('章纲已变化，请重新读取。');
      const paths = row.chapterPath
        ? [row.chapterPath]
        : (current.document.bindings?.find((binding) => binding.chapter === Number(row.chapter))?.paths ??
          []);
      if (paths.length > 1) throw new Error('本章关联多份正文，请先明确章节绑定，未修改标题。');
      const path = paths[0];
      if (path && listing.documents.some((doc) => doc.category === 'chapter' && doc.path === path)) {
        const chapter = await api('document', null, { path });
        await api('chapter-title', {
          path,
          title,
          expectedHash: chapter.hash,
          outlineHash: current.document.hash,
        });
      } else
        await api('document', {
          path: 'outline.json',
          expectedHash: current.document.hash,
          text: editOutline(current.text, { kind: 'field', index, field: 'title', value: title }),
        });
      const updated = await api('document', null, { path: 'outline.json' });
      await applyTitleResult(updated, current);
    }
    async function applyTitleResult(value, current) {
      if (selected.current === value.path) {
        if (state.current.text !== current.text) {
          setConflict(value);
          setMessage('标题已保存；等待期间的新修改仍保留，请比较后合并。');
        } else {
          state.current = { document: value, text: value.text, dirty: false, conflict: null };
          setDocument(value);
          setText(value.text);
          setSelection(null);
          setConflict(null);
          setMessage(
            value.path === 'outline.json'
              ? '章纲标题已保存，关联正文标题同步；路径和章号未变。'
              : '标题已保存，正文路径和章节编号未变。',
          );
          // A clean recovery checkpoint also retires any old clean cached text.
          // Input after this point uses the new baseline, never an old title.
          try {
            await writeDraft(draftKey(value.path), {
              hash: value.hash,
              baseText: value.text,
              text: value.text,
            });
            await settleDraft(draftKey(value.path), {
              previousHash: value.hash,
              hash: value.hash,
              text: value.text,
            });
          } catch {
            setMessage('标题已保存；本机草稿缓存异常，请下载当前稿备份。');
          }
        }
      }
      await loadList();
    }
    async function beginChapterOrder() {
      await preserveDraft();
      const snapshot = await api('chapter-order');
      if (snapshot.entries.length < 2) throw new Error('至少两章才能调整顺序。');
      setOrder({ ...snapshot, id: crypto.randomUUID() });
      setRenaming(false);
      setAdding(false);
      closeHistory();
      setMessage('先调整位置，再预览影响；当前书稿与未提交稿均保留。');
    }
    async function applyChapterOrder(keys, preview) {
      await preserveDraft();
      await api('chapter-order', {
        action: 'apply',
        keys,
        version: order.version,
        fingerprint: preview.fingerprint,
      });
      setOrder(null);
      await loadList();
      const before = state.current.document;
      if (before && selected.current === before.path) {
        const latest = await api('document', null, { path: before.path });
        const current = state.current;
        if (selected.current === latest.path && current.document?.hash === before.hash) {
          if (latest.hash === current.document.hash) {
            setDocument(latest);
            state.current = { ...current, document: latest };
          } else if (current.dirty) setConflict(latest);
          else {
            setDocument(latest);
            setText(latest.text);
            state.current = { document: latest, text: latest.text, dirty: false, conflict: null };
          }
        }
      }
      setMessage('顺序已保存，正文与本机稿未改写；接力、旧记忆与候选请复核。');
    }
    async function start(mode, templateKey = 'write', reviewFocus = 'general') {
      if (state.current.dirty) throw new Error('请先保存当前正文，再让 AI 基于这个版本创作。');
      const send = nativeTask(ctx, sessionId, listing.book, { fromComposer: true });
      const instruction = send.instruction;
      let target = document;
      if (
        ['write', 'begin', 'continue'].includes(mode) &&
        !target?.outline &&
        !target?.text.replace(/^\uFEFF?#[^\r\n]*(?:\r?\n|$)/, '').trim()
      ) {
        send(
          JSON.stringify({
            request: instruction || '按大纲撰写当前章节',
            kind: 'write',
            book: listing.book.root,
            ...(target?.path.startsWith('chapters/') ? { path: target.path } : {}),
          }),
          { kind: 'chapter', instruction },
        );
        return;
      }
      if (!target || !target.path.startsWith('chapters/')) {
        const path = await createChapter();
        target = await api('document', null, { path });
      } else {
        const base = target;
        const fresh = await api('document', null, { path: base.path });
        if (
          state.current.dirty ||
          selected.current !== base.path ||
          state.current.document?.hash !== base.hash
        )
          throw new Error('准备期间书稿或本机修改发生变化，未发送 AI 任务；请核对当前稿。');
        if (fresh.hash !== base.hash) {
          setConflict(fresh);
          throw new Error('云端正文已更新，未发送旧版本的 AI 任务；请先比较。');
        }
        target = fresh;
        setDocument(fresh);
        state.current = { ...state.current, document: fresh };
      }
      if (target.outlineHash === undefined)
        throw new Error('章纲或正文关联暂不可用，未发送旧规划；可在源文件中核对后重试。');
      if (mode === 'review')
        send(reviewPrompt(listing.book, target, listing.documents, { focus: reviewFocus, instruction }), {
          kind: 'review',
          instruction,
        });
      else {
        const hasSelection = !!selection?.text;
        if (hasSelection && target.text.slice(selection.start, selection.end) !== selection.text)
          throw new Error('选段已变化，请重新选择要改写的文字；未创建提案。');
        const edit = writingEdit(target, mode, selection);
        const writingMode =
          mode === 'write'
            ? target.text.replace(/^\uFEFF?#[^\r\n]*(?:\r?\n|$)/, '').trim()
              ? 'rewrite'
              : 'begin'
            : mode === 'continue' &&
                target.outline &&
                !target.text.replace(/^\uFEFF?#[^\r\n]*(?:\r?\n|$)/, '').trim()
              ? 'begin'
              : mode;
        const proposal = await api('proposals', {
          originSessionId: sessionId,
          path: target.path,
          expectedHash: target.hash,
          outlineHash: target.outlineHash,
          writing: {
            version: 1,
            mode: writingMode,
            instruction,
            flexible: true,
            templateKey,
            ...(writingMode === 'begin' && target.outline ? { purpose: 'chapter' } : {}),
          },
          ...(edit ? { edit } : {}),
        });
        if (
          state.current.dirty ||
          selected.current !== target.path ||
          state.current.document?.hash !== target.hash
        )
          throw new Error('准备期间正文有新修改，未发送 AI 任务；本机稿与未发送候选均保留。');
        send(
          proposalPrompt(
            listing.book,
            target,
            proposal,
            instruction,
            writingMode,
            selection?.text ?? '',
            listing.documents,
          ),
          {
            kind:
              templateKey === 'deai'
                ? 'polish'
                : templateKey === 'ending'
                  ? 'ending'
                  : proposal.writing.purpose === 'chapter'
                    ? 'chapter'
                    : writingMode === 'begin'
                      ? 'begin'
                      : writingMode === 'continue'
                        ? 'continue'
                        : 'rewrite',
            instruction,
            proposalId: proposal.id,
          },
        );
        setReview(await api('review', null, { id: proposal.id }));
        setPanel('chapter');
        await loadList();
      }
      setMessage(mode === 'review' ? '审稿意见在当前对话中。' : '正在创作，完成后自动保存并保留旧版。');
    }
    async function startWritingRun(range, publication) {
      if (state.current.dirty) throw new Error('请先保存当前修改，再发起按纲连写。');
      const send = nativeTask(ctx, sessionId, listing.book, { fromComposer: true });
      const outline = await api('document', null, { path: 'outline.json' });
      if (state.current.dirty) throw new Error('准备期间有新修改，未创建连写；本机稿保留。');
      const run = await api('writing-run', {
        action: 'create',
        id: crypto.randomUUID(),
        range,
        publication,
        expectedHash: outline.hash,
        originSessionId: sessionId,
        instruction: send.instruction,
      });
      setActiveRunId(run.id);
      setPanel('run');
      if (!run.completed)
        send(writingRunPrompt(listing.book, run), {
          kind: 'writing-run',
          runId: run.id,
          instruction: run.instruction,
        });
      await loadList();
      setMessage(
        run.completed
          ? '所选章节均已有正文，已跳过，未调用模型。'
          : '连写已交给当前原生对话；可以继续浏览书稿。',
      );
      return run;
    }
    async function resumeWritingRun(run) {
      if (state.current.dirty) throw new Error('请先保存当前修改，再继续连写。');
      if (run.originSessionId !== sessionId) throw new Error('请先打开本次连写的发起对话，再继续检查点。');
      // A resume does not reinterpret the frozen instruction or consume new intent.
      const send = nativeTask(ctx, sessionId, listing.book);
      const fresh = await api('writing-run', null, { id: run.id });
      send(writingRunPrompt(listing.book, fresh), {
        kind: 'writing-run',
        runId: fresh.id,
        instruction: fresh.instruction,
      });
      setMessage('已请求从原检查点继续；已有候选保留。');
    }
    function editWritingInstruction() {
      try {
        const binding = ctx.sessions.binding(sessionId);
        if (!binding || ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd !== listing.book.root)
          throw new Error('当前对话不属于这本书。');
        const input = ctx.conversation.input.for(binding.ctx);
        if (embedded && !actionHost) onDialogue?.();
        if ((sidebar.fullscreen || innerWidth < 960) && ctx.sidebarRight.isExpanded())
          ctx.sidebarRight.toggleExpanded();
        requestAnimationFrame(() => input.focus());
      } catch (error) {
        say(error);
      }
    }
    const planningDocuments = () =>
      listing.documents.filter((item) =>
        ['seed.md', 'setting.md', 'canon.json', 'rules.json', 'memory.json'].includes(item.path),
      );
    async function planOutline(range, instruction) {
      if (dirty) throw new Error('请先保存大纲，再基于这个版本发起规划。');
      const send = nativeTask(ctx, sessionId, listing.book);
      const proposal = await api('proposals', {
        path: 'outline.json',
        expectedHash: document.hash,
        range,
        originSessionId: sessionId,
      });
      send(outlinePrompt(listing.book, proposal, instruction, planningDocuments()), {
        kind: 'outline',
        instruction,
        proposalId: proposal.id,
      });
      setReview(await api('review', null, { id: proposal.id }));
      setPanel('outline');
      await loadList();
      setMessage('正在规划，完成后直接保存；旧版本保留在历史中。');
    }
    async function resumeOutline() {
      const send = nativeTask(ctx, sessionId, listing.book);
      const current = await api('review', null, { id: review.proposal.id });
      if (current.current.hash !== current.proposal.baseHash || current.outline?.staleSources)
        throw new Error('大纲、方向或正文已更新，请基于新版本发起规划；原候选保留。');
      const resumed = await api('proposals', {
        resumeId: current.proposal.id,
        originSessionId: sessionId,
        expectedDraftHash: current.draft.hash,
      });
      send(
        outlinePrompt(listing.book, resumed, '补全当前大纲', planningDocuments()) +
          '\n' +
          JSON.stringify({ validationIssues: current.outline?.issues ?? [] }),
        {
          kind: 'outline-resume',
          instruction: '保留已有规划，补齐缺章并修正检查指出的问题。',
          proposalId: current.proposal.id,
        },
      );
      setMessage('补全原候选 · 已有规划保留。');
    }
    async function openOutlineChapter(chapter) {
      if (dirty) throw new Error('请先保存大纲，再打开或关联正文。');
      const result = await api('outline-chapter', { chapter, expectedHash: document.hash });
      await loadList();
      await select(result.path);
      setPanel('chapter');
      setMessage(
        result.created ? '已创建并关联本章；尚未调用 AI，可直接写或再发起试写。' : '已打开本章正文。',
      );
    }
    async function editDirection() {
      if (!listing.documents.some((item) => item.path === DIRECTION_PATH))
        await api('document', { path: DIRECTION_PATH, text: '', expectedHash: null });
      await loadList();
      await select(DIRECTION_PATH);
      setPanel('outline');
    }
    async function showReview(proposalId, stillCurrent = () => true) {
      const request = ++reviewFetch.current;
      reviewEpoch.current++;
      setMessage('正在读取候选…');
      await preserveDraft();
      const value = await api('review', null, { id: proposalId });
      // Typing can continue during a read; preserve that later input too.
      await preserveDraft();
      if (request !== reviewFetch.current || !stillCurrent()) return;
      setReview(value);
      setPanel('proposals');
    }
    useEffect(() => {
      if (
        !listing ||
        busy ||
        opening ||
        !(navigation?.params?.proposalId || navigation?.params?.runId) ||
        handledNavigation.current === navigation.revision
      )
        return;
      handledNavigation.current = navigation.revision;
      if (navigation.params.runId) {
        if (!validRunId(navigation.params.runId) || navigation.params.proposalId) {
          setMessage('连写引用无效，原书稿保留。');
          return;
        }
        perform(async () => {
          await preserveDraft();
          setActiveRunId(navigation.params.runId);
          setPanel('run');
        });
        return;
      }
      if (!validProposalId(navigation.params.proposalId)) {
        setMessage('候选引用无效，原书稿保留。');
        return;
      }
      perform(() =>
        showReview(
          navigation.params.proposalId,
          () => latestNavigation.current?.revision === navigation.revision,
        ),
      );
    }, [listing?.book.id, busy, opening, navigation]);
    function downloadLocal(content = text, path = document?.path) {
      const a = window.document.createElement('a'),
        url = URL.createObjectURL(
          new Blob([typeof content === 'string' ? content : text], { type: 'text/plain;charset=utf-8' }),
        );
      a.href = url;
      a.download = (path?.split('/').pop() || '未保存稿') + '.txt';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    useEffect(() => {
      let alive = true;
      const initialSelection = selectionRequest.current;
      loadList()
        .then((result) => {
          if (!alive || selected.current || selectionRequest.current !== initialSelection) return;
          const first =
            result.documents.find((item) => item.category === 'chapter') ??
            result.documents.find((item) => item.category === 'draft' && !item.managed) ??
            (embedded ? result.documents.find((item) => item.path === 'outline.json') : null) ??
            result.documents.find((item) => item.path === 'seed.md');
          if (first) {
            if (embedded && first.path === 'outline.json') setPanel('outline');
            return select(first.path);
          } else setMessage('先规划大纲，或创建第一章。');
        })
        .then(() => {
          if (alive) setPresentationReady(true);
        })
        .catch(say);
      return () => {
        alive = false;
        selectionRequest.current++;
      };
    }, [id]);
    useEffect(() => {
      const handler = (event) => {
        if (state.current.dirty) {
          event.preventDefault();
          event.returnValue = '';
        }
      };
      window.addEventListener('beforeunload', handler);
      return () => window.removeEventListener('beforeunload', handler);
    }, []);
    useEffect(() => {
      let active = true,
        loading = false;
      const ready = () =>
        !loading &&
        !operation.current &&
        pendingSelection.current === null &&
        (embedded || (ctx.sidebarRight.mounted.getSnapshot() === sessionId && ctx.sidebarRight.isExpanded()));
      const poll = async () => {
        if (
          loading ||
          operation.current ||
          pendingSelection.current !== null ||
          window.document.visibilityState === 'hidden' ||
          (!embedded &&
            (ctx.sidebarRight.mounted.getSnapshot() !== sessionId || !ctx.sidebarRight.isExpanded()))
        )
          return false;
        loading = true;
        const epoch = reviewEpoch.current;
        const serial = selectionRequest.current;
        try {
          const result = await api('documents');
          if (!active) return false;
          setListing(result);
          if (serial !== selectionRequest.current || operation.current || pendingSelection.current !== null)
            return false;
          if (review) {
            const updated = await api('review', null, { id: review.proposal.id });
            if (active && epoch === reviewEpoch.current && reviewIdentity.current === updated.proposal.id)
              setReview(updated);
          } else if (!selected.current && state.current.panel === 'chapter' && !state.current.dirty) {
            const first = result.documents.find((d) => d.category === 'chapter');
            if (first) await select(first.path);
          } else if (selected.current) {
            const path = selected.current,
              value = await api('document', null, { path });
            if (
              !active ||
              selected.current !== path ||
              serial !== selectionRequest.current ||
              operation.current ||
              pendingSelection.current !== null
            )
              return false;
            const current = state.current;
            if (value.hash !== current.document?.hash) {
              if (current.dirty) {
                setConflict(value);
                setMessage('云端正文有更新，未覆盖你的修改。');
              } else {
                setDocument(value);
                setText(value.text);
                setSelection(null);
                setMessage('已同步最新正文');
              }
            } else if (
              documentContextRevision(value) !== documentContextRevision(current.document) ||
              JSON.stringify(value.candidate) !== JSON.stringify(current.document?.candidate)
            ) {
              // Reordering on another device does not change prose bytes.
              // Refresh bindings/part paths without replacing unsaved body text.
              setDocument(value);
              state.current = { ...current, document: value };
            }
          }
        } catch (error) {
          if (
            active &&
            serial === selectionRequest.current &&
            !operation.current &&
            pendingSelection.current === null &&
            error.status !== 409
          )
            say(error);
          throw error;
        } finally {
          loading = false;
        }
      };
      const release = watchBookChanges(api, {
        refresh: poll,
        ready,
        active: () =>
          bookActivities(ctx, { root: '/workspace/novels/' + id }).rows.some((r) =>
            ['running', 'pending'].includes(r.kind),
          ),
        error: (error) => {
          if (active) say(error);
        },
      });
      let activityPhase;
      const releaseActivity = subscribeBookActivities(ctx, () => {
        const next = bookActivities(ctx, { root: '/workspace/novels/' + id })
          .rows.map((row) => row.id + ':' + row.kind)
          .join('|');
        if (next !== activityPhase) {
          activityPhase = next;
          wakeBookChanges(api);
        }
      });
      return () => {
        active = false;
        releaseActivity();
        release();
      };
    }, [id, sessionId, embedded, review?.proposal.id]);
    function Diff({ before, after }) {
      const diff = changedLines(before, after);
      return h(
        'div',
        { className: 'novel-diff' },
        ...['before', 'after'].map((side) =>
          h(
            'section',
            { key: side },
            h('h3', null, side === 'before' ? '原文' : '候选稿'),
            h(
              'pre',
              null,
              ...diff[side].map((line, index) =>
                h(
                  'span',
                  {
                    key: index,
                    className:
                      index >= diff.start && index < diff[side + 'End']
                        ? side === 'before'
                          ? 'removed'
                          : 'added'
                        : undefined,
                  },
                  line + '\n',
                ),
              ),
            ),
          ),
        ),
      );
    }
    const showDocumentTools =
      !!document &&
      !opening &&
      !history &&
      !liveCandidate &&
      !order &&
      !showImportRecords &&
      !['run', 'proposals'].includes(panel);
    return h(
      'section',
      {
        className: 'novel-manuscript',
        'aria-label': '小说书稿',
        'data-book-id': id,
        'data-session-id': sessionId,
        'data-outline-hash': document?.outlineHash ?? '',
      },
      renderHeading(
        h(
          'header',
          { className: 'novel-ms-heading' },
          h(
            'strong',
            { title: bookWorkspace?.title || listing?.book.title || '书稿' },
            bookWorkspace?.title || listing?.book.title || '书稿',
          ),
          listing
            ? h(TitleEditor, {
                value: bookWorkspace?.title || listing.book.title,
                label: '书名',
                onSave: async (title) => {
                  await renameBook(ctx, listing.book, title, bookWorkspace?.title);
                  await loadList();
                },
              })
            : null,
          listing ? h(ReadingExport, { key: id, api, hasLocalDraft: dirty }) : null,
          !embedded && !sidebar.fullscreen
            ? h(
                'button',
                {
                  className: 'novel-focus-manuscript',
                  onClick: () => {
                    const target = ctx.sidebarRight.commandTarget(null);
                    if (target?.sessionId === sessionId && target.tabId === tab.id && target.host === 'dock')
                      ctx.sidebarRight.toggleFullscreen(target);
                  },
                },
                '展开书稿',
              )
            : null,
          !embedded && sidebar.fullscreen
            ? h(
                'button',
                {
                  className: 'novel-to-dialogue',
                  onClick: () => {
                    if (ctx.sidebarRight.isExpanded()) ctx.sidebarRight.toggleExpanded();
                  },
                },
                '对话',
              )
            : null,
        ),
      ),
      h(
        'nav',
        { className: 'novel-ms-tabs', 'aria-label': '书稿区域', 'aria-busy': !!opening },
        ...[
          ['chapter', '正文'],
          ['outline', '大纲'],
          ['run', '连写'],
          ['reference', '设定'],
          ['prompts', '提示词'],
        ].map(([key, label]) =>
          h(
            'button',
            {
              key,
              type: 'button',
              disabled: busy || !listing,
              'aria-pressed': panel === key,
              onClick: () => browsePanel(key),
            },
            label,
          ),
        ),
        showDocumentTools
          ? h(
              'button',
              {
                type: 'button',
                className: 'novel-ms-options-toggle',
                disabled: busy,
                'aria-label': '文稿选项',
                'aria-expanded': documentOptions,
                'aria-controls': documentOptions ? documentOptionsId : undefined,
                onClick: () => setDocumentOptions(!documentOptions),
              },
              '更多',
            )
          : null,
      ),
      h(
        'div',
        { className: 'novel-workspace-status' },
        h(
          'div',
          { className: 'novel-workspace-messages' },
          document && panel === 'chapter'
            ? h(
                'span',
                { className: 'novel-ms-count' },
                illustrationEntries(text)
                  .reduceRight((prose, entry) => prose.slice(0, entry.from) + prose.slice(entry.to), text)
                  .replace(/\s/g, '').length + ' 字',
              )
            : null,
          h(
            'div',
            { className: 'novel-ms-status', role: 'status', 'aria-live': 'polite' },
            opening ? '正在读取，可切换页面…' : message,
            dirty && draftStatus?.path === document.path && draftStatus.text === text
              ? ' · ' +
                  (draftStatus.phase === 'pending'
                    ? '本机草稿保存中'
                    : draftStatus.phase === 'saved'
                      ? '本机草稿已保留'
                      : '本机草稿存储失败，请保存或下载本地稿。')
              : '',
          ),
          h(NativeActivity, { ctx, sessionId }),
        ),
        showDocumentTools && dirty
          ? h(
              'div',
              {
                className: 'novel-document-tools',
                role: 'group',
                'aria-label': '文稿操作',
              },
              dirty
                ? h(
                    'button',
                    {
                      'data-variant': 'primary',
                      disabled: busy || (candidate && !candidate.editable),
                      onClick: () => perform(save),
                      'aria-label': candidate
                        ? '保存候选'
                        : panel === 'outline'
                          ? document.path === DIRECTION_PATH
                            ? '保存方向'
                            : document.path === 'outline.json'
                              ? '保存大纲'
                              : '保存候选'
                          : panel === 'prompts'
                            ? '保存提示词'
                            : panel === 'reference'
                              ? '保存设定'
                              : '保存正文',
                    },
                    busy && message === '正在保存…' ? '保存中…' : '保存',
                  )
                : null,
            )
          : null,
      ),
      !listing
        ? null
        : h(
            'div',
            {
              className: 'novel-ms-body',
              ref: body,
              'data-history-open': !!history,
              // Old panel controls cannot start a write or steal a pending
              // navigation. Only the sibling top-level navigation stays live.
              inert: opening ? '' : undefined,
              onKeyDown: (event) => {
                if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
                  event.preventDefault();
                  event.stopPropagation();
                  if (
                    !opening &&
                    !history &&
                    !showImportRecords &&
                    !order &&
                    !['run', 'proposals'].includes(panel) &&
                    state.current.dirty
                  )
                    perform(save);
                }
              },
            },
            management
              ? h(ContentManagement, {
                  key: management.action + ':' + (management.index ?? ''),
                  request: management,
                  api,
                  busy,
                  onClose: () => setManagement(null),
                  onCommit: commitManagement,
                })
              : liveCandidate
                ? h(
                    'section',
                    { className: 'novel-live-manuscript', 'aria-label': '书稿生成预览' },
                    h(
                      'div',
                      { className: 'novel-ms-actions' },
                      h(
                        'strong',
                        null,
                        liveCandidate.target === 'outline.json' ? '正在写大纲' : '正在写正文',
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          onClick: () => {
                            browsingTurn.current = liveOwner.current?.turn ?? browsingTurn.current;
                            followed.current = null;
                            setLiveCandidate(null);
                          },
                        },
                        '继续浏览书稿',
                      ),
                    ),
                    h(ProseEditor, {
                      value: proposalToolModel('novel_proposal_submit', liveCandidate.block).content,
                      readOnly: true,
                      label: '书稿流式预览',
                    }),
                  )
                : panel === 'run'
                  ? h(WritingRunPanel, {
                      ctx,
                      api,
                      book: listing.book,
                      sessionId,
                      initialRunId: activeRunId,
                      onSelect: setActiveRunId,
                      busy,
                      onStart: (range, publication) => perform(() => startWritingRun(range, publication)),
                      onResume: (run) => perform(() => resumeWritingRun(run)),
                      onReview: (proposalId) => perform(() => showReview(proposalId)),
                      onChapter: (path) =>
                        perform(async () => {
                          await select(path);
                          setPanel('chapter');
                        }),
                    })
                  : order && ['chapter', 'outline'].includes(panel)
                    ? h(ChapterOrderEditor, {
                        key: order.id,
                        snapshot: order,
                        disabled: busy,
                        onCancel: () => {
                          setOrder(null);
                          setMessage('已取消排序，未写入文件。');
                        },
                        onReload: () => perform(beginChapterOrder),
                        onDraft: (draft) =>
                          setOrder((current) => (current ? { ...current, ...draft } : current)),
                        onPreview: (keys) =>
                          perform(() =>
                            api('chapter-order', { action: 'preview', keys, version: order.version }),
                          ),
                        onApply: (keys, preview) => perform(() => applyChapterOrder(keys, preview)),
                      })
                    : panel === 'proposals'
                      ? h(
                          'div',
                          { className: 'novel-proposals' },
                          !listing.proposals.length
                            ? review
                              ? null
                              : h('p', null, '暂无生成记录。')
                            : h(
                                'div',
                                { className: 'novel-document-strip' },
                                ...listing.proposals.map((p, index) =>
                                  h(
                                    'button',
                                    {
                                      key: p.id,
                                      disabled: busy,
                                      'aria-pressed': review?.proposal.id === p.id,
                                      onClick: () => perform(() => showReview(p.id)),
                                    },
                                    index +
                                      1 +
                                      '. ' +
                                      (p.target === 'canon.json'
                                        ? '资料整理'
                                        : p.target === 'outline.json'
                                          ? '大纲规划'
                                          : p.target.split('/').pop()),
                                  ),
                                ),
                              ),
                          review
                            ? h(
                                React.Fragment,
                                null,
                                review.proposal.nativeWritingRun?.version === 1
                                  ? h(
                                      'button',
                                      {
                                        type: 'button',
                                        disabled: busy,
                                        onClick: () =>
                                          perform(async () => {
                                            await preserveDraft();
                                            setActiveRunId(review.proposal.nativeWritingRun.id);
                                            setPanel('run');
                                          }),
                                      },
                                      '返回连写进度',
                                    )
                                  : null,
                                h(ProposalOrigin, {
                                  book: listing.book,
                                  proposal: review.proposal,
                                  busy,
                                  onOpen: () =>
                                    perform(async () => {
                                      await preserveDraft();
                                      openProposalConversation(ctx, listing.book, review.proposal);
                                      if (
                                        (sidebar.fullscreen || innerWidth < 960) &&
                                        ctx.sidebarRight.isExpanded()
                                      )
                                        ctx.sidebarRight.toggleExpanded();
                                    }),
                                }),
                                h(
                                  'p',
                                  null,
                                  review.proposal.status !== 'pending'
                                    ? (review.proposal.status === 'accepted' ? '已接受' : '已放弃') +
                                        (review.proposal.resolvedDraftHash
                                          ? ' · 只读回看处理时的候选，不会再次收录。'
                                          : ' · 旧提案未冻结处理时版本，以下为当前候选文件。')
                                    : review.orderWarning ||
                                        review.contextWarning ||
                                        (review.current.hash !== review.proposal.baseHash
                                          ? '原文已变化，不能直接覆盖；可将候选稿另存为草稿后手工合并。'
                                          : '候选稿在生成时自动更新，接受前请检查完整内容。'),
                                ),
                                review.proposal.edit
                                  ? h(
                                      'p',
                                      { role: 'status' },
                                      review.proposal.edit.start === review.proposal.edit.end
                                        ? '本次仅追加候选内容，已有全文保持不变。'
                                        : '本次仅替换选中段落，其余全文保持不变。',
                                    )
                                  : null,
                                h(WritingBasis, { review, key: review.proposal.id }),
                                review.proposal.status === 'accepted' &&
                                  review.proposal.target === 'canon.json'
                                  ? h(
                                      'p',
                                      { role: 'note' },
                                      Array.isArray(review.proposal.acceptedKeys)
                                        ? '实际只收录了 ' +
                                            review.proposal.acceptedKeys.length +
                                            ' 条选中资料；整份候选仍包含未收录内容，正式资料以“人物与资料”为准。'
                                        : '旧提案未记录收录范围，不能按整份候选推断已收录；正式资料以“人物与资料”为准。',
                                    )
                                  : null,
                                review.proposal.status !== 'pending'
                                  ? h(Diff, { before: review.base, after: review.draft.text })
                                  : review.proposal.target === 'outline.json'
                                    ? h(OutlineReview, {
                                        review,
                                        busy,
                                        onResume: () => perform(resumeOutline),
                                        onAccept: () =>
                                          perform(async () => {
                                            const result = await api('accept', {
                                              id: review.proposal.id,
                                              draftHash: review.draft.hash,
                                            });
                                            setReview(null);
                                            setPanel('outline');
                                            await loadList();
                                            await select(result.document.path);
                                            setMessage(
                                              '本批规划已接受，全篇方向与大纲同一事务保存；正文未改动。',
                                            );
                                          }),
                                      })
                                    : review.proposal.target === 'canon.json'
                                      ? h(
                                          React.Fragment,
                                          null,
                                          h(CanonReview, {
                                            review,
                                            api,
                                            busy,
                                            onStatus: setMessage,
                                            onAccept: (keys) =>
                                              perform(async () => {
                                                const result = await api('accept', {
                                                  id: review.proposal.id,
                                                  draftHash: review.draft.hash,
                                                  keys,
                                                });
                                                setReview(null);
                                                setPanel('reference');
                                                await loadList();
                                                await select(result.document.path);
                                                setMessage(
                                                  '已收录 ' +
                                                    keys.length +
                                                    ' 条待确认资料，原设定与未选建议未被覆盖。',
                                                );
                                              }),
                                          }),
                                          h(
                                            'details',
                                            {
                                              open: showReviewSource,
                                              onToggle: (event) =>
                                                setShowReviewSource(event.currentTarget.open),
                                            },
                                            h('summary', null, '完整候选源文件'),
                                            showReviewSource
                                              ? h(Diff, { before: review.base, after: review.draft.text })
                                              : null,
                                          ),
                                        )
                                      : h(Diff, { before: review.base, after: review.draft.text }),
                                h(
                                  'div',
                                  {
                                    className:
                                      'novel-ms-actions' +
                                      (['canon.json', 'outline.json'].includes(review.proposal.target)
                                        ? ' novel-canon-secondary'
                                        : ''),
                                  },
                                  review.proposal.status !== 'pending' ||
                                    ['canon.json', 'outline.json'].includes(review.proposal.target)
                                    ? null
                                    : h(
                                        'button',
                                        {
                                          disabled:
                                            busy ||
                                            !!review.orderWarning ||
                                            !!review.contextWarning ||
                                            review.current.hash !== review.proposal.baseHash ||
                                            !review.draft.text.trim(),
                                          onClick: () =>
                                            perform(async () => {
                                              const result = await api('accept', {
                                                id: review.proposal.id,
                                                draftHash: review.draft.hash,
                                              });
                                              setReview(null);
                                              setPanel('chapter');
                                              await loadList();
                                              await select(result.document.path);
                                              setMessage('已接受改稿，原文已进入历史。');
                                            }),
                                        },
                                        '接受改稿',
                                      ),
                                  review.proposal.status === 'pending'
                                    ? h(
                                        'button',
                                        {
                                          disabled: busy,
                                          onClick: () =>
                                            perform(async () => {
                                              await api('reject', { id: review.proposal.id });
                                              setReview(null);
                                              await loadList();
                                              setMessage('已放弃提案，正文未修改；候选文件仍保留。');
                                            }),
                                        },
                                        '放弃',
                                      )
                                    : null,
                                  h(
                                    'button',
                                    {
                                      onClick: () =>
                                        perform(async () => {
                                          setPanel(
                                            review.proposal.target === 'canon.json'
                                              ? 'reference'
                                              : review.proposal.target === 'outline.json'
                                                ? 'outline'
                                                : 'chapter',
                                          );
                                          await select(review.proposal.draft);
                                        }),
                                    },
                                    review.proposal.status === 'pending' ? '编辑候选稿' : '查看候选稿',
                                  ),
                                ),
                              )
                            : null,
                        )
                      : h(
                          React.Fragment,
                          null,
                          panel === 'outline'
                            ? document?.path === DIRECTION_PATH || document?.path.startsWith('drafts/')
                              ? h(
                                  'button',
                                  {
                                    type: 'button',
                                    disabled: busy || !!opening,
                                    onClick: () => perform(() => select('outline.json')),
                                  },
                                  '返回章节大纲',
                                )
                              : null
                            : panel === 'chapter'
                              ? h(ChapterNavigation, {
                                  documents: listing.documents,
                                  path: document?.path,
                                  disabled: busy || !!opening,
                                  warning: listing.navigationWarning,
                                  outlineCount: listing.outlineChapterCount,
                                  onReorder: () => perform(beginChapterOrder),
                                  onSelect: (path) => perform(() => select(path)),
                                  onAdd: () => setAdding(!adding),
                                  onRecovery: () => manage('list'),
                                  onRename: document?.path.startsWith('chapters/')
                                    ? () => {
                                        setChapterName(
                                          document.outline?.title || document.chapterTitle || '',
                                        );
                                        setRenaming(!renaming);
                                      }
                                    : undefined,
                                  renameDisabled:
                                    busy || dirty || !!conflict || document?.outlineHash === undefined,
                                  renameHint: dirty
                                    ? '先保存正文修改，再改标题'
                                    : '同步正文首行与关联章纲，不更改路径',
                                  expanded: chapterDirectory,
                                  onExpandedChange: (expanded) => {
                                    setChapterDirectory(expanded);
                                    if (expanded) wakeBookChanges(api);
                                  },
                                })
                              : panel === 'prompts'
                                ? null
                                : h(
                                    'div',
                                    { className: 'novel-document-strip' },
                                    ...listing.documents
                                      .filter((d) =>
                                        panel === 'chapter'
                                          ? d.category === 'chapter'
                                          : (panel === 'prompts'
                                              ? d.path === 'rules.json'
                                              : d.category === 'reference' && d.path !== 'rules.json') &&
                                            !['outline.json', DIRECTION_PATH].includes(d.path),
                                      )
                                      .map((d) =>
                                        h(
                                          'button',
                                          {
                                            key: d.path,
                                            disabled: busy || !!opening,
                                            'aria-pressed': !showImportRecords && document?.path === d.path,
                                            onClick: () => perform(() => select(d.path)),
                                          },
                                          d.path === 'seed.md'
                                            ? '灵感'
                                            : d.path === 'setting.md'
                                              ? '背景与人物'
                                              : d.path === 'outline.json'
                                                ? '大纲'
                                                : d.path === 'canon.json'
                                                  ? '人物与资料'
                                                  : d.path === 'memory.json'
                                                    ? 'AI 记忆'
                                                    : d.path === 'rules.json'
                                                      ? '创作规则'
                                                      : d.path.split('/').pop(),
                                        ),
                                      ),
                                    panel === 'reference' &&
                                      ['chats', 'snapshots', 'operationLogs', 'agentHistory'].some(
                                        (key) => listing.book.stats?.[key] > 0,
                                      )
                                      ? h(
                                          'button',
                                          {
                                            type: 'button',
                                            disabled: busy || !!opening,
                                            'aria-pressed': showImportRecords,
                                            onClick: () =>
                                              perform(async () => {
                                                await preserveDraft();
                                                setShowImportRecords(true);
                                                setReview(null);
                                                closeHistory();
                                              }),
                                          },
                                          '导入记录',
                                        )
                                      : null,
                                    panel === 'chapter'
                                      ? h('button', { onClick: () => setAdding(!adding) }, '＋ 新章')
                                      : null,
                                  ),
                          adding
                            ? h(
                                'form',
                                {
                                  className: 'novel-ms-new',
                                  onSubmit: (event) => {
                                    event.preventDefault();
                                    perform(createChapter);
                                  },
                                },
                                h('input', {
                                  'aria-label': '新章节标题',
                                  placeholder: '章节标题',
                                  value: newTitle,
                                  onChange: (e) => setNewTitle(e.target.value),
                                  maxLength: 120,
                                }),
                                h('button', { type: 'submit', disabled: busy }, '创建'),
                              )
                            : null,
                          panel === 'chapter' && document?.path.startsWith('drafts/') && !candidate
                            ? h(
                                'div',
                                { className: 'novel-candidate-bar', 'aria-label': '未收录草稿' },
                                h('span', null, '未收录草稿'),
                                h(
                                  'button',
                                  {
                                    type: 'button',
                                    disabled: busy || dirty,
                                    onClick: () =>
                                      perform(async () => {
                                        const value = await api('adopt-draft', {
                                          path: document.path,
                                          expectedHash: document.hash,
                                        });
                                        await loadList();
                                        await select(value.document.path);
                                        setMessage('已收录为章节，原草稿保留');
                                      }),
                                  },
                                  '收录为章节',
                                ),
                              )
                            : null,
                          panel === 'reference' && showImportRecords
                            ? h(ImportRecords, {
                                bookId: id,
                                onReference: (prompt) => {
                                  stageImportReference(ctx, sessionId, listing.book, prompt);
                                  setMessage('引用已放入对话输入框；可补充问题后发送，尚未调用 AI。');
                                  (onDialogue ?? appNavigation?.dialogue)?.();
                                },
                              })
                            : document && !opening
                              ? h(
                                  React.Fragment,
                                  null,
                                  candidate
                                    ? h(
                                        'div',
                                        { className: 'novel-candidate-bar', 'aria-label': '候选编辑状态' },
                                        h(
                                          'strong',
                                          null,
                                          canonCandidate && candidate.status === 'pending'
                                            ? '资料候选 · 尚未收录'
                                            : '候选稿',
                                        ),
                                        h(
                                          'span',
                                          null,
                                          candidate.warning ||
                                            (candidate.resolvedDraftHash &&
                                            candidate.resolvedDraftHash !== document.hash
                                              ? '此文件在处理后有变化；提案回看使用处理时的历史快照。'
                                              : '') ||
                                            (!candidate.editable
                                              ? '提案已处理；原候选只读保留。'
                                              : candidate.running
                                                ? 'AI 仍在运行；可先修改，结束或停止后再保存。'
                                                : '保存只更新候选，正式资料不变。'),
                                        ),
                                        candidate.status === 'pending'
                                          ? h(
                                              'button',
                                              {
                                                type: 'button',
                                                disabled: busy || dirty,
                                                title: dirty
                                                  ? '先保存候选修改，再返回核对'
                                                  : '返回原提案，重新检查并选择收录',
                                                onClick: () => perform(() => showReview(candidate.id)),
                                              },
                                              '返回核对',
                                            )
                                          : null,
                                      )
                                    : null,
                                  panel === 'chapter' && !candidate && document.path.startsWith('chapters/')
                                    ? h(ChapterFocus, {
                                        key: 'chapter-focus:' + document.path,
                                        document,
                                        disabled: busy || dirty,
                                        onReview: (focus) => perform(() => start('review', 'write', focus)),
                                      })
                                    : null,
                                  documentOptions
                                    ? h(
                                        'section',
                                        {
                                          id: documentOptionsId,
                                          className: 'novel-document-options',
                                          'aria-label': '文稿选项',
                                          key: 'document-options:' + document.path,
                                        },
                                        h('span', { className: 'novel-ms-path' }, document.path),
                                        h(
                                          'button',
                                          {
                                            disabled: busy,
                                            onClick: () =>
                                              perform(async () => {
                                                setDocumentOptions(false);
                                                await openHistory();
                                              }),
                                          },
                                          '历史',
                                        ),
                                        dirty ? h('button', { onClick: downloadLocal }, '下载本地稿') : null,
                                        h(
                                          'button',
                                          {
                                            type: 'button',
                                            disabled: busy,
                                            onClick: () => browsePanel('proposals'),
                                          },
                                          '生成记录',
                                        ),
                                        !candidate && document.path.startsWith('chapters/')
                                          ? h(
                                              React.Fragment,
                                              null,
                                              h(
                                                'button',
                                                {
                                                  type: 'button',
                                                  disabled: busy || dirty || !!conflict,
                                                  onClick: () => manage('clearChapter'),
                                                },
                                                '清空正文',
                                              ),
                                              h(
                                                'button',
                                                {
                                                  type: 'button',
                                                  disabled: busy || dirty || !!conflict,
                                                  'data-variant': 'danger',
                                                  onClick: () => manage('deleteChapter'),
                                                },
                                                '删除本章',
                                              ),
                                            )
                                          : null,
                                        h(
                                          'button',
                                          {
                                            type: 'button',
                                            disabled: busy || dirty || !!conflict,
                                            onClick: () => manage('list'),
                                          },
                                          '回收与恢复',
                                        ),
                                      )
                                    : null,
                                  renaming
                                    ? h(
                                        'form',
                                        {
                                          className: 'novel-chapter-rename',
                                          onSubmit: (event) => {
                                            event.preventDefault();
                                            perform(renameChapter);
                                          },
                                        },
                                        h(
                                          'label',
                                          null,
                                          '章节标题',
                                          h('input', {
                                            'aria-label': '章节标题',
                                            value: chapterName,
                                            maxLength: 240,
                                            disabled: busy,
                                            onChange: (e) => setChapterName(e.target.value),
                                          }),
                                        ),
                                        h(
                                          'small',
                                          null,
                                          document.titleMode === 'prepend'
                                            ? '会在正文开头添加一级标题。'
                                            : '只替换正文首行一级标题。',
                                          document.outline
                                            ? ' 同步第 ' + document.outline.chapter + ' 章章纲标题。'
                                            : '',
                                        ),
                                        h(
                                          'div',
                                          { className: 'novel-ms-actions' },
                                          h(
                                            'button',
                                            {
                                              type: 'submit',
                                              disabled: busy || dirty || !chapterName.trim(),
                                            },
                                            '保存标题',
                                          ),
                                          h(
                                            'button',
                                            {
                                              type: 'button',
                                              disabled: busy,
                                              onClick: () => setRenaming(false),
                                            },
                                            '取消',
                                          ),
                                          h(
                                            'button',
                                            {
                                              type: 'button',
                                              disabled: busy,
                                              onClick: () => perform(() => select(document.path)),
                                            },
                                            '重新读取',
                                          ),
                                        ),
                                      )
                                    : null,
                                  conflict
                                    ? h(ConflictEditor, {
                                        key: 'conflict:' + document.path,
                                        base: document,
                                        json: (candidate?.target ?? document.path).endsWith('.json'),
                                        local: text,
                                        remote: conflict,
                                        busy,
                                        onApply: (merged, frame) => perform(() => adoptMerge(merged, frame)),
                                        onManual: (frame) =>
                                          perform(() => adoptMerge(frame.local, frame, true)),
                                        onCopy: () =>
                                          perform(async () => {
                                            const path = 'drafts/local-' + crypto.randomUUID() + '.md';
                                            await api('document', { path, text, expectedHash: null });
                                            setMessage('本机内容已另存为草稿，云端原文未覆盖。');
                                          }),
                                      })
                                    : null,
                                  legacyAlternative
                                    ? h(
                                        'details',
                                        null,
                                        h('summary', null, '发现旧页面的另一份本机草稿'),
                                        h('p', null, '两份未保存稿不同，未自动覆盖或删除旧缓存。'),
                                        h(
                                          'button',
                                          {
                                            type: 'button',
                                            onClick: () =>
                                              downloadLocal(
                                                legacyAlternative.text,
                                                document.path + '-旧缓存',
                                              ),
                                          },
                                          '下载旧页面草稿',
                                        ),
                                      )
                                    : null,
                                  document.path.endsWith('.json') && orderReviewOf(text)
                                    ? h(
                                        'details',
                                        { className: 'novel-order-review' },
                                        h('summary', null, '章节顺序已调整 · 章节引用待核对'),
                                        h(
                                          'p',
                                          null,
                                          '结构化章号已同步；旧前文记忆、文字章号和接力没有自动重写。核对正文后可标记。',
                                        ),
                                        h(
                                          'button',
                                          {
                                            disabled: busy,
                                            onClick: () => {
                                              try {
                                                edit(acknowledgeOrderReview(text));
                                                setMessage('已标记核对，保存后生效。');
                                              } catch (error) {
                                                say(error);
                                              }
                                            },
                                          },
                                          '标记已核对（尚未保存）',
                                        ),
                                      )
                                    : null,
                                  panel === 'outline' && document.path === 'outline.json'
                                    ? h(OutlineEditor, {
                                        text,
                                        savedHash: document.hash,
                                        dirty,
                                        onChange: edit,
                                        onStatus: setMessage,
                                        disabled: busy,
                                        api,
                                        documents: listing.documents,
                                        bindings: document.bindings,
                                        onOpenChapter: (chapter) =>
                                          perform(() => openOutlineChapter(chapter)),
                                        onEditDirection: () => perform(editDirection),
                                        onPlan: (range, note) => perform(() => planOutline(range, note)),
                                        onReorder: () => perform(beginChapterOrder),
                                        onRenameTitle: (index, title) =>
                                          perform(() => renameOutlineTitle(index, title), true),
                                        onManage: (action, extra) => manage(action, extra),
                                      })
                                    : ['reference', 'prompts'].includes(panel) &&
                                        (document.path.endsWith('.json') || canonCandidate)
                                      ? h(
                                          React.Fragment,
                                          null,
                                          h(ReferenceEditor, {
                                            key: 'reference:' + document.path,
                                            promptsOnly: panel === 'prompts',
                                            path: canonCandidate ? 'canon.json' : document.path,
                                            candidate: canonCandidate ? candidate : undefined,
                                            onReadSource: (path) => api('document', null, { path }),
                                            text,
                                            onChange: edit,
                                            onStatus: setMessage,
                                            disabled: busy,
                                          }),
                                        )
                                      : h(
                                          React.Fragment,
                                          null,
                                          mixedNewlines
                                            ? h(
                                                'p',
                                                { role: 'note' },
                                                '原文含混合换行；网页手工编辑后会按首个换行统一格式，未编辑的原文不会变化。',
                                              )
                                            : null,
                                          h(ProseEditor, {
                                            key: document.path + ':' + !!(candidate && !candidate.editable),
                                            value: text,
                                            illustrationApi: document.path.startsWith('chapters/')
                                              ? api
                                              : null,
                                            readOnly: !!(candidate && !candidate.editable),
                                            onChange: edit,
                                            onSelection: (next) =>
                                              setSelection((previous) =>
                                                previous?.start === next.start &&
                                                previous?.end === next.end &&
                                                previous?.text === next.text
                                                  ? previous
                                                  : next,
                                              ),
                                            onSave: () => {
                                              if (state.current.dirty) perform(save);
                                            },
                                          }),
                                        ),
                                  history
                                    ? h(DocumentHistory, {
                                        key: 'history:' + history.path,
                                        data: history,
                                        document,
                                        text,
                                        busy,
                                        canLoad: !candidate || candidate.editable,
                                        onClose: () => closeHistory(true),
                                        onPreview: previewHistory,
                                        onRetry: () => fetchHistoryList(history.owner),
                                        onMore: () => fetchHistoryList(history.owner, history.nextCursor),
                                        onLoad: (frame) =>
                                          perform(async () => {
                                            const owner = history.owner;
                                            setHistory((previous) =>
                                              previous?.owner === owner
                                                ? { ...previous, error: null }
                                                : previous,
                                            );
                                            try {
                                              await loadHistory(frame);
                                            } catch (error) {
                                              if (ownsHistory(owner))
                                                setHistory((previous) =>
                                                  previous?.owner === owner
                                                    ? { ...previous, error: error.message }
                                                    : previous,
                                                );
                                              throw error;
                                            }
                                          }),
                                        onDownload: () => downloadLocal(),
                                      })
                                    : null,
                                )
                              : h(
                                  'div',
                                  { className: 'novel-ms-empty' },
                                  h(
                                    'h2',
                                    { role: opening ? 'status' : undefined },
                                    opening
                                      ? '正在打开文稿…'
                                      : panel === 'outline'
                                        ? '暂不能打开大纲'
                                        : '先写一小段',
                                  ),
                                  opening
                                    ? null
                                    : h(
                                        'p',
                                        null,
                                        panel === 'outline'
                                          ? '原文件与分片保留；不会用空大纲覆盖它们。'
                                          : '保留你的零碎灵感，让故事从一个具体场景开始。',
                                      ),
                                ),
                        ),
          ),
      listing && panel === 'chapter' && !opening && !order && !candidate && !history
        ? renderActions(
            h(
              'footer',
              { className: 'novel-ms-ai', role: 'group', 'aria-label': 'AI 写作操作' },
              !embedded
                ? h(
                    'div',
                    { className: 'novel-ms-input-link' },
                    h('span', null, '要求来自对话框'),
                    h('button', { type: 'button', onClick: editWritingInstruction }, '编辑要求'),
                  )
                : null,
              h(
                'div',
                { className: 'novel-ms-actions' },
                h(
                  'button',
                  {
                    'data-variant': 'primary',
                    disabled: busy,
                    title: '按对话中的要求创作，可同时改前文、续写后文',
                    onClick: () => perform(() => start('write')),
                  },
                  selection?.text ? '按选段要求写作' : '写作',
                ),
                h(
                  'button',
                  {
                    disabled: busy || !document?.path.startsWith('chapters/'),
                    title: '使用当前对话框的文字审稿',
                    onClick: () => perform(() => start('review')),
                  },
                  '审稿',
                ),
                document?.path.startsWith('chapters/')
                  ? h(
                      'details',
                      { className: 'novel-more-writing' },
                      h('summary', null, '更多写作'),
                      h(
                        'button',
                        {
                          type: 'button',
                          disabled: busy || !text.trim(),
                          onClick: () => perform(() => start('review', 'write', 'continuity')),
                        },
                        '检查前后矛盾',
                      ),
                      h(
                        'button',
                        {
                          disabled: busy || !text.trim(),
                          onClick: () => perform(() => start('rewrite', 'deai')),
                        },
                        selection?.text ? '润色选段' : '润色本章',
                      ),
                      h(
                        'button',
                        {
                          disabled: busy || !text.replace(/^\uFEFF?#[^\r\n]*(?:\r?\n|$)/, '').trim(),
                          onClick: () => perform(() => start('continue', 'ending')),
                        },
                        '写章节收尾',
                      ),
                    )
                  : null,
              ),
            ),
          )
        : null,
    );
  }
  if (!appNavigation)
    ctx.effect(
      () =>
        ctx.slots.inject('sidebar.right.pane.tab', () =>
          ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TYPE }, Manuscript),
        ),
      'novel: manuscript body',
    );
  if (!appNavigation)
    ctx.effect(
      () =>
        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register({ name: 'conversation.input.left', id: TYPE, order: -10 }, Header),
        ),
      'novel: manuscript entry',
    );
}
