import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';

test('客户端模块导出插槽注册，面板与侧栏入口成对出现', async () => {
  let registered;
  globalThis.window = { __ModuleLoader__: { load: entry => { registered = entry; } } };
  const React = {
    createElement: () => null,
    Fragment: Symbol('Fragment'),
    Component: class Component {},
    useEffect: () => {},
    useLayoutEffect: () => {},
    useRef: () => ({ current: null }),
    useState: value => [typeof value === 'function' ? value() : value, () => {}],
    useSyncExternalStore: () => '',
  };
  await import('../src/client.js');
  assert.ok(registered, '客户端模块必须调用 __ModuleLoader__.load');
  assert.equal(registered.id, 'dsh-quiet-reader');
  const plugin = registered.factory(specifier => {
    assert.equal(specifier, 'react');
    return React;
  });
  assert.deepEqual(plugin.inject, ['slots']);
  const calls = [];
  plugin.apply({
    slots: {
      inject(name, register) { calls.push(name); register(); },
      register(options) { calls.push(options.name); },
    },
  });
  assert.deepEqual(calls, ['main', 'main', 'sidebar.footer.action', 'sidebar.footer.action', 'sidebar.panellist', 'sidebar.panellist']);
  delete globalThis.window;
});

function hookHarness() {
  let cursor = 0;
  const hooks = [];
  const effects = [];
  const useEffect = (effect, dependencies) => {
    const index = cursor++;
    const previous = hooks[index];
    if (previous && dependencies && previous.dependencies?.length === dependencies.length &&
        dependencies.every((value, i) => Object.is(value, previous.dependencies[i]))) return;
    hooks[index] = { dependencies };
    effects.push(() => {
      previous?.cleanup?.();
      hooks[index].cleanup = effect();
    });
  };
  const React = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({
      type,
      // Mirror React: children are also exposed on props so class boundaries
      // and wrapper components can read them.
      props: { ...(props ?? {}), ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}) },
      children,
    }),
    Component: class Component { constructor(props) { this.props = props ?? {}; } },
    useEffect,
    useLayoutEffect: useEffect,
    useRef(value) { return hooks[cursor++] ??= { current: value }; },
    useState(value) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof value === 'function' ? value() : value;
      return [hooks[index], next => { hooks[index] = typeof next === 'function' ? next(hooks[index]) : next; }];
    },
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  };
  // The panel is wrapped in an ErrorBoundary class and some sections render
  // through function components (e.g. Modal). Expand those wrappers so the
  // tree assertions below see the real content, like React would.
  const renderDeep = node => {
    let guard = 0;
    while (node && typeof node.type === 'function' && guard++ < 8) {
      if (node.type.prototype instanceof React.Component || node.type.prototype?.render) {
        node = new node.type(node.props).render();
      } else {
        node = node.type(node.props);
      }
    }
    return node;
  };
  return {
    React,
    async settle(render) {
      let tree;
      for (let pass = 0; pass < 4; pass++) {
        cursor = 0;
        tree = renderDeep(render({}));
        for (const run of effects.splice(0)) run();
        await setImmediate();
      }
      return tree;
    },
    unmount() { for (const hook of hooks) hook?.cleanup?.(); },
  };
}

function* elements(node) {
  if (Array.isArray(node)) {
    for (const item of node) yield* elements(item);
  } else if (node?.type) {
    yield node;
    yield* elements(node.children);
  }
}

