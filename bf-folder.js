/* ============================================================
   刷题站 · 批量导入题库文件夹 bf-folder.js
   ————————————————————————————————————————————————
   干什么：把一整个文件夹（可多层嵌套）里的 .json / .txt 题库
   一次性导进来，并按文件夹结构自动建好分类目录。

     天天师兄课后巩固-分章题库/
       内科学/01 内科课后巩固 1.json   →  分类「内科学」下的题库

   建目录只有一条规则：照文件夹层级「镜像」——大文件夹当顶层目录，
   里面的每个子文件夹各建一层（有几层建几层），题库放进它所在的那个
   小文件夹目录里。不提供别的策略，避免和资源管理器里看到的不一样。
   （散文件没带文件夹信息 → 预览里直接拦住，让你改选整个文件夹。）

   预览面板里的「要导入的部分」是一棵可勾选的目录树（按真实层级缩进）：
   取消勾选某个文件夹，它下面的文件就都不导。

   怎么选文件夹：
     1) 「选择文件夹」按钮（Chrome / Edge 支持选整个文件夹）；
     2) 直接把文件夹拖到这里（拖拽是唯一在 file:// 下也能用的通用方式）。

   去重：同 id 或「同名 + 同题数」的题库会被认出来，可选跳过或覆盖。
   ============================================================ */
