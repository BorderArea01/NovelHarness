import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TASK_LABELS, conversationTitle } from '../pages/public/novel-assets/conversation-title.mjs';
import { drawerFocusables, focusNativeDrawer, handleNativeDrawerKey } from './drawer-presentation.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const LICENSE = `/**
 * Novel studio presentation adapter. Original modules: dsh-edge 0.30.0 /
 * DeepSeek Harness 0.2.1-rc.2. Original third-party notices remain below.
 * MIT License
 * Copyright (c) 2026 pawaca
 * Copyright (c) 2026 DeepSeek
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */\n`;
const SPECS = {
  conversation: {
    plugin: 'dsh-client-ui-conversation',
    hash: '8554738cbeeb5218ad1bfa4773ef094363b066d052a1893d7a96797c5bc33a63',
  },
  sidebar: {
    plugin: 'dsh-client-ui-sidebar',
    hash: '4d4535b9ac9160e13067b1f8a8510d158da2aaf6a15191b418a5956261ff9b3e',
  },
  layout: {
    plugin: 'dsh-client-ui-layout',
    hash: '686fb83c91c8ff8d03c365bb666ef34dacc3dd110eb768deacbc7998b885c8c1',
  },
  settings: {
    plugin: 'dsh-client-ui-settings-general',
    hash: 'fb6c8d32d1994454578caa31cc975575a789e11f0afd6d3c19fe769f47050f7e',
  },
};
function once(source, before, after) {
  if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before))
    throw new Error('Pinned native shell composition seam changed; refusing an unverified UI adapter.');
  return source.replace(before, after);
}
// Explicit presentation seams in MIT-licensed, hash-pinned native modules.
// Their original registrations retain ownership of children and session scopes.
// Native conversation is passed as a React subtree, never reimplemented or
// rendered through stolen slot ownership. Engine/model/VFS code is untouched.
export function adaptNativeShell(kind, input) {
  if (!SPECS[kind] || createHash('sha256').update(input).digest('hex') !== SPECS[kind].hash)
    throw new Error('Unverified native UI artifact; shell staging refused.');
  let source = String(input);
  if (kind === 'settings') {
    // Expose the ORIGINAL shell's section action to its contributed launcher.
    // The shell still owns selection, modal focus, forms and first-use steps.
    source = once(
      source,
      'openSettings: actions.open,',
      'openSettings: actions.open, openSettingsSection: actions.openSection,',
    );
    // Automatic first-use steps can become eligible after a slow catalog or
    // configuration read. They must not close an explicitly opened settings
    // panel (even a step whose own renderer immediately decides to show nothing).
    // The original shell still owns forms, modal focus and step completion.
    source = once(
      source,
      'if (appeared && open) close();',
      'if (appeared && open && requestedOnboarding !== void 0) close();',
    );
    source = once(
      source,
      'onboardingStep !== void 0 && renderSlot("settings.onboarding",',
      '!open && onboardingStep !== void 0 && renderSlot("settings.onboarding",',
    );
  } else if (kind === 'conversation') {
    source = once(
      source,
      '"data-testid": "todo-panel",',
      '"data-testid": "todo-panel", "data-novel-completed": todos.every((item) => item.status === "completed") || void 0,',
    );
    source = once(
      source,
      'return renderSlot("main.conversation", {});',
      'return renderSlot("novel.workspace", { conversation: renderSlot("main.conversation", {}) });',
    );
    source = once(
      source,
      'children: { "main.conversation": {',
      'children: { "novel.workspace": { kind: "single", scope: "root" }, "main.conversation": {',
    );
    source = once(
      source,
      'function HeroShell({ t, renderSlot, children }) {',
      'function HeroShell({ children }) { return react.createElement("div", { className: "novel-assistant-welcome" }, react.createElement("h2", null, "创作助手"), children); }\n\t\tfunction NativeHeroShell({ t, renderSlot, children }) {',
    );
    source = once(source, 'hero && heroWorkspaceRow,', 'null,');
    source = once(
      source,
      'reportMessageSubmission(this.rootCtx, submission);',
      'reportMessageSubmission(this.rootCtx, submission); this.rootCtx.emit("novel/input-submitted", { sessionId: binding.sessionId, source: submission.source });',
    );
    source = once(
      source,
      'className: clsx(ConversationRoot_module_css_default.composerStack, hero && ConversationRoot_module_css_default.composerHero),',
      'className: ConversationRoot_module_css_default.composerStack,',
    );
    source = once(source, 'variant: hero ? "hero" : "composer",', 'variant: "composer",');
    source = once(
      source,
      'children: [sessionId === void 0 ? null : (0, react_jsx_runtime.jsx)(Views, {}), composerSeat]',
      'children: [sessionId === void 0 ? null : (0, react_jsx_runtime.jsx)(Views, {}), renderSlot("novel.composer", { composer: composerSeat }, { fallback: composerSeat })]',
    );
    source = once(
      source,
      '"conversation.composer": {\n\t\t\t\t\t\tkind: "chain",',
      '"novel.composer": { kind: "single", scope: "session-maybe" },\n\t\t\t\t\t"conversation.composer": {\n\t\t\t\t\t\tkind: "chain",',
    );
    source = once(
      source,
      'function deriveAncestry(list, id) {',
      'const TASK_LABELS = Object.freeze(' +
        JSON.stringify(TASK_LABELS) +
        ');\n\t\t' +
        conversationTitle.toString() +
        '\n\t\tfunction deriveAncestry(list, id) {',
    );
    source = once(
      source,
      'id: summary.id,\n\t\t\t\t\tdisplayTitle: summary.displayTitle,',
      'id: summary.id,\n\t\t\t\t\tdisplayTitle: conversationTitle(summary.displayTitle),',
    );
    for (const [before, after] of [
      ['"input.send": "发送消息",', '"input.send": "发送并讨论",'],
      ['"input.send": "Send message",', '"input.send": "Send and discuss",'],
      ['描述你想要构建的内容, / 调用指令, @ 文件或对话', '讨论情节、人物，或提出写作要求；@ 引用资料'],
      ['发消息或创建任务, / 调用指令, @ 文件或对话', '继续讨论这本书，或提出本次修改要求'],
      [
        'Describe what you want to build, / commands, @ files or sessions',
        'Discuss the story, characters, or your writing request',
      ],
      ['Message or run a task, / commands, @ files or sessions', 'Discuss this book or request a revision'],
    ])
      source = once(source, before, after);
  } else if (kind === 'sidebar') {
    source = once(
      source,
      'function SidebarRoot({ collapsed, width,',
      'function NativeSidebarRoot({ collapsed, width,',
    );
    source = once(
      source,
      'ctx.slots.inject("sidebar", () => ctx.slots.register({',
      'function SidebarRoot(props) { return props.renderSlot("novel.navigation", { collapsed: props.collapsed, settings: props.renderSlot("sidebar.settings", { wide: !props.collapsed }) }); }\n\t\t\tctx.slots.inject("sidebar", () => ctx.slots.register({',
    );
    source = once(
      source,
      '"sidebar.brand.mark": {\n\t\t\t\t\t\tkind: "single",',
      '"novel.navigation": { kind: "single", scope: "root" },\n\t\t\t\t\t"sidebar.brand.mark": {\n\t\t\t\t\t\tkind: "single",',
    );
  } else {
    source = once(source, 'const productTitle = "DeepSeek Harness";', 'const productTitle = "小说工作台";');
    // Browser chrome must not project private session labels. Keep its original
    // owner but remove the session subscription; in-app headings stay intact.
    source = once(
      source,
      `function DocumentTitle({ useSessions, usePanelInfo, productTitle }) {
\t\t\tconst showSessionTitle = usePanelInfo((info) => info.activePanelId === null);
\t\t\tconst title = useSessions((state) => {
\t\t\t\tconst current = Object.values(state.byId).find((session) => (session.retainedBy.mainView ?? 0) > 0)?.id;
\t\t\t\treturn !showSessionTitle || current === void 0 ? void 0 : state.byId[current]?.title;
\t\t\t});
\t\t\t(0, react.useEffect)(() => {
\t\t\t\tdocument.title = title === void 0 ? productTitle : \`\${title} — \${productTitle}\`;
\t\t\t\treturn () => {
\t\t\t\t\tdocument.title = productTitle;
\t\t\t\t};
\t\t\t}, [productTitle, title]);
\t\t\treturn null;
\t\t}`,
      `function DocumentTitle({ productTitle }) {
\t\t\t(0, react.useEffect)(() => {
\t\t\t\tdocument.title = productTitle;
\t\t\t\treturn () => { document.title = productTitle; };
\t\t\t}, [productTitle]);
\t\t\treturn null;
\t\t}`,
    );
    source = once(
      source,
      'const SIDEBAR_AUTO_COLLAPSE = 1024;',
      'const SIDEBAR_AUTO_COLLAPSE = 1024;\n' +
        [drawerFocusables, focusNativeDrawer, handleNativeDrawerKey].map((fn) => fn.toString()).join('\n'),
    );
    source = once(
      source,
      'const sidebarCollapsed = narrow ? !layoutInfo.narrowExpanded : layoutInfo.sidebar === 0;',
      'const sidebarCollapsed = narrow ? !layoutInfo.narrowExpanded : layoutInfo.sidebar === 0;\n' +
        'const compact = viewport <= 600; const drawerOpen = narrow && !sidebarCollapsed;\n' +
        'const previousDrawerOpen = (0, react.useRef)(false);\n' +
        '(0, react.useLayoutEffect)(() => { focusNativeDrawer(frameRef.current, drawerOpen, previousDrawerOpen.current); previousDrawerOpen.current = drawerOpen; }, [drawerOpen]);',
    );
    source = once(
      source,
      'const collapsedWidth = darwin || document.documentElement.hasAttribute("data-windows-titlebar") ? 0 : 56;',
      'const collapsedWidth = compact || darwin || document.documentElement.hasAttribute("data-windows-titlebar") ? 0 : 56;',
    );
    source = once(
      source,
      'const leadingMounted = darwin && sidebarCollapsed;',
      'const leadingMounted = darwin && sidebarCollapsed && !compact;',
    );
    source = once(
      source,
      'const normal = computeColumns(viewport, !layoutInfo.rightbarShown && narrow ? 0 : sidebarPreference, rightbarPreference, collapsedWidth);',
      'const normal = computeColumns(viewport, narrow ? 0 : sidebarPreference, rightbarPreference, collapsedWidth);',
    );
    source = once(
      source,
      'const cols = computeColumns(viewport, sidebarPreference, layoutInfo.rightbarTrack ? rightbarPreference : 0, collapsedWidth);',
      'const cols = computeColumns(viewport, narrow ? 0 : sidebarPreference, layoutInfo.rightbarTrack ? rightbarPreference : 0, collapsedWidth);',
    );
    source = once(
      source,
      'className: AppFrame_module_css_default.frame,',
      'className: "novel-native-frame " + AppFrame_module_css_default.frame,',
    );
    source = once(
      source,
      'className: AppFrame_module_css_default.sidebarCol,',
      'className: "novel-native-sidebar-column " + AppFrame_module_css_default.sidebarCol, hidden: compact && sidebarCollapsed, role: drawerOpen ? "dialog" : void 0, "aria-label": drawerOpen ? "导航菜单" : void 0, "aria-modal": drawerOpen ? true : void 0, tabIndex: drawerOpen ? -1 : void 0,',
    );
    source = once(
      source,
      'className: AppFrame_module_css_default.centerCol,',
      'className: "novel-native-center-column " + AppFrame_module_css_default.centerCol, inert: props.blocked ? "" : void 0,',
    );
    source = once(
      source,
      'className: AppFrame_module_css_default.rightbarCol,',
      'className: "novel-native-rightbar-column " + AppFrame_module_css_default.rightbarCol, inert: props.blocked ? "" : void 0,',
    );
    source = once(
      source,
      '(CenterColumn, { children: main })',
      '(CenterColumn, { blocked: drawerOpen, children: main })',
    );
    source = once(
      source,
      '(RightbarColumn, { children: renderSlot("rightbar", {',
      '(RightbarColumn, { blocked: drawerOpen, children: renderSlot("rightbar", {',
    );
    source = once(
      source,
      'className: AppFrame_module_css_default.bottomRow,',
      'className: AppFrame_module_css_default.bottomRow, inert: drawerOpen ? "" : void 0,',
    );
    source = once(
      source,
      'leadingMounted && (0, react_jsx_runtime.jsx)("div", {',
      'compact && sidebarCollapsed && (0, react_jsx_runtime.jsx)("button", { type: "button", className: "novel-mobile-navigation-toggle", "aria-label": "展开导航", "aria-haspopup": "dialog", onClick: () => actions.toggleSidebar(), children: "☰" }), leadingMounted && (0, react_jsx_runtime.jsx)("div", {',
    );
    source = once(
      source,
      'gridTemplateColumns: `${cols.sidebar}px minmax(${cols.rightbar === 0 ? 0 : 400}px, 1fr) minmax(0px, ${rightbarMax}px)`',
      '"--novel-sidebar-width": `${Math.min(sidebarPreference || 280, Math.max(0, viewport - 48))}px`, gridTemplateColumns: `${narrow ? collapsedWidth : cols.sidebar}px minmax(${cols.rightbar === 0 ? 0 : 400}px, 1fr) minmax(0px, ${rightbarMax}px)`',
    );
    source = once(
      source,
      '"data-sidebar-collapsed": sidebarCollapsed || void 0,',
      '"data-novel-narrow": narrow || void 0, "data-novel-compact": compact || void 0, "data-sidebar-collapsed": sidebarCollapsed || void 0, onKeyDown: (event) => { if (drawerOpen) handleNativeDrawerKey(event, frameRef.current, () => actions.toggleSidebar()); },',
    );
    source = once(
      source,
      '!sidebarCollapsed && (0, react_jsx_runtime.jsx)(DragHandle, {',
      'narrow && !sidebarCollapsed && (0, react_jsx_runtime.jsx)("button", { className: "novel-navigation-scrim", "aria-label": "关闭导航", tabIndex: -1, onClick: () => actions.toggleSidebar() }), !narrow && !sidebarCollapsed && (0, react_jsx_runtime.jsx)(DragHandle, {',
    );
  }
  return LICENSE + source;
}
export async function stageNativeShell(destination) {
  await mkdir(resolve(destination, 'native-shell'), { recursive: true });
  for (const [kind, spec] of Object.entries(SPECS)) {
    const input = await readFile(
      resolve(root, 'cloud/tools/node_modules/dsh-edge/dist/plugins/@deepseek-ai', spec.plugin, 'client.js'),
    );
    await writeFile(resolve(destination, 'native-shell', kind + '.js'), adaptNativeShell(kind, input));
  }
}
