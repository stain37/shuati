/* ============================================================
   刷题站 · 题库目录（大目录 / 子目录）cat.js
   ————————————————————————————————————————————————
   解决的问题：原来首页只有一个平铺的题库列表，题一多就没法看；
   而且自建题库只存在浏览器里（localStorage），换地址、清缓存就没了。

   这里做的事：
     1) 分类树：分类可以无限层级嵌套（大目录 → 子目录 → …），
        分类可以新建 / 改名 / 移动 / 删除，题库可以放进分类、在分类间移动；
     2) 目录导航：首页变成「文件夹 + 题库」的目录视图，带面包屑、
        搜索框（只搜当前目录）、返回上一级；
     3) 题库文件：把「自建题库 + 分类」存成本机文件（见 bf.js），
        下次打开一键读回来，不再受浏览器存储限制。

   存储：
     qbank.cats.v1   分类树 [{ id, title, parent, order }]（parent 为 null 即顶层）
     题库对象上的 b.cat 字段 = 所属分类 id（null / 不存在 = 根目录）
   兼容：没有 CAT 数据时不会自动改任何东西；导入 / 导出会带上分类。
   ============================================================ */
(function () {
  'use strict';

  /* ---------- 常量与状态 ---------- */
  var CAT_KEY = 'qbank.cats.v1';
  var CUR_KEY = 'qbank.curcat.v1';       // 上次停留的目录，刷新后回到原处
  var CONFIRM_KEY = 'qbank.catconfirm.v1'; // 「移动题库会改哪些东西」是否已提示过

  var CAT = null;                        // [{ id, title, parent, order }]
  var CUR = null;                        // 当前目录 id（null = 根）
  var CUR_SET = false;                   // 本次打开页面是否已确定过目录（避免被存档顶回去）
  var QUERY = '';                        // 当前目录内的搜索词
  var DRAG = null;                       // { type:'cat'|'bank', id, ids:[] }
  var LOCK = false;                      // 正在写数据，避免重复触发
  var BATCH = null;                      // 批量管理：null = 关闭；开启时 { sel: { 题库id: 1 } }

  /* ---------- 小工具（都在 app.js 里，但这里做一次安全取值） ---------- */
  function T(msg, ms) {
    if (typeof toast === 'function') { try { toast(msg, ms); return; } catch (e) {} }
    if (window.console) console.log('[刷题站]', msg);
  }
  function E(s) {
    if (typeof esc === 'function') return esc(s);
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function TITLE(c) { return (c && c.title) ? String(c.title) : '未命名分类'; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function uid(prefix) {
    var s = Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
    var id = (prefix || 'cat') + '-' + s;
    var n = 0;
    while (CAT && CAT.some(function (c) { return c.id === id; })) { id = (prefix || 'cat') + '-' + s + '-' + (++n); }
    return id;
  }
  function bankList() { return (typeof baseBanks === 'function') ? baseBanks() : []; }
  function bankOf(id) { return (typeof bankById === 'function') ? bankById(id) : null; }
  function catsAll() { ensure(); return CAT; }
  function notifyFile() { try { if (window.BF && BF.autoSync) BF.autoSync(); } catch (e) {} }

  /* ---------- 读取 / 整理 / 保存 ---------- */
  function readRaw() {
    var v = null;
    try { v = JSON.parse(localStorage.getItem(CAT_KEY)); } catch (e) { v = null; }
    if (!Array.isArray(v)) return [];
    return v.filter(function (c) { return c && typeof c === 'object'; }).map(function (c, i) {
      return {
        id: String(c.id || ('cat-' + (i + 1))),
        title: String(c.title == null ? '未命名分类' : c.title),
        parent: (c.parent == null || c.parent === '' || c.parent === 'root') ? null : String(c.parent),
        order: (c.order == null ? i : +c.order || 0)
      };
    });
  }

  /* 整理：去重 id、父节点必须存在、断开环形引用（父指向自己的后代） */
  function normalize() {
    var seen = {}, i, c, changed = false;
    for (i = 0; i < CAT.length; i++) {
      c = CAT[i];
      if (seen[c.id]) { c.id = uid(); changed = true; }
      seen[c.id] = 1;
    }
    var byId = {};
    CAT.forEach(function (x) { byId[x.id] = x; });
    CAT.forEach(function (x) {
      if (x.parent && !byId[x.parent]) { x.parent = null; changed = true; }
      if (x.parent === x.id) { x.parent = null; changed = true; }
    });
    /* 从每个节点往上走，走超过 CAT.length 步说明成环，断在最上面那个节点 */
    CAT.forEach(function (x) {
      var p = x.parent, steps = 0;
      while (p && steps++ <= CAT.length) {
        if (p === x.id) { x.parent = null; changed = true; break; }
        p = byId[p] ? byId[p].parent : null;
      }
    });
    /* 没有父节点的兄弟顺序重排成 0,1,2…（留着大间隔也不影响） */
    return changed;
  }

  function compact() {
    var groups = {};
    CAT.forEach(function (c) { var k = c.parent || '__root__'; (groups[k] = groups[k] || []).push(c); });
    Object.keys(groups).forEach(function (k) {
      groups[k].sort(function (a, b) { return (a.order || 0) - (b.order || 0) || String(a.title).localeCompare(String(b.title), 'zh'); });
      groups[k].forEach(function (c, i) { c.order = i; });
    });
  }

  function ensure() {
    if (CAT) return CAT;
    CAT = readRaw();
    normalize();
    compact();
    return CAT;
  }

  function saveCats(opts) {
    opts = opts || {};
    if (LOCK && !opts.force) return;
    LOCK = true;
    try {
      normalize(); compact();
      try { localStorage.setItem(CAT_KEY, JSON.stringify(CAT)); } catch (e) { T('分类没存下（浏览器存储满了）'); }
      writeBanksIfNeeded();
      if (typeof invalidateBanks === 'function') { /* 分类不参与题库缓存，这里不用清 */ }
      notifyFile();
    } finally { LOCK = false; }
    if (!opts.quiet) repaint();
  }

  function writeBanksIfNeeded() {
    try { if (typeof LOCAL !== 'undefined' && typeof writeLS === 'function') writeLS('qbank.local.v2', LOCAL); } catch (e) {}
  }

  /* ---------- 树查询 ---------- */
  function byId(id) { ensure(); return CAT.find(function (c) { return c.id === id; }) || null; }
  function kids(pid) {
    ensure();
    var p = pid == null ? null : pid;
    return CAT.filter(function (c) { return (c.parent || null) === p; })
      .sort(function (a, b) { return (a.order || 0) - (b.order || 0) || String(a.title).localeCompare(String(b.title), 'zh'); });
  }
  function pathOf(id) {
    ensure();
    var out = [], seen = {}, cur = id, steps = 0;
    while (cur && steps++ < 200) {
      var c = byId(cur);
      if (!c || seen[c.id]) break;
      seen[c.id] = 1;
      out.unshift(c);
      cur = c.parent || null;
    }
    return out;
  }
  function descIds(id) {
    ensure();
    if (!id) return CAT.map(function (c) { return c.id; });
    var out = [], stack = [id];
    while (stack.length) {
      var cur = stack.pop();
      kids(cur).forEach(function (k) { out.push(k.id); stack.push(k.id); });
    }
    return out;
  }
  /* bank 是否在目录 id 下（id 为 null = 根目录：只算直接放在根目录的） */
  function inDir(b, id) { return (b.cat || null) === (id || null); }
  function dirBanks(id) { return bankList().filter(function (b) { return inDir(b, id); }); }

  /* 搜索：词里含分隔符就按「目录/子目录/题库名」逐段匹配 */
  function matchSegs(str, segs) {
    var s = String(str).toLowerCase(), i = 0;
    for (var k = 0; k < segs.length; k++) {
      var p = s.indexOf(segs[k], i);
      if (p < 0) return false;
      i = p + segs[k].length;
    }
    return true;
  }
  function catMatches(c, segs, deep) {
    if (matchSegs(TITLE(c), segs)) return true;
    if (!deep) return false;
    function any(list) {
      for (var i = 0; i < list.length; i++) {
        if (matchSegs(TITLE(list[i]), segs)) return true;
        if (any(kids(list[i].id))) return true;
      }
      return false;
    }
    return any(kids(c.id));
  }
  function searchAll(segs) {
    ensure();
    var out = { cats: [], banks: [] };
    CAT.forEach(function (c) { if (catMatches(c, segs, false)) out.cats.push(c); });
    bankList().forEach(function (b) {
      var node = b.cat ? byId(b.cat) : null;
      var crumb = pathOf(node ? node.id : null).map(TITLE).join(' ');
      if (matchSegs(b.title, segs) || matchSegs(crumb + ' ' + b.title, segs)) out.banks.push(b);
    });
    out.cats.sort(function (a, b) { return TITLE(a).localeCompare(TITLE(b), 'zh'); });
    out.banks.sort(function (a, b) { return String(a.title).localeCompare(String(b.title), 'zh'); });
    return out;
  }

  /* ---------- 目录里的题库统计（含子目录汇总） ---------- */
  function bankStat(b) {
    var n = b.questions.length, done = 0, ok = 0, wr = 0;
    b.questions.forEach(function (q) {
      var k = kOf(b, q), a = ANS[k];
      if (a && !a.redo) { done++; if (a.ok) ok++; }
      if (a && (a.wrong || 0) > 0) wr++;
    });
    return { n: n, done: done, ok: ok, wr: wr, pct: n ? done / n * 100 : 0, acc: done ? Math.round(ok / done * 100) : 0 };
  }
  function subStat(cid) {
    var acc = { banks: 0, q: 0, done: 0, ok: 0, wr: 0, cats: 0 };
    function walk(id) {
      kids(id).forEach(function (k) {
        acc.cats++;
        dirBanks(k.id).forEach(function (b) {
          var s = bankStat(b);
          acc.banks++; acc.q += s.n; acc.done += s.done; acc.ok += s.ok; acc.wr += s.wr;
        });
        walk(k.id);
      });
    }
    walk(cid);
    /* 直属题库也一起算进来，卡片上显示的是「这个目录里的全部题」 */
    dirBanks(cid).forEach(function (b) {
      var s = bankStat(b);
      acc.banks++; acc.q += s.n; acc.done += s.done; acc.ok += s.ok; acc.wr += s.wr;
    });
    return acc;
  }

  /* ---------- 改数据 ---------- */
  function createCat(parent, title, order) {
    ensure();
    var id = uid('cat');
    CAT.push({ id: id, title: (title || '新分类').trim() || '新分类', parent: parent || null, order: (order == null ? 1e6 : order) });
    return id;
  }
  function renameCat(id, title) {
    var c = byId(id); if (!c) return;
    c.title = String(title || '').trim() || c.title;
  }
  /* 从题库文件 / 全部数据备份里带入分类：同 id 就地更新，新 id 追加。
     不能简单地「已存在就跳过」——那样同一个分类会在树里出现两次。 */
  function importCats(rows) {
    ensure();
    var seen = {}, added = 0, upd = 0;
    CAT.forEach(function (c) { seen[c.id] = 1; });
    (rows || []).forEach(function (c) {
      if (!c || !c.id) return;
      c = { id: String(c.id), title: String(c.title || '未命名分类'), parent: (c.parent == null ? null : String(c.parent)), order: (c.order == null ? 999 : (+c.order || 0)) };
      if (!seen[c.id]) { CAT.push(c); seen[c.id] = 1; added++; return; }
      var t = CAT.filter(function (x) { return x.id === c.id; })[0];
      if (t) { t.title = c.title; t.parent = c.parent; t.order = c.order; upd++; }
    });
    /* 父目录不存在（文件里少带了）就挂到顶层，别让分类变成看不见的孤儿 */
    CAT.forEach(function (c) { if (c.parent && !CAT.some(function (x) { return x.id === c.parent; })) c.parent = null; });
    if (added || upd) { saveCats(); }
    return { added: added, updated: upd };
  }
  function isDesc(rootId, id) { return rootId === id || descIds(rootId).indexOf(id) >= 0; }
  function moveCat(id, newParent, beforeId) {
    var c = byId(id); if (!c) return false;
    if (newParent && !byId(newParent)) return false;
    if (isDesc(id, newParent)) return false;      // 不能把目录塞进自己的子目录
    c.parent = newParent || null;
    placeNear(c, beforeId);
    return true;
  }
  /* 把 node 排到 beforeId 前面（beforeId 为空 = 排到最后） */
  function placeNear(node, beforeId) {
    var sibs = kids(node.parent).filter(function (x) { return x.id !== node.id; });
    if (!beforeId) {
      var last = sibs[sibs.length - 1];
      node.order = last ? (last.order || 0) + 1 : 0;
      return;
    }
    var idx = sibs.findIndex(function (x) { return x.id === beforeId; });
    if (idx < 0) { node.order = (sibs.length ? (sibs[sibs.length - 1].order || 0) + 1 : 0); return; }
    var after = sibs[idx], prev = idx > 0 ? sibs[idx - 1] : null;
    if (!prev) node.order = (after.order || 0) - 1;
    else node.order = ((prev.order || 0) + (after.order || 0)) / 2;
  }
  /* 原始对象 vs 规范化副本：allBanks()/bankById() 返回的是 normalizeBank() 造的
     新对象（缓存 _bankCache 里），改它不会写回 localStorage。
     分类和排序必须改 LOCAL 里的那一份，否则刷新就「重置」了。 */
  function toLocal(id) {
    if (typeof LOCAL === 'undefined' || !Array.isArray(LOCAL)) return null;
    return LOCAL.filter(function (x) { return x.id === id; })[0] || null;
  }
  /* 内置题库的原始对象在 window.__BANKS__ 里，改副本同样不会生效 */
  function toRaw(id) {
    var raw = toLocal(id);
    if (raw) return raw;
    try {
      var BI = window.__BANKS__;
      if (Array.isArray(BI)) return BI.filter(function (x) { return x && x.id === id; })[0] || null;
    } catch (e) {}
    return null;
  }
  function syncBankToLocal(id) {
    var raw = toLocal(id);
    if (!raw) return false;
    var b = bankOf(id);
    if (b) {
      raw.cat = b.cat == null ? null : b.cat;
      if (b.ord == null) delete raw.ord; else raw.ord = b.ord;
    }
    try { if (typeof writeLS === 'function') writeLS('qbank.local.v2', LOCAL); } catch (e) {}
    notifyFile();
    return true;
  }
  function moveBank(id, dir, beforeId) {
    var b = bankOf(id); if (!b || b.paper) return false;
    b.cat = dir || null;
    var sibs = dirBanks(dir).filter(function (x) { return x.id !== id; });
    if (!beforeId) {
      var last = sibs[sibs.length - 1];
      b.ord = last ? (+last.ord || 0) + 1 : 0;
    } else {
      var idx = sibs.findIndex(function (x) { return x.id === beforeId; });
      var after = idx >= 0 ? sibs[idx] : null;
      b.ord = after ? ((idx > 0 ? (+sibs[idx - 1].ord || 0) : (after.ord || 0) - 1) + (after.ord || 0)) / 2 : (sibs.length ? (+sibs[sibs.length - 1].ord || 0) + 1 : 0);
    }
    syncBankToLocal(id);          // 立刻写回原始题库对象，刷新后位置还在
    var raw = toRaw(id);          // 内置题库不在 LOCAL 里，得改 __BANKS__ 里的那一份
    if (raw) {
      raw.cat = b.cat == null ? null : b.cat;
      if (b.ord == null) delete raw.ord; else raw.ord = b.ord;
    }
    return true;
  }

  /* ---------- 批量管理：一次处理多个题库（移动 / 删除 / 导出） ----------
     打开后首页的题库卡片变成可多选，底部出现一条固定的操作条；
     目录卡片照常点进去，多一个「选中本目录题库」的按钮，可以整目录勾选。 */
  function batOn() { return !!BATCH; }
  function batSel(id) { return !!(BATCH && BATCH.sel[id]); }
  function batCount() { return BATCH ? Object.keys(BATCH.sel).length : 0; }
  function batBanks() {
    if (!BATCH) return [];
    return Object.keys(BATCH.sel).map(function (id) { return bankOf(id); })
      .filter(function (b) { return b && !b.paper; });
  }
  function batToggle(id) {
    if (!BATCH || !id) return;
    if (BATCH.sel[id]) delete BATCH.sel[id]; else BATCH.sel[id] = 1;
  }
  function batStat() {
    var bs = batBanks(), q = 0, builtin = 0, local = 0;
    bs.forEach(function (b) { q += b.questions.length; if (b.source === 'local') local++; else builtin++; });
    return { n: bs.length, q: q, local: local, builtin: builtin };
  }
  /* 当前页面上「看得见」的题库：搜索时是搜索结果，否则是当前目录里的 */
  function visibleBanks() {
    if (QUERY.trim()) {
      var segs = QUERY.toLowerCase().split(/[\/\s>›→]+/).filter(function (s) { return s; });
      var r = searchAll(segs.length ? segs : [QUERY.toLowerCase()]);
      return r.banks.filter(function (b) { return !b.paper; });
    }
    return dirBanks(CUR).filter(function (b) { return !b.paper; });
  }
  function batchBarHtml() {
    if (!BATCH) return '';
    var s = batStat(), vis = visibleBanks().length;
    return '<div class="nb-bspace"></div>'
      + '<div class="nb-bbatch" id="nbBatchBar">'
      + '<div class="bb-txt">已选 <b>' + s.n + '</b> 个题库 · 共 ' + s.q + ' 题'
      + '<span class="small muted">点题库卡片选中 / 取消；进目录可以接着选；'
      + (s.builtin ? '内置题库 ' + s.builtin + ' 个不能删除' : '现在选中的都能删、能移') + '</span></div>'
      + '<div class="bb-btns">'
      + '<button class="btn small" data-act="bAll">全选本页（' + vis + '）</button>'
      + '<button class="btn small" data-act="bInv">反选</button>'
      + '<button class="btn small" data-act="bMove">移动到…</button>'
      + '<button class="btn small danger" data-act="bDel">删除</button>'
      + '<button class="btn small" data-act="bExport">导出</button>'
      + '<button class="btn small primary" data-act="batchExit">退出批量</button>'
      + '</div></div>';
  }

  /* ---------- 面包屑 / 返回上一级 ---------- */
  function crumbHtml() {
    var p = pathOf(CUR);
    var parts = ['<a class="nb-crumb" data-crumb="" href="#/">🏠 全部题库</a>'];
    p.forEach(function (c, i) {
      var last = i === p.length - 1;
      parts.push('<span class="nb-sep">›</span>');
      parts.push('<a class="nb-crumb' + (last ? ' on' : '') + '" data-crumb="' + E(c.id) + '" href="#/">' + E(TITLE(c)) + '</a>');
    });
    return parts.join('');
  }

  /* ---------- 渲染 ---------- */
  var ICON_FOLDER = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"/></svg>';
  var ICON_BANK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2h9l5 5v15H6z" opacity=".35"/><path d="M14 2v6h6"/></svg>';

  function catCardHtml(c, inSearch) {
    var s = subStat(c.id);
    var sub = kids(c.id);
    var crumb = inSearch ? pathOf(c.id).slice(0, -1).map(TITLE).join(' › ') : '';
    return '<div class="nb-card nb-dir" data-cat="' + E(c.id) + '" draggable="' + (batOn() ? 'false' : 'true') + '" title="双击或点名称进入：' + E(TITLE(c)) + '">'
      + '<span class="nb-ic">' + ICON_FOLDER + '</span>'
      + '<div class="nb-info">'
      + '<div class="nb-name">' + E(TITLE(c))
      + (sub.length ? '<span class="pill">' + sub.length + ' 个子目录</span>' : '')
      + '</div>'
      + '<div class="nb-meta">'
      + (crumb ? '在 ' + E(crumb) + '　·　' : '')
      + s.banks + ' 个题库　' + s.q + ' 题　已答 ' + s.done
      + (s.wr ? '　<span class="warn">错题 ' + s.wr + '</span>' : '')
      + (s.done ? '　正确率 ' + Math.round(s.ok / s.done * 100) + '%' : '')
      + '</div>'
      + '<div class="prog"><i style="width:' + (s.q ? (s.done / s.q * 100).toFixed(1) : 0) + '%"></i></div>'
      + '</div>'
      + '<div class="nb-acts">'
      + '<button class="btn tiny" data-act="open" data-id="' + E(c.id) + '">打开</button>'
      + (batOn() ? '<button class="btn tiny" data-act="batchDir" data-id="' + E(c.id) + '">选中本目录题库</button>' : '')
      + '<button class="btn tiny" data-act="menu" data-id="' + E(c.id) + '">⋯</button>'
      + '</div></div>';
  }

  function bankCardHtml(b, inSearch) {
    var s = bankStat(b);
    var crumb = inSearch ? pathOf(b.cat || null).map(TITLE).join(' › ') : '';
    var pick = batOn(), on = pick && batSel(b.id);
    return '<div class="nb-card nb-bank' + (on ? ' nb-on' : '') + '" data-bank="' + E(b.id) + '" draggable="' + (pick ? 'false' : 'true') + '">'
      + (pick ? '<span class="nb-box' + (on ? ' on' : '') + '" aria-hidden="true"></span>' : '')
      + '<span class="nb-ic">' + ICON_BANK + '</span>'
      + '<div class="nb-info">'
      + '<div class="nb-name">' + E(b.title)
      + (b.source === 'local' ? '<span class="pill local">自建</span>' : '<span class="pill">内置</span>')
      + '</div>'
      + '<div class="nb-meta">'
      + (crumb ? '在 ' + E(crumb) + '　·　' : '')
      + (b.subtitle ? E(b.subtitle) + '　' : '')
      + b.questions.length + ' 题　已答 ' + s.done
      + (s.wr ? '　<span class="warn">错题 ' + s.wr + '</span>' : '')
      + '　正确率 ' + s.acc + '%'
      + '</div>'
      + '<div class="prog"><i style="width:' + s.pct.toFixed(1) + '%"></i></div>'
      + '</div>'
      + '<div class="nb-acts">'
      + (pick
        ? '<span class="small muted">' + (on ? '✔ 已选中，再点一下取消' : '点这张卡片选中它') + '</span>'
        : ('<button class="btn tiny primary" data-act="start" data-id="' + E(b.id) + '">' + (s.done ? '继续' : '开始') + '</button>'
          + '<button class="btn tiny" data-act="wrong" data-id="' + E(b.id) + '">错题 ' + s.wr + '</button>'
          + '<button class="btn tiny" data-act="rand" data-id="' + E(b.id) + '">随机 30</button>'
          + '<button class="btn tiny" data-act="move" data-id="' + E(b.id) + '">移动</button>'
          + '<button class="btn tiny" data-act="more" data-id="' + E(b.id) + '">⋯</button>'))
      + '</div></div>';
  }

  function toolbarHtml() {
    return '<div class="nb-bar">'
      + '<input id="nbSearch" class="nb-search" type="search" placeholder="搜索目录 / 题库名（也可以用「目录名 题库名」）" value="' + E(QUERY) + '">'
      + '</div>';
  }

  function emptyHint() {
    return '<div class="card"><div class="empty">'
      + '这个目录还是空的。<br>点「＋ 新建分类」建一个大目录 / 子目录，'
      + '或点「＋ 新建 / 导入题库」把题目放进来。<br>'
      + '<span class="small muted">也可以把题库 JSON 文件直接拖到网页上导入。</span>'
      + '</div></div>';
  }

  function homeHtml() {
    ensure();
    var bk = typeof baseBanks === 'function' ? baseBanks() : [];
    var papers = (typeof allBanks === 'function' ? allBanks() : bk).filter(function (b) { return b.paper; });
    var totalQ = 0, totalDone = 0, totalOk = 0, wrongN = 0, dueN = 0;
    bk.forEach(function (b) { b.questions.forEach(function (q) {
      totalQ++;
      var k = kOf(b, q), a = ANS[k];
      if (a && !a.redo) { totalDone++; if (a.ok) totalOk++; }
      if (a && (a.wrong || 0) > 0) wrongN++;
      if (typeof isDue === 'function' && isDue(k)) dueN++;
    }); });
    var favN = Object.keys(FAV).filter(function (k) { return FAV[k]; }).length;
    var TODAY = typeof todayStats === 'function' ? todayStats() : { dNum: 0, dOk: 0, streak: 0, weekN: 0 };
    var srsCap = (typeof srsCfg === 'function') ? (+srsCfg().daily || 0) : 0;

    var last = typeof lastPos === 'function' ? lastPos() : null;
    var resumeHtml = '';
    if (last) {
      var lp = pathOf(last.bank.cat || null).map(TITLE).join(' › ');
      resumeHtml = '<div class="resume">'
        + '<div class="rinfo">'
        + '<div class="rtitle">' + E(last.bank.title) + (lp ? ' <span class="small muted">' + E(lp) + '</span>' : '') + '</div>'
        + '<div class="rmeta">上次做到 第 ' + (last.idx + 1) + ' / ' + last.n + ' 题 · 已答 ' + last.done
        + ' · 正确率 ' + (last.done ? Math.round(last.ok / last.done * 100) : 0) + '%'
        + (last.ts ? ' · ' + fmtTime(last.ts) : '') + '</div>'
        + '<div class="prog"><i style="width:' + (last.n ? Math.round(last.done / last.n * 100) : 0) + '%"></i></div>'
        + '</div><button class="btn primary" id="toResume" data-act="resume">继续刷题</button></div>';
    }

    var paperList = papers.map(function (b) {
      var done = 0, ok = 0;
      b.questions.forEach(function (q) { var a = ANS[kOf(b, q)]; if (a && !a.redo) { done++; if (a.ok) ok++; } });
      return '<div class="card bank paper-card"><div class="info">'
        + '<div class="name">' + E(b.title) + '<span class="pill paper">' + (b.exam ? '模拟考试' : '临时套卷') + '</span></div>'
        + '<div class="meta">' + b.questions.length + ' 题　已做 ' + done + '　正确率 ' + (done ? Math.round(ok / done * 100) : 0) + '%</div>'
        + '<div class="prog"><i style="width:' + (b.questions.length ? done / b.questions.length * 100 : 0) + '%"></i></div>'
        + '</div><div class="acts">'
        + '<button class="btn primary" data-start="' + E(b.id) + '">' + (done ? '继续' : '开始') + (b.exam ? '考试' : '做题') + '</button>'
        + '<button class="btn danger" data-delpaper="' + E(b.id) + '">删除' + (b.exam ? '试卷' : '套卷') + '</button>'
        + '</div></div>';
    }).join('');

    var body;
    if (QUERY.trim()) {
      var segs = QUERY.toLowerCase().split(/[\/\s>›→]+/).filter(function (s) { return s; });
      var r = searchAll(segs.length ? segs : [QUERY.toLowerCase()]);
      var sc = r.cats.map(function (c) { return catCardHtml(c, true); }).join('');
      var sb = r.banks.map(function (b) { return bankCardHtml(b, true); }).join('');
      body = '<h2 class="sec">搜索「' + E(QUERY) + '」的结果</h2>'
        + ((sc || sb) ? ('<div class="nb-cards">' + sc + sb + '</div>') : '<div class="card"><div class="empty">没找到。可以试试目录名、题库名的一部分，或者用「目录名/题库名」的写法。</div></div>');
    } else {
      var dirs = kids(CUR), bs = dirBanks(CUR);
      var curTitle = CUR ? TITLE(byId(CUR)) : '全部题库';
      var cards = dirs.map(function (c) { return catCardHtml(c, false); }).join('')
        + bs.slice().sort(sortBank).map(function (b) { return bankCardHtml(b, false); }).join('');
      var agg = CUR ? subStat(CUR) : null;
      body = '<h2 class="sec">' + E(curTitle) + '</h2>'
        + (agg ? '<div class="small muted" style="margin:-4px 0 10px">本目录共 ' + agg.cats + ' 个子目录 · ' + agg.banks + ' 个题库 · ' + agg.q + ' 题 · 已答 ' + agg.done + '</div>' : '')
        + (cards ? ('<div class="nb-cards">' + cards + '</div>') : emptyHint());
    }

    return ''
      + '<div class="hero">'
      + '<h1>刷题站</h1>'
      + '<p>选择题即时判分，选错立刻出解析。题库可以按「大目录 / 子目录」分类摆放，拖一下就能移动；自建题库能存成本机文件，换电脑、清缓存都不怕。</p>'
      + '<div class="hstat">'
      + '<div><b>' + bk.length + '</b>个题库</div>'
      + '<div><b>' + totalQ + '</b>道题</div>'
      + '<div><b>' + totalDone + '</b>已答</div>'
      + '<div><b>' + (totalDone ? Math.round(totalOk / totalDone * 100) : 0) + '%</b>正确率</div>'
      + '<div><b>' + wrongN + '</b>错题</div>'
      + '<div><b>' + favN + '</b>收藏</div>'
      + '<div><b>' + dueN + '</b>待复习</div>'
      + '</div>'
      + '<div class="hstat today">'
      + '<div><b>' + TODAY.dNum + '</b>今日已答</div>'
      + '<div><b>' + (TODAY.dNum ? Math.round(TODAY.dOk / TODAY.dNum * 100) : 0) + '%</b>今日正确率</div>'
      + '<div><b>' + TODAY.streak + '</b>连续天数</div>'
      + '<div><b>' + TODAY.weekN + '</b>近 7 天</div>'
      + '</div></div>'
      + resumeHtml
      + '<div class="nb-nav" id="nbNav">'
      + '<div class="nb-crumbs">' + crumbHtml() + '</div>'
      + '<div class="nb-navbtns">'
      + (CUR ? '<button class="btn small" data-act="up">↑ 上一级</button>' : '')
      + '<button class="btn small" data-act="expandAll">展开 / 收起目录树</button>'
      + (DRAG ? '<button class="btn small primary" data-act="dropshow">放到这里</button><button class="btn small" data-act="dropcancel">取消移动</button>' : '')
      + '</div>'
      + '<div id="nbTree" class="nb-tree" style="display:none"></div>'
      + '</div>'
      + '<div class="row-inline" style="margin:14px 0 12px">'
      + '<button class="btn primary" data-act="newcat">＋ 新建分类</button>'
      + '<button class="btn" data-act="newbank">＋ 新建 / 导入题库</button>'
      + (BATCH
        ? '<button class="btn primary" data-act="batchExit">退出批量（已选 ' + batCount() + '）</button>'
        : '<button class="btn" data-act="batch">批量管理题库</button>')
      + (dueN ? '<button class="btn primary" id="toReview" data-act="review" data-n="' + (srsCap && dueN > srsCap ? srsCap : dueN) + '">今日复习 ' + (srsCap && dueN > srsCap ? srsCap + ' / ' + dueN : dueN) + ' 题</button>' : '')
      + '<button class="btn" id="toWrong" data-act="go" data-hash="#/wrong">错题本' + (wrongN ? '（' + wrongN + (dueN ? ' · 待复习' + dueN : '') + '）' : '') + '</button>'
      + '<button class="btn" id="toFav" data-act="go" data-hash="#/fav">收藏' + (favN ? '（' + favN + '）' : '') + '</button>'
      + '<button class="btn" id="toSearch" data-act="go" data-hash="#/search">搜索全部</button>'
      + '<button class="btn" id="toRand" data-act="randall">随机抽 30 题</button>'
      + '<button class="btn" id="toStats" data-act="go" data-hash="#/stats">学习统计</button>'
      + '<button class="btn" id="toHelp" data-act="help">快捷键</button>'
      + '</div>'
      + toolbarHtml()
      + body
      + (paperList ? '<h2 class="sec">临时套卷</h2>' + paperList : '')
      + '<div id="bfBoot"></div>'
      + '<div class="card" style="margin-top:16px">'
      + '<div class="name" style="font-weight:700;margin-bottom:6px">数据备份</div>'
      + '<div class="small muted" style="margin-bottom:10px">作答记录、错题、收藏、自定义解析存在本机浏览器里；题库和分类可以另存成本机文件（见上面的「本机题库文件」）。</div>'
      + (typeof backupHint === 'function' ? backupHint() : '')
      + '<div class="row-inline">'
      + '<button class="btn" id="expAll">导出全部数据</button>'
      + '<button class="btn" id="impAll">导入数据（恢复）</button>'
      + '<input type="file" id="impAllFile" accept=".json" style="display:none">'
      + '</div></div>'
      + '<div id="storeUse" class="small muted" style="margin:10px 2px 0">正在统计占用…</div>'
      + batchBarHtml();
  }

  function sortBank(a, b) {
    return (+a.ord || 0) - (+b.ord || 0) || String(a.title).localeCompare(String(b.title), 'zh');
  }

  /* 目录树（侧边/顶部折叠）：整个分类结构一次看全 */
  function treeHtml() {
    ensure();
    function walk(pid, depth) {
      var out = '';
      kids(pid).forEach(function (c) {
        out += '<div class="nb-trow" data-trow="' + E(c.id) + '" style="padding-left:' + (depth * 14) + 'px">'
          + '<button class="btn tiny" data-act="open" data-id="' + E(c.id) + '">' + E(TITLE(c)) + '</button>'
          + '<span class="small muted">' + dirBanks(c.id).length + ' 个题库</span>'
          + '</div>';
        out += walk(c.id, depth + 1);
      });
      return out;
    }
    var loose = dirBanks(null).length;
    return '<div class="nb-trow nb-trow-root' + (CUR ? '' : ' on') + '" data-trow="" style="padding-left:0">' + '<button class="btn tiny' + (CUR ? '' : ' primary') + '" data-act="open" data-id="">全部题库（根目录）</button>'
      + '<span class="small muted">' + loose + ' 个题库</span></div>'
      + walk(null, 1);
  }

  /* ---------- 渲染入口：替换首页 ============
     由 app.js 的 renderHome() 在最后调用（见 catRenderHook）。
     策略：先让原首页正常渲染（它的统计 / 数据备份按钮都还在），
     然后把 .hero 到「数据备份」卡片之间的内容整段换成目录视图。 */
  function catRenderHook() {
    ensure();
    var view = document.getElementById('view');
    if (!view) return;
    var hero = view.querySelector('.hero');
    if (!hero) return;                       // 不是首页结构：不动
    var old = document.getElementById('nbHome');
    if (old) old.remove();                   // 重画时先把上一次的目录视图撤掉
    /* 记住停留的目录：只有本次打开页面还没定过位置时才读存档，
       否则会把 openDir() 刚设好的目录又顶回旧的 */
    if (!CUR_SET) {
      try {
        var stored = JSON.parse(localStorage.getItem(CUR_KEY));
        CUR = (stored && typeof stored.id === 'string') ? stored.id : null;
      } catch (e) { CUR = null; }
      CUR_SET = true;
    }
    if (CUR && !byId(CUR)) CUR = null;

    var holder = document.createElement('div');
    holder.id = 'nbHome';
    holder.innerHTML = homeHtml();
    hero.parentNode.insertBefore(holder, hero);
    hookHome();
    /* 旧的平铺列表 / 常用按钮行 / 我的题库标题 / 空状态，全部撤掉 */
    var nodes = Array.prototype.slice.call(view.children);
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (n === holder) continue;
      /* 首页里属于 app.js 的旧统计卡 / 列表 / 按钮行 / 空状态：一律撤掉。
         新的 hero、按钮行、目录视图都在 holder 里，不会误删。 */
      n.remove();
    }
    /* 兜底：只留 holder 和我们自己那块「数据备份」（含导出/导入按钮）。
       app.js 原首页的同名卡片是「会生成、但没人寻址」的，留着就会重复，所以这里显式清掉。 */
    var spare = [];
    Array.prototype.slice.call(document.querySelectorAll('#view .card')).forEach(function (c) {
      if (holder.contains(c)) return;                  // 我们自己的备份卡在 holder 里
      if (c.querySelector('#expAll') || c.querySelector('#impAll')) spare.push(c);
    });
    spare.forEach(function (c) { c.remove(); });
    /* 没有 #storeUse（app.js 那行被删了）就补一个，paintStorageUse() 要往里写占用 */
    if (typeof paintStorageUse === 'function' && !document.getElementById('storeUse')) {
      var su = document.createElement('div');
      su.id = 'storeUse';
      su.className = 'small muted';
      su.style.margin = '10px 2px 0';
      holder.appendChild(su);
    }
    bind(holder);
    if (typeof BF !== 'undefined' && BF.boot) BF.boot();
  }

  /* ---------- 事件绑定（都在 holder 内，重渲染后重新绑一次） ---------- */
  function bind(host) {
    var search = host.querySelector('#nbSearch');
    if (search) {
      search.addEventListener('input', function () {
        QUERY = search.value;
        clearTimeout(bind._t);
        bind._t = setTimeout(function () { repaint(); }, 220);
      });
      search.addEventListener('keydown', function (e) { if (e.key === 'Enter') { QUERY = search.value; repaint(); } });
    }
    host.querySelectorAll('[data-crumb]').forEach(function (a) {
      a.onclick = function (e) { e.preventDefault(); openDir(a.dataset.crumb || null); };
    });
    host.querySelectorAll('[data-trow]').forEach(function (row) {
      row.onclick = function () { openDir(row.dataset.trow); };
    });
    host.querySelectorAll('[data-act]').forEach(function (el) {
      el.onclick = function (e) {
        e.preventDefault(); e.stopPropagation();
        doAct(el.dataset.act, el.dataset.id, el, host);
      };
    });
    /* 再按 id 绑一遍：这一排按钮不管谁先渲染都能点 */
    var BY_ID = { toWrong: '#/wrong', toFav: '#/fav', toSearch: '#/search', toStats: '#/stats' };
    Object.keys(BY_ID).forEach(function (id) {
      var el = host.querySelector('#' + id);
      if (el && !el.onclick) el.onclick = function () { if (typeof go === 'function') go(BY_ID[id]); };
    });
    /* 数据备份卡里的「导出全部数据 / 导入数据（恢复）」：这张卡是我们自己重画的，
       app.js 原来绑好的那份节点已经被上面撤掉了，所以必须在这里补绑，否则点了没反应 */
    var exA = host.querySelector('#expAll');
    if (exA && !exA.onclick) exA.onclick = function () { if (typeof exportAllData === 'function') exportAllData(); };
    var imA = host.querySelector('#impAll');
    var imF = host.querySelector('#impAllFile');
    if (imA && imF && !imA.onclick) imA.onclick = function () { imF.click(); };
    if (imF && !imF.onchange && typeof importAllData === 'function') imF.onchange = function (e) { importAllData(e); };
    /* 双击 / 单击卡片：进入目录、开始刷题 */
    host.querySelectorAll('.nb-dir').forEach(function (row) {
      row.addEventListener('dblclick', function () { openDir(row.dataset.cat); });
      row.addEventListener('click', function (e) {
        if (e.target.closest('[data-act]')) return;
        if (e.detail > 1) return;
        if (dragSticky()) return;              // 长按选中后，这一下点击不算「打开」
        openDir(row.dataset.cat);
      });
    });
    host.querySelectorAll('.nb-bank').forEach(function (row) {
      row.addEventListener('dblclick', function () {
        if (BATCH) { batToggle(row.dataset.bank); repaint(); return; }
        startBankWrapped(row.dataset.bank);
      });
      row.addEventListener('click', function (e) {
        if (e.target.closest('[data-act]')) return;
        if (e.detail > 1) return;
        if (BATCH) { batToggle(row.dataset.bank); repaint(); return; }   // 批量模式下点卡片 = 选中 / 取消
        if (dragSticky()) return;
        startBankWrapped(row.dataset.bank);
      });
    });
    attachDrag(host);
  }

  function startBankWrapped(id) {
    QUERY = '';
    if (typeof startBank === 'function') startBank(id);
  }

  function openDir(id) {
    ensure();
    if (id && !byId(id)) id = null;
    CUR = id || null;
    CUR_SET = true;
    QUERY = '';
    try { localStorage.setItem(CUR_KEY, JSON.stringify({ id: CUR, ts: Date.now() })); } catch (e) {}
    repaint();
    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { window.scrollTo(0, 0); }
  }

  /* 内部重画：调 app.js 的全局 render 重画首页（不能叫 render，否则同名自我递归） */
  function repaint() {
    try { if (typeof window.render === 'function') window.render(); } catch (e) {}
  }

  /* ---------- 菜单与动作 ---------- */
  function doAct(act, id, el, host) {
    switch (act) {
      case 'open': openDir(id || null); break;
      case 'up': openDir(byId(CUR) ? byId(CUR).parent : null); break;
      case 'newcat': askNewCat(); break;
      case 'newbank': if (typeof go === 'function') go('#/import'); break;
      case 'start': startBankWrapped(id); break;
      case 'wrong': if (typeof QZ !== 'undefined') QZ.filter = 'wrong'; startBankWrapped(id); break;
      case 'rand': if (typeof randomPaper === 'function') randomPaper([bankOf(id)], 30); break;
      case 'move': askMoveBank(id); break;
      /* 批量管理 */
      case 'batch': BATCH = { sel: {} }; DRAG = null; LOCK = false; T('批量管理：点题库卡片选中，底部那排按钮操作'); repaint(); break;
      case 'batchExit': BATCH = null; repaint(); break;
      case 'batchDir': batPickDir(id); break;
      case 'bAll': if (!BATCH) break; visibleBanks().forEach(function (b) { BATCH.sel[b.id] = 1; }); repaint(); break;
      case 'bInv': if (!BATCH) break; visibleBanks().forEach(function (b) { if (BATCH.sel[b.id]) delete BATCH.sel[b.id]; else BATCH.sel[b.id] = 1; }); repaint(); break;
      case 'bMove': askBatchMove(); break;
      case 'bDel': askBatchDel(); break;
      case 'bExport': batchExport(); break;
      case 'more': bankMenu(id); break;
      case 'menu': catMenu(id); break;
      case 'dropshow': askMoveByPick(); break;
      case 'dropcancel': DRAG = null; LOCK = false; repaint(); break;
      /* 首页那排按钮：走这里跳转，不靠 app.js 在 renderHome 里的 id 绑定
         （它绑的是被我们替换掉的那一排，绑完那些节点就被撤了，所以以前点不动） */
      case 'go': if (typeof go === 'function' && el && el.dataset.hash) go(el.dataset.hash); break;
      case 'resume': var lp2 = (typeof lastPos === 'function') ? lastPos() : null; if (lp2) startBankWrapped(lp2.bank.id); break;
      case 'review': if (typeof startReview === 'function') startReview(+(el && el.dataset.n) || 60); break;
      case 'randall': if (typeof randomPaper === 'function') randomPaper(bankList(), 30); break;
      case 'help': if (typeof showHelp === 'function') showHelp(); break;
      case 'expandAll':
        var t = host.querySelector('#nbTree');
        if (t) { var open = t.style.display === 'none'; t.style.display = open ? 'block' : 'none'; if (open) t.innerHTML = treeHtml() + '<div class="small muted" style="margin-top:6px">点一个目录就能跳过去（含它下面的子目录）。</div>'; }
        break;
      default: break;
    }
  }

  function askNewCat() {
    var parent = CUR;
    var pTxt = parent ? pathOf(parent).map(TITLE).join(' › ') : '根目录（顶层）';
    BFUI.prompt({
      title: '新建分类',
      label: '分类名称（可以随时改名）',
      placeholder: '例如：药理 / 第一章 总论',
      hint: '将创建在：' + pTxt + '。想要子目录，先进到那个目录里再点「＋ 新建分类」。',
      choices: parent ? [{ label: '建在根目录（顶层）', value: '__ROOT__' }] : [],
      test: function (v) { return v ? '' : '名称不能为空'; }
    }).then(function (v) {
      if (v == null) return;
      if (v === '__ROOT__') { CUR = null; askNewCatRoot(); return; }
      var nid = createCat(parent, v);
      saveCats({ quiet: false });
      T('已新建分类「' + v + '」');
      if (nid) openDir(nid);
    });
  }
  function askNewCatRoot() {
    BFUI.prompt({
      title: '新建分类（建在根目录）',
      label: '分类名称',
      placeholder: '例如：西医综合',
      test: function (v) { return v ? '' : '名称不能为空'; }
    }).then(function (v) {
      if (v == null) return;
      createCat(null, v);
      saveCats();
      T('已新建分类「' + v + '」');
    });
  }

  function catMenu(id) {
    var c = byId(id); if (!c) return;
    var pTxt = pathOf(id).map(TITLE).join(' › ');
    /* 整棵子树（自己 + 所有子孙目录）里的题库，用于「连题库一起删」的数量提示 */
    var treeIds = [id].concat(descIds(id));
    var inTree = {}; treeIds.forEach(function (x) { inTree[x] = 1; });
    var treeBanks = bankList().filter(function (b) { return b.cat != null && inTree[b.cat]; });
    var deepLocal = treeBanks.filter(function (b) { return b.source === 'local'; });
    var deepQ = 0; deepLocal.forEach(function (b) { deepQ += b.questions.length; });
    var direct = dirBanks(id).length;
    BFUI.pick({
      title: c.title,
      desc: '位置：' + pTxt + '　·　' + kids(id).length + ' 个子目录 · ' + direct + ' 个题库（直属）'
        + (treeBanks.length > direct ? '　·　含子目录共 ' + treeBanks.length + ' 个题库' : ''),
      items: [
        { value: 'open', label: '打开这个目录' },
        { value: 'rename', label: '重命名' },
        { value: 'newsub', label: '在这里新建子目录' },
        { value: 'move', label: '移动到其它目录…' },
        { value: 'deldeep', label: '🔥 删除目录（连同里面的题库）', note: deepLocal.length ? ('删 ' + deepLocal.length + ' 个题库 / ' + deepQ + ' 题，不可恢复') : '里面没有自建题库' },
        { value: 'del', label: '只删目录，题库移到上一级', note: '不删题库' }
      ]
    }).then(function (v) {
      if (v === 'open') openDir(id);
      else if (v === 'rename') {
        BFUI.prompt({ title: '重命名分类', label: '新名称', value: c.title, test: function (x) { return x ? '' : '名称不能为空'; } })
          .then(function (nv) { if (nv == null) return; renameCat(id, nv); saveCats(); T('已改名为「' + nv + '」'); });
      } else if (v === 'newsub') {
        BFUI.prompt({ title: '在「' + c.title + '」里新建子目录', label: '子目录名称', test: function (x) { return x ? '' : '名称不能为空'; } })
          .then(function (nv) { if (nv == null) return; createCat(id, nv); saveCats(); T('已新建子目录「' + nv + '」'); });
      } else if (v === 'move') askMoveCat(id);
      else if (v === 'deldeep') askDelCatDeep(id);
      else if (v === 'del') askDelCat(id);
    });
  }

  function askMoveCat(id) {
    var bad = descIds(id);
    var items = [{ value: '__ROOT__', label: '🏠 顶层（移出所有目录）' }];
    catsAll().forEach(function (c) {
      if (bad.indexOf(c.id) >= 0) return;
      items.push({ value: c.id, label: pathOf(c.id).map(TITLE).join(' › '), note: dirBanks(c.id).length + ' 个题库' });
    });
    BFUI.pick({ title: '把「' + TITLE(byId(id)) + '」移动到…', desc: '不能移动到自己或自己的子目录里。', items: items })
      .then(function (v) {
        if (v == null) return;
        var ok = moveCat(id, v === '__ROOT__' ? null : v);
        if (!ok) { T('不能移动到自己的子目录里'); return; }
        saveCats();
        T('已移动');
      });
  }

  function askDelCat(id) {
    var c = byId(id); if (!c) return;
    var subs = kids(id), bs = dirBanks(id);
    var parent = c.parent || null;
    BFUI.confirm({
      title: '删除分类「' + c.title + '」？',
      html: '删除后：<br>'
        + '· ' + subs.length + ' 个子目录会移到' + (parent ? '上一级目录' : '顶层') + '<br>'
        + '· ' + bs.length + ' 个题库会移到' + (parent ? '上一级目录' : '顶层') + '<br>'
        + '<span class="muted">题目本身和作答记录不会丢，只是换个位置放。</span>',
      okText: '删除分类',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      /* 先把内容挪走，再删节点，保证没有孤儿 */
      subs.forEach(function (k) { k.parent = parent; });
      bs.forEach(function (b) {
        b.cat = parent;
        var raw = toRaw(b.id);
        if (raw) raw.cat = parent;
        syncBankToLocal(b.id);
      });
      CAT = CAT.filter(function (x) { return x.id !== id; });
      if (CUR === id) CUR = parent;
      if (typeof invalidateBanks === 'function') invalidateBanks();
      saveCats();
      T('已删除分类，内容已移到' + (parent ? '上一级' : '顶层'));
    });
  }

  /* 真删题库（只删自建）：作答记录 / 收藏 / 自定义解析 + 墓碑一起清，返回删掉的题数 */
  function purgeBanks(list) {
    var qn = 0;
    (list || []).forEach(function (b) {
      if (!b || b.source !== 'local') return;
      b.questions.forEach(function (q) {
        var k = kOf(b, q);
        delete ANS[k]; delete FAV[k]; delete NOTES[k];
        tombAdd('ans', k); tombAdd('fav', k); tombAdd('note', k);
        qn++;
      });
      if (typeof LOCAL !== 'undefined' && Array.isArray(LOCAL)) {
        LOCAL = LOCAL.filter(function (x) { return x.id !== b.id; });
      }
      try { localStorage.removeItem('qbank.last.' + b.id); } catch (e) {}
    });
    if (qn) {
      if (typeof invalidateBanks === 'function') invalidateBanks();
      try { if (typeof writeLS === 'function') writeLS('qbank.local.v2', LOCAL); } catch (e) {}
      if (typeof saveAns === 'function') saveAns();
      if (typeof saveFav === 'function') saveFav();
      if (typeof saveNotes === 'function') saveNotes();
      notifyFile();
    }
    return qn;
  }

  /* 删除目录（连内容一起删）：自己 + 所有子孙目录 + 子树里所有题库，一次清干净 */
  function askDelCatDeep(id) {
    var c = byId(id); if (!c) return;
    var ids = [id].concat(descIds(id));
    var set = {}; ids.forEach(function (x) { set[x] = 1; });
    var all = bankList().filter(function (b) { return b.cat != null && set[b.cat]; });
    var dels = all.filter(function (b) { return b.source === 'local'; });
    var keep = all.filter(function (b) { return b.source !== 'local'; });
    var qn = 0; dels.forEach(function (b) { qn += b.questions.length; });
    var upTxt = c.parent ? '上一级目录' : '顶层';
    var names = dels.slice(0, 8).map(function (b) { return E(b.title); }).join('、') + (dels.length > 8 ? ' 等 ' + dels.length + ' 个' : '');
    BFUI.confirm({
      title: '删除目录「' + c.title + '」，连同里面的题库？',
      html: (dels.length
          ? '会删除 <b>' + dels.length + ' 个题库 / ' + qn + ' 题</b>：<br><span class="small">' + names + '</span><br>'
          : '这个目录（含子目录）里没有可删除的自建题库。<br>')
        + '目录本身也会删掉 ' + ids.length + ' 个（含 ' + (ids.length - 1) + ' 个子目录）。<br>'
        + '它们下面所有题目的作答记录、收藏、自定义解析会一起清掉，<b>不可恢复</b>。'
        + (keep.length ? '<div class="small muted" style="margin-top:6px">另有 ' + keep.length + ' 个内置题库不能删，会移到' + upTxt + '。</div>' : ''),
      okText: '全部删除',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      var n = purgeBanks(dels);
      /* 内置题库不能删：挪到上一级免得成孤儿（必须改原始对象，副本改了不生效） */
      keep.forEach(function (b) {
        b.cat = c.parent || null;
        var raw = toRaw(b.id);
        if (raw) raw.cat = c.parent || null;
        syncBankToLocal(b.id);
      });
      CAT = CAT.filter(function (x) { return !set[x.id]; });                            // 整棵子树一起删
      if (CUR && set[CUR]) CUR = c.parent || null;
      if (typeof invalidateBanks === 'function') invalidateBanks();
      saveCats();
      try { if (typeof writeLS === 'function') writeLS('qbank.local.v2', LOCAL); } catch (e) {}
      notifyFile();
      T('已删除 ' + ids.length + ' 个目录、' + dels.length + ' 个题库（' + n + ' 题）'
        + (keep.length ? '，' + keep.length + ' 个内置题库已移到' + upTxt : ''));
      repaint();
    });
  }

  /* 移动题库：先选目标目录（含搜索），再决定是否连带作答记录 */
  function askMoveBank(id) {
    var b = bankOf(id); if (!b) return;
    if (b.paper) { T('临时套卷不能移动'); return; }
    var items = [{ value: '__ROOT__', label: '🏠 顶层（根目录）' }];
    catsAll().forEach(function (c) {
      items.push({ value: c.id, label: pathOf(c.id).map(TITLE).join(' › '), note: dirBanks(c.id).length + ' 个题库' });
    });
    /* 允许顺手新建一个目录 */
    items.unshift({ value: '__NEW__', label: '＋ 新建一个分类再放进去…' });
    BFUI.pick({ title: '把「' + b.title + '」移动到…', desc: '选题库要放进的目录。', items: items })
      .then(function (v) {
        if (v == null) return;
        if (v === '__NEW__') {
          BFUI.prompt({ title: '新建分类', label: '分类名称', placeholder: '例如：药理 / 抗菌药' })
            .then(function (name) {
              if (name == null) return;
              var nid = createCat(CUR, name);
              applyMoveBank(id, nid);
            });
          return;
        }
        applyMoveBank(id, v === '__ROOT__' ? null : v);
      });
  }
  function applyMoveBank(id, dir) {
    var b = bankOf(id);
    if (!moveBank(id, dir)) { T('移动失败'); return; }
    saveBankOrder();
    var where = dir ? pathOf(dir).map(TITLE).join(' › ') : '顶层';
    T('已把「' + b.title + '」移到 ' + where);
    repaint();
  }
  function saveBankOrder() {
    try {
      if (typeof LOCAL !== 'undefined' && Array.isArray(LOCAL)) {
        LOCAL.forEach(function (raw) {                 // 把缓存里的 cat/ord 全部同步回原始对象
          if (!raw || !raw.id) return;
          var b = null;
          try { b = bankOf(raw.id); } catch (e) { b = null; }
          if (!b) return;
          raw.cat = b.cat == null ? null : b.cat;
          if (b.ord == null) delete raw.ord; else raw.ord = b.ord;
        });
      }
      if (typeof writeLS === 'function') writeLS('qbank.local.v2', LOCAL);
    } catch (e) {}
    if (typeof invalidateBanks === 'function') invalidateBanks();
    notifyFile();
  }

  /* 拖拽移动（用「先选中、再点目标」的两步法，手机上比长按拖好按） */
  function askMoveByPick() {
    if (!DRAG) return;
    var items = [{ value: '__ROOT__', label: '🏠 顶层（根目录）' }];
    catsAll().forEach(function (c) {
      var isSelf = DRAG.type === 'cat' && (c.id === DRAG.id || descIds(DRAG.id).indexOf(c.id) >= 0);
      items.push({ value: c.id, label: pathOf(c.id).map(TITLE).join(' › '), disabled: isSelf, note: isSelf ? '（自己在里面）' : dirBanks(c.id).length + ' 个题库' });
    });
    BFUI.pick({ title: '移动到…', items: items }).then(function (v) {
      if (v == null) return;
      var dir = v === '__ROOT__' ? null : v;
      if (DRAG.type === 'cat') {
        if (!moveCat(DRAG.id, dir)) { T('不能移动到自己的子目录里'); return; }
        saveCats();
      } else {
        applyMoveBank(DRAG.id, dir);
        DRAG = null;
        saveCats({ quiet: false });
      }
      DRAG = null;
      T('已移动');
      repaint();
    });
  }

  function bankMenu(id) {
    var b = bankOf(id); if (!b) return;
    var isLocal = b.source === 'local';
    var items = [
      { value: 'start', label: '开始 / 继续刷题' },
      { value: 'move', label: '移动到其它目录…' },
      { value: 'export', label: '导出这个题库（JSON）' }
    ];
    if (isLocal) {
      items.push({ value: 'rename', label: '改名 / 改说明' });
      items.push({ value: 'edit', label: '编辑题目内容' });
      items.push({ value: 'del', label: '删除题库', note: '不可恢复' });
    }
    BFUI.pick({ title: b.title, desc: pathOf(b.cat || null).map(TITLE).join(' › ') + '　·　' + b.questions.length + ' 题', items: items })
      .then(function (v) {
        if (v === 'start') startBankWrapped(id);
        else if (v === 'move') askMoveBank(id);
        else if (v === 'export') { if (typeof exportBank === 'function') exportBank(b); }
        else if (v === 'rename') askRenameBank(id);
        else if (v === 'edit') editBank(id);
        else if (v === 'del') askDelBank(id);
      });
  }

  function askRenameBank(id) {
    var b = bankOf(id); if (!b) return;
    BFUI.prompt({ title: '改名', label: '题库名称', value: b.title, test: function (v) { return v ? '' : '名称不能为空'; } })
      .then(function (v) {
        if (v == null) return;
        b.title = v;
        saveBankOrder();
        T('已改名');
        repaint();
      });
  }
  function editBank(id) {
    var b = bankOf(id); if (!b) return;
    if (typeof SS !== 'undefined') {
      SS.set('editing', b.id);
      SS.set('importText', JSON.stringify({ id: b.id, title: b.title, subtitle: b.subtitle, questions: b.questions }, null, 2));
    }
    if (typeof go === 'function') go('#/import');
  }
  function askDelBank(id) {
    var b = bankOf(id); if (!b) return;
    BFUI.confirm({
      title: '删除题库「' + b.title + '」？',
      html: '该题库的作答记录、收藏、自定义解析也会一起清掉，<b>不可恢复</b>。',
      okText: '删除', danger: true
    }).then(function (ok) {
      if (!ok) return;
      b.questions.forEach(function (q) {
        var k = kOf(b, q);
        delete ANS[k]; delete FAV[k]; delete NOTES[k];
        tombAdd('ans', k); tombAdd('fav', k); tombAdd('note', k);
      });
      if (typeof LOCAL !== 'undefined') LOCAL = LOCAL.filter(function (x) { return x.id !== b.id; });
      try { localStorage.removeItem('qbank.last.' + b.id); } catch (e) {}
      if (typeof invalidateBanks === 'function') invalidateBanks();
      try { if (typeof writeLS === 'function') writeLS('qbank.local.v2', LOCAL); } catch (e) {}
      if (typeof saveAns === 'function') saveAns();
      if (typeof saveFav === 'function') saveFav();
      if (typeof saveNotes === 'function') saveNotes();
      notifyFile();
      T('已删除');
      repaint();
    });
  }

  /* ---------- 批量动作 ---------- */
  function batPickDir(cid) {
    if (!BATCH) return;
    var ids = [cid].concat(descIds(cid));
    var n = 0;
    ids.forEach(function (d) {
      dirBanks(d).forEach(function (b) {
        if (b.paper || BATCH.sel[b.id]) return;
        BATCH.sel[b.id] = 1; n++;
      });
    });
    T(n ? ('已选中 ' + n + ' 个题库') : '这个目录里没有还没选的题库');
    repaint();
  }
  function askBatchMove() {
    if (!BATCH) return;
    var bs = batBanks();
    if (!bs.length) { T('先点题库卡片选中要移动的题库'); return; }
    var items = [{ value: '__ROOT__', label: '🏠 顶层（根目录）' }];
    catsAll().forEach(function (c) {
      items.push({ value: c.id, label: pathOf(c.id).map(TITLE).join(' › '), note: dirBanks(c.id).length + ' 个题库' });
    });
    var desc = bs.slice(0, 6).map(function (b) { return b.title; }).join('、') + (bs.length > 6 ? ' 等 ' + bs.length + ' 个' : '');
    BFUI.pick({ title: '把这 ' + bs.length + ' 个题库移动到…', desc: desc, items: items }).then(function (v) {
      if (v == null) return;
      var dir = v === '__ROOT__' ? null : v;
      var n = 0;
      bs.forEach(function (b) { if (moveBank(b.id, dir)) n++; });
      saveBankOrder();
      BATCH = null;
      T('已把 ' + n + ' 个题库移到 ' + (dir ? pathOf(dir).map(TITLE).join(' › ') : '顶层'));
      repaint();
    });
  }
  function askBatchDel() {
    if (!BATCH) return;
    var bs = batBanks();
    if (!bs.length) { T('先点题库卡片选中要删除的题库'); return; }
    var dels = bs.filter(function (b) { return b.source === 'local'; });
    var skip = bs.length - dels.length;
    if (!dels.length) { T('内置题库不能删除'); return; }
    var names = dels.slice(0, 8).map(function (b) { return E(b.title); }).join('、') + (dels.length > 8 ? ' 等 ' + dels.length + ' 个' : '');
    BFUI.confirm({
      title: '删除选中的 ' + dels.length + ' 个题库？',
      html: names + '<br>它们下面所有题目的作答记录、收藏、自定义解析也会一起清掉，<b>不可恢复</b>。'
        + (skip ? '<div class="small muted" style="margin-top:6px">另有 ' + skip + ' 个内置题库会跳过（不能删）。</div>' : ''),
      okText: '全部删除', danger: true
    }).then(function (ok) {
      if (!ok) return;
      var qn = 0;
      dels.forEach(function (b) {
        b.questions.forEach(function (q) {
          var k = kOf(b, q);
          delete ANS[k]; delete FAV[k]; delete NOTES[k];
          tombAdd('ans', k); tombAdd('fav', k); tombAdd('note', k);
          qn++;
        });
        if (typeof LOCAL !== 'undefined') LOCAL = LOCAL.filter(function (x) { return x.id !== b.id; });
        try { localStorage.removeItem('qbank.last.' + b.id); } catch (e) {}
      });
      if (typeof invalidateBanks === 'function') invalidateBanks();
      try { if (typeof writeLS === 'function') writeLS('qbank.local.v2', LOCAL); } catch (e) {}
      if (typeof saveAns === 'function') saveAns();
      if (typeof saveFav === 'function') saveFav();
      if (typeof saveNotes === 'function') saveNotes();
      notifyFile();
      BATCH = null;
      T('已删除 ' + dels.length + ' 个题库（' + qn + ' 题）' + (skip ? '，跳过 ' + skip + ' 个内置题库' : ''));
      repaint();
    });
  }
  function batchExport() {
    if (!BATCH) return;
    var bs = batBanks();
    if (!bs.length) { T('先点题库卡片选中要导出的题库'); return; }
    var raw = [], catIds = {}, qn = 0;
    bs.forEach(function (b) {
      qn += b.questions.length;
      raw.push({ id: b.id, title: b.title, subtitle: b.subtitle, source: b.source, cat: b.cat == null ? null : b.cat, ord: b.ord, questions: b.questions });
      pathOf(b.cat || null).forEach(function (c) { catIds[c.id] = 1; });
    });
    var catsOut = [];
    catsAll().forEach(function (c) { if (catIds[c.id]) catsOut.push({ id: c.id, title: c.title, parent: c.parent == null ? null : c.parent, order: +c.order || 0 }); });
    var tsTag = '';
    try { tsTag = (typeof stamp === 'function') ? stamp() : String(Date.now()); } catch (e) { tsTag = String(Date.now()); }
    if (typeof download !== 'function') { T('这个浏览器不支持直接保存文件'); return; }
    download('刷题站-题库-' + raw.length + '个-' + tsTag + '.json',
      JSON.stringify({ app: 'shuati', version: 2, exported: new Date().toISOString(), note: '刷题站·批量导出 ' + raw.length + ' 个题库', banks: raw, cats: catsOut, answers: {}, favs: {}, notes: {}, fixes: {}, papers: [] }),
      'application/json');
    T('已导出 ' + raw.length + ' 个题库（' + qn + ' 题）');
  }

  /* ---------- 拖拽 ---------- */
  /* 长按选中的那一刻会立刻重画，紧接着手指抬起产生的 click 会落在新节点上：
     用这个时间戳把「刚选中」的 600ms 内的点击忽略掉，免得一长按就跳进题库。 */
  var DRAG_AT = 0;
  function dragSticky() { return !!DRAG && (Date.now() - DRAG_AT) < 600; }
  function setDrag(d) { DRAG = d; DRAG_AT = Date.now(); }
  /* 点空白处就取消选中，避免一直卡在移动模式 */
  document.addEventListener('click', function (e) {
    if (!DRAG) return;
    if (e.target.closest && (e.target.closest('.nb-card') || e.target.closest('[data-act]'))) return;
    DRAG = null;
    repaint();
  });
  function attachDrag(host) {
    if (BATCH) return;                     // 批量多选时不做拖拽，免得点一下就被当成拖动
    var cards = host.querySelectorAll('.nb-card[draggable="true"]');
    cards.forEach(function (card) {
      /* 桌面：HTML5 拖放 */
      card.addEventListener('dragstart', function (e) {
        var isCat = card.classList.contains('nb-dir');
        setDrag({ type: isCat ? 'cat' : 'bank', id: isCat ? card.dataset.cat : card.dataset.bank });
        try { e.dataTransfer.setData('text/plain', DRAG.id); e.dataTransfer.effectAllowed = 'move'; } catch (err) {}
        card.classList.add('dragging');
      });
      card.addEventListener('dragend', function () { card.classList.remove('dragging'); });
      /* 触摸：长按 350ms 进入移动模式 */
      var lp = null, sx = 0, sy = 0;
      card.addEventListener('pointerdown', function (e) {
        if (e.target.closest('[data-act]') || e.target.closest('input')) return;
        if (e.pointerType === 'mouse') return;
        sx = e.clientX; sy = e.clientY;
        lp = setTimeout(function () {
          lp = null;
          var isCat = card.classList.contains('nb-dir');
          setDrag({ type: isCat ? 'cat' : 'bank', id: isCat ? card.dataset.cat : card.dataset.bank });
          card.classList.add('dragging');
          if (navigator.vibrate) { try { navigator.vibrate(15); } catch (err) {} }
          T('已选中，点「放到这里」选目标目录');
          repaint();
        }, 350);
      });
      card.addEventListener('pointermove', function (e) {
        if (!lp) return;
        if (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10) { clearTimeout(lp); lp = null; }
      });
      ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) {
        card.addEventListener(ev, function () { if (lp) { clearTimeout(lp); lp = null; } });
      });
      /* 放下 */
      var isCat = card.classList.contains('nb-dir');
      card.addEventListener('dragover', function (e) {
        if (!DRAG) return;
        e.preventDefault();
        card.classList.add('drop-tgt');
      });
      card.addEventListener('dragleave', function () { card.classList.remove('drop-tgt'); });
      card.addEventListener('drop', function (e) {
        card.classList.remove('drop-tgt');
        if (!DRAG) return;
        e.preventDefault();
        e.stopPropagation();
        var targetCat = isCat ? card.dataset.cat : (bankOf(card.dataset.bank) || {}).cat || null;
        dropInto(targetCat);
      });
    });
    /* 空白处放下 = 移到当前目录 */
    if (!host._nbDropBound) {
      host._nbDropBound = true;
      host.addEventListener('dragover', function (e) { if (DRAG) e.preventDefault(); });
      host.addEventListener('drop', function (e) {
        if (!DRAG) return;
        e.preventDefault();
        dropInto(CUR);
      });
    }
  }
  function dropInto(dir) {
    if (!DRAG) return;
    if (DRAG.type === 'cat') {
      if (!moveCat(DRAG.id, dir)) { T('不能移动到自己的子目录里'); return; }
      saveCats();
    } else {
      if (dir === CUR && moveBank(DRAG.id, dir)) { saveBankOrder(); }
      else applyMoveBank(DRAG.id, dir);
      saveCats({ quiet: false });
    }
    DRAG = null;
    LOCK = false;
    repaint();
  }

  /* ---------- 点击顶栏「刷题站」回根目录 ---------- */
  function hookHome() {
    if (hookHome._done) return;
    hookHome._done = true;
    var t = document.getElementById('appTitle');
    if (t && !t._nbHome) {
      t._nbHome = true;
      t.addEventListener('click', function () { CUR = null; QUERY = ''; DRAG = null; });
    }
    var btn = document.getElementById('btnHome');
    if (btn && !btn._nbHome) {
      btn._nbHome = true;
      btn.addEventListener('click', function () { CUR = null; QUERY = ''; DRAG = null; });
    }
  }

  /* ---------- 空目录清理（批量导入后顺手用） ---------- */
  /* 空目录 = 自己以及所有子目录里，一个题库都没有 */
  function emptyDirIds() {
    ensure();
    var all = bankList();
    return CAT.filter(function (c) {
      var ids = [c.id].concat(descIds(c.id));
      return !all.some(function (b) { return ids.indexOf(b.cat) >= 0; });
    }).map(function (c) { return c.id; });
  }
  /* 真正删掉这些目录节点（里面的题库本来就没有），返回删掉的目录数 */
  function deleteDirs(ids) {
    ensure();
    if (!ids || !ids.length) return 0;
    var set = {};
    ids.forEach(function (x) { set[x] = 1; });
    var n = CAT.filter(function (c) { return set[c.id]; }).length;
    CAT = CAT.filter(function (c) { return !set[c.id]; });
    if (CUR && set[CUR]) CUR = null;
    saveCats();
    try { invalidateBanks(); } catch (e) {}
    notifyFile();
    try { if (typeof window.render === 'function') window.render(); } catch (e) {}
    return n;
  }
  function askDelEmpty(silentWhenNone) {
    var ids = emptyDirIds();
    if (!ids.length) { if (!silentWhenNone) T('没有空目录，每个目录里都有题库。'); return Promise.resolve(0); }
    return BFUI.confirm({
      title: '清掉 ' + ids.length + ' 个空目录？',
      html: '这些目录（含它们下面的空子目录）里一个题库都没有，删掉不会动到任何题目、作答记录和收藏。',
      okText: '清掉空目录',
      danger: true
    }).then(function (ok) {
      if (!ok) return 0;
      var n = deleteDirs(ids);
      T('已清掉 ' + n + ' 个空目录');
      return n;
    });
  }

  /* ---------- 对外接口 ---------- */
  window.CAT = {
    KEY: CAT_KEY,
    all: catsAll,
    kids: kids,
    get: byId,
    path: pathOf,
    descIds: descIds,
    dirBanks: dirBanks,
    cur: function () { return CUR; },
    setCur: function (id) { CUR = id || null; CUR_SET = true; },
    create: createCat,
    importCats: importCats,
    rename: renameCat,
    move: moveCat,
    moveBank: moveBank,
    save: saveCats,
    bankStat: bankStat,
    subStat: subStat,
    renderHook: catRenderHook,
    treeHtml: treeHtml,
    render: repaint,
    reload: function () { try { CAT = null; ensure(); hookHome(); } catch (e) {} },
    batch: function () { return BATCH ? { n: batCount(), ids: Object.keys(BATCH.sel) } : null; },
    visibleBanks: visibleBanks,
    openDir: openDir,
    menu: catMenu,              // 目录「⋯」菜单（测试/自动化用）
    delDeep: askDelCatDeep,     // 删除目录并连里面的题库一起删
    emptyDirs: emptyDirIds,     // 空目录 id 列表
    delEmpty: deleteDirs,       // 直接删掉这些空目录（返回删掉数）
    cleanEmpty: askDelEmpty     // 带确认框的空目录清理
  };
})();
