/**
 * Host half of the ui-tweaks bundle.
 * Persists the subagent panel's display preferences — per-parent manual order
 * and per-child display-name aliases — in a storage-domain table and bridges
 * them to the browser over /ui-tweaks (GET 读取 / POST 保存).
 */

export const inject = ['storageDomain', 'webServer'];

const passthrough = { parse: (v) => v };

const UiTweaksSpec = {
  name: 'uitweaks',
  version: 1,
  tables: {
    settings: { valueSchema: passthrough },
  },
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** 清洗外部输入:order = { 父会话id: [子会话id/分组id...] },names = { 子会话id: 显示名 },pending = { 子会话id: true },groups = { 父会话id: { 分组id: { name, children } } } */
function sanitize(state) {
  const order = {};
  const names = {};
  const pending = {};
  const groups = {};
  if (state && typeof state.order === 'object' && state.order !== null) {
    for (const [k, v] of Object.entries(state.order)) {
      if (Array.isArray(v)) {
        order[String(k)] = v.filter((x) => typeof x === 'string').slice(0, 500);
      }
    }
  }
  if (state && typeof state.names === 'object' && state.names !== null) {
    for (const [k, v] of Object.entries(state.names)) {
      if (typeof v === 'string') {
        const t = v.trim().slice(0, 100);
        if (t) names[String(k)] = t;
      }
    }
  }
  if (state && typeof state.pending === 'object' && state.pending !== null) {
    for (const [k, v] of Object.entries(state.pending)) {
      if (v === true) pending[String(k)] = true;
    }
  }
  if (state && typeof state.groups === 'object' && state.groups !== null) {
    for (const [pk, map] of Object.entries(state.groups)) {
      if (!map || typeof map !== 'object') continue;
      const clean = {};
      for (const [gid, g] of Object.entries(map)) {
        if (!g || typeof g !== 'object') continue;
        const name = typeof g.name === 'string' ? g.name.trim().slice(0, 60) : '';
        if (!name) continue;
        const children = Array.isArray(g.children)
          ? g.children.filter((x) => typeof x === 'string').slice(0, 500)
          : [];
        clean[String(gid)] = { name, children };
      }
      if (Object.keys(clean).length > 0) groups[String(pk)] = clean;
    }
  }
  const costs = {};
  if (state && typeof state.costs === 'object' && state.costs !== null) {
    for (const [sid, c] of Object.entries(state.costs)) {
      if (!c || typeof c !== 'object') continue;
      const yuan = typeof c.yuan === 'number' && Number.isFinite(c.yuan) && c.yuan >= 0 ? c.yuan : 0;
      const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
      const l = c.last && typeof c.last === 'object' ? c.last : {};
      costs[String(sid)] = { yuan, last: { u: num(l.u), cw: num(l.cw), cr: num(l.cr), o: num(l.o) } };
    }
  }
  let price = null;
  if (state && typeof state.price === 'number' && Number.isFinite(state.price) && state.price > 0 && state.price <= 1000) {
    price = state.price;
  }
  const collapsedGroups = [];
  if (state && Array.isArray(state.collapsedGroups)) {
    for (const x of state.collapsedGroups) {
      if (typeof x === 'string') collapsedGroups.push(x);
    }
    if (collapsedGroups.length > 500) collapsedGroups.length = 500;
  }
  return { order, names, pending, groups, costs, price, collapsedGroups };
}

export async function apply(ctx) {
  const domain = await ctx.storageDomain.open(UiTweaksSpec);
  ctx.effect(() => () => domain.close());

  const settings = domain.table('settings');

  async function loadState() {
    const row = settings.get('state');
    return sanitize(row && typeof row === 'object' ? row : {});
  }

  // 启动时清空「待重启验证」标记:能走到这一步,说明这些改名已随持久化数据活过了一次重启
  const bootState = await loadState();
  if (bootState.pending && Object.keys(bootState.pending).length > 0) {
    await settings.put('state', Object.assign({}, bootState, { pending: {} }));
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/ui-tweaks',
      async handler(req, res) {
        try {
          if (req.method === 'GET') {
            sendJson(res, 200, await loadState());
            return;
          }
          if (req.method === 'POST') {
            const body = await readBody(req);
            const cur = await loadState();
            const next = sanitize({
              order: body && body.order !== undefined ? body.order : cur.order,
              names: body && body.names !== undefined ? body.names : cur.names,
              pending: body && body.pending !== undefined ? body.pending : cur.pending,
              groups: body && body.groups !== undefined ? body.groups : cur.groups,
              costs: body && body.costs !== undefined ? body.costs : cur.costs,
              price: body && body.price !== undefined ? body.price : cur.price,
              collapsedGroups: body && body.collapsedGroups !== undefined ? body.collapsedGroups : cur.collapsedGroups,
            });
            await settings.put('state', next);
            sendJson(res, 200, next);
            return;
          }
          sendJson(res, 405, { ok: false, error: '仅支持 GET / POST' });
        } catch (e) {
          sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      },
    }),
  );
}
