// WebMCP runtime: lets an AI agent drive TRIP MAKER through named tools instead of
// guessing at the DOM. Tools are declared by the page (see webmcp-tools.js for the
// site-wide set, and trip.js for the ones scoped to an open trip) and handed to
// whichever agent host the browser exposes.
//
// Three hosts, tried in order, because the API is still moving:
//   1. document.modelContext  — where the W3C draft put it (April 2026)
//   2. navigator.modelContext — Edge 147 / the Chrome 149 origin trial, deprecated in Chrome 150
//   3. window.tripiTools      — our own bridge, always installed
//
// (3) is the one that matters today: native support is thin, and almost every agent
// that reaches this site does so through a headless browser where the only channel is
// evaluating JS. Same tools, same arguments, same results — `window.tripiTools.call()`
// is a faithful stand-in for a native host, not a lesser path.
(function () {
  'use strict';

  // matches the spec's tool-name grammar: 1–128 chars, ASCII alphanumeric . _ -
  const NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;
  const registry = new Map(); // name → full descriptor, execute included

  const warn = (...a) => console.warn('[TRIP MAKER][webmcp]', ...a);

  // WebMCP's result shape is a human-readable `content` array plus a machine-readable
  // `structuredContent` holding the same data. Emitting both is what keeps a tool
  // legible to a host that only renders text and to one that parses the payload.
  function ok(data) {
    const structuredContent = typeof data === 'string' ? { message: data } : data;
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    return { content: [{ type: 'text', text }], structuredContent };
  }

  // a failed tool call is a *result*, not a thrown exception — the agent needs to read
  // the reason and pick a different move, which a rejected promise doesn't let it do
  function fail(message, extra) {
    const structuredContent = { error: String(message), ...(extra || {}) };
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
      structuredContent,
      isError: true,
    };
  }

  // ---------- host binding ----------
  const host = (() => {
    try {
      if (typeof document !== 'undefined' && document.modelContext) return document.modelContext;
    } catch { /* insecure context, or the getter is gone in this build */ }
    try {
      if (typeof navigator !== 'undefined' && navigator.modelContext) return navigator.modelContext;
    } catch { /* same */ }
    return null;
  })();

  function pushToHost(tool) {
    if (!host) return;
    try {
      if (typeof host.registerTool === 'function') {
        // registerTool rejects on a duplicate name, so drop the old one first — pages
        // re-register when their state reloads, and that must not be an error
        if (typeof host.unregisterTool === 'function') {
          try { host.unregisterTool(tool.name); } catch { /* wasn't registered yet */ }
        }
        Promise.resolve(host.registerTool(tool, tool.signal ? { signal: tool.signal } : undefined))
          .catch((err) => warn('registerTool(' + tool.name + ') failed:', err));
        return;
      }
      // earlier drafts took the whole tool list at once and replaced it wholesale,
      // so this branch re-sends everything registered so far, not just the new tool
      if (typeof host.provideContext === 'function') {
        Promise.resolve(host.provideContext({ tools: [...registry.values()] }))
          .catch((err) => warn('provideContext failed:', err));
      }
    } catch (err) {
      warn('registration failed for ' + tool.name + ':', err);
    }
  }

  function pullFromHost(name) {
    if (!host || typeof host.unregisterTool !== 'function') return;
    try { host.unregisterTool(name); } catch { /* already gone */ }
  }

  // ---------- registration ----------
  // Wrapping execute here — rather than trusting each tool to be careful — is what
  // guarantees every tool answers in the same shape, including when it throws.
  function wrapExecute(name, execute) {
    return async function (input) {
      try {
        const result = await execute(input || {});
        // a tool that already built a content/structuredContent envelope keeps it;
        // anything else is plain data and gets wrapped
        if (result && typeof result === 'object' && Array.isArray(result.content)) return result;
        return ok(result === undefined ? { ok: true } : result);
      } catch (err) {
        return fail((err && err.message) || 'tool failed', { tool: name });
      }
    };
  }

  /**
   * Declare one tool. Returns a function that removes it again.
   * @param {{name:string, title?:string, description:string, inputSchema?:object,
   *          annotations?:object, execute:Function, signal?:AbortSignal}} tool
   */
  function register(tool) {
    if (!tool || !NAME_RE.test(tool.name || '')) {
      warn('refusing to register a tool with an invalid name:', tool && tool.name);
      return () => {};
    }
    if (typeof tool.execute !== 'function') {
      warn('tool ' + tool.name + ' has no execute()');
      return () => {};
    }
    const entry = {
      name: tool.name,
      title: tool.title || tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema || { type: 'object', properties: {} },
      annotations: tool.annotations || {},
      execute: wrapExecute(tool.name, tool.execute),
      signal: tool.signal,
    };
    registry.set(entry.name, entry);
    pushToHost(entry);
    announce();
    return () => unregister(entry.name);
  }

  function registerAll(tools) {
    const undo = (tools || []).map(register);
    return () => undo.forEach((fn) => fn());
  }

  function unregister(name) {
    if (!registry.delete(name)) return;
    pullFromHost(name);
    // the batch API has no per-tool removal — re-send what's left
    if (host && typeof host.registerTool !== 'function' && typeof host.provideContext === 'function') {
      try { host.provideContext({ tools: [...registry.values()] }); } catch { /* best effort */ }
    }
  }

  const publicDescriptor = (t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: t.annotations,
  });

  // ---------- the always-on bridge ----------
  // Anything with a JS channel into the page gets the same tools a native host would,
  // through `window.tripiTools`. Deliberately on `window` and deliberately unminified:
  // it is a documented entry point, not an implementation detail.
  const bridge = {
    // 'document' | 'navigator' | null — which native host picked the tools up, if any
    get host() {
      if (!host) return null;
      try { return (typeof document !== 'undefined' && document.modelContext === host) ? 'document' : 'navigator'; }
      catch { return 'navigator'; }
    },
    list() {
      return [...registry.values()].map(publicDescriptor);
    },
    async call(name, input) {
      const tool = registry.get(name);
      if (!tool) {
        return fail('no such tool: ' + name, { available: [...registry.keys()] });
      }
      return tool.execute(input || {});
    },
  };

  // one console line so an agent that lands on the page with nothing but the console
  // can find the tools. Debounced — registration happens in bursts as scripts run.
  let announced = null;
  function announce() {
    clearTimeout(announced);
    announced = setTimeout(() => {
      const via = bridge.host ? bridge.host + '.modelContext' : 'window.tripiTools only (no native host)';
      console.info(
        `[TRIP MAKER] WebMCP: ${registry.size} tools via ${via}. ` +
        'window.tripiTools.list() to see them, window.tripiTools.call(name, input) to run one.'
      );
    }, 250);
  }

  window.tripiTools = bridge;

  // common.js declares TRIPI with `const`, which is a lexical binding and never lands
  // on window — so this has to reach the identifier directly. typeof guards the case
  // where webmcp.js is loaded on its own.
  try {
    if (typeof TRIPI !== 'undefined') {
      TRIPI.mcp = {
        register, registerAll, unregister, ok, fail,
        list: () => bridge.list(),
        call: (n, i) => bridge.call(n, i),
        get host() { return bridge.host; },
      };
    }
  } catch { /* no common.js on this page — window.tripiTools still works */ }
}());
