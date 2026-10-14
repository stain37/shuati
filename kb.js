/* ============================================================
   刷题站 · 本地知识库 kb.js
   · 资料只存在本机：优先 IndexedDB，退而 localStorage
   · 中文按「双字切分」做 BM25 检索，不用联网、不用向量库
   · 大资料不走浏览器：用 make-kb.py 把 资料/ 变成 知识库.js（自动挂载）
   · 本文件提供：知识库管理界面、检索接口 kbSearch()
   ============================================================ */

const KB_LS_LIST = 'qbank.kb.list.v1';     /* 知识库目录（只存元信息） */
const KB_LS_SEL  = 'qbank.kb.sel.v1';      /* 选中了哪些知识库 */
const KB_LS_DATA = 'qbank.kb.data.v1.';    /* 每个知识库的正文（localStorage 后端时） */
const KB_LS_SKIP = 'qbank.kb.skip.v1';     /* 删掉、不再自动挂载的文件知识库 id */

let KB_LIST = readLS(KB_LS_LIST, []);      /* [{ id, name, src, addedAt, chars, docs, chunks }] */
let KB_SEL_RAW = readLS(KB_LS_SEL, null);  /* null = 从没选过（默认全选） */
let KB_SEL = Array.isArray(KB_SEL_RAW) ? KB_SEL_RAW.slice() : [];
let KB_SEL_SET = Array.isArray(KB_SEL_RAW);
let KB_SKIP = readLS(KB_LS_SKIP, []);      /* 形如 ['chatbox-5']：删掉的文件库，刷新后不再自动挂载 */
const KB_MEM = {}, KB_IDX = {}, KB_OPEN = {};
let KB_DB = null;
const kbBackend = () => (KB_DB ? 'IndexedDB' : 'localStorage');
const kbName = id => { const k = KB_LIST.find(x => x.id === id); return k ? k.name : id; };
const kbList = () => KB_LIST.slice();
const kbSelected = () => (KB_SEL_SET ? KB_SEL.slice() : KB_LIST.map(k => k.id));
function kbSaveList() { writeLS(KB_LS_LIST, KB_LIST.filter(k => !k.auto)); }
function kbSaveSel() { writeLS(KB_LS_SEL, KB_SEL); }
function kbSetSel(id, on) {
  if (!KB_SEL_SET) { KB_SEL = KB_LIST.map(k => k.id); KB_SEL_SET = true; }
  KB_SEL = KB_SEL.filter(x => x !== id);
  if (on) KB_SEL.push(id);
  kbSaveSel();
  if (route().name === 'quiz' && document.querySelector('.aichip')) paintAiChips();
}
function kbSelAll(on) { KB_SEL_SET = true; KB_SEL = on ? KB_LIST.map(k => k.id) : []; kbSaveSel(); }

/* ---------- 存储后端 ---------- */
function kbIdbOpen() {
  return new Promise((res, rej) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; rej(new Error('timeout')); } }, 1200);
    try {
      const rq = indexedDB.open('shuati-kb', 1);
      rq.onupgradeneeded = () => { try { rq.result.createObjectStore('kb'); } catch (e) {} };
      rq.onsuccess = () => { if (done) return; done = true; clearTimeout(t); KB_DB = rq.result; res(rq.result); };
      rq.onerror = () => { if (done) return; done = true; clearTimeout(t); rej(rq.error || new Error('idb error')); };
      rq.onblocked = () => { if (done) return; done = true; clearTimeout(t); rej(new Error('blocked')); };
    } catch (e) { clearTimeout(t); rej(e); }
  });
}
function kbStorePut(id, obj) {
  if (KB_DB) return new Promise(res => {
    try {
      const tx = KB_DB.transaction('kb', 'readwrite');
      tx.objectStore('kb').put(JSON.stringify(obj), id);
      tx.oncomplete = () => res(true); tx.onerror = () => res(false);
    } catch (e) { res(false); }
  });
  return Promise.resolve(writeLS(KB_LS_DATA + id, obj));
}
function kbStoreGet(id) {
  if (KB_DB) return new Promise(res => {
    try {
      const rq = KB_DB.transaction('kb').objectStore('kb').get(id);
      rq.onsuccess = () => { let v = rq.result || null; if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { v = null; } } res(v); };
      rq.onerror = () => res(null);
    } catch (e) { res(null); }
  });
  return Promise.resolve(readLS(KB_LS_DATA + id, null));
}
function kbStoreDel(id) {
  if (KB_DB) return new Promise(res => { try { const tx = KB_DB.transaction('kb', 'readwrite'); tx.objectStore('kb').delete(id); tx.oncomplete = () => res(true); tx.onerror = () => res(false); } catch (e) { res(false); } });
  try { localStorage.removeItem(KB_LS_DATA + id); } catch (e) {}
  return Promise.resolve(true);
}
/* 启动时探测一次：file:// 下有些浏览器不给用 IndexedDB，就退回 localStorage */
kbIdbOpen().then(() => { if (route().name === 'kb') render(); }).catch(() => {});

