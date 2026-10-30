#!/usr/bin/env node
/**
 * Browser-free smoke test for dsh-aurora-theme.
 *
 * It executes the REAL committed artifacts against a stubbed runtime, so a
 * broken bundle is caught here instead of at profile boot — where the failure
 * mode is an app that will not start.
 *
 * What it proves:
 *   1. lib/ is in sync with src/ (lib/ is committed, so a stale artifact is a
 *      real shipping bug);
 *   2. package.json carries the three fields @deepseek-ai/dsh-client-modules
 *      requires to enroll a browser bundle;
 *   3. the host half is importable and exports name + apply;
 *   4. lib/client.js honours the module-loader contract and, when the runtime
 *      calls apply(ctx), it publishes the settings section and the overlay and
 *      stacks exactly one alias-token layer whose every token has both a light
 *      and a dark value;
 *   5. the panel component renders without throwing, with and without a
 *      wallpaper, and that disabling the plugin removes every side effect.
 *
 * It is NOT a substitute for loading the plugin in a real profile: it says
 * nothing about visuals, slot keys the deployment actually declares, or the
 * browser's CSS. Run `npm run build` first if it reports stale artifacts.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderHost, renderClient } from './build.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

let failures = 0;

async function check(label, fn) {
  try {
    await fn();
    console.log('  ok    ' + label);
  } catch (error) {
    failures += 1;
    console.error('  FAIL  ' + label);
    console.error('        ' + (error && error.message ? error.message : String(error)));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Depth-first search over the element tree the React stub builds. */
function findElement(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findElement(child, predicate);
      if (hit) return hit;
    }
    return null;
  }
  if (predicate(node)) return node;
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      const hit = findElement(child, predicate);
      if (hit) return hit;
    }
  }
  return null;
}

/* ── the stub runtime ─────────────────────────────────────────────────────── */

const reactStub = {
  createElement(type, props, ...children) {
    return { type: typeof type === 'function' ? type.name || 'anonymous' : type, props: props || {}, children };
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}];
  },
  useEffect() {},
};

/**
 * Build a fresh environment, evaluate the bundle in it, and return the loaded
 * module plus the probes used to observe what apply() did.
 */
/**
 * Minimal in-memory IndexedDB covering exactly the surface the bundle uses:
 * open (+upgradeneeded), transaction, objectStore put/get/delete, close.
 * Runs on microtasks so a test can await it with plain promise ticks.
 */
function makeFakeIndexedDb() {
  const databases = new Map();

  function makeDatabase(entry) {
    return {
      objectStoreNames: { contains: (name) => entry.stores.has(name) },
      createObjectStore(name) {
        entry.stores.set(name, new Map());
        return {};
      },
      close() {},
      transaction(storeName) {
        const data = entry.stores.get(storeName) || new Map();
        const pending = [];
        const tx = { error: null, oncomplete: null, onerror: null, onabort: null };
        tx.objectStore = () => ({
          put(value, key) {
            pending.push(() => data.set(key, value));
            return {};
          },
          delete(key) {
            pending.push(() => data.delete(key));
            return {};
          },
          get(key) {
            const request = { result: undefined, error: null, onsuccess: null, onerror: null };
            pending.push(() => {
              request.result = data.get(key);
              if (request.onsuccess) request.onsuccess();
            });
            return request;
          },
        });
        queueMicrotask(() => {
          while (pending.length > 0) pending.shift()();
          if (tx.oncomplete) tx.oncomplete();
        });
        return tx;
      },
    };
  }

  return {
    open(name) {
      const request = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      queueMicrotask(() => {
        const isNew = !databases.has(name);
        if (isNew) databases.set(name, { stores: new Map() });
        request.result = makeDatabase(databases.get(name));
        if (isNew && request.onupgradeneeded) request.onupgradeneeded();
        if (request.onsuccess) request.onsuccess();
      });
      return request;
    },
  };
}