(function () {
  'use strict';

  var LS_LAST = 'qbank.lastbatch.v1';
  var MAX_FILES = 3000;
  var MAX_BYTES = 60 * 1024 * 1024;

  var SCAN = null;                  // 最近一次扫描结果
  var INCLUDE = {};                 // 每个一级文件夹是否纳入
  var BUSY = false;
  /* 改完这个文件就顺手改一下 BUILD：面板上会显示它，方便确认浏览器跑的是不是最新代码
     （站点有 Service Worker，旧 JS 会被缓存 —— index.html 里靠 ?v=20261014d 穿透） */
  var BUILD = 'v3 · 镜像模式';

  function T(msg, ms) {
    if (typeof toast === 'function') { try { toast(msg, ms); return; } catch (e) {} }
    if (window.console) console.log('[批量导入]', msg);
  }
  function E(s) {
    if (typeof esc === 'function') return esc(s);
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function readLS(k, d) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
  function writeLS(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  function catAll() { try { return (window.CAT && CAT.all) ? CAT.all() : []; } catch (e) { return []; } }
  /* 预览勾选的粒度：所选文件夹下面的一级子目录名。
     note：拖 / 选文件夹时 path[0] 就是被选中的那个文件夹自己（walkEntry 从 [entry.name] 起步），
     所以要把根那一段跳掉，否则所有文件都会被塞进同一个分组。 */
  function groupKey(row) {
    var p = (row && row.path) || [];
    var i = 0;
    if (SCAN && SCAN.rootName && p.length && p[0] === SCAN.rootName) i = 1;
    return p.length > i ? p[i] : '__flat__';
  }
  function catsOf(list) { var m = {}; (list || []).forEach(function (c) { m[c.id] = c; }); return m; }
  function catIdOf(title, parentId) {
    var by = catsOf(catAll());
    var hit = null;
    Object.keys(by).forEach(function (k) {
      var c = by[k];
      if (String(c.title) === String(title) && (c.parent || null) === (parentId || null)) hit = c.id;
    });
    return hit;
  }

  /* ---------- 一层层读出文件夹里的文件 ---------- */
  function readEntries(reader) {
    return new Promise(function (resolve) {
      var all = [];
      function step() {
        try {
          reader.readEntries(function (batch) {
            if (!batch || !batch.length) { resolve(all); return; }
            all = all.concat(Array.prototype.slice.call(batch));
            if (all.length > MAX_FILES) { resolve(all); return; }
            step();
          }, function () { resolve(all); });
        } catch (e) { resolve(all); }
      }
      step();
    });
  }
  function readFile(file) {
    return new Promise(function (resolve) {
      try {
        if (file.text) { file.text().then(resolve, function () { resolve(''); }); return; }
      } catch (e) {}
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result || '')); };
      fr.onerror = function () { resolve(''); };
      fr.readAsText(file, 'utf-8');
    });
  }
  /* FileSystemEntry 递归：{ path:[...], file:File }[] */
  function walkEntry(entry, path, out, limit) {
    return new Promise(function (resolve) {
      if (!entry || out.length >= (limit || MAX_FILES)) { resolve(); return; }
      if (entry.isFile) {
        entry.file(function (f) { out.push({ path: path, file: f }); resolve(); }, function () { resolve(); });
        return;
      }
      if (entry.isDirectory) {
        readEntries(entry.createReader()).then(function (list) {
          var i = 0;
          function next() {
            if (i >= list.length || out.length >= (limit || MAX_FILES)) { resolve(); return; }
            var child = list[i++];
            walkEntry(child, path.concat([child.name]), out, limit).then(next, next);
          }
          next();
        }, function () { resolve(); });
        return;
      }
      resolve();
    });
  }
  /* 拖进来的 DataTransfer → 普通文件列表（尽量走 entry 以保留目录名） */
  function collectDrop(dt) {
    var out = [];
    var items = dt && dt.items ? Array.prototype.slice.call(dt.items) : [];
    var hasDir = false;
    var jobs = items.map(function (it) {
      var entry = null;
      try { if (it.kind === 'file' && it.webkitGetAsEntry) entry = it.webkitGetAsEntry(); } catch (e) { entry = null; }
      if (entry && entry.isDirectory) hasDir = true;
      if (!entry) return Promise.resolve();
      return walkEntry(entry, [entry.name], out);
    });
    return Promise.all(jobs).then(function () {
      if (out.length) return { files: out, folderCount: countDirs(out) };
      /* 兜底：没有 entry（老浏览器 / 测试环境）就看 webkitRelativePath */
      var files = dt && dt.files ? Array.prototype.slice.call(dt.files) : [];
      var list = files.map(function (f) {
        var rel = f.webkitRelativePath || f.name;
        var parts = rel.split('/').filter(function (x) { return x; });
        return { path: parts, file: f };
      });
      return { files: list, folderCount: Math.max(hasDir ? 1 : 0, countDirs(list)) };
    });
  }
  function countDirs(list) {
    var s = {};
    (list || []).forEach(function (x) { if (x.path.length > 1) s[x.path.slice(0, -1).join('/')] = 1; });
    return Object.keys(s).length;
  }

  /* ---------- 解析每个文件成题库 ---------- */
  function parseBank(text, name) {
    var d;
    try { d = JSON.parse(text); } catch (e) { return { err: 'JSON 格式不对' }; }
    var arr = null;
    if (Array.isArray(d)) arr = d;
    else if (d && Array.isArray(d.questions)) arr = [d];
    else if (d && Array.isArray(d.banks)) arr = d.banks;
    if (!arr) return { err: '没有 questions 数组' };
    var out = [];
    arr.forEach(function (b) {
      if (!b || typeof b !== 'object' || !Array.isArray(b.questions) || !b.questions.length) return;
      var qs = b.questions.map(function (q, i) { return (typeof normalizeQ === 'function') ? normalizeQ(q, i + 1) : q; })
        .filter(function (q) { return q && q.stem && (q.options || []).length >= 2; });
      if (!qs.length) return;
      out.push({
        id: String(b.id || ''),
        title: String(b.title || name || '未命名题库'),
        subtitle: String(b.subtitle || ''),
        questions: qs
      });
    });
    if (!out.length) return { err: '没解析出题目' };
    return { banks: out };
  }

  /* ---------- 扫描：目录树 + 去重标记 ---------- */
  function scan(list, opts) {
    opts = opts || {};
    var files = (list || []).filter(function (x) {
      return /\.json$/i.test(x.file.name) || /\.txt$/i.test(x.file.name);
    });
    if (!files.length) { T('这个文件夹里没有 .json / .txt 题库文件'); return Promise.resolve(null); }
    var totalBytes = files.reduce(function (s, x) { return s + (x.file.size || 0); }, 0);
    if (totalBytes > MAX_BYTES) { T('文件夹太大（' + (totalBytes / 1048576).toFixed(0) + ' MB），请分批导入'); return Promise.resolve(null); }
    T('正在读取 ' + files.length + ' 个文件…', 1500);

    var rootName = null;
    var dirs = {};
    var noFolder = 0;                                // 没带文件夹信息的文件（直接选/拖进来的散文件）
    files.forEach(function (x) {
      var rel = x.path.slice(0, -1);                 // 去掉文件名，剩下的就是它所在的文件夹链
      if (!rel.length) { noFolder++; return; }
      if (!rootName) rootName = rel[0];
      dirs[rel.join('/')] = 1;
    });
    var dirKeys = Object.keys(dirs);
    var flat = (dirKeys.length <= 1);

    var existing = {};
    (typeof LOCAL !== 'undefined' && Array.isArray(LOCAL) ? LOCAL : []).forEach(function (b) {
      existing[b.id] = b;
      existing['t:' + String(b.title) + '|' + (b.questions || []).length] = b;
    });

    return Promise.all(files.map(function (x) {
      return readFile(x.file).then(function (text) { x.text = text; });
    })).then(function () {
      var rows = [];
      files.forEach(function (x) {
        var rel = x.path.slice(0, -1);                        // 原样照搬，一层都不许少
        var base = x.file.name.replace(/\.(json|txt)$/i, '');
        var r = parseBank(x.text, base);
        rows.push({ path: rel, name: x.file.name, base: base, size: x.file.size, banks: r.banks || [], err: r.err || '' });
      });
      var totalQ = 0, okFiles = 0, dup = 0, errFiles = 0, newBanks = 0;
      rows.forEach(function (r) {
        if (r.err) { errFiles++; return; }
        okFiles++;
        r.banks.forEach(function (b) {
          b.n = b.questions.length;
          totalQ += b.n;
          var hit = (b.id && existing[b.id]) || existing['t:' + b.title + '|' + b.n];
          b.dup = !!hit;
          if (b.dup) dup++; else newBanks++;
        });
      });
      /* 目录树：预览里勾选、导入时建目录，都以它为准。
         每行同时写入 dirKeys（从根到它所在文件夹的每一级 key） */
      var tree = buildTree(rows);
      collect(tree, rows);
      var gList = tree.kids.map(function (n) {
        return { key: n.key, title: n.title, files: n.files, qs: n.qs, errs: n.errs, rows: n.allRows.slice(), node: n };
      }).sort(function (a, b) {
        if (a.key === '__flat__') return -1;
        if (b.key === '__flat__') return 1;
        return String(a.title).localeCompare(String(b.title), 'zh');
      });
      var existingTitles = {};
      ((typeof LOCAL !== 'undefined' && Array.isArray(LOCAL)) ? LOCAL : []).forEach(function (b) { existingTitles[String(b.title)] = 1; });

      var res = {
        files: files.length, okFiles: okFiles, errFiles: errFiles,
        totalQ: totalQ, dup: dup, newBanks: newBanks,
        groups: gList, rows: rows, tree: tree, flat: flat,
        rootName: rootName, noFolder: noFolder,
        candidateTop: rootName,
        existingTitles: existingTitles,
        cur: (function () { try { return (window.CAT && CAT.cur) ? CAT.cur() : null; } catch (e) { return null; } })()
      };
      return res;
    });
  }

  /* ---------- 目录树 / 建目录的统一规则 ---------- */
  /* 把 rows 的目录链拼成一棵树；顺手给每行写上 dirKeys（祖先 key 链） */
  function buildTree(rows) {
    var root = { key: '', title: '', depth: 0, kids: [], rows: [] };
    var byKey = { '': root };
    rows.forEach(function (r, i) {
      var acc = (r.path || []).slice();
      if (!acc.length) acc = ['__flat__'];
      /* 累计 key：'丁大目录'、'丁大目录/外科学' —— 必须和树节点的 key 一致，
         否则「取消勾选某个子文件夹」时祖先判断会查不到 */
      r.dirKeys = acc.map(function (_, i) { return acc.slice(0, i + 1).join('/'); });
      var node = root;
      acc.forEach(function (seg, idx) {
        var full = acc.slice(0, idx + 1).join('/');
        var n = byKey[full];
        if (!n) {
          n = {
            key: full,
            title: (full === '__flat__' ? '（没带文件夹的散文件）' : seg),
            depth: idx + 1, kids: [], rows: []
          };
          byKey[full] = n;
          node.kids.push(n);
        }
        node = n;
      });
      node.rows.push(i);
    });
    root.byKey = byKey;
    return root;
  }
  /* 自下而上汇总每个节点：文件数 / 题数 / 读不了的文件数 / 子孙行号 */
  function collect(node, rows) {
    node.files = node.rows.length;
    node.qs = 0; node.errs = 0;
    node.allRows = node.rows.slice();
    node.rows.forEach(function (i) {
      var r = rows[i];
      (r.banks || []).forEach(function (b) { node.qs += (b.n || 0); });
      if (r.err) node.errs++;
    });
    node.kids.forEach(function (k) {
      collect(k, rows);
      node.files += k.files; node.qs += k.qs; node.errs += k.errs;
      node.allRows = node.allRows.concat(k.allRows);
    });
    return node;
  }
  /* INCLUDE[完整目录 key] === false 表示这一支下面都不导 */
  function pickedRows(res) {
    return res.rows.filter(function (r) {
      var keys = r.dirKeys || ['__flat__'];
      for (var i = 0; i < keys.length; i++) { if (INCLUDE[keys[i]] === false) return false; }
      return true;
    });
  }
  function setBranchIncl(node, val) {
    INCLUDE[node.key] = val;
    node.kids.forEach(function (k) { setBranchIncl(k, val); });
  }
  function cssKey(k) { return String(k).replace(/"/g, '\\"'); }
  /* 「这一行」将来放进哪一串目录 —— 只有一条规则：
     照它在硬盘上的文件夹层级，一模一样地镜像过来。
     预览里的「将建成」和真正导入都走这一个函数，保证所见即所得。 */
  function dirsFor(r) { return (r.path || []).slice(); }

  /* ---------- 预览面板 ---------- */
  function ensurePanel() {
    var p = document.getElementById('bfBatchPanel');
    if (p) return p;
    p = el('div', 'bfBatchPanel');
    p.id = 'bfBatchPanel';
    p.style.display = 'none';
    document.body.appendChild(p);
    return p;
  }
  function statusText() {
    var last = readLS(LS_LAST, null);
    if (!last) return '';
    try { return '上次批量导入：' + (typeof fmtTime === 'function' ? fmtTime(last.ts) : new Date(last.ts).toLocaleString()) + '（' + last.banks + ' 个题库 / ' + last.q + ' 题）'; } catch (e) { return ''; }
  }

  function renderPreview(res) {
    SCAN = res;
    INCLUDE = {};
    (function markAll(n) { INCLUDE[n.key] = true; n.kids.forEach(markAll); })(res.tree);
    var host = ensurePanel();
    var C = res.candidateTop || '';
    /* 没带文件夹结构的散文件：全都没有 → 直接拦下来不让导；只有一部分 → 默认不勾选 */
    var loose = res.rows.filter(function (r) { return !(r.path || []).length; });
    var allLoose = loose.length > 0 && loose.length === res.rows.length;
    if (res.noFolder) INCLUDE['__flat__'] = false;
    var warnNoFolder = !loose.length ? '' : (allLoose
      ? '<div class="bffWarn">⚠ <b>这批文件没带文件夹结构</b>（浏览器只在「选择文件夹」或「把文件夹拖进来」时才给这个信息），所以没法照资源管理器那样建目录。<br>'
        + '请点下面的 <b>「改选文件夹…」</b>，把<b>整个大文件夹</b>选进来——大文件夹会成为顶层目录，里面的每个小文件夹各建一层，题库放进对应的小文件夹里。'
        + '<br>只想导单个题库文件的话，直接把 .json 拖到网页上就行。</div>'
      : '<div class="bffWarn">⚠ 有 <b>' + loose.length + '</b> 个散文件没带文件夹结构（'
        + E(loose.slice(0, 3).map(function (r) { return r.base; }).join('、')) + (loose.length > 3 ? ' 等' : '')
        + '），已默认<b>不勾选</b>；要一起导就在下面「没带文件夹的散文件」里勾上（它们会放在顶层）。</div>');
    function nodeHtml(n, depth) {
      var isFlat = (n.key === '__flat__');
      var out = '<label class="bffRow" style="padding-left:' + (4 + depth * 18) + 'px">'
        + '<input type="checkbox" data-g="' + cssKey(n.key) + '"' + ((isFlat && res.noFolder) ? '' : ' checked') + '>'
        + '<span class="bffT">' + (isFlat ? '' : '<span class="bffIco">' + (n.kids.length ? '📂' : '📁') + '</span> ') + E(n.title) + '</span>'
        + '<span class="bffN">' + n.files + ' 个文件 · ' + n.qs + ' 题' + (n.errs ? ' · <span class="warn">' + n.errs + ' 个读不了</span>' : '') + '</span>'
        + '</label>';
      n.kids.forEach(function (k) { out += nodeHtml(k, depth + 1); });
      return out;
    }
    var rows = res.tree.kids.map(function (n) { return nodeHtml(n, 0); }).join('');

    host.innerHTML = '<div class="bffBox">'
      + '<div class="bffHead"><b>批量导入预览</b><span class="small muted" style="margin-left:8px">' + BUILD + '</span><span class="spacer-grow"></span><button class="btn tiny" id="bffClose">关闭</button></div>'
      + '<div class="bffSummary">共 <b>' + res.files + '</b> 个文件（成功解析 ' + res.okFiles + (res.errFiles ? '，失败 ' + res.errFiles : '') + '）'
      + ' · 合计 <b>' + res.totalQ + '</b> 题 · 新题库 <b>' + res.newBanks + '</b> 个'
      + (res.dup ? ' · 已存在 <span class="warn">' + res.dup + '</span> 个' : '') + '</div>'
      + warnNoFolder
      + '<div class="bffOpts">目录怎么建<span class="small muted">：完全照文件夹层级镜像 —— 大文件夹当顶层目录，里面每个小文件夹各建一层，题库放进它所在的那个小文件夹里</span></div>'
      + (C ? '<div class="bffMirror">📂 ' + E(C) + ' <span class="muted">▸</span> 子文件夹 <span class="muted">▸</span> … <span class="muted">▸</span> 题库</div>' : '')
      + '<div class="bffOpts">已经导过的同一个题库' + (res.dup ? '（这次有 <b>' + res.dup + '</b> 个重复）' : '（这次没有重复的）') + '：</div>'
      + '<div class="bffRadios">'
      + '<label class="chk"><input type="radio" name="bfdup" value="skip" checked><span class="chkTxt">保留原来的<span class="small muted">（题目不动，只把它摆到文件夹对应的目录里）</span></span></label>'
      + '<label class="chk"><input type="radio" name="bfdup" value="over"><span class="chkTxt">用新文件覆盖<span class="small muted">（题目 / 解析换成文件里的）</span></span></label>'
      + '</div>'
      + '<div class="bffOpts">要导入的部分<span class="small muted">（按文件夹层级列出；取消勾选一个文件夹，它下面的就都不导）</span>：</div>'
      + '<div class="bffList">' + rows + '</div>'
      + '<div class="bffPlan" id="bffPlan"></div>'
      + '<div class="actions">'
      + '<button class="btn primary" id="bffGo"' + (allLoose ? ' disabled' : '') + '>' + (allLoose ? '开始导入（请先选文件夹）' : '开始导入') + '</button>'
      + (allLoose ? '<button class="btn" id="bffRepick">改选文件夹…</button>' : '')
      + '<button class="btn" id="bffAll">全选 / 全不选</button>'
      + '<button class="btn" id="bffCancel">取消</button>'
      + '</div>'
      + '<div class="small muted" id="bffMsg"></div>'
      + '</div>';
    host.style.display = 'flex';

    function close() { host.style.display = 'none'; host.innerHTML = ''; }
    var c1 = host.querySelector('#bffClose'); if (c1) c1.onclick = close;
    var c2 = host.querySelector('#bffCancel'); if (c2) c2.onclick = close;
    /* 「将建成」实时预览：勾选变化就重算，和真正导入走同一个 dirsFor */
    var planBox = host.querySelector('#bffPlan');
    function refreshPlan() {
      if (!planBox) return;
      var picked = pickedRows(res);
      var order = [], map = {};
      var banks = 0, qs = 0;
      picked.forEach(function (r) {
        if (r.err) return;
        var dirs = dirsFor(r);
        var key = dirs.length ? dirs.join(' › ') : '（顶层，没建分类）';
        if (!map[key]) { map[key] = { key: key, dirs: dirs, banks: 0, qs: 0 }; order.push(map[key]); }
        map[key].banks += r.banks.length;
        r.banks.forEach(function (b) { map[key].qs += (b.n || 0); banks++; qs += (b.n || 0); });
      });
      order.sort(function (a, b) { return String(a.key).localeCompare(String(b.key), 'zh'); });
      var show = order.slice(0, 10);
      var lines = show.map(function (o) {
        var depth = Math.max(0, o.dirs.length - 1);
        return '<div class="bffPlanRow" style="padding-left:' + (depth * 16) + 'px">'
          + '<span class="bffIco">' + (o.dirs.length ? (depth ? '└' : '📁') : '·') + '</span>'
          + '<span class="bffPlanT">' + E(o.key) + '</span>'
          + '<span class="bffPlanN">' + o.banks + ' 个题库 · ' + o.qs + ' 题</span></div>';
      }).join('');
      planBox.innerHTML = '<div class="bffPlanHead">将建成 <b>' + order.length + '</b> 个位置 · ' + banks + ' 个题库 / ' + qs + ' 题</div>'
        + lines
        + (order.length > show.length ? '<div class="small muted">…还有 ' + (order.length - show.length) + ' 个位置</div>' : '');
    }
    var c3 = host.querySelector('#bffAll');
    if (c3) c3.onclick = function () {
      var boxes = Array.prototype.slice.call(host.querySelectorAll('[data-g]'));
      var anyOff = boxes.some(function (b) { return !b.checked; });
      boxes.forEach(function (b) { b.checked = anyOff; INCLUDE[b.dataset.g] = anyOff; });
      refreshPlan();
    };
    host.querySelectorAll('[data-g]').forEach(function (b) {
      b.onchange = function () {
        var node = res.tree.byKey[b.dataset.g];
        if (node) {
          setBranchIncl(node, b.checked);
          (function sync(n) {
            n.kids.forEach(function (k) {
              var kb = host.querySelector('[data-g="' + cssKey(k.key) + '"]');
              if (kb) kb.checked = INCLUDE[k.key] !== false;
              sync(k);
            });
          })(node);
        } else INCLUDE[b.dataset.g] = b.checked;
        refreshPlan();
      };
    });
    var rp = host.querySelector('#bffRepick');
    if (rp) rp.onclick = function () { pickFolder().then(function (res2) { if (res2) renderPreview(res2); }); };
    refreshPlan();
    var goBtn = host.querySelector('#bffGo');
    if (goBtn) goBtn.onclick = function () { doImport(host, goBtn); };
  }

  function chosenDup(host) {
    var r = host.querySelector('input[name="bfdup"]:checked');
    return r ? r.value : 'skip';
  }
  /* 真正要导的行：任何一级祖先目录被取消勾选 → 这一行不导 */
  function chosenPicked(host, res) {
    var boxes = {}, any = false;
    host.querySelectorAll('[data-g]').forEach(function (b) { boxes[b.dataset.g] = b.checked; any = true; });
    if (!any) return pickedRows(res);
    return res.rows.filter(function (r) {
      var keys = r.dirKeys || ['__flat__'];
      for (var i = 0; i < keys.length; i++) { if (boxes[keys[i]] === false) return false; }
      return true;
    });
  }

  /* ---------- 真正导入 ---------- */
  function doImport(host, btn) {
    if (!SCAN || BUSY) return;
    BUSY = true;
    btn.disabled = true;
    var msg = host.querySelector('#bffMsg');
    var dupMode = chosenDup(host);
    var res = SCAN;
    var picked = chosenPicked(host, res);
    if (!picked.length) { msg.textContent = '一个都没勾，没东西可导。'; btn.disabled = false; BUSY = false; return; }
    if (!res.rows.some(function (r) { return (r.path || []).length; })) {
      msg.textContent = '这些文件没带文件夹结构，没法建子目录 —— 请点「改选文件夹…」把整个文件夹选进来。';
      btn.disabled = false; BUSY = false; return;
    }
    /* 每一行落在哪一串目录，全部交给 dirsFor（照文件夹层级镜像，和预览里看到的一致） */
    var baseParent = null;

    var madeCats = 0, dupSkip = 0, added = 0, dupOver = 0;

    function ensureCat(title, parentId) {
      if (!title) return parentId;
      var id = catIdOf(title, parentId);
      if (id) return id;
      if (typeof CAT !== 'undefined' && CAT && CAT.create) {
        madeCats++;
        var made = null;
        try { made = CAT.create(parentId, title); } catch (e) { made = null; }
        if (made && typeof made === 'string') id = made;
        if (made && typeof made === 'object' && made.id) id = made.id;
        if (!id) id = catIdOf(title, parentId);   // create 没回 id 时再查一次
        return id || parentId || null;
      }
      return parentId || null;
    }
    /* 把一串目录名建成真实目录，返回最深那一层的 id（同一个父 + 同名会复用） */
    var chainCache = {};
    var madePaths = [];
    function ensureChain(dirs, baseId) {
      var pid = baseId || null;
      for (var i = 0; i < dirs.length; i++) {
        var ck = (pid || '') + '|' + dirs[i];
        if (chainCache[ck] !== undefined) { pid = chainCache[ck]; continue; }
        var before = madeCats;
        pid = ensureCat(dirs[i], pid);
        chainCache[ck] = pid;
        if (madeCats > before) madePaths.push(dirs.slice(0, i + 1).join(' › '));
      }
      return pid;
    }

    var topLandId = null;            // 导完把用户带到新建的顶层目录
    var fatal = null;
    try {
      picked.forEach(function (r) {
        if (r.err) return;
        var dirs = dirsFor(r);
        var dirId = ensureChain(dirs, baseParent);
        if (!topLandId && dirs.length) topLandId = ensureChain([dirs[0]], baseParent);
        r.banks.forEach(function (b) {
          var ex = null;
          if (b.id && typeof LOCAL !== 'undefined') ex = LOCAL.filter(function (x) { return x.id === b.id; })[0];
          if (!ex && typeof LOCAL !== 'undefined') ex = LOCAL.filter(function (x) { return String(x.title) === b.title && (x.questions || []).length === b.n; })[0];
          if (ex) {
            if (dupMode === 'skip') {
              /* 保留原来的题目，但位置要按文件夹结构摆好：以前导过、位置不对的（或者裸在顶层的）顺手归位 */
              if (dirId && ex.cat !== dirId) {
                ex.cat = dirId;
                if (typeof CAT !== 'undefined' && CAT && CAT.save) { try { CAT.save({ quiet: true }); } catch (e) {} }
              }
              dupSkip++; return;
            }
            ex.title = b.title; ex.questions = b.questions;
            if (b.subtitle) ex.subtitle = b.subtitle;
            ex.cat = dirId || null;
            dupOver++;
            return;
          }
          var id = b.id || ('local-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6));
          if (typeof LOCAL !== 'undefined' && LOCAL.some(function (x) { return x.id === id; })) id += '-' + Math.random().toString(36).slice(2, 6);
          LOCAL.push({
            id: id, title: b.title,
            subtitle: b.subtitle || ('批量导入 · ' + b.n + ' 题'),
            cat: (typeof dirId === 'string' && dirId) ? dirId : null,
            questions: b.questions
          });
          added++;
        });
      });
    } catch (e) { fatal = e; }

    if (typeof CAT !== 'undefined' && CAT && CAT.save) { try { CAT.save({ quiet: true }); } catch (e) {} }
    if (typeof writeLS === 'function' && typeof LS !== 'undefined' && LOCAL) writeLS(LS.banks, LOCAL);
    if (typeof invalidateBanks === 'function') invalidateBanks();
    if (typeof BF !== 'undefined' && BF && BF.autoSave) { try { BF.autoSave(); } catch (e) {} }
    writeLS(LS_LAST, { ts: Date.now(), banks: added + dupOver, q: picked.reduce(function (s, r) { return s + r.banks.reduce(function (t, b) { return t + b.n; }, 0); }, 0), mode: 'mirror' });

    BUSY = false;
    btn.disabled = false;
    var tip = '导入完成：新增 ' + added + ' 个题库'
      + (dupOver ? '，覆盖 ' + dupOver + ' 个' : '')
      + (dupSkip ? '，跳过已存在 ' + dupSkip + ' 个' : '')
      + (madeCats ? '，新建 ' + madeCats + ' 个分类目录' : '')
      + (fatal ? '（出错：' + fatal.message + '）' : '');
    if (msg) msg.textContent = tip;
    T(tip, 3600);
    /* 不直接关掉面板：给一张「导入结果」，能一眼核对目录结构，并顺手清空目录 */
    showResult(host, {
      picked: picked, added: added, dupOver: dupOver, dupSkip: dupSkip,
      madeCats: madeCats, madePaths: madePaths, topLandId: topLandId, fatal: fatal, tip: tip
    });
  }

  /* ---------- 导入结果清单：放进哪些目录、各放几个题库 ---------- */
  function showResult(host, r) {
    var groups = {}, order = [];
    r.picked.forEach(function (row) {
      if (row.err) return;
      var dirs = dirsFor(row);
      var key = dirs.length ? dirs.join(' › ') : '（顶层，不建目录）';
      if (!groups[key]) { groups[key] = { dirs: dirs, banks: 0, q: 0 }; order.push(key); }
      groups[key].banks += row.banks.length;
      groups[key].q += row.banks.reduce(function (s, b) { return s + (b.n || 0); }, 0);
    });
    var listHtml = order.map(function (k) {
      var g = groups[k];
      var made = g.dirs.length && r.madePaths.indexOf(g.dirs.join(' › ')) >= 0;
      return '<div class="bffRow" style="padding-left:' + (4 + Math.max(0, g.dirs.length - 1) * 18) + 'px">'
        + '<span class="bffT">' + (g.dirs.length ? (made ? '<span class="bffNew">新</span>' : '<span class="bffIco">📂</span> ') : '') + E(k) + '</span>'
        + '<span class="bffN">' + g.banks + ' 个题库 · ' + g.q + ' 题</span></div>';
    }).join('') || '<div class="bffRow"><span class="bffT muted">这次没有要导入的文件</span></div>';
    var emptyN = 0;
    try { if (window.CAT && CAT.emptyDirs) emptyN = CAT.emptyDirs().length; } catch (e) { emptyN = 0; }
    host.innerHTML = '<div class="bffBox">'
      + '<div class="bffHead"><b>导入完成</b><span class="small muted" style="margin-left:8px">' + BUILD + '</span>'
      + '<span class="spacer-grow"></span><button class="btn tiny" id="bffDone">关闭</button></div>'
      + '<div class="bffSummary">新增 <b>' + r.added + '</b> 个题库'
      + (r.dupOver ? ' · 用新文件覆盖 <b>' + r.dupOver + '</b> 个' : '')
      + (r.dupSkip ? ' · 保留原来的 <b>' + r.dupSkip + '</b> 个' : '')
      + ' · 新建 <b>' + r.madeCats + '</b> 个目录'
      + (r.fatal ? ' · <span class="warn">出错：' + E(r.fatal.message) + '</span>' : '') + '</div>'
      + '<div class="bffOpts">题库放进这些目录<span class="small muted">（<span class="bffNew">新</span> = 这次新建的目录；层级和资源管理器一样）</span>：</div>'
      + '<div class="bffList">' + listHtml + '</div>'
      + '<div id="bffEmptyBox">' + (emptyN
        ? '<div class="bffWarn">另外站里还有 <b>' + emptyN + '</b> 个空目录（以前导进去的，现在里面一个题库都没有）。</div>' : '') + '</div>'
      + '<div class="actions">'
      + '<button class="btn primary" id="bffGoDir"' + (r.topLandId ? '' : ' disabled') + '>去新建的目录看看</button>'
      + '<button class="btn" id="bffClean"' + (emptyN ? '' : ' style="display:none"') + '>清掉这 ' + emptyN + ' 个空目录</button>'
      + '<button class="btn" id="bffDone2">关闭</button>'
      + '</div></div>';
    host.style.display = 'flex';
    function close() { host.style.display = 'none'; host.innerHTML = ''; }
    function openLand() {
      close();
      if (typeof CAT !== 'undefined' && CAT && CAT.setCur) { try { CAT.setCur(r.topLandId); } catch (e) {} }
      if (typeof go === 'function') go('#/'); else if (typeof render === 'function') render();
    }
    ['#bffDone', '#bffDone2'].forEach(function (s) { var b = host.querySelector(s); if (b) b.onclick = close; });
    var gd = host.querySelector('#bffGoDir'); if (gd) gd.onclick = openLand;
    var cl = host.querySelector('#bffClean');
    if (cl) cl.onclick = function () {
      cl.disabled = true;
      var p = (window.CAT && CAT.cleanEmpty) ? CAT.cleanEmpty() : Promise.resolve(0);
      Promise.resolve(p).then(function (n) {
        var box = host.querySelector('#bffEmptyBox');
        if (box) box.innerHTML = n ? '<div class="bffWarn">已清掉 <b>' + n + '</b> 个空目录。</div>' : '';
        cl.style.display = 'none';
        if (typeof render === 'function') { try { render(); } catch (e) {} }
      });
    };
    /* 导完就把用户带到新建的顶层目录，结果立刻看得见 */
    if (typeof CAT !== 'undefined' && CAT && CAT.setCur) { try { CAT.setCur(r.topLandId); } catch (e) {} }
    if (typeof go === 'function') go('#/'); else if (typeof render === 'function') render();
  }

  /* ---------- 选文件夹（按钮 / 拖拽） ---------- */
  function pickFolder() {
    if (typeof window.showDirectoryPicker === 'function') {
      return window.showDirectoryPicker({ mode: 'read' }).then(function (dir) {
        var out = [];
        var names = [];
        function walk(handle, path) {
          var jobs = [];
          var it = handle.values();
          if (!it || typeof it.next !== 'function') return Promise.resolve();
          /* values() 给的是异步迭代器（没有 forEach），只能一个个 next() 取 */
          function eat() {
            return it.next().then(function (r) {
              if (r.done) return Promise.all(jobs);
              var h = r.value;
              if (h && h.kind === 'file') {
                jobs.push(h.getFile().then(function (f) { out.push({ path: path, file: f }); }, function () {}));
              } else if (h && h.kind === 'directory') {
                jobs.push(walk(h, path.concat([h.name])));
              }
              return eat();
            }, function () { return Promise.all(jobs); });
          }
          return eat();
        }
        return walk(dir, [dir.name]).then(function () { return scan(out, {}); });
      }).catch(function (err) {
        if (err && (err.name === 'AbortError' || err.name === 'NotAllowedError')) return null;
        return pickFolderInput();
      });
    }
    return pickFolderInput();
  }
  function pickFolderInput() {
    return new Promise(function (resolve) {
      var inp = document.createElement('input');
      inp.type = 'file';
      inp.multiple = true;
      inp.setAttribute('webkitdirectory', '');
      inp.setAttribute('directory', '');
      inp.style.cssText = 'position:fixed;left:-9999px';
      inp.onchange = function () {
        var files = Array.prototype.slice.call(inp.files || []);
        var list = files.map(function (f) {
          var rel = f.webkitRelativePath || f.name;
          return { path: rel.split('/').filter(function (x) { return x; }), file: f };
        });
        inp.remove();
        scan(list, {}).then(resolve);
      };
      document.body.appendChild(inp);
      inp.click();
      setTimeout(function () { if (inp.parentNode) { /* 用户可能取消了：留着也无妨 */ } }, 60000);
    });
  }
  function pickFiles() {
    return new Promise(function (resolve) {
      var inp = document.createElement('input');
      inp.type = 'file';
      inp.multiple = true;
      inp.accept = '.json,.txt';
      inp.style.cssText = 'position:fixed;left:-9999px';
      inp.onchange = function () {
        var files = Array.prototype.slice.call(inp.files || []);
        var list = files.map(function (f) { return { path: [f.name], file: f }; });
        inp.remove();
        scan(list, {}).then(resolve);
      };
      document.body.appendChild(inp);
      inp.click();
    });
  }

  /* ---------- 挂到「导入 / 新建题库」页 ---------- */
  function attachToImportPage() {
    var view = document.getElementById('view');
    if (!view) return;
    if (document.getElementById('bfFolderCard')) return;
    var anchor = view.querySelector('.card');
    if (!anchor) return;
    var card = el('div', 'card');
    card.id = 'bfFolderCard';
    card.innerHTML = '<div class="name" style="font-weight:700;margin-bottom:6px">批量导入：整个文件夹的题库</div>'
      + '<div class="small muted" style="margin-bottom:10px">把<b>整个大文件夹</b>选进来，里面所有 <code>.json</code> / <code>.txt</code> 题库会一次导完，'
      + '<b>目录完全照资源管理器的层级建</b>：<code>天天师兄课后巩固-分章题库/内科学/第一章.json</code> → 顶层目录「天天师兄课后巩固-分章题库」› 子目录「内科学」› 题库。'
      + '导入前会先给你看「将建成哪些目录、各放几个题库」，确认了再导。</div>'
      + '<div class="row-inline">'
      + '<button class="btn primary" id="bfPickFolder">选择文件夹…</button>'
      + '</div>'
      + '<div class="small muted" style="margin-top:8px">也可以直接把文件夹拖到网页上（任何页面都行）。'
      + '要的就是文件夹层级，所以请选 / 拖<b>整个文件夹</b>——单独几个 .json 拖进网页会按普通导入处理，批量导入只认文件夹。'
      + '<span id="bfLastBatch">' + E(statusText()) + '</span></div>';
    view.insertBefore(card, anchor);
    var b1 = card.querySelector('#bfPickFolder');
    if (b1) b1.onclick = function () { pickFolder().then(function (res) { if (res) renderPreview(res); }); };
    var b2 = card.querySelector('#bfPickFiles');      // 老页面缓存里可能还有这个按钮
    if (b2) b2.onclick = function () { pickFolder().then(function (res) { if (res) renderPreview(res); }); };
  }

  /* ---------- 顶栏「≡」按钮：在浏览器里也可以从任意页面进入导入 ---------- */
  function boot() {
    /* 把「打开题库文件」升级成智能入口（支持文件夹） */
    if (window.BF && BF.open && !BF.open._smart) {
      var orig = BF.open;
      var smart = function () {
        return (window.BFUI && BFUI.pick ? BFUI.pick({
          title: '打开题库',
          desc: '批量导入请选文件夹：目录会照文件夹层级一模一样地建。',
          items: [
            { value: 'folder', label: '打开一个文件夹（按文件夹层级批量导入）', note: '推荐' },
            { value: 'one', label: '只打开一个题库文件（.json）' }
          ]
        }) : Promise.resolve('one')).then(function (v) {
          if (v === 'folder') return pickFolder().then(function (res) { if (res) renderPreview(res); return 'folder'; });
          if (v === 'one') return orig();
          return null;
        });
      };
      smart._smart = true;
      BF.open = smart;
    }
    /* 拖文件夹进来 */
    window.addEventListener('drop', function (e) {
      var dt = e.dataTransfer;
      if (!dt) return;
      var items = dt.items ? Array.prototype.slice.call(dt.items) : [];
      var dirish = items.some(function (it) { try { var en = it.webkitGetAsEntry && it.webkitGetAsEntry(); return !!(en && en.isDirectory); } catch (err) { return false; } });
      var files = dt.files ? Array.prototype.slice.call(dt.files) : [];
      var multi = files.length > 1;
      var hasRel = files.some(function (f) { return f.webkitRelativePath && f.webkitRelativePath.indexOf('/') > 0; });
      if (!dirish && !hasRel && !multi) return;         // 单个文件交给原来的导入逻辑
      e.preventDefault();
      e.stopPropagation();
      collectDrop(dt).then(function (r) {
        if (!r || !r.files.length) { T('没读到文件'); return; }
        return scan(r.files, {}).then(function (res) { if (res) renderPreview(res); });
      });
    }, true);

    /* 首页也给一个入口 */
    var host = document.getElementById('nbHome');
    if (host && !document.getElementById('bfHomeBatch')) {
      var bar = host.querySelector('.nb-bar');
      if (bar) {
        var b = el('button', 'btn', '＋ 批量导入文件夹');
        b.id = 'bfHomeBatch';
        b.onclick = function () { pickFolder().then(function (res) { if (res) renderPreview(res); }); };
        bar.appendChild(b);
      }
    }
  }

  window.BFF = {
    pickFolder: pickFolder,
    pickFiles: pickFiles,
    scan: scan,
    preview: renderPreview,
    attach: attachToImportPage,
    boot: boot,
    state: function () { return SCAN; }
  };
})();