/* ---------- 分段 & 检索 ---------- */
/* 中文没有空格：汉字串切成双字（行政诉讼 → 行政/政诉/诉讼），英文数字按词 */
function kbTokens(s) {
  s = String(s || '').toLowerCase();
  const out = [], re = /[\u4e00-\u9fff]+|[a-z0-9_]+/g;
  let m;
  while ((m = re.exec(s))) {
    const w = m[0];
    if (/[\u4e00-\u9fff]/.test(w)) {
      if (w.length === 1) out.push(w);
      else for (let i = 0; i < w.length - 1; i++) out.push(w.slice(i, i + 2));
    } else if (w.length > 1) out.push(w);
  }
  return out;
}
/* 把一篇文章切成 500 字上下的小段，带一点重叠，记下所属标题 */
function kbChunk(text) {
  const MAX = 560, OVER = 90;
  text = String(text || '').replace(/\r\n?/g, '\n').replace(/\u3000/g, ' ').replace(/\n{3,}/g, '\n\n');
  const isHead = s => /^#{1,6}\s+\S/.test(s)
    || /^第[0-9一二三四五六七八九十百千]+[章节讲部分课题]/.test(s)
    || /^[（(]?[一二三四五六七八九十\d]+[)）]?[、.．]\s*\S/.test(s)
    || /^\*\*[^*]{2,30}\*\*$/.test(s);
  const out = [];
  let head = '', buf = '';
  const push = () => {
    const t = buf.trim();
    buf = '';
    if (!t) return;
    if (t.length < 60 && out.length && (out[out.length - 1].t.length + t.length) < MAX) { out[out.length - 1].t += '\n' + t; return; }
    out.push({ h: head, t: t });
  };
  String(text || '').split('\n').forEach(raw => {
    const s = raw.trim();
    if (!s) { if (buf) buf += '\n'; return; }
    if (isHead(s) && s.length <= 40) { push(); head = s.replace(/^#{1,6}\s+/, '').replace(/\*\*/g, ''); return; }
    if (buf.length + s.length > MAX && buf.length) {
      const tail = buf.slice(-OVER);
      push();
      buf = tail + '\n';
    }
    buf += s + '\n';
  });
  push();
  return out;
}
function kbIndex(docs) {
  const chunks = [], df = Object.create(null);
  let total = 0;
  docs.forEach((d, di) => {
    (d.chunks || []).forEach((c, ci) => {
      const toks = kbTokens((c.h ? c.h + ' ' : '') + c.t);
      const tf = Object.create(null);
      let len = 0;
      toks.forEach(t => { tf[t] = (tf[t] || 0) + 1; len++; });
      Object.keys(tf).forEach(t => { df[t] = (df[t] || 0) + 1; });
      total += len;
      chunks.push({ d: di, ci: ci, h: c.h, t: c.t, tf: tf, len: len });
    });
  });
  return { chunks: chunks, df: df, avg: chunks.length ? total / chunks.length : 1 };
}
function kbSearchSync(query, ids, topK) {
  const qt = Array.from(new Set(kbTokens(query))).filter(t => t.length > 1 || /[\u4e00-\u9fff]/.test(t));
  if (!qt.length) return [];
  const hits = [];
  ids.forEach(id => {
    const idx = KB_IDX[id];
    if (!idx) return;
    const N = idx.chunks.length || 1;
    idx.chunks.forEach(c => {
      let s = 0;
      qt.forEach(t => {
        const tf = c.tf[t];
        if (!tf) return;
        const dfv = idx.df[t] || 1;
        s += Math.log(1 + (N - dfv + 0.5) / (dfv + 0.5)) * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * c.len / idx.avg));
      });
      if (s > 0) hits.push({ id: id, score: s, ch: c });
    });
  });
  hits.sort((a, b) => b.score - a.score);
  return kbPickDiverse(hits, topK || 4);
}
/* 挑结果时限制「同一个文件最多占几段」，避免 4 段参考资料全来自同一个 PDF */
function kbPickDiverse(hits, K) {
  const cap = K >= 4 ? 2 : 1;      /* 参考资料条数够多时，同一个文件最多取 2 段 */
  const out = [], spill = [], used = Object.create(null);
  for (let i = 0; i < hits.length && out.length < K; i++) {
    const h = hits[i];
    const dk = h.id + "#" + h.ch.d;
    if ((used[dk] || 0) < cap) { used[dk] = (used[dk] || 0) + 1; out.push(h); }
    else spill.push(h);
  }
  for (let i = 0; i < spill.length && out.length < K; i++) out.push(spill[i]);   /* 来源不够时再补同文件的 */
  return out;
}
async function kbEnsure(id) {
  if (KB_IDX[id]) return true;
  if (!KB_MEM[id]) { const d = await kbStoreGet(id); if (!d) return false; KB_MEM[id] = d; }
  KB_IDX[id] = kbIndex(KB_MEM[id].docs || []);
  return true;
}
function kbSnippet(t, q, n) {
  n = n || 200;
  const toks = kbTokens(q).filter(x => x.length > 1);
  let pos = -1;
  toks.forEach(tk => { const i = t.indexOf(tk); if (i >= 0 && (pos < 0 || i < pos)) pos = i; });
  if (pos < 0) return t.slice(0, n) + (t.length > n ? '…' : '');
  const s = Math.max(0, pos - Math.floor(n / 3));
  return (s > 0 ? '…' : '') + t.slice(s, s + n) + (s + n < t.length ? '…' : '');
}
/* 对外：检索。不传 ids 就用当前选中的知识库 */
async function kbSearch(query, ids, topK) {
  if (typeof kbEnsureFilesLoaded === 'function') { try { await kbEnsureFilesLoaded(); } catch (e) {} }
  ids = (ids && ids.length) ? ids : kbSelected();
  if (!query || !ids.length) return [];
  for (const id of ids) await kbEnsure(id);
  return kbSearchSync(query, ids.filter(id => KB_IDX[id]), topK || 4).map(h => {
    const d = (KB_MEM[h.id].docs || [])[h.ch.d] || {};
    return { id: h.id, kb: kbName(h.id), doc: d.name || '资料', head: h.ch.h || '', text: h.ch.t, score: h.score, snip: kbSnippet(h.ch.t, query, 200) };
  });
}