test('先选工作区再导入及打开文献，文献请求携带工作区编号', async t => {
  const globals = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  const hooks = hookHarness();
  t.after(() => { hooks.unmount(); Object.assign(globalThis, globals); });
  let registered;
  globalThis.window = Object.assign(new EventTarget(), { __ModuleLoader__: { load: entry => { registered = entry; } } });
  globalThis.document = Object.assign(new EventTarget(), { baseURI: 'http://127.0.0.1:8767/' });
  const workspace = { id: 'workspace-1', path: 'D:/Papers', title: 'Papers' };
  const id = 'a'.repeat(64);
  const assets = new Map([
    ['pdf.mjs', `export const GlobalWorkerOptions = {}; export function getDocument() {
      return { async destroy() {}, promise: Promise.resolve({ numPages: 1, async getMetadata() { return {}; }, async getPage() {
        return { getViewport() { return { width: 612, height: 792 }; }, cleanup() {} };
      } }) };
    }`],
    ['layout.js', `export function extractPageLayout(_pdf, _page, _viewport, page) {
      return { regions: [], paragraphs: [{ page, text: 'Fixture source paragraph.', box: [.1, .2, .9, .3] }] };
    }`],
  ]);
  const modules = registerHooks({ resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith('http://127.0.0.1:8767/api/dsh-quiet-reader?')) return nextResolve(specifier, context);
    const params = new URL(specifier).searchParams;
    const source = assets.get(params.get('name'));
    assert.equal(params.get('action'), 'asset');
    assert.ok(source, `unexpected asset: ${specifier}`);
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  } });
  t.after(() => modules.deregister());
  let active = null;
  let picks = 0;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    const params = new URL(url).searchParams;
    const action = params.get('action');
    requests.push({ action, method: options.method ?? 'GET', workspaceId: params.get('workspaceId') });
    if (action === 'workspace') {
      if (options.method === 'POST') {
        assert.deepEqual(JSON.parse(options.body), { folder: workspace.path });
        active = workspace;
      }
      return Response.json({ workspace: active });
    }
    if (action === 'settings') return Response.json({ current: {}, providers: [] });
    assert.equal(params.get('workspaceId'), workspace.id);
    if (action === 'list') return Response.json([{ id, workspaceId: workspace.id, title: 'Fixture paper' }]);
    if (action === 'import') {
      assert.equal(options.body.get('pdf').name, 'fixture.pdf');
      const parsed = JSON.parse(options.body.get('document'));
      assert.equal(parsed.layoutVersion, 16);
      assert.deepEqual(parsed.range, { first: 1, last: 1 });
    } else {
      assert.equal(action, 'detail');
      assert.equal(params.get('id'), id);
    }
    return Response.json({ id, workspaceId: workspace.id, title: 'Fixture paper', layoutVersion: 16, layoutPages: [1],
      pages: [{ width: 612, height: 792 }], paragraphs: [], history: [], translations: {}, status: 'complete', translated: 0, expected: 0 });
  };
  await import('../src/client.js?workspace-contract');
  assert.ok(registered);
  const plugin = registered.factory(() => hooks.React);
  let panel;
  plugin.apply({
    inject(_services, setup) {
      setup({ uiWorkspace: { async pickDirectory() { picks++; return workspace.path; } } });
    },
    slots: {
      inject(_name, register) { register(); },
      register(options, component) { if (options.name === 'main') panel = component; },
    },
  });
  assert.ok(panel);
  const before = [...elements(await hooks.settle(panel))];
  const upload = before.find(node => node.type === 'button' && node.children.includes('上传 PDF'));
  assert.ok(!upload || upload.props.disabled);
  assert.equal(requests.some(request => request.action === 'list'), false);
  const chooser = before.find(node => node.type === 'button' && node.children.some(text => typeof text === 'string' && /选择.*工作区/.test(text)));
  assert.ok(chooser, '应先显示选择工作区按钮');
  await chooser.props.onClick();
  const opened = [...elements(await hooks.settle(panel))];
  assert.equal(picks, 1);
  assert.ok(requests.some(request => request.action === 'workspace' && request.method === 'POST'));
  assert.ok(requests.some(request => request.action === 'list' && request.workspaceId === workspace.id));
  const papers = opened.find(node => node.type === 'select' && [...elements(node.children)].some(option => option.props.value === id));
  assert.ok(papers);
  const file = opened.find(node => node.type === 'input' && node.props.type === 'file');
  assert.ok(file);
  await file.props.onChange({ currentTarget: { files: [new File(['%PDF-1.7'], 'fixture.pdf')], value: 'fixture.pdf' } });
  const dialog = [...elements(await hooks.settle(panel))];
  const submit = dialog.find(node => node.type === 'button' && node.children.includes('开始解析并翻译'));
  assert.ok(submit, '上传后应显示页码确认');
  await submit.props.onClick();
  await hooks.settle(panel);
  assert.ok(requests.some(request => request.action === 'import' && request.workspaceId === workspace.id));
  assert.ok(requests.some(request => request.action === 'detail' && request.workspaceId === workspace.id));
});

