/*
 * dsh-agent-panel —— DeepSeek Harness 子智能体常驻面板
 * 1) 右侧边栏新增常驻「智能体」标签页:大字树形展示全部子智能体
 *    - 点击行:在当前面板直接打开该子智能体对话(主对话窗口保持不变,
 *      智能体面板作为标签页保留,可随时切回)
 *    - 行尾按钮:在主对话窗口打开该子智能体
 *    - 拖拽行可改变顺序:拖到分组行中间=放入分组,拖到边缘=排在分组前/后
 *    - 「+ 分组」创建两级自定义分组;分组可改名(✎)、删除(✕,子项回到根层)
 *    - ✎ 改显示名(不改动真实会话数据);改名后名字追加「-重启有效」标记,
 *      重启应用后标记消失、只显示纯名字,以此验证持久化生效
 *    - 改名会同步到右侧栏子智能体对话标签页的标题 chip(实时)
 *    - 改名/排序/分组通过 /ui-tweaks 持久化到 storageDomain,重启不丢
 * 2) 费用参考:每行/分组合计/面板合计/主会话顶部栏,单价可自定义(默认 4 元/百万)
 * 3) 文件跳转:右侧栏第 1 个分栏里点击文件,直接在第 2 个分栏打开(最多 2 个分栏)
 * 4) 注入 CSS:加大 header 子智能体下拉树的点击区与字号;修复右侧栏小字与模糊
 *
 * 注意:GLOBAL_CSS 中的 rezYhW_* / p2k40q_* 是当前 DSH 版本(0.2.2-rc.3)编译产物的
 * CSS Modules 哈希类名。DSH 升级后若失效,重新生成方法:
 *   从 app.asar 解出 @deepseek-ai/dsh-client-ui-subagent/lib/client.js 与
 *   @deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js,
 *   用正则 /\.([A-Za-z0-9_-]+)_(row|metrics|label|secondaryLabel|disclosure|sidebarButton|clickarea)\{/
 *   与 entryDescription 的哈希替换下方类名前缀即可。
 */