/* ---------- 文件知识库（make-kb.py 生成 知识库.js 时自动挂载） ---------- */
let KB_FILES_DONE = false;
function kbIngestFiles(force) {
  const arr = window.__KBS__ || [];
  if (!arr.length) return 0;                      /* 知识库.js 还没加载 */
  if (KB_FILES_DONE && !force) return 0;          /* 已经挂载过了，不必每次开 AI 面板都遍历一遍 */
  KB_FILES_DONE = true;
  let added = 0;
  arr.forEach((b, i) => {
    const id = 'file:' + (b.id || i);
    if (kbIsSkipped(id)) return;              /* 你删掉的库：不再自动挂载 */
    if (KB_LIST.some(x => x.id === id)) return;
    const docs = (b.docs || []).map(d => ({ name: d.name || '资料', chunks: Array.isArray(d.chunks) ? d.chunks : kbChunk(d.text || '') }));
    KB_MEM[id] = { docs: docs };
    const st = kbStats({ docs: docs });
    KB_LIST.push({ id: id, name: b.name || ('资料 ' + (i + 1)), src: 'file', addedAt: Date.now(), auto: true, chars: st.chars, docs: st.docs, chunks: st.chunks });
    added++;
  });
  return added;
}
function kbStats(data) {
  let chars = 0, chunks = 0;
  (data.docs || []).forEach(d => { chunks += (d.chunks || []).length; (d.chunks || []).forEach(c => { chars += c.t.length; }); });
  return { chars: chars, chunks: chunks, docs: (data.docs || []).length };
}

