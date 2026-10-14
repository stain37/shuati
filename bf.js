/* ============================================================
   刷题站 · 本机题库文件 bf.js
   ————————————————————————————————————————————————
   为什么要有这个：自建题库原来只存在浏览器的 localStorage 里——
   换个地址打开（file:// 和 http://localhost 是两套数据）、清理缓存、
   换浏览器、无痕窗口，题库就「重置」了；localStorage 只有 5MB 左右，
   知识库一大还可能把题库挤掉。

   现在可以把「自建题库 + 分类」存成本机的 .json 文件：
     · 「保存到本机文件」  → 选一次位置，之后一键覆盖保存（浏览器支持文件系统接口时）
     · 「打开题库文件」    → 从文件读回来（合并进当前数据，不删已有的）
     · 「自动保存」        → 每次改题库自动写回那个文件（需要授权，浏览器会问一次）
     · 不支持文件系统接口的浏览器（部分苹果浏览器）自动退回「下载文件」方式
     · 支持把 .json 题库文件直接拖进网页导入
   存储：IndexedDB（只放那个文件句柄）+ localStorage 里的开关
   ============================================================ */
(function () {
  'use strict';

  var LS_KEY = 'qbank.localfile.v1';
  var DB_NAME = 'shuati-files';
  var STORE = 'handles';
  var FILE_HANDLE = 'bankfile';
  var FILE_VER = 1;
  var _db = null, _dbTried = false;

  var S = { linked: false, name: '', lastSave: 0, auto: false, rev: 0, needPerm: false };
  try { Object.assign(S, JSON.parse(localStorage.getItem(LS_KEY) || '{}')); } catch (e) {}

  function persist() {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ linked: S.linked, name: S.name, lastSave: S.lastSave, auto: S.auto })); } catch (e) {}
  }
  function T(msg, ms) {
    if (typeof toast === 'function') { try { toast(msg, ms); return; } catch (e) {} }
    if (window.console) console.log('[题库文件]', msg);
  }
  function E(s) {
    if (typeof esc === 'function') return esc(s);
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }
  function timeTxt(ts) {
    if (!ts) return '还没保存过';
    try { return (typeof fmtTime === 'function') ? fmtTime(ts) : new Date(ts).toLocaleString(); } catch (e) { return new Date(ts).toLocaleString(); }
  }
  function support() { return typeof window.showSaveFilePicker === 'function' && typeof window.showOpenFilePicker === 'function'; }

  /* ---------- IndexedDB：只存文件句柄 ---------- */
  function idb() {
    if (_db || _dbTried) return Promise.resolve(_db);
    _dbTried = true;
    return new Promise(function (resolve) {
      var req;
      try { req = indexedDB.open(DB_NAME, 1); } catch (e) { resolve(null); return; }
      req.onupgradeneeded = function () {
        try { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); } catch (e) {}
      };
      req.onsuccess = function () { _db = req.result; resolve(_db); };
      req.onerror = function () { resolve(null); };
      setTimeout(function () { resolve(_db); }, 5000);      // 有的浏览器根本不回调，别卡死
    });
  }
  function idbPut(v) {
    return idb().then(function (db) {
      if (!db) return false;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).put(v, FILE_HANDLE);
          tx.oncomplete = function () { resolve(true); };
          tx.onerror = function () { resolve(false); };
        } catch (e) { resolve(false); }
      });
    });
  }
  function idbGet() {
    return idb().then(function (db) {
      if (!db) return null;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(STORE, 'readonly');
          var rq = tx.objectStore(STORE).get(FILE_HANDLE);
          rq.onsuccess = function () { resolve(rq.result || null); };
          rq.onerror = function () { resolve(null); };
        } catch (e) { resolve(null); }
      });
    });
  }
  function idbDel() { return idbPut(null); }

  /* ---------- 数据打包 / 应用 ---------- */
  function catsData() {
    try { if (window.CAT && CAT.all) return CAT.all().map(function (c) { return { id: c.id, title: c.title, parent: c.parent, order: c.order }; }); } catch (e) {}
    try { return JSON.parse(localStorage.getItem('qbank.cats.v1')) || []; } catch (e) { return []; }
  }
  function packBank(b) {
    var o = {};
    Object.keys(b).forEach(function (k) { if (k !== 'paper') o[k] = b[k]; });
    return o;
  }
  function makePayload() {
    var banks = (typeof LOCAL !== 'undefined' ? LOCAL : []).map(packBank);
    return {
      app: 'shuati-bank-file',
      version: FILE_VER,
      type: 'bankfile',
      savedAt: new Date().toISOString(),
      cats: catsData(),
      banks: banks,
      papers: (typeof PAPERS !== 'undefined' ? PAPERS : []),
      note: '这是「刷题站」的题库文件：自建题库 + 分类 + 临时套卷。在网页首页用「打开题库文件」读回来即可；作答记录不在这里面（用「导出全部数据」备份）。'
    };
  }
  function safeName(s) { return String(s).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60); }
  function today() {
    var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
  }

  /* 读取文件并合并数据；返回 { banks, cats, papers, added } */
  function applyPayload(d) {
    if (!d || typeof d !== 'object') throw new Error('不是 JSON 对象');
    var src = null;
    if (Array.isArray(d.banks)) src = d.banks;
    else if (Array.isArray(d.questions)) src = [d];                 // 单个题库文件
    else if (Array.isArray(d.local)) src = d.local;
    if (!src) throw new Error('文件里没有题库（需要 banks 数组，或单个题库的 questions）');
    if (typeof LOCAL === 'undefined' || typeof writeLS !== 'function') throw new Error('页面还没准备好');

    var added = 0, replaced = 0;
    src.forEach(function (b) {
      if (!b || typeof b !== 'object' || !Array.isArray(b.questions)) return;
      var id = String(b.id || ('local-' + Date.now().toString(36) + '-' + added));
      b.id = id;
      var at = LOCAL.findIndex(function (x) { return x.id === id; });
      var copy = JSON.parse(JSON.stringify(b));
      if (at >= 0) {
        /* 同名同 id：题数不一样就问一次，避免把本机改过的版本直接覆盖掉 */
        var old = LOCAL[at];
        var same = (old.questions || []).length === copy.questions.length;
        if (!same && !window.confirm('题库「' + copy.title + '」文件里是 ' + copy.questions.length + ' 题，本机是 ' + (old.questions || []).length + ' 题。用文件里的版本覆盖吗？（取消 = 保留本机版本）')) return;
        LOCAL[at] = copy; replaced++;
      } else { LOCAL.push(copy); added++; }
    });

    if (Array.isArray(d.cats) && window.CAT && CAT.all) {
      if (CAT.importCats) CAT.importCats(d.cats);
      else CAT.save({ quiet: true });
    }
    if (Array.isArray(d.papers) && typeof PAPERS !== 'undefined') {
      d.papers.forEach(function (p) { if (p && p.id && !PAPERS.some(function (x) { return x.id === p.id; })) PAPERS.push(p); });
      if (typeof savePapers === 'function') savePapers();
    }
    writeLS('qbank.local.v2', LOCAL);
    if (typeof invalidateBanks === 'function') invalidateBanks();
    return { added: added, replaced: replaced, banks: LOCAL.length };
  }

  /* ---------- 保存到文件 ---------- */
  function writeHandle(handle, text) {
    return handle.createWritable().then(function (w) {
      return w.write(text).then(function () { return w.close(); });
    });
  }
  function needsPerm(handle) { return !handle.queryPermission || handle.queryPermission({ mode: 'readwrite' }) !== 'granted'; }
  function askPerm(handle) {
    if (!handle.requestPermission) return Promise.resolve(false);
    try {
      return Promise.resolve(handle.requestPermission({ mode: 'readwrite' })).then(function (p) { return p === 'granted'; }, function () { return false; });
    } catch (e) { return Promise.resolve(false); }
  }
  /* 保存：有已链接的文件就直接写，没有就弹出「另存为」 */
  function save(forceDialog) {
    var text = JSON.stringify(makePayload(), null, 2);
    if (!support()) { download(text); return Promise.resolve('download'); }
    return idbGet().then(function (h) {
      if (h && !forceDialog) {
        return askPerm(h).then(function (ok) {
          if (!ok) { S.needPerm = true; persist(); paint(); return 'denied'; }
          return writeHandle(h, text).then(function () {
            S.lastSave = Date.now(); S.linked = true; S.needPerm = false; persist(); paint();
            T('已保存到文件：' + (h.name || S.name || '题库文件.json'));
            return 'saved';
          });
        });
      }
      return window.showSaveFilePicker({
        suggestedName: '刷题站-题库-' + today() + '.json',
        types: [{ description: '刷题站题库文件', accept: { 'application/json': ['.json'] } }]
      }).then(function (nh) {
        return writeHandle(nh, text).then(function () {
          S.linked = true; S.name = nh.name || ''; S.lastSave = Date.now(); S.needPerm = false;
          persist(); idbPut(nh);
          T('已保存到本机文件：' + (nh.name || '题库文件'), 2600);
          return 'saved';
        });
      });
    }).catch(function (err) {
      if (err && (err.name === 'AbortError' || err.name === 'NotAllowedError')) { return 'cancel'; }
      T('保存失败：' + ((err && err.message) || err));
      return 'error';
    });
  }
  function download(text) {
    if (typeof download !== 'function') { T('这个浏览器不支持直接保存文件'); return; }
    download('刷题站-题库-' + today() + '.json', text, 'application/json');
    S.lastSave = Date.now(); persist(); paint();
    T('浏览器不支持文件系统接口，已改成下载文件', 3000);
  }
  /* 另存一份（永远弹窗选位置，不给外行看错文件名） */
  function saveAs() { return save(true); }

  /* ---------- 打开 / 导入文件 ---------- */
  function openFile() {
    if (typeof window.showOpenFilePicker === 'function') {
      return window.showOpenFilePicker({
        multiple: false,
        types: [{ description: '刷题站题库文件', accept: { 'application/json': ['.json'] } }]
      }).then(function (arr) {
        var h = arr[0];
        return h.getFile().then(function (f) { return f.text(); }).then(function (txt) {
          var r = applyRead(txt, h.name);
          if (r) {
            S.linked = true; S.name = h.name || ''; S.lastSave = Date.now(); S.needPerm = false;
            persist(); idbPut(h);
            paint();
          }
          return r;
        });
      }).catch(function (err) {
        if (err && (err.name === 'AbortError' || err.name === 'NotAllowedError')) return null;
        T('打开失败：' + ((err && err.message) || err));
        return null;
      });
    }
    /* 退回 <input type=file> */
    return new Promise(function (resolve) {
      var inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.json';
      inp.onchange = function () {
        var f = inp.files && inp.files[0];
        if (!f) { resolve(null); return; }
        var fr = new FileReader();
        fr.onload = function () { resolve(applyRead(String(fr.result), f.name)); };
        fr.onerror = function () { T('读取失败'); resolve(null); };
        fr.readAsText(f, 'utf-8');
      };
      inp.click();
    });
  }
  function applyRead(txt, name) {
    var d;
    try { d = JSON.parse(txt); } catch (e) { T('不是合法的 JSON 文件：' + name); return null; }
    try {
      if (d && d.app === 'shuati' && d.banks && d.cats === undefined && d.answers) {
        /* 有人把「导出全部数据」的备份拖进来了：也能用 */
        var n = 0;
        (d.banks || []).forEach(function (b) { if (b && b.questions) n++; });
        T('这是「全部数据」备份，共 ' + n + ' 个题库；用首页的「导入数据（恢复）」更完整', 4200);
      }
      var r = applyPayload(d);
      if (typeof render === 'function') render();
      T('已从「' + name + '」读入 ' + r.added + ' 个新题库' + (r.replaced ? '，覆盖 ' + r.replaced + ' 个' : '') + '，现在共 ' + r.banks + ' 个自建题库', 3600);
      return r;
    } catch (e) {
      T('导入失败：' + (e.message || e), 3600);
      return null;
    }
  }

  /* ---------- 自动保存 ---------- */
  var _t = null;
  function autoSync() {
    if (!S.auto || !S.linked) return;
    clearTimeout(_t);
    _t = setTimeout(function () { save(false).then(function (r) { if (r === 'denied') S.needPerm = true; }); }, 1800);
  }
  /* 页面打开时：已链接过文件就悄悄把权限状态查一下，问过就给个「保存」提示 */
  function checkPerm() {
    idbGet().then(function (h) {
      if (!h) { S.linked = false; paint(); return; }
      S.linked = true; S.name = S.name || h.name || '';
      var q = h.queryPermission ? h.queryPermission({ mode: 'readwrite' }) : 'prompt';
      if (q && q.then) q = q.then(function (p) { return p; });
      Promise.resolve(q).then(function (p) {
        S.needPerm = (p !== 'granted');
        if (p === 'granted' && S.auto) autoSync();
        paint();
      }, function () { paint(); });
    });
  }

  /* ---------- 诊断：数据到底能不能存住 ---------- */
  function probeLS() {
    try {
      var k = '__qbank_probe__' + Date.now();
      localStorage.setItem(k, '1');
      localStorage.removeItem(k);
      return true;
    } catch (e) { return false; }
  }
  function bytesOf() { return (typeof storageBytes === 'function') ? storageBytes() : 0; }
  function originTxt() { return location.origin === 'null' ? '本地文件（file://）' : location.origin; }

  function diagHtml() {
    var can = probeLS();
    var total = (typeof Object !== 'undefined' && typeof LOCAL !== 'undefined') ? LOCAL.length : 0;
    var bad = '';
    if (!can) {
      bad = '<div class="note err" style="margin:6px 0 10px"><b>这台浏览器现在写不进本机存储</b>'
        + '（无痕模式、隐私设置、或存储已满）。不处理的话，新建的题库关掉页面就会没了。'
        + '下面「打开题库文件」或「保存到本机文件」不受这个限制，先存成文件最稳。</div>';
    }
    return '<div class="small muted">'
      + '当前地址：' + E(originTxt()) + '　·　本机存储：' + (can ? '可写 ✓' : '写不进 ✗')
      + '　·　已占 ' + (bytesOf() / 1024 / 1024).toFixed(2) + ' MB'
      + '（浏览器一般只给 5 MB 左右；自建题库 ' + total + ' 个）'
      + '</div>'
      + bad
      + '<div class="small muted" style="margin-top:6px">小提示：<b>file:// 打开</b>和 <b>http://localhost:5173</b> 打开是两套互不相通的数据。'
      + '想让题库「跨地址都在」，就存成下面的题库文件，两边都读它。</div>';
  }

  /* ---------- 设置面板 ---------- */
  function paint() {
    var host = document.getElementById('bfBoot');
    if (!host) return;
    if (host.dataset.built !== '1') return;      // boot() 还没画过
    var t = host.querySelector('#bfFileState');
    if (t) {
      t.innerHTML = S.linked
        ? ('已链接：<b>' + E(S.name || '题库文件') + '</b>　·　最近保存 ' + E(timeTxt(S.lastSave))
           + (S.needPerm ? '　<span class="warn">（浏览器需要你点一次「保存到本机文件」重新授权）</span>' : ''))
        : '还没有链接题库文件。链接一次之后，自建题库和分类就不怕清缓存、换地址了。';
    }
    var cb = host.querySelector('#bfAuto');
    if (cb && cb.checked !== !!S.auto) cb.checked = !!S.auto;
  }

  function boot() {
    var host = document.getElementById('bfBoot');
    if (!host) return;
    if (host.dataset.built === '1') { paint(); return; }
    host.dataset.built = '1';
    host.innerHTML = '<div class="card nbfile">'
      + '<div class="nbhead"><b>本机题库文件</b>'
      + '<span class="pill">推荐</span>'
      + '<span class="spacer-grow"></span>'
      + '<button class="btn tiny" id="bfToggleBody">收起 / 展开</button></div>'
      + '<div id="bfFileState" class="small muted">—</div>'
      + '<div id="bfBody">'
      + '<div class="row-inline" style="margin-top:10px">'
      + '<button class="btn primary" id="bfSave">保存到本机文件</button>'
      + '<button class="btn" id="bfOpen">打开题库文件</button>'
      + '<button class="btn" id="bfSaveAs">另存为…</button>'
      + '<label class="chk" style="margin-left:2px"><input type="checkbox" id="bfAuto"> 自动保存（改动后自动写回文件）</label>'
      + '</div>'
      + '<div id="bfDiag" style="margin-top:10px">' + diagHtml() + '</div>'
      + '<div class="small muted" style="margin-top:8px">题库文件的用途：把这台电脑上的「自建题库 + 分类 + 临时套卷」存成一个 .json，'
      + '换电脑、换浏览器、清缓存后读回来；也可以放进网盘同步。<b>作答记录 / 错题 / 收藏</b>不在里面，'
      + '那些用下面「数据备份 → 导出全部数据」。</div>'
      + '</div></div>';

    var saveBtn = host.querySelector('#bfSave');
    saveBtn.onclick = function () {
      saveBtn.disabled = true;
      save(false).then(function (r) {
        saveBtn.disabled = false;
        if (r === 'denied') T('浏览器没给写文件的权限，再点一次试试', 3000);
      });
    };
    host.querySelector('#bfOpen').onclick = function () { openFile(); };
    host.querySelector('#bfSaveAs').onclick = function () { saveAs(); };
    host.querySelector('#bfToggleBody').onclick = function () {
      var b = host.querySelector('#bfBody');
      b.style.display = (b.style.display === 'none') ? '' : 'none';
    };
    var cb = host.querySelector('#bfAuto');
    cb.checked = !!S.auto;
    cb.onchange = function () {
      S.auto = cb.checked; persist();
      if (S.auto) {
        if (!S.linked) { T('先点一次「保存到本机文件」选个位置，之后就会自动保存'); }
        else autoSync();
      }
      paint();
    };
    checkPerm();
    /* 每 40 秒看一眼权限（有的浏览器静默恢复授权） */
    if (!boot._timer) boot._timer = setInterval(function () { if (document.getElementById('bfBoot')) checkPerm(); }, 40000);
  }

  /* 顶栏加一个磁盘按钮的入口：不依赖首页（做题页也能一键保存题库） */
  function topButton() {
    var row = document.querySelector('.top .row');
    if (!row || document.getElementById('btnBankFile')) return;
    var b = document.createElement('button');
    b.className = 'btn tg';
    b.id = 'btnBankFile';
    b.title = '把自建题库保存到本机文件 / 从文件读回来';
    b.textContent = '💾';
    b.onclick = function () {
      if (typeof go === 'function') go('#/');
      setTimeout(function () {
        var host = document.getElementById('bfBoot');
        if (!host) return;
        host.scrollIntoView({ behavior: 'smooth', block: 'center' });
        var bd = host.querySelector('#bfBody');
        if (bd) bd.style.display = '';
        if (typeof toast === 'function') toast('在这里保存 / 打开本机题库文件', 2600);
      }, 120);
    };
    row.insertBefore(b, document.getElementById('btnTheme') || null);
  }

  /* ---------- 拖文件进网页 ---------- */
  function dropZone() {
    window.addEventListener('dragover', function (e) {
      if (e.dataTransfer && Array.prototype.some.call(e.dataTransfer.types || [], function (t) { return t === 'Files'; })) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    });
    window.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      e.preventDefault();
      if (!/\.json$/i.test(f.name) && !/\.txt$/i.test(f.name)) { T('只认得 .json 题库文件'); return; }
      var fr = new FileReader();
      fr.onload = function () {
        if (/\.txt$/i.test(f.name)) {         // txt = 题目的纯文本，走「导入题库」那一页
          if (typeof SS !== 'undefined') { SS.set('importText', String(fr.result)); }
          if (typeof go === 'function') go('#/import');
          T('已把「' + f.name + '」放进导入页，检查后点保存', 3200);
          return;
        }
        applyRead(String(fr.result), f.name);
      };
      fr.readAsText(f, 'utf-8');
    });
  }

  /* ---------- 给别处调用的包装 ---------- */
  /* 原来的「导出题库」：点了就导出文件（链接了题库文件时顺手更新它） */
  function exportBankHook(b) {
    try {
      if (!b) return;
      var one = { app: 'shuati-bank-file', version: FILE_VER, type: 'bankfile', savedAt: new Date().toISOString(), cats: catsData(), banks: [packBank(b)], note: '单个题库文件，可直接拖进网页导入。' };
      var name = (typeof safeName === 'function' ? safeName(b.title) : String(b.title)) + '.json';
      if (typeof download === 'function') download(name, JSON.stringify(one, null, 2), 'application/json');
      if (S.linked) autoSync();
    } catch (e) { T('导出失败：' + (e.message || e)); }
  }
  /* 自动保存题库：刚改了题库（编辑 / 移动 / 新建）时调用 */
  function autoSave() { if (S.auto) autoSync(); }
  function statusText() {
    if (!S.linked) return '未链接题库文件';
    return (S.name || '题库文件') + '　·　' + timeTxt(S.lastSave) + (S.needPerm ? '　（需要重新授权）' : '');
  }

  window.BF = {
    boot: boot,
    paint: paint,
    save: save,
    saveAs: saveAs,
    open: openFile,
    autoSync: autoSync,
    autoSave: autoSave,
    checkPerm: checkPerm,
    exportBankHook: exportBankHook,
    payload: makePayload,
    diagHtml: diagHtml,
    statusText: statusText,
    state: S,
    _apply: applyPayload
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { topButton(); dropZone(); });
  } else { topButton(); dropZone(); }
})();