/** Let queued microtasks (fake IndexedDB transactions) drain. */
async function settle() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function bootClient(source, savedState, indexedDb) {
  const created = [];
  const documentStub = {
    head: {
      appendChild(el) {
        el.parentNode = documentStub.head;
        created.push(el);
      },
      removeChild(el) {
        const at = created.indexOf(el);
        if (at >= 0) created.splice(at, 1);
        el.parentNode = null;
      },
    },
    documentElement: { appendChild(el) { el.parentNode = documentStub.documentElement; } },
    createElement(tag) {
      return {
        tagName: tag,
        textContent: '',
        attrs: {},
        parentNode: null,
        setAttribute(key, value) { this.attrs[key] = value; },
      };
    },
  };

  const store = new Map();
  if (savedState !== undefined) store.set('dsh-aurora-theme/v1', JSON.stringify(savedState));

  const loaded = [];
  const windowStub = {
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { store.set(key, String(value)); },
      removeItem: (key) => { store.delete(key); },
    },
    __ModuleLoader__: {
      load(spec) {
        loaded.push({ id: spec.id, exports: spec.factory((name) => {
          if (name === 'react') return reactStub;
          throw new Error('bundle required an unexpected module: ' + name);
        }) });
      },
    },
  };

  // Blob URLs, faked. A picked file must never be turned into a base64 string, so
  // the harness can assert that both the stylesheet and the record stay tiny.
  const objectUrls = [];
  const revoked = [];
  let urlSeq = 0;
  const urlApi = {
    createObjectURL(blob) {
      urlSeq += 1;
      const url = 'blob:test/' + urlSeq;
      objectUrls.push({ url, blob });
      return url;
    },
    revokeObjectURL(url) {
      revoked.push(url);
    },
  };

  // `window`, `document`, `indexedDB` and `URL` are parameters, not globals: the
  // bundle runs in a browser scope that this harness only imitates.
  new Function('window', 'document', 'indexedDB', 'URL', source)(windowStub, documentStub, indexedDb, urlApi);

  return { loaded, created, store, documentStub, windowStub, indexedDb, objectUrls, revoked };
}

/** Run apply(ctx) against a recording context and report what it registered. */
function runApply(moduleExports) {
  const registrations = [];
  const tokenCalls = [];
  const effects = [];

  const slots = {
    inject(key, callback) {
      callback();
      return () => {};
    },
    register(options, render) {
      registrations.push({ options, render });
      return () => {};
    },
  };
  const theme = {
    overrideTokens(source, tokens) {
      tokenCalls.push({ source, tokens });
      return () => {};
    },
  };
  const ctx = {
    get(name) {
      if (name === 'theme') return theme;
      if (name === 'slots') return slots;
      return undefined;
    },
    effect(callback) {
      const disposer = callback();
      effects.push(disposer);
      return () => { if (typeof disposer === 'function') disposer(); };
    },
  };

  moduleExports.apply(ctx);
  return { registrations, tokenCalls, effects };
}

/* ── 1. artifacts are fresh ───────────────────────────────────────────────── */

console.log('\nartifacts');

await check('lib/index.js is in sync with src/host.js', () => {
  const onDisk = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8');
  const fresh = renderHost(readFileSync(join(ROOT, 'src', 'host.js'), 'utf8'));
  assert(onDisk === fresh, 'stale artifact — run: npm run build');
});

await check('lib/client.js is in sync with src/client.js', () => {
  const onDisk = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');
  const fresh = renderClient(pkg.name, readFileSync(join(ROOT, 'src', 'client.js'), 'utf8'));
  assert(onDisk === fresh, 'stale artifact — run: npm run build');
});

/* ── 2. the enrollment fields the loader needs ────────────────────────────── */

console.log('\npackage manifest');

await check('declares dsh.bundle.patch pointing at a real file', () => {
  const patch = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch;
  assert(typeof patch === 'string', 'dsh.bundle.patch missing — the package would never join the layer stack');
  assert(existsSync(join(ROOT, patch)), 'dsh.bundle.patch points at a missing file: ' + patch);
});

await check('declares dsh.client for platform web', () => {
  const client = pkg.dsh && pkg.dsh.client;
  assert(client && typeof client === 'object', 'dsh.client missing — the browser half would never be scanned');
  assert(client.platform === 'web', 'dsh.client.platform must be "web", got ' + String(client.platform));
  assert(Array.isArray(client.inject), 'dsh.client.inject must be an array');
});

await check('exports a ./client bundle the scanner can resolve', () => {
  const entry = pkg.exports && pkg.exports['./client'];
  const rel = typeof entry === 'string' ? entry : entry && entry.default;
  assert(typeof rel === 'string', 'exports["./client"] missing — dsh-client-modules throws without it');
  assert(existsSync(join(ROOT, rel)), 'exports["./client"] points at a missing file: ' + rel);
});

/* ── 3. host half ─────────────────────────────────────────────────────────── */

console.log('\nhost half');

await check('imports and exports name + apply', async () => {
  const mod = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href);
  assert(typeof mod.apply === 'function', 'host half must export apply()');
  assert(mod.name === pkg.name, 'host half name must match the package name');
  mod.apply();
});

/* ── 4. client bundle contract ────────────────────────────────────────────── */

console.log('\nclient bundle');