/* ---------- 新增 / 追加 / 删除 ---------- */
function kbNewId() { return 'kb' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
async function kbCreate(name, docs, src) {
  const id = kbNewId();
  const data = { docs: (docs || []).map(d => ({ name: d.name || '资料', chunks: kbChunk(d.text || '') })) };
  const st = kbStats(data);
  if (!st.chunks) throw new Error('没读到有效内容');
  KB_MEM[id] = data;
  KB_IDX[id] = kbIndex(data.docs);
  const ok = await kbStorePut(id, data);
  if (!ok) { delete KB_MEM[id]; delete KB_IDX[id]; throw new Error('保存失败：浏览器存储放不下了（' + kbBackend() + '）。大资料请用 make-kb.py 生成 知识库.js'); }
  KB_LIST.push({ id: id, name: name || '知识库', src: src || 'local', addedAt: Date.now(), chars: st.chars, docs: st.docs, chunks: st.chunks });
  kbSaveList(); kbSetSel(id, true);
  return id;
}
async function kbAppend(id, docs) {
  const k = KB_LIST.find(x => x.id === id);
  if (!k) throw new Error('先选一个目标知识库');
  if (k.auto) throw new Error('文件知识库是只读的（由 知识库.js 生成），要改请重新生成');
  await kbEnsure(id);
  const data = KB_MEM[id];
  let add = 0;
  (docs || []).forEach(d => {
    const ch = kbChunk(d.text || '');
    if (ch.length) { data.docs.push({ name: d.name || '资料', chunks: ch }); add += ch.length; }
  });
  if (!add) throw new Error('没读到有效内容');
  const ok = await kbStorePut(id, data);
  if (!ok) throw new Error('保存失败：存储空间不够');
  const st = kbStats(data);
  k.chars = st.chars; k.docs = st.docs; k.chunks = st.chunks;
  KB_IDX[id] = kbIndex(data.docs);
  kbSaveList();
  return add;
}
async function kbDropDoc(id, di) {
  const k0 = KB_LIST.find(x => x.id === id);
  if (k0 && k0.auto) throw new Error('文件知识库是只读的（由 知识库.js 生成），要改请重新生成');
  await kbEnsure(id);
  const data = KB_MEM[id];
  data.docs.splice(di, 1);
  await kbStorePut(id, data);
  const k = KB_LIST.find(x => x.id === id);
  const st = kbStats(data);
  if (k) { k.chars = st.chars; k.docs = st.docs; k.chunks = st.chunks; }
  KB_IDX[id] = kbIndex(data.docs);
  kbSaveList();
}
async function kbRemove(id) {
  const isFile = String(id).indexOf('file:') === 0;
  /* 先在内存里删干净并重画，别让界面等存储（file:// 下 IndexedDB 要等 1.2 秒超时） */
  delete KB_MEM[id]; delete KB_IDX[id];
  KB_LIST = KB_LIST.filter(x => x.id !== id);
  KB_SEL = KB_SEL.filter(x => x !== id);
  kbSaveList(); kbSaveSel();
  if (isFile) { kbSkipAdd(id); return; }   /* 文件库不占浏览器存储：只有一份黑名单要写，立刻完事 */
  await kbStoreDel(id);                    /* 网页导入的库：正文存在浏览器里，真删 */
}
/* 文件知识库（知识库.js 挂载的）删掉后要记住，否则刷新就被挂载回来 —— 这两组函数就是那本「黑名单」 */
function kbFileIdOf(id) { return String(id || '').replace(/^file:/, ''); }
function kbIsSkipped(id) { const f = kbFileIdOf(id); return KB_SKIP.indexOf(f) >= 0; }
function kbSkipAdd(id) { const f = kbFileIdOf(id); if (KB_SKIP.indexOf(f) < 0) { KB_SKIP.push(f); writeLS(KB_LS_SKIP, KB_SKIP); } }
function kbSkipRemove(id) { const f = kbFileIdOf(id); KB_SKIP = KB_SKIP.filter(x => x !== f); writeLS(KB_LS_SKIP, KB_SKIP); }
function kbSkipName(id) { const f = kbFileIdOf(id); const b = (window.__KBS__ || []).find(x => String(x.id) === f); return b ? (b.name || f) : f; }
function kbRestoreSkip(id) {
  kbSkipRemove(id);
  kbIngestFiles(true);          /* 恢复被删的库：强制重新挂载 */
  if (KB_LIST.some(x => x.id === 'file:' + kbFileIdOf(id))) kbSetSel('file:' + kbFileIdOf(id), true);
}
function kbUsageText() {
  const chars = KB_LIST.reduce((a, b) => a + (b.chars || 0), 0);
  const chunks = KB_LIST.reduce((a, b) => a + (b.chunks || 0), 0);
  const mb = (typeof storageBytes === 'function') ? (storageBytes() / 1024 / 1024) : 0;
  return KB_LIST.length + ' 个知识库 · ' + chars.toLocaleString() + ' 字 · ' + chunks.toLocaleString() + ' 段　·　存储：' + kbBackend()
    + (KB_DB ? '' : '（浏览器已用 ' + mb.toFixed(2) + ' MB，约 5 MB 上限；大资料请用 make-kb.py）');
}

/* ---------- 文本 / 文件解析 ---------- */
function kbTextFromHtml(s) {
  return String(s || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n');
}
function kbReadFile(f) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onerror = () => rej(new Error('读不了 ' + f.name));
    fr.onload = () => {
      let t = String(fr.result || '');
      const n = (f.name || '').toLowerCase();
      if (/\.html?$/.test(n)) t = kbTextFromHtml(t);
      if (/\.json$/.test(n)) { try { t = JSON.stringify(JSON.parse(t), null, 1).replace(/[{}\"\[\],]/g, ' ').replace(/\s{2,}/g, ' '); } catch (e) {} }
      res({ name: f.name, text: t });
    };
    fr.readAsText(f, 'utf-8');
  });
}

/* ---------- 界面：知识库管理 + 试检索（由 ai.js 的 #/kb 页面调用） ---------- */
function kbRowHtml(k) {
  const sel = new Set(kbSelected());
  const on = sel.has(k.id);
  const open = !!KB_OPEN[k.id];
  let html = '<div class="kbrow' + (on ? ' on' : '') + '" data-id="' + k.id + '">'
    + '<label class="kbchk"><input type="checkbox" data-kbsel="' + k.id + '"' + (on ? ' checked' : '') + '><span>' + esc(k.name) + '</span></label>'
    + '<span class="mini-tag' + (k.src === 'file' ? ' ok' : '') + '">' + (k.src === 'file' ? '文件' : '网页导入') + '</span>'
    + '<span class="kbinfo small muted">' + (k.docs || 0) + ' 篇 · ' + (k.chars || 0).toLocaleString() + ' 字 · ' + (k.chunks || 0) + ' 段</span>'
    + '<span class="spacer-grow"></span>'
    + '<button class="btn tiny" data-kbact="open">' + (open ? '收起' : '明细') + '</button>'
    + '<button class="btn tiny" data-kbact="rename">改名</button>'
    + '<button class="btn tiny" data-kbact="export">导出</button>'
    + '<button class="btn tiny danger" data-kbact="del"' + (k.auto ? ' title="删掉后刷新也不会再自动挂载，页面下方可以恢复"' : '') + '>删除</button>';
  if (open) {
    html += '<div class="kbdocs">';
    if (KB_MEM[k.id]) {
      html += (KB_MEM[k.id].docs || []).map(function (d, i) {
        return '<div class="kbDoc"><span>' + esc(d.name || '资料') + '</span><span class="small muted">' + (d.chunks || []).length + ' 段</span>'
          + (k.auto ? '' : '<button class="btn tiny danger" data-kbdoc="' + i + '">删</button>') + '</div>';
      }).join('') || '<div class="small muted">空的</div>';
    if (k.auto) html += '<div class="small muted">文件知识库是只读的：单篇删不掉，要减内容请重新生成 知识库.js；整个库不想用就点这一行的「删除」。</div>';
    } else html += '<div class="small muted">正在读取正文…</div>';
    html += '</div>';
  }
  return html + '</div>';
}
function kbSectionHtml() {
  const rows = KB_LIST.map(kbRowHtml).join('') || '<div class="small muted">还没有知识库。导入 txt / md 文件，或把资料直接粘进来。</div>';
  const opts = KB_LIST.map(k => '<option value="' + k.id + '">' + esc(k.name) + '</option>').join('');
  const L = [];
  L.push('<div class="card kbcard">');
  L.push('<div class="kbhead">② 知识库 <span class="small muted" id="kbUsage">' + esc(kbUsageText()) + '</span></div>');
  L.push('<div class="hint">资料只存在本机浏览器里。<b>大资料</b>更推荐把文件放进站点的 <code>资料/</code> 文件夹，双击 <code>转知识库.bat</code> 生成 <code>知识库.js</code>，本站会自动挂载（不受浏览器 5 MB 限制）。</div>');
  L.push('<div class="kbList" id="kbRows">' + rows + '</div>');
  if (KB_SKIP.length) {
    L.push('<div class="kbSkipped small muted" id="kbSkipped" style="margin-top:10px">已删掉、刷新也不再自动挂载：'
      + KB_SKIP.map(f => '<span style="display:inline-block;margin:4px 10px 0 0">' + esc(kbSkipName(f))
        + ' <button class="btn tiny" data-kbskipres="' + esc(f) + '">恢复</button></span>').join('') + '</div>');
  }
  L.push('<div class="tools" style="margin-top:12px">');
  L.push('<span class="tl">目标知识库</span>');
  L.push('<select class="num" id="kbTarget"><option value="__new">＋ 新建知识库</option>' + opts + '</select>');
  L.push('<input class="num" id="kbNewName" placeholder="新知识库名字，如：民法笔记">');
  L.push('</div>');
  L.push('<div class="tools">');
  L.push('<button class="btn primary" id="kbPick">导入文件（txt / md / csv / html / json）</button>');
  L.push('<span class="small muted">可多选；Word、PDF 请先转成 txt（见 AI知识库说明.md）</span>');
  L.push('<input type="file" id="kbFile" multiple accept=".txt,.md,.markdown,.csv,.json,.html,.htm,.log,.srt,.text,text/*" style="display:none">');
  L.push('</div>');
  L.push('<textarea class="ed-ta kb-ta" id="kbPaste" placeholder="也可以把讲义、笔记直接粘在这里…"></textarea>');
  L.push('<div class="actions">');
  L.push('<input class="num" id="kbPasteName" placeholder="这段资料的名字（可留空）">');
  L.push('<button class="btn" id="kbPasteAdd">加入知识库</button>');
  L.push('<button class="btn" id="kbAll">全选</button>');
  L.push('<button class="btn" id="kbNone">清空选择</button>');
  L.push('</div></div>');
  L.push('<div class="card kbcard">');
  L.push('<div class="kbhead">③ 试检索 <span class="small muted">（看看资料能不能被 AI 找到，不花 token）</span></div>');
  L.push('<div class="tools">');
  L.push('<input class="num grow" id="kbQ" placeholder="输入题干关键词，例如：善意取得的构成要件">');
  L.push('<button class="btn primary" id="kbSearchBtn">检索</button>');
  L.push('</div>');
  L.push('<div id="kbHits"></div>');
  L.push('</div>');
  return L.join('\n');
}
function kbBind(host) {
  const rows = host.querySelector('#kbRows');
  if (rows) rows.addEventListener('change', e => {
    const id = e.target.dataset && e.target.dataset.kbsel;
    if (!id) return;
    kbSetSel(id, e.target.checked);
    const row = e.target.closest('.kbrow');
    if (row) row.classList.toggle('on', e.target.checked);
  });
  if (rows) rows.addEventListener('click', async e => {
    const row = e.target.closest('.kbrow');
    if (!row) return;
    const id = row.dataset.id, k = KB_LIST.find(x => x.id === id);
    if (!k) return;
    const docBtn = e.target.closest('[data-kbdoc]');
    if (docBtn) {
      await kbEnsure(id);
      const d = (KB_MEM[id].docs || [])[+docBtn.dataset.kbdoc] || {};
      if (!confirm('删掉《' + (d.name || '资料') + '》？')) return;
      await kbDropDoc(id, +docBtn.dataset.kbdoc);
      render();
      return;
    }
    const b = e.target.closest('[data-kbact]');
    const act = b && b.dataset.kbact;
    if (!act) return;
    if (act === 'open') {
      KB_OPEN[id] = !KB_OPEN[id];
      if (KB_OPEN[id]) await kbEnsure(id);
      render();
    } else if (act === 'rename') {
      const n = prompt('新的知识库名字', k.name);
      if (n == null) return;
      k.name = n.trim() || k.name;
      if (k.auto) toast('文件知识库改名只在本页有效，刷新后恢复');
      kbSaveList(); render();
    } else if (act === 'export') {
      await kbEnsure(id);
      const docs = (KB_MEM[id].docs || []).map(d => ({ name: d.name, text: (d.chunks || []).map(c => c.t).join('\n') }));
      download(k.name + '.知识库.json', JSON.stringify({ app: 'shuati-kb', name: k.name, docs: docs }), 'application/json');
      toast('已导出，可以换台电脑再导入');
    } else if (act === 'del') {
      if (!confirm(k.auto
        ? ('删掉《' + k.name + '》？它是 知识库.js 里的资料库：删掉后刷新不会再自动挂载，需要时在列表下方点「恢复」。')
        : ('删除知识库《' + k.name + '》？资料只存在本机，删了就没了。'))) return;
      await kbRemove(id); render();
      toast(k.auto ? '已删除，刷新也不会再挂载' : '已删除');
    }
  });
  const sk = host.querySelector('#kbSkipped');
  if (sk) sk.addEventListener('click', e => {
    const b = e.target.closest('[data-kbskipres]');
    if (!b) return;
    kbRestoreSkip(b.dataset.kbskipres);
    render(); toast('已恢复《' + kbSkipName(b.dataset.kbskipres) + '》');
  });
  on('kbAll', () => { kbSelAll(true); render(); });
  on('kbNone', () => { kbSelAll(false); render(); });
  on('kbPick', () => $('kbFile').click());
  on('kbFile', async e => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length) await kbImportFiles(files);
  }, 'change');
  on('kbPasteAdd', () => kbImportPaste());
  on('kbSearchBtn', () => kbRunTest());
  on('kbQ', e => { if (e.key === 'Enter') kbRunTest(); }, 'keydown');
}
async function kbImportFiles(files) {
  const target = $('kbTarget') ? $('kbTarget').value : '__new';
  const newName = $('kbNewName') ? $('kbNewName').value.trim() : '';
  try {
    toast('正在读取 ' + files.length + ' 个文件…', 800);
    const docs = [];
    for (const f of files) docs.push(await kbReadFile(f));
    const keep = docs.filter(d => (d.text || '').trim().length > 20);
    if (!keep.length) { toast('这些文件里没读到文字'); return; }
    let msg;
    if (target === '__new') {
      const id = await kbCreate(newName || keep[0].name.replace(/\.[^.]+$/, '') || '知识库', keep, 'local');
      msg = '已建《' + kbName(id) + '》：' + keep.length + ' 篇';
    } else {
      const n = await kbAppend(target, keep);
      msg = '已往《' + kbName(target) + '》加 ' + keep.length + ' 篇 / ' + n + ' 段';
    }
    if ($('kbNewName')) $('kbNewName').value = '';
    render(); toast(msg);
  } catch (err) { toast(err.message || '导入失败'); }
}
async function kbImportPaste() {
  const ta = $('kbPaste'), nameEl = $('kbPasteName');
  if (!ta) return;
  const text = (ta.value || '').trim();
  if (text.length < 20) { toast('粘贴的内容太短了'); return; }
  const target = $('kbTarget') ? $('kbTarget').value : '__new';
  const nm = (nameEl.value || '').trim() || ('粘贴资料 ' + new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }));
  try {
    if (target === '__new') { const id = await kbCreate(nm, [{ name: nm, text: text }], 'local'); toast('已建《' + kbName(id) + '》'); }
    else { const n = await kbAppend(target, [{ name: nm, text: text }]); toast('已加入 ' + n + ' 段'); }
    ta.value = ''; nameEl.value = '';
    render();
  } catch (err) { toast(err.message || '加入失败'); }
}
async function kbRunTest() {
  const q = ($('kbQ').value || '').trim();
  const box = $('kbHits');
  if (!q) { toast('先写点关键词'); return; }
  box.innerHTML = '<div class="small muted">检索中…</div>';
  const hits = await kbSearch(q, null, 6);
  if (!hits.length) {
    box.innerHTML = '<div class="small muted">没命中。可能：① 没勾选知识库；② 关键词和资料的用词不一样（换几个词试试）；③ 资料还没导入。</div>';
    return;
  }
  box.innerHTML = hits.map(function (h, i) {
    return '<div class="kbhit"><div class="kbhit-h"><b>[' + (i + 1) + ']</b> ' + esc(h.kb) + ' · ' + esc(h.doc) + (h.head ? ' · ' + esc(h.head) : '')
      + '<span class="spacer-grow"></span><span class="small muted">得分 ' + h.score.toFixed(1) + '</span></div><div class="small">' + esc(h.snip) + '</div></div>';
  }).join('');
}

