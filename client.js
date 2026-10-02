/**
 * dsh-plugin-chrome-driverless — browser half.
 *
 * Adds a "浏览器 / Browser" panel to the DSH web surface: the chrome-driverless
 * console (live viewport, URL bar, tabs, logs — the service's own page at `/`)
 * embedded as an iframe, so the agent's browser is visible and directly
 * operable while it works. The sidebar icon mirrors terminal-panel: a panel
 * icon in `sidebar.panellist`, the surface itself in the `main` slot.
 *
 * The host half (`lib/panel.js`) serves `/chrome-driverless/api/info` with the
 * configured baseUrl and health, so the panel follows config instead of
 * hardcoding the port.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-chrome-driverless',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-plugin-chrome-driverless';
    const API = '/chrome-driverless/api';
    const UI = '/chrome-driverless/ui';
    const PANEL_KEY = 'chrome-driverless';
    const POLL_MS = 15000;

    const DICTS = {
      zh: {
        title: '浏览器',
        live: '实时页面',
        refresh: '重新加载页面',
        openExternal: '在新窗口打开',
        online: '服务在线',
        offline: '服务不可达',
        offlineHint: 'chrome-driverless 没有响应。确认容器在跑（browser_container / docker ps），或检查插件 baseUrl 配置。',
        loading: '连接 chrome-driverless…',
      },
      en: {
        title: 'Browser',
        live: 'Live page',
        refresh: 'Reload page',
        openExternal: 'Open in new window',
        online: 'Service online',
        offline: 'Service unreachable',
        offlineHint:
          'chrome-driverless did not respond. Check the container is running (browser_container / docker ps), or the plugin baseUrl config.',
        loading: 'Connecting to chrome-driverless…',
      },
    };

    const runtime = {
      t: (key) => (DICTS.en[key] !== undefined ? DICTS.en[key] : key),
      syncScheme: null,
    };

    // ---------------------------------------------------------------- api

    async function api(method) {
      const response = await fetch(API + '/' + method, { credentials: 'same-origin' });
      let parsed = null;
      try {
        parsed = await response.json();
      } catch (err) {
        parsed = null;
      }
      if (!parsed || parsed.ok !== true) {
        throw new Error((parsed && parsed.error && parsed.error.message) || 'HTTP ' + response.status);
      }
      return parsed.value;
    }

    // --------------------------------------------------------------- store

    const store = {
      snapshot: { baseUrl: null, reachable: null, health: null, reloads: 0, ready: false },
      listeners: new Set(),
      subscribe: (fn) => {
        store.listeners.add(fn);
        return () => {
          store.listeners.delete(fn);
        };
      },
      getSnapshot: () => store.snapshot,
      patch(next) {
        store.snapshot = Object.assign({}, store.snapshot, next);
        for (const fn of Array.from(store.listeners)) fn();
      },
    };

    function useStore() {
      return React.useSyncExternalStore(store.subscribe, store.getSnapshot);
    }

    async function refresh() {
      try {
        const value = await api('info');
        store.patch({
          baseUrl: value.baseUrl || null,
          reachable: value.reachable === true,
          health: value.health || null,
          ready: true,
        });
      } catch (err) {
        store.patch({ reachable: false, ready: true });
      }
    }

    function reloadFrame() {
      store.patch({ reloads: store.snapshot.reloads + 1 });
    }

    function selectPanel() {
      const layout = runtime.ctx && runtime.ctx.get ? runtime.ctx.get('layout') : null;
      if (layout && typeof layout.selectPanel === 'function') {
        try {
          layout.selectPanel(PANEL_KEY);
        } catch (err) {
          /* unknown panel id is fine: the icon still works */
        }
      }
    }

    // ------------------------------------------------------------ components

    function StatusDot({ on }) {
      return h('span', {
        className: 'dcb-dot' + (on ? ' on' : ''),
        title: on ? runtime.t('online') : runtime.t('offline'),
        'aria-hidden': true,
      });
    }

    function BrowserPanel() {
      const state = useStore();
      const src = state.baseUrl ? UI + '/' : null;
      return h(
        'div',
        { className: 'dcb-panel' },
        h(
          'div',
          { className: 'dcb-head' },
          h('span', { className: 'dcb-title' }, runtime.t('live')),
          h(StatusDot, { on: state.reachable === true }),
          h('span', { className: 'dcb-url' }, state.baseUrl || runtime.t('loading')),
          h(
            'button',
            { type: 'button', className: 'dcb-btn', onClick: reloadFrame, title: runtime.t('refresh'), disabled: !src },
            '⟳',
          ),
          src
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dcb-btn',
                  onClick: () => window.open(state.baseUrl + '/', '_blank', 'noopener'),
                  title: runtime.t('openExternal'),
                },
                '↗',
              )
            : null,        ),
        state.reachable === false && state.ready
          ? h(
              'div',
              { className: 'dcb-empty' },
              h('div', { className: 'dcb-empty-title' }, runtime.t('offline')),
              h('div', { className: 'dcb-empty-hint' }, runtime.t('offlineHint')),
              h(
                'button',
                { type: 'button', className: 'dcb-empty-btn', onClick: refresh },
                '⟳ ' + runtime.t('refresh'),
              ),
            )
          : src
            ? h('iframe', {
                key: state.reloads,
                className: 'dcb-frame',
                src: src,
                title: 'chrome-driverless',
                allow: 'clipboard-read; clipboard-write',
              })
            : h('div', { className: 'dcb-empty' }, h('div', { className: 'dcb-empty-hint' }, runtime.t('loading'))),
      );
    }

    function PanelIcon(props) {
      const state = useStore();
      const size = props && props.size ? props.size : 18;
      const active = Boolean(props && props.active);
      return h(
        'span',
        { className: 'dcb-icon' },
        h(
          'svg',
          {
            width: size,
            height: size,
            viewBox: '0 0 16 16',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.4,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': true,
            style: { display: 'block', opacity: active ? 1 : 0.85 },
          },
          h('circle', { cx: 8, cy: 8, r: 6.4 }),
          h('ellipse', { cx: 8, cy: 8, rx: 2.8, ry: 6.4 }),
          h('path', { d: 'M1.8 6.2h12.4M1.8 9.8h12.4' }),
        ),
        h('span', {
          className: 'dcb-badge' + (state.reachable === false && state.ready ? ' off' : ''),
          'aria-hidden': true,
        }),
      );
    }

    // ---------------------------------------------------------------- style

    const CSS = [
      '.dcb-panel{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1f2329)}',
      '.dcb-head{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.1));background:var(--dsw-alias-bg-layer-1,#fafafa)}',
      '.dcb-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#6b7280);white-space:nowrap}',
      '.dcb-url{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
      '.dcb-btn{flex:0 0 auto;border:1px solid var(--dsw-alias-border-l1,rgba(15,23,42,.14));background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);border-radius:7px;padding:2px 8px;cursor:pointer;font:inherit;line-height:1.4}',
      '.dcb-btn:hover:not(:disabled){color:var(--dsw-alias-brand-primary,#4d6bfe);border-color:currentColor}',
      '.dcb-btn:disabled{opacity:.4;cursor:default}',
      '.dcb-dot{flex:0 0 auto;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-secondary,#9ca3af)}',
      '.dcb-dot.on{background:var(--dsw-alias-state-success-primary,#16a34a)}',
      '.dcb-frame{flex:1 1 auto;min-height:0;width:100%;border:0;background:#111}',
      '.dcb-empty{flex:1 1 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:var(--dsw-alias-label-secondary,#6b7280);padding:24px;text-align:center}',
      '.dcb-empty-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2329)}',
      '.dcb-empty-hint{font-size:12px;max-width:420px;line-height:1.6}',
      '.dcb-empty-btn{margin-top:4px;border:0;border-radius:8px;padding:6px 12px;background:var(--dsw-alias-brand-primary,#4d6bfe);color:#fff;font:inherit;font-weight:600;cursor:pointer}',
      '.dcb-icon{position:relative;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;line-height:0}',
      '.dcb-badge{position:absolute;top:-1px;right:-1px;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#16a34a);box-shadow:0 0 0 1.5px var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-base,#fff))}',
      '.dcb-badge.off{background:var(--dsw-alias-state-error-primary,#dc2626)}',
    ].join('\n');

    function installStyles(ctx) {
      let dispose;
      try {
        if (typeof styles !== 'undefined' && styles && typeof styles.insert === 'function') {
          dispose = styles.insert(CSS);
        }
      } catch (err) {
        dispose = null;
      }
      if (!dispose) {
        try {
          const node = document.createElement('style');
          node.setAttribute('data-dsh-plugin', NS);
          node.textContent = CSS;
          document.head.appendChild(node);
          dispose = () => {
            if (node.parentNode) node.parentNode.removeChild(node);
          };
        } catch (err) {
          return;
        }
      }
      ctx.effect(() => dispose);
    }

    function installLocale(ctx) {
      try {
        const locale = ctx.get('locale');
        if (locale && typeof locale.getLocale === 'function') {
          const id = locale.getLocale() && locale.getLocale().active;
          if (/^zh/i.test(String(id || ''))) runtime.t = (key) => (DICTS.zh[key] !== undefined ? DICTS.zh[key] : key);
        }
      } catch (err) {
        /* keep English */
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        runtime.ctx = ctx;
        installLocale(ctx);
        installStyles(ctx);
        ctx.effect(() => {
          refresh();
          const timer = window.setInterval(refresh, POLL_MS);
          return () => window.clearInterval(timer);
        });
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_KEY }, BrowserPanel));
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_KEY,
              order: 23,
              label: () => runtime.t('title'),
            },
            PanelIcon,
          ),
        );
      },
    };
  },
});