await check('loads through __ModuleLoader__ and exports apply', () => {
  const src = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');
  const { loaded } = bootClient(src);
  assert(loaded.length === 1, 'the bundle must call window.__ModuleLoader__.load exactly once');
  assert(loaded[0].id === pkg.name, 'bundle id must be the package name, got ' + loaded[0].id);
  assert(typeof loaded[0].exports.apply === 'function', 'client bundle must export apply()');
});

await check('declares the Cordis inject its halves hard-depend on', () => {
  const src = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');
  const { loaded } = bootClient(src);
  const inject = loaded[0].exports.inject;
  assert(Array.isArray(inject), 'the client bundle must export inject, not just apply');
  assert(inject.includes('slots'), 'inject must cover slots');
  assert(inject.includes('theme'), 'inject must cover theme');
});

await check('a late theme service is picked up instead of dropped', () => {
  const src = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');
  const env = bootClient(src);

  const applied = [];
  const theme = { overrideTokens(source) { applied.push(source); return () => {}; } };
  let lookups = 0;
  const ctx = {
    get(name) {
      if (name !== 'theme') return undefined;
      lookups += 1;
      return lookups >= 3 ? theme : undefined;
    },
    effect(callback) {
      const disposer = callback();
      return () => { if (typeof disposer === 'function') disposer(); };
    },
  };

  // Capture the retry timer so the pending path can be driven deterministically.
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const queue = [];
  globalThis.setTimeout = (cb) => { queue.push(cb); return queue.length; };
  globalThis.clearTimeout = () => {};
  try {
    env.loaded[0].exports.apply(ctx);
    assert(applied.length === 0, 'no token layer may be stacked while the service is absent');
    let guard = 0;
    while (queue.length > 0 && guard < 50) {
      guard += 1;
      queue.shift()();
    }
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }

  assert(applied.length === 1, 'the retry must stack exactly one token layer once the service appears');
});

await check('a permanently absent theme service does not spin forever', () => {
  const src = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');
  const env = bootClient(src);
  const ctx = {
    get() { return undefined; },
    effect(callback) {
      const disposer = callback();
      return () => { if (typeof disposer === 'function') disposer(); };
    },
  };

  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let scheduled = 0;
  const queue = [];
  globalThis.setTimeout = (cb) => { scheduled += 1; queue.push(cb); return scheduled; };
  globalThis.clearTimeout = () => {};
  try {
    env.loaded[0].exports.apply(ctx);
    let guard = 0;
    while (queue.length > 0 && guard < 500) {
      guard += 1;
      queue.shift()();
    }
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }

  assert(scheduled > 0, 'a missing service should start the retry path');
  assert(scheduled <= 60, 'the retry must be bounded, scheduled ' + scheduled + ' times');
});

await check('apply registers the settings section and the overlay', () => {
  const src = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');
  const { loaded } = bootClient(src);
  const { registrations } = runApply(loaded[0].exports);

  const section = registrations.find((r) => r.options.name === 'settings.section');
  const overlay = registrations.find((r) => r.options.name === 'shell.overlay');
  assert(section, 'no settings.section registration');
  assert(section.options.id === 'aurora-theme', 'settings.section id changed: ' + section.options.id);
  assert(overlay, 'no shell.overlay registration');
  assert(overlay.options.id === 'aurora-glow', 'shell.overlay id changed: ' + overlay.options.id);
});

await check('apply stacks one alias-token layer with light+dark for every token', () => {
  const src = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');
  const { loaded } = bootClient(src);
  const { tokenCalls } = runApply(loaded[0].exports);

  assert(tokenCalls.length === 1, 'expected exactly one overrideTokens call, got ' + tokenCalls.length);
  const call = tokenCalls[0];
  assert(call.source === pkg.name, 'overrideTokens source must be the package name, got ' + call.source);
  const names = Object.keys(call.tokens);
  assert(names.length === 13, 'expected 13 alias tokens, got ' + names.length);
  for (const name of names) {
    assert(name.startsWith('--dsw-'), 'unexpected token name: ' + name);
    const value = call.tokens[name];
    assert(value && typeof value.light === 'string' && typeof value.dark === 'string', name + ' needs both a light and a dark value');
  }
});

await check('the glass default is 50% surface opacity', () => {
  const src = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');
  const { loaded } = bootClient(src);
  const { tokenCalls } = runApply(loaded[0].exports);

  // --dsw-alias-bg-base carries the surface alpha directly.
  const base = tokenCalls[0].tokens['--dsw-alias-bg-base'];
  assert(base.dark === 'rgba(7, 11, 24, 0.5)', 'dark surface should default to 50%, got ' + base.dark);
  assert(base.light === 'rgba(238, 244, 255, 0.5)', 'light surface should default to 50%, got ' + base.light);
});