/* 导入别处导出的知识库 JSON */
async function kbImportJson(files) {
  for (const f of files) {
    try {
      const t = await f.text();
      const j = JSON.parse(t);
      if (!j || !Array.isArray(j.docs)) throw new Error('不是知识库文件');
      const id = await kbCreate(j.name || f.name.replace(/\.[^.]+$/, ''), j.docs, 'local');
      toast('已导入《' + kbName(id) + '》');
    } catch (e) { toast('导入失败：' + (e.message || '格式不对')); }
  }
  render();
}

/* ---------- 备份：自己导入的知识库也能一起导出 / 恢复 ----------
   来自 知识库.js 的文件库不进备份（正文就在那个文件里，换电脑重新生成或复制过去即可）。 */
async function kbExportAll() {
  const list = KB_LIST.filter(k => !k.auto);
  const out = { list: list, sel: kbSelected(), skip: KB_SKIP.slice(), data: {}, autoN: KB_LIST.filter(k => k.auto).length };
  for (const k of list) {
    let d = KB_MEM[k.id];
    if (!d) { try { d = await kbStoreGet(k.id); } catch (e) { d = null; } }
    if (d) out.data[k.id] = d;
  }
  return out;
}
function kbImportAll(o) {
  if (!o || typeof o !== 'object') return 0;
  if (Array.isArray(o.skip)) { o.skip.forEach(f => { if (KB_SKIP.indexOf(f) < 0) KB_SKIP.push(f); }); writeLS(KB_LS_SKIP, KB_SKIP); }
  const list = Array.isArray(o.list) ? o.list : [];
  let n = 0;
  list.forEach(k => {
    if (!k || !k.id) return;
    const d = (o.data || {})[k.id];
    if (d) {
      KB_MEM[k.id] = d;
      delete KB_IDX[k.id];
      kbStorePut(k.id, d);                       /* 存回浏览器（IndexedDB / localStorage） */
      const st = kbStats(d);
      k.chars = st.chars; k.docs = st.docs; k.chunks = st.chunks; k.auto = false;
    }
    if (!KB_LIST.some(x => x.id === k.id)) KB_LIST.push(k);
    n++;
  });
  if (Array.isArray(o.sel)) { KB_SEL = o.sel.filter(x => KB_LIST.some(k => k.id === x)); KB_SEL_SET = true; kbSaveSel(); }
  kbSaveList();
  kbPreheatIndex();
  return n;
}