test('工作台提供检查器页签、全文检索、键盘翻页与状态栏', async t => {
  const globals = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  const hooks = hookHarness();
  t.after(() => { hooks.unmount(); Object.assign(globalThis, globals); });
  let registered;
  globalThis.window = Object.assign(new EventTarget(), { __ModuleLoader__: { load: entry => { registered = entry; } } });
  globalThis.document = Object.assign(new EventTarget(), { baseURI: 'http://127.0.0.1:8767/' });
  const workspace = { id: 'workspace-2', path: 'D:/Papers2', title: 'Papers2' };
  const id = 'b'.repeat(64);
  const paper = {
    id, workspaceId: workspace.id, title: 'Fixture paper', layoutVersion: 16, layoutPages: [1, 2, 3],
    pages: [{ width: 612, height: 792 }, { width: 612, height: 792 }, { width: 612, height: 792 }],
    range: { first: 1, last: 3 },
    paragraphs: [{ id: 1, page: 2, kind: 'text', text: 'Fixture source paragraph.', box: [.1, .2, .9, .3] }],
    translations: { 1: '示例译文' }, history: [{ question: '问题', answer: '**加粗** 与 `code`', references: [{ id: 1, page: 2 }] }],
    failedParagraphs: [], status: 'complete', translated: 1, expected: 1,
  };
  globalThis.fetch = async (url, options = {}) => {
    const params = new URL(url).searchParams;
    const action = params.get('action');
    if (action === 'workspace') return Response.json({ workspace });
    if (action === 'settings') return Response.json({ current: {}, providers: [] });
    if (action === 'list') return Response.json([{ id, workspaceId: workspace.id, title: paper.title }]);
    if (action === 'detail') return Response.json(paper);
    return Response.json({});
  };
  await import('../src/client.js?workbench-contract');
  assert.ok(registered);
  const plugin = registered.factory(() => hooks.React);
  let panel;
  plugin.apply({
    inject() {},
    slots: {
      inject(_name, register) { register(); },
      register(options, component) { if (options.name === 'main') panel = component; },
    },
  });
  const main = await hooks.settle(panel);
  const picker = [...elements(main)].find(node => node.type === 'select' && node.props['aria-label'] === '选择文献');
  picker.props.onChange({ target: { value: id } });
  const view = [...elements(await hooks.settle(panel))];
  // Inspector tabs are always present once a paper is open.
  const tabs = view.find(node => node.type === 'div' && node.props.role === 'tablist');
  assert.ok(tabs, '应有检查器页签');
  assert.deepEqual([...elements(tabs)].map(node => node.children[0]).filter(text => typeof text === 'string'), ['段落', '问答', '问题']);
  // Status bar surfaces the workspace path.
  assert.ok(view.some(node => node.type === 'footer' && node.props.className === 'qr-statusbar'), '应有状态栏');
  // Answers render light markdown instead of raw text.
  const chatTab = [...elements(view.find(node => node.type === 'div' && node.props.role === 'tablist'))]
    .find(node => node.type === 'button' && node.children.includes('问答'));
  chatTab.props.onClick();
  const chatted = [...elements(await hooks.settle(panel))];
  assert.ok(chatted.some(node => node.type === 'strong' && node.children.includes('加粗')), '加粗应渲染为 strong');
  // Full-text search lists matching paragraphs and can jump to them.
  const search = view.find(node => node.type === 'input' && node.props['aria-label'] === '全文检索');
  assert.ok(search, '应有全文检索框');
  search.props.onChange({ target: { value: 'Fixture' } });
  const searched = [...elements(await hooks.settle(panel))];
  const listbox = searched.find(node => node.type === 'div' && node.props.role === 'listbox');
  assert.ok(listbox, '应有搜索结果列表');
  const hit = [...elements(listbox)].find(node => node.type === 'button' && node.children.some(part =>
    typeof part === 'object' && part?.children?.includes?.('第 2 页 · 段 1')));
  assert.ok(hit, '搜索结果应包含第 2 页 · 段 1');
  hit.props.onClick();
  const jumped = [...elements(await hooks.settle(panel))];
  const pane = jumped.find(node => node.props?.role === 'tabpanel' && node.props['aria-labelledby'] === 'qr-tab-paragraph');
  assert.ok(pane && [...elements(pane)].some(node => node.children.includes?.('Fixture source paragraph.')),
    '搜索命中后检查器应显示该段原文');
  // Arrow keys flip pages while focus is not inside a control. The element
  // is re-read after each settle because the stub harness re-renders fresh
  // trees (old props capture stale closures).
  let panelMain = jumped.find(node => node.type === 'main');
  panelMain.props.onKeyDown({ key: 'ArrowRight', target: { tagName: 'MAIN' }, ctrlKey: false, metaKey: false, altKey: false, preventDefault() {} });
  const paged = [...elements(await hooks.settle(panel))];
  const pageInput = paged.find(node => node.type === 'input' && node.props['aria-label'] === '页码');
  assert.equal(pageInput.props.value, 3, '→ 应翻到下一页');
  panelMain = paged.find(node => node.type === 'main');
  panelMain.props.onKeyDown({ key: 'ArrowLeft', target: { tagName: 'MAIN' }, ctrlKey: false, metaKey: false, altKey: false, preventDefault() {} });
  const back = [...elements(await hooks.settle(panel))];
  assert.equal(back.find(node => node.type === 'input' && node.props['aria-label'] === '页码').props.value, 2, '← 应翻回上一页');
  // Typing targets are exempt from page shortcuts.
  panelMain = back.find(node => node.type === 'main');
  panelMain.props.onKeyDown({ key: 'ArrowLeft', target: { tagName: 'TEXTAREA' }, ctrlKey: false, metaKey: false, altKey: false, preventDefault() {} });
  const typed = [...elements(await hooks.settle(panel))];
  assert.equal(typed.find(node => node.type === 'input' && node.props['aria-label'] === '页码').props.value, 2,
    '输入框内不应触发翻页');
});