await check('apply owns three stylesheet layers and paints the wallpaper', () => {
  const src = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');
  const { loaded, created } = bootClient(src);
  runApply(loaded[0].exports);

  assert(created.length === 3, 'expected 3 owned <style> layers, got ' + created.length);
  const css = created.map((el) => el.textContent).join('\n');
  assert(css.includes('body::before'), 'the wallpaper rule is missing');
  assert(css.includes('--aurora-wallpaper:'), 'no wallpaper value was written');
  assert(css.includes('--aurora-opacity:'), 'no parameter layer was written');
  assert(css.includes('position:fixed'), 'the wallpaper layer must be viewport-anchored');
  assert(!/body::before\{[^}]*inset:0/.test(css), 'body::before must not use inset:0');
  for (const el of created) {
    assert(el.attrs['data-dsh-plugin'] === pkg.name, 'owned styles must be tagged with the package name');
    assert(el.attrs['data-plugin'] === pkg.name, 'owned styles must carry data-plugin or the module system may claim them');
  }
});

await check('the panel renders for a preset wallpaper and for a seeded image', () => {
  const src = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');

  const presetCase = bootClient(src);
  const a = runApply(presetCase.loaded[0].exports);
  const sectionA = a.registrations.find((r) => r.options.name === 'settings.section');
  const treeA = sectionA.render({});
  assert(treeA && treeA.type === 'div', 'panel did not render an element');

  const seeded = bootClient(src, { enabled: true, imageUrl: 'data:image/png;base64,AAAA', fit: 'height', preset: 'none' });
  const b = runApply(seeded.loaded[0].exports);
  const sectionB = b.registrations.find((r) => r.options.name === 'settings.section');
  const treeB = sectionB.render({});
  assert(treeB && treeB.type === 'div', 'panel did not render with a seeded image');

  const cssB = seeded.created.map((el) => el.textContent).join('\n');
  assert(cssB.includes('--aurora-wallpaper:url("data:image/png;base64,AAAA")'), 'a seeded wallpaper was not applied');
  assert(cssB.includes('--aurora-size:auto 100%'), 'the seeded fit mode was not applied');
});

await check('a disabled plugin stacks no tokens and zeroes the wallpaper', () => {
  const src = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');
  const off = bootClient(src, { enabled: false, preset: 'aurora' });
  const result = runApply(off.loaded[0].exports);

  assert(result.tokenCalls.length === 0, 'a disabled plugin must not stack a token layer');
  const css = off.created.map((el) => el.textContent).join('\n');
  assert(css.includes('--aurora-wallpaper:none'), 'a disabled plugin must not paint a wallpaper');
  assert(css.includes('--aurora-opacity:0'), 'a disabled plugin must zero the wallpaper opacity');
});

await check('a disk-picked wallpaper survives a reload', async () => {
  const src = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');
  const idb = makeFakeIndexedDb();
  const RECORD_KEY = 'dsh-aurora-theme/v1';

  // ── session 1: pick a file big enough to blow localStorage's quota ────────
  const first = bootClient(src, undefined, idb);
  const runA = runApply(first.loaded[0].exports);
  const panel = runA.registrations.find((r) => r.options.name === 'settings.section');
  const tree = panel.render({});

  const fileInput = findElement(tree, (node) => node.props && node.props.type === 'file');
  assert(fileInput, 'the panel must render a file input to pick from');

  // The reporter's own file: 7.4 MB. It must not become a ~9.9 MB string anywhere.
  const file = { name: '1 (2).png', size: 7763935, type: 'image/png' };
  fileInput.props.onChange({ target: { files: [file], value: '' } });
  await settle();
  await settle();
  await settle();

  const stored = first.store.get(RECORD_KEY);
  assert(typeof stored === 'string', 'the plugin must write a settings record');
  assert(stored.length < 200000, 'the localStorage record must stay small, was ' + stored.length);

  const record = JSON.parse(stored);
  assert(record.imageStored === true, 'the record must point at the stored image');
  assert(record.imageUrl === undefined, 'a multi-megabyte URL must not go into localStorage');
  assert(record.opacity !== undefined, 'the ordinary parameters must still be persisted');

  const cssA = first.created.map((el) => el.textContent).join('\n');
  assert(cssA.includes('--aurora-wallpaper:url("blob:'), 'a picked file must reach CSS as a blob: URL');
  assert(!cssA.includes('data:image'), 'a picked file must never be base64-encoded');
  assert(cssA.length < 20000, 'the stylesheet must stay small, was ' + cssA.length + ' chars');

  // ── session 2: a fresh page load against the same browser database ────────
  const second = bootClient(src, record, idb);
  runApply(second.loaded[0].exports);
  await settle();
  await settle();
  await settle();

  const css = second.created.map((el) => el.textContent).join('\n');
  assert(
    css.includes('--aurora-wallpaper:url("blob:'),
    'the stored wallpaper must be restored on the next load',
  );
  assert(second.objectUrls.length === 1, 'the restore must mint exactly one object URL');
});