window.__ModuleLoader__.load({
  id: 'dsh-agent-panel',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect } = React;

    const TAB_KIND = 'agenttree';
    const TAB_ID = 'dsh-agent-panel';

    const MODE_LABEL = {
      'one-shot': '一次性',
      continuable: '可继续',
      unknown: '未知',
      external: '外部',
    };

    // ---- 费用参考价 ------------------------------------------------------
    // 参考价 = 单价(元/百万 tokens) × 该会话累计 tokens。
    // 默认 4 为占位值;面板头部「总价」后面有输入框可随时自定义,持久化保存。
    const AVG_PRICE_PER_MILLION = 4;

    function currentPrice(state) {
      const p = state && typeof state.price === 'number' ? state.price : null;
      return p != null && p > 0 ? p : AVG_PRICE_PER_MILLION;
    }

    function costOfUsage(usage, price) {
      if (!usage) return null;
      const p = typeof price === 'number' && price > 0 ? price : AVG_PRICE_PER_MILLION;
      const total =
        (usage.uncachedInputTokens || 0) +
        (usage.cacheWriteTokens || 0) +
        (usage.cacheReadTokens || 0) +
        (usage.outputTokens || 0);
      return (total * p) / 1e6;
    }

    function formatCost(yuan) {
      if (yuan == null) return '';
      if (yuan > 0 && yuan < 0.01) return '\u00A5<0.01';
      if (yuan >= 1000) return '\u00A5' + yuan.toFixed(0);
      return '\u00A5' + yuan.toFixed(2);
    }

    // 与 dsh-client-ui-subagent 相同的侧栏对话资源地址格式
    function subagentChatAddress(address) {
      const query = new URLSearchParams({
        parent: address.parentSessionId,
        mode: address.mode,
      });
      return 'dsh-resource://subagentchat/session/' + encodeURIComponent(address.childSessionId) + '?' + query;
    }

    // 模块级偏好存储:面板与标签页标题芯片共享,改名即时同步到 chip
    let prefsStore = { order: {}, names: {}, pending: {}, groups: {}, costs: {}, price: null, collapsedGroups: [] };
    const prefsListeners = new Set();
    let prefsLoaded = false;

    function publishPrefs(next) {
      prefsStore = next;
      for (const listener of prefsListeners) listener();
    }

    function subscribePrefs(listener) {
      prefsListeners.add(listener);
      return () => {
        prefsListeners.delete(listener);
      };
    }

    // 分组定义桥接:寄存在 order 数组里的哨兵字符串,旧版主机也能保存
    // 格式:__gdef:<gid>|<name>|<childId csv>
    const GROUP_BRIDGE = '__gdef:';

    function encodeGroupBridge(gid, g) {
      return GROUP_BRIDGE + gid + '|' + g.name + '|' + (g.children || []).join(',');
    }

    function withBridges(state) {
      const order = {};
      for (const pid of Object.keys(state.order || {})) {
        const kept = (state.order[pid] || []).filter(
          (x) => typeof x !== 'string' || !x.startsWith(GROUP_BRIDGE),
        );
        const map = (state.groups && state.groups[pid]) || {};
        for (const gid of Object.keys(map)) {
          kept.push(encodeGroupBridge(gid, map[gid]));
        }
        order[pid] = kept;
      }
      return Object.assign({}, state, { order });
    }

    function ensurePrefsLoaded() {
      if (prefsLoaded) return;
      prefsLoaded = true;
      fetch('/ui-tweaks', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : {}))
        .then((data) => {
          // 桥接解码:旧版主机不支持 groups 字段,分组定义以 __gdef: 形式寄存在 order 里
          const rawOrder = (data && data.order) || {};
          const rawGroups = (data && data.groups) || {};
          const order = {};
          const groups = {};
          for (const pid of Object.keys(rawOrder)) {
            const kept = [];
            const decoded = {};
            for (const x of rawOrder[pid] || []) {
              if (typeof x === 'string' && x.startsWith(GROUP_BRIDGE)) {
                const parts = x.slice(GROUP_BRIDGE.length).split('|');
                const gid = parts[0];
                const name = parts[1];
                if (gid && name) {
                  decoded[gid] = { name, children: ((parts[2] || '').split(',').filter(Boolean)) };
                }
              } else {
                kept.push(x);
              }
            }
            order[pid] = kept;
            groups[pid] = Object.assign({}, decoded, rawGroups[pid] || {});
          }
          for (const pid of Object.keys(rawGroups)) {
            if (!groups[pid]) groups[pid] = rawGroups[pid];
          }
          publishPrefs({
            order,
            names: (data && data.names) || {},
            pending: (data && data.pending) || {},
            groups,
            costs: (data && data.costs) || {},
            price: typeof data.price === 'number' ? data.price : null,
            collapsedGroups: Array.isArray(data.collapsedGroups) ? data.collapsedGroups : [],
          });
          // 立即回写一次:让分组定义(桥接形式)进入服务器,重启前保住结构
          fetch('/ui-tweaks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(prefsStore),
          }).catch(() => {});
        })
        .catch(() => {});
    }

    // 从 subagentchat 标签内容地址中取出子会话 id
    function parseSubagentChatChild(contentId) {
      const m = /^dsh-resource:\/\/subagentchat\/session\/([^?]+)/.exec(contentId || '');
      if (!m) return null;
      try {
        return decodeURIComponent(m[1]);
      } catch (e) {
        return m[1];
      }
    }

    // ---- 文件跳转:第 1 个侧边栏分栏点击文件 → 直接在第 2 个分栏打开 ----
    function isFileAddress(address) {
      return typeof address === 'string' && address.indexOf('dsh-resource://file') === 0;
    }

    // 读取侧边栏当前 docked 分栏的 pane id(按 DOM 列顺序)
    function sidebarPaneIds() {
      const panel = document.querySelector('[data-sidebar-right-open], [data-sidebar-right-panel]');
      if (!panel) return [];
      const ids = [];
      for (const el of panel.querySelectorAll('[data-dockkit-pane]')) {
        const id = el.dataset && el.dataset.dockkitPane;
        if (id && ids.indexOf(id) === -1) ids.push(id);
      }
      return ids;
    }

    function installFilePaneRedirect(scope) {
      const svc = scope.sidebarRight;
      if (!svc || svc.__agentPanelFileRedirect) return () => {};
      const original = svc.openResourceIn;
      if (typeof original !== 'function') return () => {};
      svc.__agentPanelFileRedirect = true;
      svc.openResourceIn = function (sessionId, address, options) {
        options = options || {};
        if (
          isFileAddress(address) &&
          options.paneId !== undefined &&
          options.preferNewPane !== true &&
          options.replaceTab === undefined
        ) {
          const paneIds = sidebarPaneIds();
          if (paneIds.indexOf(options.paneId) === 0) {
            // 点击发生在第 1 个分栏:已有第 2 个分栏就跳过去;只有一个分栏则新分一个
            if (paneIds.length >= 2) {
              options = Object.assign({}, options, { paneId: paneIds[1] });
            } else {
              options = Object.assign({}, options, { paneId: undefined, preferNewPane: true });
            }
          }
        }
        return original.call(svc, sessionId, address, options);
      };
      return () => {
        if (svc.__agentPanelFileRedirect) {
          svc.__agentPanelFileRedirect = false;
          svc.openResourceIn = original;
        }
      };
    }

    const GLOBAL_CSS = [
      // 子智能体下拉面板加宽(稳定变量覆盖,不依赖哈希)
      '[data-subagent-panel]{--dsh-subagent-menu-width:min(420px,calc(100vw - 32px))}',
      // 下拉树:更大行高、字号与点击区
      '[data-subagent-panel] .rezYhW_row{min-height:44px;padding:6px 8px 6px 11px;gap:8px}',
      '[data-subagent-panel] .rezYhW_clickarea{gap:8px}',
      '[data-subagent-panel] .rezYhW_label{font-size:14px;line-height:20px}',
      '[data-subagent-panel] .rezYhW_secondaryLabel{color:var(--dsw-alias-label-secondary)}',
      '[data-subagent-panel] .rezYhW_metrics{font-size:11px}',
      '[data-subagent-panel] .rezYhW_disclosure::after{width:34px}',
      '[data-subagent-panel] .rezYhW_sidebarButton{width:32px;height:32px}',
      // 右侧栏:指南页灰色描述 11px→12px 并提高对比度
      '[data-sidebar-right-open] .p2k40q_entryDescription{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      // 右侧栏内的子智能体对话:字体平滑渲染,消除模糊
      '[data-sidebar-right-open] [data-sidebar-chat]{-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}',
    ].join('\n');

    const PANEL_CSS = [
      '.uit-tree{display:flex;flex-direction:column;height:100%;box-sizing:border-box;overflow:auto;padding:14px 12px;gap:2px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}',
      '.uit-header{display:flex;align-items:center;gap:8px;margin-bottom:8px;padding:0 2px}',
      '.uit-title{font-size:14px;font-weight:600;line-height:20px}',
      '.uit-count{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.uit-status{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.uit-addgroup{flex:none;font-size:12px;padding:4px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;color:var(--dsw-alias-brand-primary);cursor:pointer}',
      '.uit-addgroup:hover{border-color:var(--dsw-alias-brand-primary)}',
      '.uit-refresh{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:1;cursor:pointer}',
      '.uit-refresh:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary)}',
      '.uit-list{display:flex;flex-direction:column}',
      '.uit-row{display:flex;align-items:center;gap:8px;box-sizing:border-box;min-height:40px;padding:6px 8px;border-radius:8px;cursor:grab}',
      '.uit-row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.uit-row-external{cursor:default;opacity:.7}',
      '.uit-caret,.uit-caret-spacer{flex:none;width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center}',
      '.uit-caret{border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:1;cursor:pointer;padding:0;border-radius:4px;transition:transform .12s ease}',
      '.uit-caret:hover{color:var(--dsw-alias-label-primary)}',
      '.uit-caret-open{transform:rotate(90deg)}',
      '.uit-dot{flex:none;width:8px;height:8px;border-radius:50%}',
      '.uit-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}',
      '.uit-name{font-size:14px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.uit-sub{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.uit-badge{flex:none;font-size:11px;line-height:18px;padding:0 8px;border:1px solid var(--dsw-alias-brand-primary);border-radius:999px;color:var(--dsw-alias-brand-primary)}',
      '.uit-cost{flex:none;font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.uit-total{flex:none;font-size:12px;color:var(--dsw-alias-brand-primary);font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.uit-main-cost{font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap;padding:2px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px}',
      '.uit-pricebox{flex:none;display:inline-flex;align-items:center;gap:2px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:2px 6px}',
      '.uit-pricebox:focus-within{border-color:var(--dsw-alias-brand-primary)}',
      '.uit-priceinput{width:46px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;outline:none;font-variant-numeric:tabular-nums;text-align:right}',
      '.uit-priceunit{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.uit-btn{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1;cursor:pointer;opacity:0;transition:opacity .12s ease}',
      '.uit-row:hover .uit-btn{opacity:1}',
      '.uit-btn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary)}',
      '.uit-editform{display:flex;flex:1;min-width:0;gap:6px;align-items:center}',
      '.uit-editinput{flex:1;min-width:0;padding:4px 8px;border:1px solid var(--dsw-alias-brand-primary);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;outline:none}',
      '.uit-editok,.uit-editcancel{flex:none;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;padding:4px 8px;cursor:pointer}',
      '.uit-editok{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
      '.uit-createform{padding:4px 2px 8px}',
      // 分组
      '.uit-group-row{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);min-height:38px}',
      '.uit-group-name{font-size:13.5px;font-weight:600;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.uit-group-count{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.uit-group-children{margin-left:18px;border-left:1px solid var(--dsw-alias-border-l1);padding-left:2px;display:flex;flex-direction:column}',
      // 拖拽提示
      '.uit-hint-before{box-shadow:inset 0 2px 0 var(--dsw-alias-brand-primary)}',
      '.uit-hint-after{box-shadow:inset 0 -2px 0 var(--dsw-alias-brand-primary)}',
      '.uit-hint-into{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
      '.uit-children{border-left:1px solid var(--dsw-alias-border-l1);margin-left:12px}',
      '.uit-tabtitle{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.uit-empty{padding:28px 12px;text-align:center;font-size:13px;color:var(--dsw-alias-label-secondary)}',
      '.uit-error{padding:10px;font-size:12px;color:var(--dsw-alias-state-error-primary)}',
    ].join('\n');

    function AgentTreeTab(props) {
      const sessionId = props.sessionId;
      const useSessions = props.useSessions;
      const useTabInfo = props.useTabInfo;
      const openChild = props.openChild;
      const openChildAside = props.openChildAside;
      const refreshCatalog = props.refreshCatalog;

      useTabInfo();
      const projections = useSessions((state) => state.projectionsBySession);
      const summaries = useSessions((state) => state.byId);
      const [expanded, setExpanded] = useState(() => new Set());
      const [prefs, setPrefsLocal] = useState(() => prefsStore);
      const [saveStatus, setSaveStatus] = useState('');
      const [editingId, setEditingId] = useState(null);
      const [editValue, setEditValue] = useState('');
      const [editingGroupId, setEditingGroupId] = useState(null);
      const [groupEditValue, setGroupEditValue] = useState('');
      const [creatingGroup, setCreatingGroup] = useState(false);
      const [newGroupName, setNewGroupName] = useState('');
      const [dragSource, setDragSource] = useState(null);
      const [dropHint, setDropHint] = useState(null);
      const [priceInput, setPriceInput] = useState('');

      useEffect(() => {
        if (sessionId) refreshCatalog(sessionId);
      }, [sessionId]);

      // 订阅全局偏好(与标签页标题芯片共享,改名即时同步到 chip)
      useEffect(() => {
        ensurePrefsLoaded();
        return subscribePrefs(() => setPrefsLocal(prefsStore));
      }, []);

      function persist(next) {
        // 部分更新合并到完整状态,避免丢 costs 等字段;分组定义同步写成桥接哨兵
        const merged = withBridges(Object.assign({}, prefs, next));
        publishPrefs(merged);
        setSaveStatus('保存中…');
        fetch('/ui-tweaks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(merged),
        })
          .then((r) => {
            if (r.ok) {
              setSaveStatus('已保存');
              return;
            }
            setSaveStatus('保存失败:接口不可用');
          })
          .catch(() => {
            setSaveStatus('保存失败:无法连接');
          });
      }

      const root = projections[sessionId];
      const state = root ? root.state : 'idle';
      const entries =
        root && root.values && Array.isArray(root.values.subagentCatalog)
          ? root.values.subagentCatalog
          : [];

      const runningCount = entries.filter(
        (e) => summaries[e.id] && summaries[e.id].running === true,
      ).length;

      // 费用参考价:单价(元/百万 tokens) × tokens
      function shownCostOf(summary) {
        if (!summary || !summary.projectionValues) return null;
        return costOfUsage(summary.projectionValues.tokenUsage, currentPrice(prefs));
      }

      function commitPrice() {
        const v = parseFloat(priceInput);
        if (!Number.isFinite(v) || v <= 0) {
          setPriceInput('');
          return;
        }
        const rounded = Math.round(v * 1000) / 1000;
        persist({ price: rounded });
        setPriceInput('');
      }

      const entriesById = new Map(entries.map((e) => [e.id, e]));
      const groupMap = prefs.groups[sessionId] || {};
      const sectionIds = prefs.order[sessionId] || [];
      // 分组折叠状态:来自持久化偏好(跨重启保留)
      const collapsedGroups = new Set(Array.isArray(prefs.collapsedGroups) ? prefs.collapsedGroups : []);

      // ---- 展示模型:section = 分组节 | 根层智能体节 ------------------------
      function buildSections() {
        const known = new Set(entries.map((e) => e.id));
        const used = new Set();
        const list = [];
        for (const id of sectionIds) {
          if (typeof id === 'string' && id.startsWith(GROUP_BRIDGE)) continue;
          const g = groupMap[id];
          if (g) {
            const children = (g.children || []).filter((c) => known.has(c));
            for (const c of children) used.add(c);
            list.push({ kind: 'group', id, name: g.name, children });
          } else if (known.has(id)) {
            used.add(id);
            list.push({ kind: 'agent', id });
          } else if (/^g[a-z0-9]{4,}$/i.test(id)) {
            // 历史遗留的无定义分组 id:保留占位分组,避免结构凭空消失
            list.push({ kind: 'group', id, name: '未命名分组', children: [] });
          }
        }
        for (const e of entries) {
          if (!used.has(e.id)) list.push({ kind: 'agent', id: e.id });
        }
        return list;
      }

      // ---- 状态变更辅助 ------------------------------------------------
      function persistAll(partial) {
        persist(Object.assign({}, prefs, partial));
      }

      // 把智能体从所有分组与根层序列里摘出来
      function stripAgent(agentId) {
        const nextGroups = {};
        for (const [pk, map] of Object.entries(prefs.groups)) {
          let changed = false;
          const clean = {};
          for (const [gid, g] of Object.entries(map)) {
            const children = (g.children || []).filter((c) => c !== agentId);
            if (children.length !== (g.children || []).length) changed = true;
            clean[gid] = { name: g.name, children };
          }
          nextGroups[pk] = changed ? clean : map;
        }
        const nextOrder = {};
        for (const [pk, list] of Object.entries(prefs.order)) {
          nextOrder[pk] = (list || []).filter((x) => x !== agentId);
        }
        return { groups: nextGroups, order: nextOrder };
      }

      function dropAgentIntoGroup(agentId, groupId) {
        const { groups: g0, order: o0 } = stripAgent(agentId);
        const map = g0[sessionId] || {};
        const cur = map[groupId];
        if (!cur) return;
        const children = (cur.children || []).slice();
        children.push(agentId);
        const nextGroups = Object.assign({}, g0, {
          [sessionId]: Object.assign({}, map, { [groupId]: { name: cur.name, children } }),
        });
        persist({ order: o0, names: prefs.names, pending: prefs.pending, groups: nextGroups });
      }

      function setRootSequence(nextIds) {
        persistAll({ order: Object.assign({}, prefs.order, { [sessionId]: nextIds }) });
      }

      // 按当前展示序列重建根层顺序,天然兼容「新出现、尚未登记」的智能体
      function moveGroupSection(groupId, sectionId, pos) {
        const next = [];
        for (const s of built) {
          if (s.id === groupId) continue;
          if (s.id === sectionId && pos === 'before') next.push(groupId);
          next.push(s.id);
          if (s.id === sectionId && pos === 'after') next.push(groupId);
        }
        if (!next.includes(groupId)) next.push(groupId);
        setRootSequence(next);
      }

      function insertAgentAtSection(agentId, sectionId, pos) {
        const { groups: g0 } = stripAgent(agentId);
        const next = [];
        for (const s of built) {
          if (s.id === agentId) continue;
          if (s.id === sectionId && pos === 'before') next.push(agentId);
          next.push(s.id);
          if (s.id === sectionId && pos === 'after') next.push(agentId);
        }
        if (!next.includes(agentId)) next.push(agentId);
        persist({
          order: Object.assign({}, prefs.order, { [sessionId]: next }),
          names: prefs.names,
          pending: prefs.pending,
          groups: g0,
        });
      }

      function moveAgentWithinGroup(agentId, targetAgentId, pos) {
        let targetGroupId = null;
        for (const [gid, g] of Object.entries(groupMap)) {
          if ((g.children || []).includes(targetAgentId)) {
            targetGroupId = gid;
            break;
          }
        }
        if (targetGroupId === null) {
          insertAgentAtSection(agentId, targetAgentId, pos);
          return;
        }
        const { groups: g0, order: o0 } = stripAgent(agentId);
        const map = g0[sessionId] || {};
        const cur = map[targetGroupId];
        if (!cur) return;
        const children = (cur.children || []).slice();
        let at = children.indexOf(targetAgentId);
        if (at === -1) at = children.length;
        else at += pos === 'after' ? 1 : 0;
        children.splice(at, 0, agentId);
        const nextGroups = Object.assign({}, g0, {
          [sessionId]: Object.assign({}, map, { [targetGroupId]: { name: cur.name, children } }),
        });
        persist({ order: o0, names: prefs.names, pending: prefs.pending, groups: nextGroups });
      }

      function applyDrop(target, pos) {
        if (!dragSource || !target || !pos) return;
        const src = dragSource;
        // 拖到自身 = 无操作,避免目标被摘除后落入「追加到末尾」的兜底分支
        if (src.type === target.kind && src.id === target.id) return;
        // 分组拖到自己成员行上 = 无操作(避免分组自身被摘除后落到末尾)
        if (src.type === 'group' && target.kind === 'agent' && target.groupId === src.id) return;
        if (src.type === 'group') {
          if (target.kind === 'group') {
            moveGroupSection(src.id, target.id, pos === 'into' ? 'after' : pos);
          } else if (target.kind === 'agent') {
            const anchor = target.groupId ? target.groupId : target.id;
            moveGroupSection(src.id, anchor, pos);
          }
        } else if (src.type === 'agent') {
          if (target.kind === 'group') {
            if (pos === 'into') dropAgentIntoGroup(src.id, target.id);
            else insertAgentAtSection(src.id, target.id, pos);
          } else if (target.kind === 'agent') {
            moveAgentWithinGroup(src.id, target.id, pos);
          }
        }
      }

      // ---- 分组操作 ----------------------------------------------------
      function createGroup() {
        const name = newGroupName.trim();
        if (!name) {
          setCreatingGroup(false);
          return;
        }
        const gid = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const map = Object.assign({}, groupMap, { [gid]: { name, children: [] } });
        const list = sectionIds.slice();
        list.push(gid);
        persist({
          order: Object.assign({}, prefs.order, { [sessionId]: list }),
          names: prefs.names,
          pending: prefs.pending,
          groups: Object.assign({}, prefs.groups, { [sessionId]: map }),
        });
        setCreatingGroup(false);
        setNewGroupName('');
      }

      function saveGroupRename(groupId) {
        const name = groupEditValue.trim();
        const map = Object.assign({}, groupMap);
        if (name && map[groupId]) {
          map[groupId] = { name, children: map[groupId].children };
        }
        persist({
          order: prefs.order,
          names: prefs.names,
          pending: prefs.pending,
          groups: Object.assign({}, prefs.groups, { [sessionId]: map }),
        });
        setEditingGroupId(null);
      }

      function deleteGroup(groupId) {
        const map = Object.assign({}, groupMap);
        const g = map[groupId];
        delete map[groupId];
        const list = sectionIds.filter((x) => x !== groupId);
        for (const c of (g && g.children) || []) {
          if (!list.includes(c)) list.push(c);
        }
        persist({
          order: Object.assign({}, prefs.order, { [sessionId]: list }),
          names: prefs.names,
          pending: prefs.pending,
          groups: Object.assign({}, prefs.groups, { [sessionId]: map }),
        });
      }

      function toggleGroupCollapse(groupId) {
        const list = Array.isArray(prefs.collapsedGroups) ? prefs.collapsedGroups.slice() : [];
        const idx = list.indexOf(groupId);
        if (idx !== -1) list.splice(idx, 1);
        else list.push(groupId);
        // 折叠状态持久化:跨面板开关、跨重启保留
        persist({ collapsedGroups: list });
      }

      // ---- 智能体改名 --------------------------------------------------
      function saveRename(entry) {
        const t = editValue.trim();
        const names = Object.assign({}, prefs.names);
        const pending = Object.assign({}, prefs.pending);
        if (t) {
          names[entry.id] = t;
          pending[entry.id] = true;
        } else {
          delete names[entry.id];
          delete pending[entry.id];
        }
        persist({ order: prefs.order, names, pending, groups: prefs.groups });
        setEditingId(null);
      }

      function displayName(entry) {
        const alias = prefs.names[entry.id];
        const base =
          alias ||
          entry.label ||
          (summaries[entry.id] && summaries[entry.id].title) ||
          entry.name ||
          entry.id;
        if (alias && prefs.pending[entry.id]) return base + '-重启有效';
        return base;
      }

      // ---- 子智能体子树(子智能体的子智能体)展开 -------------------------
      function toggleBranch(entry) {
        const childEntries =
          projections[entry.id] && projections[entry.id].values &&
          Array.isArray(projections[entry.id].values.subagentCatalog)
            ? projections[entry.id].values.subagentCatalog
            : [];
        if (childEntries.length === 0) return;
        setExpanded((prev) => {
          const next = new Set(prev);
          if (next.has(entry.id)) next.delete(entry.id);
          else {
            next.add(entry.id);
            refreshCatalog(entry.id);
          }
          return next;
        });
      }

      // ---- 拖拽事件 ----------------------------------------------------
      function rowDragStart(e, src) {
        try {
          e.dataTransfer.setData('text/plain', src.type + ':' + src.id);
          e.dataTransfer.effectAllowed = 'move';
        } catch (err) {
          /* 仅用于部分浏览器兼容 */
        }
        setDragSource(src);
      }

      function rowDragOver(e, target, kind) {
        e.preventDefault();
        e.stopPropagation();
        if (!dragSource) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const ratio = (e.clientY - rect.top) / Math.max(1, rect.height);
        let pos;
        if (kind === 'group' && dragSource.type === 'agent') {
          pos = ratio < 0.25 ? 'before' : ratio > 0.75 ? 'after' : 'into';
        } else {
          pos = ratio < 0.5 ? 'before' : 'after';
        }
        setDropHint(Object.assign({}, target, { pos }));
      }

      function rowDrop(e, target) {
        e.preventDefault();
        e.stopPropagation();
        if (!dropHint || dropHint.kind !== target.kind || dropHint.id !== target.id) return;
        applyDrop(target, dropHint.pos);
        setDragSource(null);
        setDropHint(null);
      }

      function rowDragEnd() {
        setDragSource(null);
        setDropHint(null);
      }

      function hintClass(target) {
        if (!dropHint || dropHint.kind !== target.kind || dropHint.id !== target.id) return '';
        if (dropHint.pos === 'before') return ' uit-hint-before';
        if (dropHint.pos === 'after') return ' uit-hint-after';
        return ' uit-hint-into';
      }

      // ---- 行渲染 ------------------------------------------------------
      function renderAgentRow(entry, level, parentId, groupId) {
        const summary = summaries[entry.id];
        const running = summary && summary.running === true;
        const timing = summary && summary.projectionValues && summary.projectionValues.subagentTiming;
        const completed = timing && timing.lastTurnCompleted === true;
        const external = entry.mode === 'external';
        const childEntries =
          projections[entry.id] && projections[entry.id].values &&
          Array.isArray(projections[entry.id].values.subagentCatalog)
            ? projections[entry.id].values.subagentCatalog
            : [];
        const hasChildren = !external && childEntries.length > 0;
        const isExpanded = hasChildren && expanded.has(entry.id);
        const title = displayName(entry);
        const sub = external
          ? '外部执行'
          : entry.name && entry.name !== title
            ? entry.name
            : MODE_LABEL[entry.mode] || '';
        const editing = editingId === entry.id;
        const target = { kind: 'agent', id: entry.id, groupId: groupId || null };
        const yuan = shownCostOf(summary);

        return h(
          'div',
          { key: entry.id, className: 'uit-node' },
          h(
            'div',
            {
              className: 'uit-row' + (external ? ' uit-row-external' : '') + hintClass(target),
              style: { paddingLeft: 8 + level * 18 },
              title: external ? undefined : '点击在当前面板打开;拖拽可排序或放入分组',
              draggable: !editing,
              onDragStart: (e) => {
                if (!editing) rowDragStart(e, { type: 'agent', id: entry.id });
              },
              onDragOver: (e) => {
                if (dragSource) rowDragOver(e, target, 'agent');
              },
              onDrop: (e) => rowDrop(e, target),
              onDragEnd: rowDragEnd,
              onClick: () => {
                if (!external && !editing) openChildAside(entry);
              },
            },
            hasChildren
              ? h(
                  'button',
                  {
                    className: 'uit-caret' + (isExpanded ? ' uit-caret-open' : ''),
                    title: isExpanded ? '折叠' : '展开',
                    onClick: (e) => {
                      e.stopPropagation();
                      toggleBranch(entry);
                    },
                  },
                  '\u25B6',
                )
              : h('span', { className: 'uit-caret-spacer' }, '\u22EE'),
            h('span', {
              className: 'uit-dot',
              style: {
                background: running
                  ? 'var(--dsw-alias-brand-primary)'
                  : completed
                    ? 'var(--dsw-alias-state-success-primary)'
                    : 'var(--dsw-alias-state-idle-primary)',
              },
            }),
            editing
              ? h(
                  'form',
                  {
                    className: 'uit-editform',
                    draggable: false,
                    onClick: (e) => e.stopPropagation(),
                    onSubmit: (e) => {
                      e.preventDefault();
                      saveRename(entry);
                    },
                  },
                  h('input', {
                    className: 'uit-editinput',
                    type: 'text',
                    value: editValue,
                    placeholder: '显示名(留空恢复原名)',
                    autoFocus: true,
                    draggable: false,
                    onChange: (e) => setEditValue(e.target.value),
                    onKeyDown: (e) => {
                      if (e.key === 'Escape') setEditingId(null);
                      e.stopPropagation();
                    },
                  }),
                  h('button', { type: 'submit', className: 'uit-editok' }, '保存'),
                  h('button', { type: 'button', className: 'uit-editcancel', onClick: () => setEditingId(null) }, '取消'),
                )
              : h(
                  'div',
                  { className: 'uit-text' },
                  h('span', { className: 'uit-name' }, title),
                  sub ? h('span', { className: 'uit-sub' }, sub) : null,
                ),
            running ? h('span', { className: 'uit-badge' }, '运行中') : null,
            yuan != null
              ? h(
                  'span',
                  {
                    className: 'uit-cost',
                    title: '参考价:单价 \u00D7 tokens',
                  },
                  formatCost(yuan),
                )
              : null,
            h('button', {
              className: 'uit-btn',
              title: '改显示名(改名后带「-重启有效」标记,重启后只显示新名)',
              onClick: (e) => {
                e.stopPropagation();
                setEditingId(entry.id);
                setEditValue(prefs.names[entry.id] || '');
              },
            }, '\u270E'),
            external
              ? null
              : h('button', {
                  className: 'uit-btn',
                  title: '在主对话窗口打开',
                  onClick: (e) => {
                    e.stopPropagation();
                    openChild(entry);
                  },
                }, '\u2913'),
          ),
          isExpanded
            ? h(
                'div',
                { className: 'uit-children' },
                childEntries.map((e) => renderAgentRow(e, level + 1, entry.id, null)),
              )
            : null,
        );
      }

      function renderGroupSection(section) {
        const collapsed = collapsedGroups.has(section.id);
        const editing = editingGroupId === section.id;
        const target = { kind: 'group', id: section.id, groupId: null };
        let groupYuan = 0;
        let groupHasCost = false;
        for (const cid of section.children) {
          const cs = summaries[cid];
          const c = shownCostOf(cs);
          if (c != null) {
            groupYuan += c;
            groupHasCost = true;
          }
        }
        return h(
          'div',
          { key: section.id, className: 'uit-node' },
          h(
            'div',
            {
              className: 'uit-row uit-group-row' + hintClass(target),
              title: '拖拽排序;拖到分组中间放入,边缘排在前后;点击折叠/展开',
              draggable: !editing,
              onDragStart: (e) => {
                if (!editing) rowDragStart(e, { type: 'group', id: section.id });
              },
              onDragOver: (e) => {
                if (dragSource) rowDragOver(e, target, 'group');
              },
              onDrop: (e) => rowDrop(e, target),
              onDragEnd: rowDragEnd,
              onClick: () => {
                if (!editing) toggleGroupCollapse(section.id);
              },
            },
            h('button', {
              className: 'uit-caret' + (collapsed ? '' : ' uit-caret-open'),
              title: collapsed ? '展开分组' : '折叠分组',
              onClick: (e) => {
                e.stopPropagation();
                toggleGroupCollapse(section.id);
              },
            }, '\u25B6'),
            editing
              ? h(
                  'form',
                  {
                    className: 'uit-editform',
                    draggable: false,
                    onClick: (e) => e.stopPropagation(),
                    onSubmit: (e) => {
                      e.preventDefault();
                      saveGroupRename(section.id);
                    },
                  },
                  h('input', {
                    className: 'uit-editinput',
                    type: 'text',
                    value: groupEditValue,
                    placeholder: '分组名称',
                    autoFocus: true,
                    draggable: false,
                    onChange: (e) => setGroupEditValue(e.target.value),
                    onKeyDown: (e) => {
                      if (e.key === 'Escape') setEditingGroupId(null);
                      e.stopPropagation();
                    },
                  }),
                  h('button', { type: 'submit', className: 'uit-editok' }, '保存'),
                  h('button', { type: 'button', className: 'uit-editcancel', onClick: () => setEditingGroupId(null) }, '取消'),
                )
              : h('span', { className: 'uit-group-name' }, section.name),
            h('span', { className: 'uit-group-count' }, section.children.length + ' 个'),
            groupHasCost
              ? h('span', { className: 'uit-cost', title: '分组参考费用(均价 \u00D7 tokens)' }, formatCost(groupYuan))
              : null,
            h('button', {
              className: 'uit-btn',
              title: '分组改名',
              onClick: (e) => {
                e.stopPropagation();
                setEditingGroupId(section.id);
                setGroupEditValue(section.name || '');
              },
            }, '\u270E'),
            h('button', {
              className: 'uit-btn',
              title: '删除分组(子项回到根层,不删除智能体)',
              onClick: (e) => {
                e.stopPropagation();
                deleteGroup(section.id);
              },
            }, '\u00D7'),
          ),
          collapsed
            ? null
            : h(
                'div',
                { className: 'uit-group-children' },
                section.children
                  .map((cid) => entriesById.get(cid))
                  .filter(Boolean)
                  .map((entry) => renderAgentRow(entry, 0, sessionId, section.id)),
              ),
        );
      }

      const built = buildSections();

      let totalYuan = 0;
      let hasAnyCost = false;
      for (const e of entries) {
        const s = summaries[e.id];
        const c = shownCostOf(s);
        if (c != null) {
          totalYuan += c;
          hasAnyCost = true;
        }
      }

      return h(
        'div',
        { className: 'uit-tree' },
        h('style', null, PANEL_CSS),
        h(
          'div',
          { className: 'uit-header' },
          h('span', { className: 'uit-title' }, '子智能体'),
          h(
            'span',
            { className: 'uit-count' },
            entries.length + ' 个' + (runningCount > 0 ? ' \u00B7 ' + runningCount + ' 运行中' : ''),
          ),
          hasAnyCost
            ? h('span', { className: 'uit-total', title: '全部子智能体参考费用合计(单价 \u00D7 tokens)' }, '合计 ' + formatCost(totalYuan))
            : null,
          h(
            'div',
            { className: 'uit-pricebox', title: '自定义参考单价(元/百万 tokens),回车或失焦保存' },
            h('input', {
              className: 'uit-priceinput',
              type: 'number',
              min: '0.001',
              step: '0.1',
              value: priceInput !== '' ? priceInput : String(currentPrice(prefs)),
              placeholder: String(currentPrice(prefs)),
              onChange: (e) => setPriceInput(e.target.value),
              onBlur: () => commitPrice(),
              onKeyDown: (e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitPrice();
                }
                if (e.key === 'Escape') setPriceInput('');
              },
            }),
            h('span', { className: 'uit-priceunit' }, '元/百万'),
          ),
          h('span', { className: 'uit-status' }, saveStatus),
          h(
            'button',
            {
              className: 'uit-addgroup',
              title: '新建分组(可拖智能体进入)',
              onClick: () => {
                setCreatingGroup(true);
                setNewGroupName('');
              },
            },
            '+ 分组',
          ),
          h(
            'button',
            {
              className: 'uit-refresh',
              title: '刷新',
              onClick: () => {
                if (sessionId) refreshCatalog(sessionId);
              },
            },
            '\u27F3',
          ),
        ),
        creatingGroup
          ? h(
              'form',
              {
                className: 'uit-editform uit-createform',
                onClick: (e) => e.stopPropagation(),
                onSubmit: (e) => {
                  e.preventDefault();
                  createGroup();
                },
              },
              h('input', {
                className: 'uit-editinput',
                type: 'text',
                value: newGroupName,
                placeholder: '分组名称,例如:前端任务',
                autoFocus: true,
                onChange: (e) => setNewGroupName(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === 'Escape') setCreatingGroup(false);
                },
              }),
              h('button', { type: 'submit', className: 'uit-editok' }, '创建'),
              h('button', { type: 'button', className: 'uit-editcancel', onClick: () => setCreatingGroup(false) }, '取消'),
            )
          : null,
        state === 'error'
          ? h('div', { className: 'uit-error' }, '加载失败,点击上方刷新重试')
          : entries.length === 0
            ? h('div', { className: 'uit-empty' }, '当前会话没有子智能体')
            : h(
                'div',
                { className: 'uit-list' },
                built.map((section) =>
                  section.kind === 'group'
                    ? renderGroupSection(section)
                    : renderAgentRow(entriesById.get(section.id), 0, sessionId, null),
                ),
              ),
      );
    }

    // 子智能体侧栏对话标签页的标题芯片:优先显示自定义名,否则回退官方默认标题
    function SubagentTabTitle(props) {
      const useTabInfo = props.useTabInfo;
      const useSessions = props.useSessions;
      const [prefs, setPrefsLocal] = useState(() => prefsStore);
      useEffect(() => {
        ensurePrefsLoaded();
        return subscribePrefs(() => setPrefsLocal(prefsStore));
      }, []);
      const { tab } = useTabInfo();
      const summaries = useSessions((s) => s.byId);
      const childId = parseSubagentChatChild(tab.contentId);
      const alias = childId ? prefs.names[childId] : undefined;
      let label = '智能体';
      if (childId) {
        if (alias) {
          label = prefs.pending[childId] ? alias + '-重启有效' : alias;
        } else {
          const summary = summaries[childId];
          label =
            (summary && summary.projectionValues && summary.projectionValues.subagent && summary.projectionValues.subagent.label) ||
            (summary && summary.title) ||
            childId;
        }
      }
      return h('span', { className: 'uit-tabtitle' }, label);
    }

    // 主会话顶部栏右侧:主 Agent 自身费用(注册到 conversation.session.header.utilities,
    // 即「标准模式/创造模式」所在的会话头部栏右端)
    function MainSessionCost(props) {
      const sessionId = props.sessionId;
      const useSessions = props.useSessions;
      const summaries = useSessions((s) => s.byId);
      const [prefs, setPrefsLocal] = useState(() => prefsStore);
      useEffect(() => {
        ensurePrefsLoaded();
        return subscribePrefs(() => setPrefsLocal(prefsStore));
      }, []);
      const summary = summaries[sessionId];
      if (!summary || !summary.projectionValues) return null;
      const yuan = costOfUsage(summary.projectionValues.tokenUsage, currentPrice(prefs));
      if (yuan == null) return null;
      return h(
        'span',
        {
          className: 'uit-main-cost',
          title: '主 Agent 参考费用:单价 \u00D7 tokens(单价可在智能体面板修改)',
        },
        formatCost(yuan),
      );
    }

    return {
      inject: ['slots', 'sessions', 'uiWorkspace'],
      apply(ctx) {
        // 主会话头部栏右侧:主 Agent 费用
        ctx.effect(() => ctx.slots.inject(
          'conversation.session.header.utilities',
          () => ctx.slots.register(
            { name: 'conversation.session.header.utilities', id: 'ui-tweaks-cost', order: 100, label: '费用' },
            MainSessionCost,
          ),
        ), 'ui-tweaks: main session cost');
        // 全局 CSS:加大子智能体下拉树点击区 + 右侧栏文字清晰度
        ctx.effect(() => {
          const el = document.createElement('style');
          el.setAttribute('data-ui-tweaks', '');
          el.textContent = GLOBAL_CSS;
          document.head.appendChild(el);
          return () => {
            el.remove();
          };
        }, 'ui-tweaks: global css');

        // 右侧栏「智能体」标签页:类型注册 + 面板主体 + 指南页入口
        ctx.inject(['sidebarRightTabs', 'sidebarRight'], (scope) => {
          // 文件跳转:第 1 个分栏点文件 → 第 2 个分栏打开(侧边栏最多 2 个分栏,官方已限)
          scope.effect(() => installFilePaneRedirect(scope), 'ui-tweaks: file pane redirect');

          scope.effect(() => scope.sidebarRightTabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            priority: 'extension',
            title: () => '智能体',
            guide: [
              {
                id: 'agents',
                order: 10,
                title: () => '智能体树',
                description: () => '常驻查看全部子智能体,支持拖拽排序、改名与分组',
              },
            ],
          }), 'ui-tweaks: tab type');

          scope.effect(() => scope.slots.inject(
            'sidebar.right.pane.tab',
            () => scope.slots.register(
              { name: 'sidebar.right.pane.tab', key: TAB_ID },
              (props) => h(AgentTreeTab, Object.assign({}, props, {
                openChild: (entry) => {
                  if (!props.sessionId) return;
                  scope.uiWorkspace.openSession({
                    parentSessionId: props.sessionId,
                    childSessionId: entry.id,
                    mode: entry.mode,
                  });
                },
                openChildAside: (entry) => {
                  if (!props.sessionId) return;
                  scope.sidebarRight.openResource(subagentChatAddress({
                    parentSessionId: props.sessionId,
                    childSessionId: entry.id,
                    mode: entry.mode,
                  }), {
                    kind: 'subagentchat',
                  });
                },
                refreshCatalog: (id) => {
                  void scope.sessions.refreshProjections(id);
                },
              })),
            ),
          ), 'ui-tweaks: tab body');

          // 子智能体对话标签页的标题芯片:用自定义名(含「-重启有效」标记)同步替换默认标题
          scope.effect(() => scope.slots.inject(
            'sidebar.right.pane.tab.title',
            () => scope.slots.register(
              { name: 'sidebar.right.pane.tab.title', key: '@deepseek-ai/dsh-client-ui-subagent' },
              SubagentTabTitle,
            ),
          ), 'ui-tweaks: subagent tab title');
        });
      },
    };
  },
});