/* ---------- 动态挂载 知识库.js（没有这个文件也没关系） ----------
   7.63 MB 的资料文件不该每次打开页面都拉一遍：等真正要用时（打开 AI 面板 / 检索 / 进 #/kb）
   再挂载。挂载过就记在 KB_FILES_DONE，之后直接返回。 */
let KB_FILES_PROMISE = null;
function kbEnsureFilesLoaded() {
  if (KB_FILES_DONE || (window.__KBS__ && window.__KBS__.length)) return Promise.resolve({ ok: true, added: kbIngestFiles() });
  if (KB_FILES_PROMISE) return KB_FILES_PROMISE;
  KB_FILES_PROMISE = new Promise(resolve => {
    const s = document.createElement('script');
    s.src = '知识库.js';
    let done = false;
    const fin = ok => {
      if (done) return;
      done = true; KB_FILES_PROMISE = null;
      const added = kbIngestFiles();
      kbPreheatIndex();
      if (route().name === 'kb') { try { render(); } catch (e) {} }
      resolve({ ok: ok, added: added });
    };
    s.onload = () => fin(true);
    s.onerror = () => fin(false);
    document.head.appendChild(s);
  });
  return KB_FILES_PROMISE;
}
/* 空闲时偷偷先拉一次：第一次点 AI 解析就不用等那 7 MB */
function kbWarmUp() {
  const go = () => { try { kbEnsureFilesLoaded(); } catch (e) {} };
  if (window.requestIdleCallback) requestIdleCallback(go, { timeout: 4000 }); else setTimeout(go, 1500);
}
/* 空闲预热检索索引：整库建索引要几百毫秒，别等用户点检索时才卡（每次只做一小会儿就让出主线程） */
function kbPreheatIndex() {
  const ids = kbSelected().filter(id => KB_MEM[id] && !KB_IDX[id]);
  if (!ids.length) return;
  let i = 0;
  const ric = window.requestIdleCallback || function (f) { return setTimeout(() => f({ timeRemaining: () => 6 }), 600); };
  const step = dl => {
    const left = () => (dl && dl.timeRemaining ? dl.timeRemaining() : 6);
    while (i < ids.length && left() > 4) {
      const id = ids[i++];
      if (KB_MEM[id] && !KB_IDX[id]) { try { KB_IDX[id] = kbIndex(KB_MEM[id].docs || []); } catch (e) {} }
    }
    if (i < ids.length) ric(step);
  };
  ric(step);
}
kbWarmUp();