await check('clearing the wallpaper also clears the stored bytes', async () => {
  const src = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');
  const idb = makeFakeIndexedDb();
  const RECORD_KEY = 'dsh-aurora-theme/v1';

  const env = bootClient(src, undefined, idb);
  const runA = runApply(env.loaded[0].exports);
  const panel = runA.registrations.find((r) => r.options.name === 'settings.section');

  const fileInput = findElement(panel.render({}), (node) => node.props && node.props.type === 'file');
  fileInput.props.onChange({
    target: { files: [{ name: 'w.png', size: 7763935, type: 'image/png' }], value: '' },
  });
  await settle();
  await settle();
  await settle();
  assert(JSON.parse(env.store.get(RECORD_KEY)).imageStored === true, 'precondition: the image should be stored');

  const clearButton = findElement(
    panel.render({}),
    (node) => Array.isArray(node.children) && node.children.indexOf('清除自定义图片') >= 0,
  );
  assert(clearButton, 'the panel must render the clear button');
  clearButton.props.onClick();
  await settle();
  await settle();

  const record = JSON.parse(env.store.get(RECORD_KEY));
  assert(record.imageStored === false, 'clearing must drop the stored pointer, got ' + String(record.imageStored));

  // And the bytes are really gone: a fresh load restores nothing.
  const next = bootClient(src, record, idb);
  runApply(next.loaded[0].exports);
  await settle();
  await settle();
  const css = next.created.map((el) => el.textContent).join('\n');
  assert(!css.includes('--aurora-wallpaper:url("blob:'), 'a cleared wallpaper must not come back');
});

await check('the font choice is applied and survives a reload', async () => {
  const src = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');
  const RECORD_KEY = 'dsh-aurora-theme/v1';

  const first = bootClient(src);
  const runA = runApply(first.loaded[0].exports);
  const panel = runA.registrations.find((r) => r.options.name === 'settings.section');

  const fontSeg = findElement(
    panel.render({}),
    (node) => node.type === 'Seg' && Array.isArray(node.props.options) && node.props.options.some((o) => o.value === 'serif'),
  );
  assert(fontSeg, 'the panel must render the font selector');
  assert(fontSeg.props.value === 'system', 'the default must be the platform stack, got ' + fontSeg.props.value);

  // 'system' must not shadow the platform's own :root declaration at all.
  const cssDefault = first.created.map((el) => el.textContent).join('\n');
  assert(!cssDefault.includes('--dsw-font-family'), 'the default must leave --dsw-font-family alone');

  fontSeg.props.onChange('serif');
  await settle();

  const cssSerif = first.created.map((el) => el.textContent).join('\n');
  assert(cssSerif.includes('--dsw-font-family:"Georgia"'), 'the chosen stack must reach the stylesheet');

  const record = JSON.parse(first.store.get(RECORD_KEY));
  assert(record.fontFamily === 'serif', 'the font choice must be persisted, got ' + String(record.fontFamily));

  // A fresh load must restore it with no user interaction.
  const second = bootClient(src, record);
  runApply(second.loaded[0].exports);
  await settle();
  const cssReloaded = second.created.map((el) => el.textContent).join('\n');
  assert(cssReloaded.includes('--dsw-font-family:"Georgia"'), 'the font choice must survive a reload');

  // Every other parameter must still be intact in the same record.
  assert(record.surface === 0.5 || typeof record.surface === 'number', 'the record must still carry the surface value');
  assert(record.preset === 'aurora', 'the record must still carry the preset');
});

await check('disabling removes every side effect', () => {
  const src = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');
  const env = bootClient(src);
  const { effects } = runApply(env.loaded[0].exports);
  assert(effects.length === 1, 'expected one owning effect, got ' + effects.length);
  assert(env.created.length === 3, 'stylesheets should exist while running');

  effects[0]();
  assert(env.created.length === 0, 'the owning effect must remove every <style> element it created');
});

/* ── verdict ──────────────────────────────────────────────────────────────── */

if (failures > 0) {
  console.error('\n' + failures + ' check(s) failed\n');
  process.exit(1);
}
console.log('\nall checks passed\n');