/* ── DOM 结构快照回归 ─────────────────────────────────────────────
   将面板渲染树序列化为稳定文本并与检入基线比对；结构调整是有意的
   时候用 UPDATE_SNAPSHOT=1 node --test test/client.test.js 重新生成。 */
const SNAPSHOT_ATTRS = ['className', 'role', 'aria-label', 'aria-selected', 'aria-pressed',
  'aria-labelledby', 'aria-describedby', 'aria-modal', 'aria-live', 'aria-current', 'type', 'id',
  'htmlFor', 'disabled', 'hidden', 'placeholder', 'title', 'value', 'maxLength', 'rows', 'min', 'max', 'lang'];
function serializeTree(node, depth = 0, lines = []) {
  if (node == null || node === false || node === true) return lines;
  if (Array.isArray(node)) { for (const item of node) serializeTree(item, depth, lines); return lines; }
  if (typeof node !== 'object' || !node.type) {
    const text = String(node).trim();
    if (text) lines.push('  '.repeat(depth) + JSON.stringify(text));
    return lines;
  }
  const indent = '  '.repeat(depth);
  if (typeof node.type === 'function') {
    lines.push(`${indent}<${node.type.name || 'Component'}>`);
    serializeTree(node.children, depth + 1, lines);
    return lines;
  }
  if (typeof node.type === 'symbol') {
    serializeTree(node.children, depth, lines);
    return lines;
  }
  const attrs = SNAPSHOT_ATTRS
    .map(name => [name, node.props?.[name]])
    .filter(([, value]) => value !== undefined && value !== null && value !== false && value !== '')
    .map(([name, value]) => `${name}=${JSON.stringify(typeof value === 'boolean' ? value : String(value))}`);
  lines.push(attrs.length ? `${indent}<${node.type} ${attrs.join(' ')}>` : `${indent}<${node.type}>`);
  serializeTree(node.children, depth + 1, lines);
  return lines;
}

test('面板渲染结构与快照基线一致', async t => {
  const globals = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch };
  const hooks = hookHarness();
  t.after(() => { hooks.unmount(); Object.assign(globalThis, globals); });
  let registered;
  globalThis.window = Object.assign(new EventTarget(), { __ModuleLoader__: { load: entry => { registered = entry; } } });
  globalThis.document = Object.assign(new EventTarget(), { baseURI: 'http://127.0.0.1:8767/' });
  const workspace = { id: 'workspace-snap', path: 'D:/Papers', title: 'Papers' };
  const id = 'c'.repeat(64);
  const paper = {
    id, workspaceId: workspace.id, title: 'Snapshot paper', layoutVersion: 16, layoutPages: [1],
    pages: [{ width: 612, height: 792 }], range: { first: 1, last: 1 },
    paragraphs: [{ id: 1, page: 1, kind: 'text', text: 'A snapshot paragraph.', box: [.1, .2, .9, .3] }],
    translations: { 1: '快照译文' }, history: [], failedParagraphs: [],
    status: 'complete', translated: 1, expected: 1,
  };
  globalThis.fetch = async url => {
    const action = new URL(url).searchParams.get('action');
    if (action === 'workspace') return Response.json({ workspace });
    if (action === 'settings') return Response.json({ current: {}, providers: [] });
    if (action === 'list') return Response.json([{ id, workspaceId: workspace.id, title: paper.title }]);
    if (action === 'detail') return Response.json(paper);
    return Response.json({});
  };
  await import('../src/client.js?snapshot-contract');
  const plugin = registered.factory(() => hooks.React);
  let panel;
  plugin.apply({
    inject() {},
    slots: {
      inject(_name, register) { register(); },
      register(options, component) { if (options.name === 'main') panel = component; },
    },
  });
  let tree = await hooks.settle(panel);
  const picker = [...elements(tree)].find(node => node.type === 'select' && node.props['aria-label'] === '选择文献');
  picker.props.onChange({ target: { value: id } });
  tree = await hooks.settle(panel);
  const snapshot = serializeTree(tree).join('\n') + '\n';
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const snapshotPath = join(dirname(fileURLToPath(import.meta.url)), 'client-tree.snap.txt');
  if (process.env.UPDATE_SNAPSHOT) {
    writeFileSync(snapshotPath, snapshot);
    t.diagnostic('快照基线已更新');
    return;
  }
  let expected;
  try {
    // Git may check the baseline out with CRLF on Windows; the renderer always
    // produces LF, so normalize before comparing.
    expected = readFileSync(snapshotPath, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    assert.fail('缺少快照基线 test/client-tree.snap.txt，先以 UPDATE_SNAPSHOT=1 生成。');
  }
  assert.equal(snapshot, expected, '渲染结构与快照基线不一致；若为有意调整，用 UPDATE_SNAPSHOT=1 重新生成基线。');
});
