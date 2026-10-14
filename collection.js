/* ============================================================
   刷题站 · collection.js
   错题本 / 收藏 / 统计 / 批量操作 / 套卷 / 自定义解析 / 导出
   依赖 app.js 的全局：ANS FAV NOTES SET allBanks baseBanks esc $ on toast download
   ============================================================ */

/* ---------------- Markdown 渲染 ---------------- */
function mdToHtml(md) {
  if (!md) return '';
  let s = esc(md);
  s = s.replace(/!\[([^\]]*)\]\((data:image\/[^)\s]+|[^)\s]+)\)/g, (m, a, u) => `<img alt="${a}" src="${u}">`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, u) =>
    /^(https?:|data:|\/|#)/.test(u) ? `<a href="${u}" target="_blank" rel="noopener">${t}</a>` : `${t}（${u}）`);
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  const lines = s.split(/\r?\n/);
  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push('</' + list + '>'); list = null; } };
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) { closeList(); continue; }
    let m;
    /* 表格：本行含 | 且下一行是分隔行  | a | b |\n| --- | --- | */
    if (t.indexOf('|') >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      closeList();
      const header = splitRow(t);
      const aligns = splitRow(lines[i + 1]).map(c => {
        const l = c.trim().charAt(0) === ':', r = c.trim().slice(-1) === ':';
        return (l && r) ? 'center' : (r ? 'right' : 'left');
      });
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].indexOf('|') >= 0) { rows.push(splitRow(lines[i])); i++; }
      i--;
      out.push(renderTable(header, rows, aligns));
      continue;
    }
    if ((m = t.match(/^(#{1,4})\s+(.*)$/))) { closeList(); const n = m[1].length + 2; out.push(`<h${n}>${m[2]}</h${n}>`); continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { closeList(); out.push('<hr>'); continue; }
    if ((m = t.match(/^&gt;\s?(.*)$/))) { closeList(); out.push(`<blockquote>${m[1]}</blockquote>`); continue; }
    if ((m = t.match(/^[-*+]\s+(.*)$/))) { if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${m[1]}</li>`); continue; }
    if ((m = t.match(/^\d+[.)]\s+(.*)$/))) { if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${m[1]}</li>`); continue; }
    if (/^<img\s/.test(t)) { closeList(); out.push(t); continue; }
    closeList(); out.push(`<p>${t}</p>`);
  }
  closeList();
  return out.join('\n');
}

/* 表格辅助 */
function splitRow(line) {
  let s = line.trim();
  if (s.charAt(0) === '|') s = s.slice(1);
  if (s.slice(-1) === '|') s = s.slice(0, -1);
  return s.split('|').map(x => x.trim());
}
function isTableSep(line) {
  let s = String(line).trim();
  if (s.charAt(0) === '|') s = s.slice(1);
  if (s.slice(-1) === '|') s = s.slice(0, -1);
  if (!s.trim()) return false;
  return s.split('|').every(c => /^\s*:?-{1,}:?\s*$/.test(c));
}
function renderTable(header, rows, aligns) {
  const st = i => (aligns[i] ? ` style="text-align:${aligns[i]}"` : '');
  const n = header.length;
  const head = '<tr>' + header.map((c, i) => `<th${st(i)}>${c || ''}</th>`).join('') + '</tr>';
  const body = rows.map(r => '<tr>' + header.map((_, i) => `<td${st(i)}>${r[i] == null ? '' : r[i]}</td>`).join('') + '</tr>').join('');
  return `<div class="tbl-wrap"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

/* ---------------- 图片 ---------------- */
function fileToDataURL(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = () => rej(new Error('读取失败'));
    fr.readAsDataURL(file);
  });
}
async function compressImage(file, maxW, quality) {
  maxW = maxW || 1100; quality = quality || 0.82;
  const raw = await fileToDataURL(file);
  if (/image\/gif/i.test(file.type || '')) return raw;
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i); i.onerror = () => rej(new Error('图片解码失败'));
      i.src = raw;
    });
    const scale = Math.min(1, maxW / (img.width || maxW));
    if (scale >= 1 && raw.length < 250 * 1024) return raw;
    const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const out = c.toDataURL('image/jpeg', quality);
    return out.length < raw.length ? out : raw;
  } catch (e) { return raw; }
}

/* ---------------- 解析编辑器 ---------------- */
let ED = null;
function openNoteEditor(k, host, q, onDone) {
  const cur = NOTES[k] || {};
  ED = { k: k, text: cur.text || '', imgs: (cur.imgs || []).map(x => ({ name: x.name || '', src: x.src })), host: host, q: q, onDone: onDone };
  paintEditor();
}
function paintEditor() {
  const host = ED.host, k = ED.k;
  const custom = !!NOTES[k];
  host.innerHTML = `
    <div class="ed">
      <div class="hint">支持 Markdown：<b>**加粗**</b>、*斜体*、\`代码\`、# 标题、- 列表、&gt; 引用、[链接](url)，以及表格（如 \`| 表头 | 表头 |\` 下一行 \`| --- | --- |\`）。图片可以直接插进来。</div>
      <textarea class="ed-ta" id="edTa" placeholder="在这里写解析…">${esc(ED.text)}</textarea>
      ${ED.imgs.length ? `<div class="ed-imgs">${ED.imgs.map((im, i) => `
        <div class="thumb"><img src="${im.src}" alt=""><button class="x" data-imgdel="${i}" title="删除">×</button></div>`).join('')}</div>` : ''}
      <div class="actions">
        <button class="btn" id="edImg">＋ 插入图片</button>
        <button class="btn" id="edAI" title="让 AI 生成一份解析，写进下面的编辑框">AI 生成解析</button>
        <button class="btn primary" id="edSave">保存解析</button>
        <button class="btn" id="edCancel">取消</button>
        ${custom ? `<button class="btn danger" id="edReset">恢复默认解析</button>` : ''}
        <input type="file" id="edFile" accept="image/*" multiple style="display:none">
      </div>
      <div class="ai-host"></div>
      <div class="hint" style="margin-top:10px">预览</div>
      <div class="ed-preview">${mdToHtml(ED.text)}${ED.imgs.map(im => `<img src="${im.src}" alt="">`).join('')}</div>
    </div>`;

  const ta = $('edTa');
  ta.oninput = () => { ED.text = ta.value; host.querySelector('.ed-preview').innerHTML = mdToHtml(ED.text) + ED.imgs.map(im => `<img src="${im.src}" alt="">`).join(''); };
  on('edImg', () => $('edFile').click());
  on('edAI', () => { if (typeof aiOpenPanel === 'function') aiOpenPanel(host.querySelector('.ai-host'), k, ED.q, txt => { ED.text = txt; paintEditor(); }); else toast('AI 模块没加载（ai.js）'); });
  on('edFile', async e => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    toast('正在处理图片…', 900);
    for (const f of files) {
      try { ED.imgs.push({ name: f.name || '', src: await compressImage(f) }); } catch (err) { toast('图片读取失败：' + f.name); }
    }
    paintEditor();
  }, 'change');
  host.querySelectorAll('[data-imgdel]').forEach(b => b.onclick = () => { ED.imgs.splice(+b.dataset.imgdel, 1); paintEditor(); });
  on('edCancel', () => { host.innerHTML = ''; ED = null; });
  on('edReset', () => {
    if (!confirm('恢复成题库自带的解析？你写的 Markdown 和图片都会删掉。')) return;
    delete NOTES[k];
    tombAdd('note', k);
    saveNotes();
    host.innerHTML = ''; ED = null; toast('已恢复默认解析'); render();
  });
  on('edSave', () => {
    const text = ($('edTa').value || '').trim();
    if (!text && !ED.imgs.length) { delete NOTES[k]; tombAdd('note', k); }
    else NOTES[k] = { text: text, imgs: ED.imgs.slice(), ts: Date.now() };
    if (!saveNotes()) { toast('保存失败：浏览器存储空间已满，建议把图片压小或先导出备份'); return; }
    const mb = storageBytes() / 1024 / 1024;
    toast(mb > 4 ? '已保存（本机存储已用 ' + mb.toFixed(2) + ' MB，接近上限）' : '已保存');
    host.innerHTML = ''; ED = null;
    render();
  });
}

/* ---------------- 列表页状态 ---------------- */
const SORTS = {
  wrong: { label: '错次', def: -1, cmp: (a, b) => (a.rec.wrong || 0) - (b.rec.wrong || 0) || (a.rec.ts || 0) - (b.rec.ts || 0) },
  rate: { label: '正确率', def: 1, cmp: (a, b) => rateOf(a.rec) - rateOf(b.rec) },
  tries: { label: '作答次数', def: -1, cmp: (a, b) => (a.rec.tries || 0) - (b.rec.tries || 0) },
  recent: { label: '最近作答', def: -1, cmp: (a, b) => (a.rec.ts || 0) - (b.rec.ts || 0) },
  id: { label: '题号', def: 1, cmp: (a, b) => String(a.bank.title).localeCompare(String(b.bank.title)) || String(a.q.id).localeCompare(String(b.q.id), 'zh', { numeric: true }) }
};
const ARROW = d => (d > 0 ? '↑' : '↓');
const mkState = () => ({ bank: 'all', sort: 'wrong', dir: -1, minWrong: 0, onlyOpen: false, onlyDue: false, withExp: true, withImg: true, withSel: true, withStat: true, open: new Set(), sel: new Set(), shown: [], scope: 'all', kw: '' });
const LP = { wrong: mkState(), fav: mkState(), search: mkState() };

function shuffle(a) {
  const r = a.slice();
  for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = r[i]; r[i] = r[j]; r[j] = t; }
  return r;
}
function dueText(k) {
  const d = dueOf(k);
  if (d == null) return '';
  const days = Math.round((d - Date.now()) / DAY);
  if (days <= 0) return '今天到期';
  if (days === 1) return '明天复习';
  return days + ' 天后复习';
}

/* 关键词：空格分隔多个词＝每个词都要命中（AND），大小写不敏感 */
function splitKw(kw) {
  return String(kw == null ? '' : kw).trim().toLowerCase().split(/\s+/).filter(Boolean);
}
function hayOf(k, q, b) {
  return (q.stem + ' ' + (q.group || '') + ' ' + (q.options || []).join(' ') + ' ' + explainOf(k, q) + ' ' + ((b && b.title) || '')).toLowerCase();
}
/* 关键词匹配用的 haystack 按题库缓存：几千道题时，每敲一个字都重拼一遍字符串很浪费
   （实测 5000 题：每次重拼 18ms → 缓存后 1ms）。题库/解析/修正答案一变就 bumpHay()。 */
let HAY_VER = 0;
const HAY_CACHE = new Map();
function bumpHay() { HAY_VER++; }
function hayListOf(b) {
  const c = HAY_CACHE.get(b.id);
  if (c && c.ver === HAY_VER && c.n === b.questions.length) return c.arr;
  const arr = b.questions.map(q => { const k = kOf(b, q); return { k: k, q: q, hay: hayOf(k, q, b) }; });
  HAY_CACHE.set(b.id, { ver: HAY_VER, n: b.questions.length, arr: arr });
  return arr;
}
function collect(mode, kw) {
  const out = [];
  const terms = splitKw(kw);
  allBanks().forEach(b => {
    if (b.paper) return;                       // 套卷自己的记录不进这些列表
    const list = hayListOf(b);
    for (let idx = 0; idx < list.length; idx++) {
      const it = list[idx], k = it.k, q = it.q, rec = recOf(k);
      if (mode === 'wrong') { if (!rec || (rec.wrong || 0) <= 0) continue; }
      else if (mode === 'fav') { if (!FAV[k]) continue; }
      else if (mode === 'due') { if (!isDue(k)) continue; }
      if (terms.length) {
        const hay = it.hay;
        let miss = false;
        for (let i = 0; i < terms.length; i++) if (hay.indexOf(terms[i]) < 0) { miss = true; break; }
        if (miss) continue;
      }
      out.push({ bank: b, q: q, k: k, rec: rec || { tries: 0, wrong: 0, ok: null, sel: [] } });
    }
  });
  return out;
}

function renderWrong() { renderList('wrong'); }
function renderFav() { renderList('fav'); }

function renderList(mode) {
  const st = LP[mode];
  const isWrong = (mode === 'wrong');
  $('appTitle').textContent = isWrong ? '错题本' : '我的收藏';
  $('stat').textContent = ''; $('bar').style.width = '0%';

  const items = collect(mode);
  const banksWith = {};
  items.forEach(it => { banksWith[it.bank.id] = (banksWith[it.bank.id] || 0) + 1; });

  const totalTries = items.reduce((s, it) => s + (it.rec.tries || 0), 0);
  const totalWrong = items.reduce((s, it) => s + (it.rec.wrong || 0), 0);
  const acc = totalTries ? Math.round((totalTries - totalWrong) / totalTries * 100) : 0;
  const openN = items.filter(it => !(it.rec.ok === true && !it.rec.redo)).length;

  let shown = items.slice();
  if (isWrong) shown = shown.filter(it => (it.rec.wrong || 0) >= (st.minWrong || 0));
  if (st.onlyOpen) shown = shown.filter(it => !(it.rec.ok === true && !it.rec.redo));
  if (isWrong && st.onlyDue) shown = shown.filter(it => isDue(it.k));
  if (st.bank !== 'all') shown = shown.filter(it => it.bank.id === st.bank);
  const S = SORTS[st.sort] || SORTS.wrong;
  shown.sort((a, b) => S.cmp(a, b) * (st.dir > 0 ? 1 : -1));
  st.shown = shown;

  const dueItems = isWrong ? items.filter(it => isDue(it.k)) : [];
  const selN = shown.filter(it => st.sel.has(it.k)).length;
  const selKeys = shown.filter(it => st.sel.has(it.k)).map(it => it.k);

  const bankChips = [`<button class="chip${st.bank === 'all' ? ' on' : ''}" data-b="all">全部 ${items.length}</button>`]
    .concat(Object.keys(banksWith).map(id => {
      const b = allBanks().find(x => x.id === id) || { title: id };
      return `<button class="chip${st.bank === id ? ' on' : ''}" data-b="${id}">${esc(b.title)} ${banksWith[id]}</button>`;
    })).join('');

  $('view').innerHTML = `
    <div class="card" style="margin-bottom:14px">
      <div class="stats">
        <div><b>${items.length}</b><span>${isWrong ? '错题' : '收藏'}题目</span></div>
        <div><b>${openN}</b><span>还没做对</span></div>
        ${isWrong ? `<div><b>${dueItems.length}</b><span>今天到期</span></div>` : ''}
        <div><b>${totalTries}</b><span>累计作答</span></div>
        <div><b>${totalWrong}</b><span>累计答错</span></div>
        <div><b>${acc}%</b><span>总正确率</span></div>
      </div>
      ${isWrong ? `<div class="revbar">
        <div class="dueinfo"><b>${dueItems.length ? '今天有 ' + dueItems.length + ' 道错题到期该复习' : '今天没有到期的错题'}</b>
          <span class="small muted">间隔重复：答对拉长间隔（1/3/8/20… 天），答错当天打回队列</span></div>
        <button class="btn primary" id="wRevAll" ${dueItems.length ? '' : 'disabled'}>开始复习（${dueItems.length} 题）</button>
        <button class="btn" id="wRevSel" ${selKeys.length ? '' : 'disabled'}>复习选中的 ${selKeys.length} 题</button>
      </div>` : ''}
      <div class="chips-inline">${bankChips}</div>

      <div class="tools">
        <span class="tl">排序（点第二次反向）</span>
        ${Object.keys(SORTS).map(id => {
          const active = st.sort === id;
          const dir = active ? st.dir : SORTS[id].def;
          return `<button class="chip${active ? ' on' : ''}" data-s="${id}">${SORTS[id].label} ${ARROW(dir)}</button>`;
        }).join('')}
      </div>

      ${isWrong ? `<div class="tools">
        <span class="tl">筛选</span>
        <span class="tl">错次 ≥</span><input type="number" min="0" value="${st.minWrong}" id="minW" class="num">
        <label class="chk mini"><input type="checkbox" id="onlyOpen" ${st.onlyOpen ? 'checked' : ''}>只看还没做对的</label>
        <label class="chk mini"><input type="checkbox" id="onlyDue" ${st.onlyDue ? 'checked' : ''}>只看今天该复习的</label>
      </div>` : ''}

      <details class="fold">
        <summary>批量操作与导出 · 已选 <b>${selN}</b> 题</summary>
        <div class="fold-body">
          <div class="tools">
            <span class="tl">勾选</span>
            <button class="btn" id="selAll">全选（${shown.length}）</button>
            <button class="btn" id="selInv">反选</button>
            <button class="btn" id="selNone">清空</button>
          </div>

          <div class="tools">
            <span class="tl">对选中的题</span>
            <button class="btn" data-batch="fav">☆ 收藏</button>
            <button class="btn" data-batch="unfav">取消收藏</button>
            ${isWrong ? `<button class="btn" data-batch="clearCount">清空作答/错误次数</button>
            <button class="btn danger" data-batch="drop">移除记录</button>` : ''}
            <button class="btn primary" data-batch="paper">组成套卷重做</button>
            <button class="btn" data-batch="exam">模拟考试</button>
          </div>

          ${paperRowsHtml()}

          <div class="tools">
            <span class="tl">导出</span>
            <label class="chk mini"><input type="checkbox" id="withExp" ${st.withExp ? 'checked' : ''}>含解析</label>
            <label class="chk mini"><input type="checkbox" id="withImg" ${st.withImg ? 'checked' : ''}>含图片</label>
            <label class="chk mini"><input type="checkbox" id="withSel" ${st.withSel ? 'checked' : ''}>含我的选择（错项）</label>
            <label class="chk mini"><input type="checkbox" id="withStat" ${st.withStat ? 'checked' : ''}>含错次统计</label>
            <select id="fmtSel" class="num">
              <option value="md">Markdown</option>
              <option value="html">HTML（可打印成PDF）</option>
              <option value="json">JSON</option>
            </select>
            <button class="btn primary" id="expSel" ${selN ? '' : 'disabled'}>导出选中（${selN}）</button>
            <button class="btn" id="expShown">导出当前列表（${shown.length}）</button>
          </div>
        </div>
      </details>
    </div>

    ${shown.length ? shown.map(it => itemHtml(it, mode)).join('')
      : `<div class="card"><div class="empty">${items.length ? '当前筛选条件下没有题目，放宽一下条件试试。' : (isWrong ? '还没有错题。答错的题会自动进来。' : '还没有收藏。刷题时点右上角「☆ 收藏」。')}</div></div>`}
  `;

  /* 事件 */
  $('view').querySelectorAll('.chips-inline .chip').forEach(c => c.onclick = () => { st.bank = c.dataset.b; render(); });
  $('view').querySelectorAll('[data-s]').forEach(c => c.onclick = () => {
    const id = c.dataset.s;
    if (st.sort === id) st.dir = -(st.dir || SORTS[id].def);
    else { st.sort = id; st.dir = SORTS[id].def; }
    render();
  });
  on('minW', () => { st.minWrong = Math.max(0, +$('minW').value || 0); render(); }, 'change');
  on('onlyOpen', () => { st.onlyOpen = $('onlyOpen').checked; render(); }, 'change');
  on('onlyDue', () => { st.onlyDue = $('onlyDue').checked; render(); }, 'change');
  on('wRevAll', () => makePaper('错题复习 · ' + dueItems.length + ' 题', dueItems.map(it => it.k)));
  on('wRevSel', () => makePaper('错题复习 · ' + selKeys.length + ' 题', selKeys));
  on('withExp', () => { st.withExp = $('withExp').checked; render(); }, 'change');
  on('withImg', () => { st.withImg = $('withImg').checked; render(); }, 'change');
  on('withSel', () => { st.withSel = $('withSel').checked; render(); }, 'change');
  on('withStat', () => { st.withStat = $('withStat').checked; render(); }, 'change');
  bindCommonTools(mode, shown);
  on('expSel', () => doExport(mode, shown.filter(it => st.sel.has(it.k)), $('fmtSel').value, st));
  on('expShown', () => doExport(mode, shown, $('fmtSel').value, st));

  $('view').querySelectorAll('.wi').forEach(node => {
    const it = shown.find(x => x.k === node.dataset.k);
    if (it) bindItem(node, mode, it);
  });
}

/* 列表页通用交互：勾选 + 批量 + 套卷/试卷命名行（各列表页共用） */
function bindCommonTools(mode, shown) {
  const st = LP[mode];
  on('selAll', () => { shown.forEach(it => st.sel.add(it.k)); render(); });
  on('selInv', () => { shown.forEach(it => st.sel.has(it.k) ? st.sel.delete(it.k) : st.sel.add(it.k)); render(); });
  on('selNone', () => { st.sel.clear(); render(); });
  document.querySelectorAll('[data-batch]').forEach(b => b.onclick = () => batch(mode, b.dataset.batch));
  on('paperOk', () => makePaper(($('paperName').value || '').trim() || '临时套卷', st.pendingKeys || []));
  on('paperCancel', () => { st.pendingKeys = []; $('paperRow').style.display = 'none'; });
  on('examOk', () => {
    const keysAll = st.pendingKeys || [];
    const lim = Math.max(1, Math.min(keysAll.length, +$('examLimit').value || keysAll.length));
    const mins = Math.max(0, +$('examMin').value || 0);
    const nm = ($('examName').value || '').trim() || ('模拟考试 · ' + lim + ' 题');
    makePaper(nm, shuffle(keysAll).slice(0, lim), { exam: true, duration: mins * 60 });
  });
  on('examCancel', () => { st.pendingKeys = []; $('examRow').style.display = 'none'; });
}

/* 套卷 / 试卷命名行 */
function paperRowsHtml() {
  return `
      <div class="tools" id="paperRow" style="display:none">
        <span class="tl">套卷名称</span>
        <input type="text" id="paperName" class="num" style="min-width:180px;flex:1 1 180px">
        <button class="btn primary" id="paperOk">生成并开始做</button>
        <button class="btn" id="paperCancel">取消</button>
      </div>
      <div class="tools" id="examRow" style="display:none">
        <span class="tl">试卷名称</span>
        <input type="text" id="examName" class="num" style="min-width:150px;flex:1 1 150px">
        <span class="tl">题数</span><input type="number" id="examLimit" class="num" min="1" style="width:76px">
        <span class="tl">时长(分钟)</span><input type="number" id="examMin" class="num" min="0" style="width:76px">
        <button class="btn primary" id="examOk">开始考试</button>
        <button class="btn" id="examCancel">取消</button>
      </div>`;
}
function batch(mode, op) {
  const st = LP[mode];
  const sel = (st.shown || []).filter(it => st.sel.has(it.k));
  if (!sel.length) { toast('先勾选题目'); return; }
  const n = sel.length;
  const keys = sel.map(it => it.k);

  if (op === 'fav') {
    keys.forEach(k => FAV[k] = Date.now());
    saveFav(); toast(`已收藏 ${n} 题`); render();
  } else if (op === 'unfav') {
    keys.forEach(k => { delete FAV[k]; tombAdd('fav', k); });
    saveFav(); toast(`已取消收藏 ${n} 题`); render();
  } else if (op === 'drop') {
    if (!confirm(`把选中的 ${n} 道题的作答记录（含错题次数）移除？不可恢复。`)) return;
    keys.forEach(k => { delete ANS[k]; tombAdd('ans', k); st.sel.delete(k); });
    saveAns(); toast(`已移除 ${n} 题`); render();
  } else if (op === 'clearCount') {
    if (!confirm(`把选中的 ${n} 道题的作答次数和答错次数清零？题目本身不删，但清零后就不再算「错题」了（想留着可以先收藏）。`)) return;
    keys.forEach(k => {
      const a = ANS[k];
      if (!a) return;
      a.tries = 0; a.wrong = 0; a.ts = 0; a.upd = Date.now(); a.redo = true;   // upd 让「清零」在合并时也不会被旧记录盖回去
    });
    saveAns(); toast(`已清空 ${n} 题的次数`); render();
  } else if (op === 'paper') {
    const suggest = (mode === 'wrong' ? '错题套卷' : mode === 'fav' ? '收藏套卷' : '复习套卷') + ' · ' + n + ' 题';
    st.pendingKeys = keys;
    const row = $('paperRow');
    if (row) {
      row.style.display = 'flex';
      $('paperName').value = suggest;
      $('paperName').focus();
      toast('给套卷起个名字，点「生成并开始做」');
    } else { makePaper(suggest, keys); }
  } else if (op === 'exam') {
    st.pendingKeys = keys;
    const row = $('examRow');
    if (!row) { makePaper('模拟考试 · ' + n + ' 题', shuffle(keys).slice(0, 50), { exam: true, duration: 3600 }); return; }
    row.style.display = 'flex';
    $('examName').value = '模拟考试 · ' + n + ' 题';
    $('examLimit').value = Math.min(n, 50);
    $('examMin').value = 60;
    $('examName').focus();
    toast('设好题数和时长，点「开始考试」');
  }
}

/* 搜索高亮：没有关键词时等同于 esc()，有就包一层 <mark>。
   关键词也要先转义，才能和转义后的正文对齐。 */
let HL_KW = '';
function hl(s) {
  const t = esc(s == null ? '' : s);
  const parts = splitKw(HL_KW).map(w => esc(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).filter(Boolean).sort((a, b) => b.length - a.length);
  if (!parts.length) return t;
  try { return t.replace(new RegExp('(' + parts.join('|') + ')', 'gi'), '<mark>$1</mark>'); } catch (e) { return t; }
}

/* ---------------- 单条 ---------------- */
function itemHtml(it, mode) {
  const k = it.k, q = it.q, rec = it.rec, st = LP[mode];
  const open = st.open.has(k);
  const sel = st.sel.has(k);
  const custom = !!noteOf(k);
  const fav = !!FAV[k];
  const mastered = rec.ok === true && !rec.redo;
  const stem = q.stem.length > 46 ? q.stem.slice(0, 46) + '…' : q.stem;
  return `
  <div class="card wi" data-k="${esc(k)}">
    <div class="wi-head">
      <input type="checkbox" class="wsel" ${sel ? 'checked' : ''} title="勾选后可批量操作">
      <span class="wno">第 ${q.id} 题</span>
      <span class="tag g">${esc(it.bank.title)}</span>
      ${hasFix(k) ? '<span class="mini-tag" title="答案是你手动改过的，只在本机生效">答案已修正</span>' : ''}
      ${mode === 'wrong'
        ? `<span class="wmeta ${mastered ? 'good' : 'bad'}">错 ${rec.wrong || 0} 次 · 作答 ${rec.tries || 0} 次 · 正确率 ${rateOf(rec)}%${mastered ? ' · 已做对' : ''}</span>`
        : mode === 'due'
        ? `<span class="wmeta">${dueText(k)} · 错 ${rec.wrong || 0} 次 / 作答 ${rec.tries || 0} 次 · 正确率 ${rateOf(rec)}%</span>`
        : `<span class="wmeta">${rec.tries ? `作答 ${rec.tries} 次 · 错 ${rec.wrong || 0} 次 · 正确率 ${rateOf(rec)}%` : '还没做过'}${mode === 'search' ? ' · ' + dueText(k) : ''}</span>`}
      <span class="spacer-grow"></span>
      <button class="btn tiny" data-act="open">${open ? '收起' : '展开'}</button>
      <button class="btn tiny" data-act="fav">${fav ? '★' : '☆'}</button>
      ${(mode === 'wrong' || mode === 'fav') ? `<button class="btn tiny danger" data-act="${mode === 'wrong' ? 'drop' : 'unfav'}" title="${mode === 'wrong' ? '移除这条记录' : '取消收藏'}">×</button>` : ''}
    </div>
    ${open ? '' : `<div class="wi-stem">${hl(stem)}</div>`}
    ${open ? `
    <div class="wi-body">
      ${q.group ? `<div class="gstem"><b>共用题干：</b>${hl(q.group)}</div>` : ''}
      <div class="stem-sm">${hl(q.stem)}</div>
      <div class="opts-sm">${q.options.map((o, i) => {
        const K = 'ABCDEFGH'[i];
        const right = ansOf(k, q).includes(K);
        const mine = (rec.sel || []).includes(K);
        return `<div class="o ${right ? 'r' : ''}${mine && !right ? ' w' : ''}"><b>${K}</b>${hl(o)}${right ? '<span class="mini-tag ok">正确</span>' : ''}${mine && !right ? '<span class="mini-tag bad">我选的</span>' : ''}</div>`;
      }).join('')}</div>
      <div class="small" style="margin:6px 0">我的选择：<b>${(rec.sel || []).join('') || '—'}</b>${rec.ts ? `　最近作答：${fmtTime(rec.ts)}` : ''}　错 ${rec.wrong || 0} 次 / 作答 ${rec.tries || 0} 次${custom ? '　<span class="mini-tag">已自定义解析</span>' : ''}</div>
      <div class="exp">${renderRich(k, explainOf(k, q))}</div>
      <div class="actions" style="margin-top:10px">
        <button class="btn" data-act="note">${custom ? '改解析' : '写解析'}</button>
        <button class="btn" data-act="fix" title="题库答案写错了 / 自己点错了：可以在这里改">${hasFix(k) ? '改答案（已修正）' : '改答案'}</button>
        <button class="btn" data-act="ai" title="让 AI 写解析（可以带上本地知识库的资料）">AI 解析</button>
        <button class="btn" data-act="link">去题库里做这道题</button>
      </div>
      <div class="note-host"></div>
      <div class="fix-host"></div>
      <div class="ai-host"></div>
    </div>` : ''}
  </div>`;
}

function bindItem(node, mode, it) {
  const st = LP[mode], k = node.dataset.k;
  const box = node.querySelector('.wsel');
  if (box) box.onchange = () => { box.checked ? st.sel.add(k) : st.sel.delete(k); render(); };
  node.querySelectorAll('[data-act]').forEach(btn => btn.onclick = e => {
    e.stopPropagation();
    const act = btn.dataset.act;
    if (act === 'open') { st.open.has(k) ? st.open.delete(k) : st.open.add(k); render(); }
    else if (act === 'fav') { toggleFav(k); }
    else if (act === 'unfav') { delete FAV[k]; tombAdd('fav', k); saveFav(); st.sel.delete(k); toast('已取消收藏'); render(); }
    else if (act === 'drop') {
      if (!confirm('把这道题的作答记录（含错题次数）移除？不可恢复。')) return;
      delete ANS[k]; tombAdd('ans', k); saveAns(); st.sel.delete(k); toast('已移除'); render();
    }
    else if (act === 'note') openNoteEditor(k, node.querySelector('.note-host'), it.q, render);
    else if (act === 'fix') openAnsEditor(node.querySelector('.fix-host'), k, it.q, render);
    else if (act === 'ai') { if (typeof aiOpenPanel === 'function') aiOpenPanel(node.querySelector('.ai-host'), k, it.q); else toast('AI 模块没加载（ai.js）'); }
    else if (act === 'link') {
      const b = allBanks().find(x => !x.paper && k.indexOf(x.id + '#') === 0);
      if (!b) return;
      const qid = k.slice(b.id.length + 1);
      QZ.filter = 'all'; QZ.order = null; QZ.cur = isNaN(+qid) ? qid : +qid;
      go('#/bank/' + b.id);
    }
  });
}

/* ---------------- 导出 ---------------- */
function doExport(mode, items, fmt, st) {
  if (!items.length) { toast('没有可导出的题目'); return; }
  const withExp = st.withExp !== false, withImg = st.withImg !== false;
  const withSel = st.withSel !== false, withStat = st.withStat !== false;
  const bankName = st.bank === 'all' ? '' : (allBanks().find(b => b.id === st.bank) || {}).title;
  const title = (mode === 'wrong' ? '错题集' : mode === 'fav' ? '收藏集' : '搜索结果') + (bankName ? ' · ' + bankName : '');
  const base = safeName(title) + '-' + stamp();
  const opt = { withExp: withExp, withImg: withImg, withSel: withSel, withStat: withStat };

  if (fmt === 'json') {
    const data = {
      kind: mode, exportedAt: new Date().toISOString(), options: opt,
      items: items.map(it => ({
        bankId: it.bank.id, bankTitle: it.bank.title, qid: it.q.id,
        stem: it.q.stem, group: it.q.group || '', options: it.q.options, answer: ansOf(it.k, it.q),
        explain: withExp ? explainOf(it.k, it.q) : '',
        custom: !!noteOf(it.k),
        images: withImg ? ((noteOf(it.k) || {}).imgs || []).map(x => x.src) : [],
        myChoice: withSel ? (it.rec.sel || []) : [],
        tries: withStat ? (it.rec.tries || 0) : null,
        wrong: withStat ? (it.rec.wrong || 0) : null
      }))
    };
    download(base + '.json', JSON.stringify(data, null, 2), 'application/json');
  } else if (fmt === 'html') {
    download(base + '.html', buildHtml(title, items, opt), 'text/html');
  } else {
    download(base + '.md', buildMd(title, items, opt), 'text/markdown');
  }
  toast('已导出 ' + items.length + ' 题');
}

function metaLine(it, o) {
  const parts = ['**正确答案：' + ansOf(it.k, it.q).join('') + '**'];
  if (o.withSel) parts.push('我的选择：' + ((it.rec.sel || []).join('') || '—'));
  if (o.withStat) parts.push(`错 ${it.rec.wrong || 0} 次 / 作答 ${it.rec.tries || 0} 次　正确率 ${rateOf(it.rec)}%`);
  return parts.join('　');
}
function metaLineHtml(it, o) {
  const parts = ['<b>正确答案：' + ansOf(it.k, it.q).join('') + '</b>'];
  if (o.withSel) parts.push('我的选择：' + ((it.rec.sel || []).join('') || '—'));
  if (o.withStat) parts.push(`错 ${it.rec.wrong || 0} 次 / 作答 ${it.rec.tries || 0} 次　正确率 ${rateOf(it.rec)}%`);
  return parts.join('　');
}

function buildMd(title, items, o) {
  const L = [];
  L.push('# ' + title);
  L.push('');
  L.push('> 导出时间：' + fmtTime(Date.now()) + '　共 ' + items.length + ' 题' + (o.withStat ? '' : ''));
  L.push('');
  items.forEach((it, i) => {
    L.push('---');
    L.push('');
    L.push(`## ${i + 1}. ${it.bank.title} · 第 ${it.q.id} 题`);
    L.push('');
    if (it.q.group) { L.push('> **共用题干**：' + it.q.group); L.push(''); }
    L.push(it.q.stem);
    L.push('');
    it.q.options.forEach((opt, j) => L.push('ABCDEFGH'[j] + '. ' + opt));
    L.push('');
    L.push(metaLine(it, o));
    L.push('');
    if (o.withExp) {
      const ex = explainOf(it.k, it.q);
      if (ex) { L.push('**解析**'); L.push(''); L.push(ex); L.push(''); }
      if (o.withImg) ((noteOf(it.k) || {}).imgs || []).forEach(im => { L.push(`![${im.name || '图'}]( ${im.src} )`); L.push(''); });
    }
  });
  return L.join('\n');
}

function buildHtml(title, items, o) {
  const body = items.map((it, i) => {
    const opts = it.q.options.map((t, j) => {
      const K = 'ABCDEFGH'[j], right = ansOf(it.k, it.q).includes(K), mine = (it.rec.sel || []).includes(K);
      return `<div class="o${right ? ' r' : ''}${mine && !right ? ' w' : ''}"><b>${K}</b> ${esc(t)}${right ? '<span class="t ok">正确</span>' : ''}${mine && !right ? '<span class="t bad">我选的</span>' : ''}</div>`;
    }).join('');
    const imgs = o.withImg ? ((noteOf(it.k) || {}).imgs || []) : [];
    return `<section class="q">
      <h2>${i + 1}. ${esc(it.bank.title)} · 第 ${it.q.id} 题</h2>
      ${it.q.group ? `<div class="g"><b>共用题干：</b>${esc(it.q.group)}</div>` : ''}
      <div class="stem">${esc(it.q.stem)}</div>
      <div class="opts">${opts}</div>
      <div class="meta">${metaLineHtml(it, o)}</div>
      ${o.withExp ? `<div class="exp"><b>解析</b>${mdToHtml(explainOf(it.k, it.q))}${imgs.map(im => `<img src="${im.src}" alt="">`).join('')}</div>` : ''}
    </section>`;
  }).join('\n');

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<style>
body{font:15px/1.75 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;max-width:820px;margin:0 auto;padding:24px;color:#1c1f23}
.tbl-wrap{overflow-x:auto;margin:10px 0}
h1{font-size:22px} .intro{color:#6b7280;font-size:13px;margin-bottom:20px}
.q{border-top:1px solid #e5e7eb;padding:18px 0}
.q h2{font-size:15px;margin:0 0 10px}
.g{background:#f8fafc;border-left:3px solid #cbd5e1;padding:8px 12px;margin-bottom:10px;font-size:14px;color:#334155}
.stem{margin-bottom:10px;white-space:pre-wrap}
.o{border:1px solid #e5e7eb;border-radius:8px;padding:8px 10px;margin-bottom:6px}
.o.r{background:#eaf7ee;border-color:#86efac} .o.w{background:#fdeeee;border-color:#fca5a5}
.t{font-size:11px;padding:1px 7px;border-radius:99px;margin-left:6px}
.t.ok{background:#15803d;color:#fff} .t.bad{background:#dc2626;color:#fff}
.meta{font-size:13.5px;color:#374151;margin:10px 0}
.exp{border-top:1px dashed #d9dde3;padding-top:10px;font-size:14px;color:#374151}
.exp img{max-width:100%;display:block;margin:10px 0;border:1px solid #e5e7eb;border-radius:8px}
.exp h1,.exp h2,.exp h3,.exp h4{font-size:15px;margin:10px 0 6px}
.exp blockquote{border-left:3px solid #cbd5e1;margin:8px 0;padding:2px 10px;color:#475569}
.exp code{background:#f1f5f9;padding:1px 5px;border-radius:4px;font-size:13px}
.exp table{border-collapse:collapse;width:100%;margin:10px 0;font-size:13.5px}
.exp th,.exp td{border:1px solid #e5e7eb;padding:6px 9px;vertical-align:top;text-align:left}
.exp th{background:#f8fafc;font-weight:700}
.exp tbody tr:nth-child(even){background:#fcfdfe}
@media print{ body{padding:0} .q{page-break-inside:avoid} }
</style></head><body>
<h1>${esc(title)}</h1>
<div class="intro">导出时间：${fmtTime(Date.now())}　共 ${items.length} 题　（用浏览器「打印 → 另存为 PDF」即可得到 PDF）</div>
${body}
</body></html>`;
}

/* ---------------- 搜索 ---------------- */
/* ⚠ 搜索框千万不能在输入过程中被重建：<input> 一被销毁重建，中文输入法的候选就断了，
   最后只剩一串拼音字母。所以这里把「搜索框骨架」和「结果区」拆开：
   骨架只在进入搜索页时搭一次，之后打字 / 切范围 / 展开题目都只重画 #sres。 */
const HIST_KEY = 'qbank.searchhist.v1';
let SHIST = readLS(HIST_KEY, []);
if (!Array.isArray(SHIST)) SHIST = [];
let sTimer = 0, sComposing = false;

function pushHist(kw) {
  kw = String(kw || '').trim();
  if (!kw) return;
  if (SHIST[0] && (kw.indexOf(SHIST[0]) === 0 || SHIST[0].indexOf(kw) === 0)) SHIST[0] = kw;   // 一边打一边搜，只留最后一条
  else if (SHIST[0] !== kw) SHIST.unshift(kw);
  SHIST = SHIST.filter((x, i) => x && SHIST.indexOf(x) === i).slice(0, 12);
  writeLS(HIST_KEY, SHIST);
}

function scheduleSearch(now) {
  clearTimeout(sTimer);
  sTimer = setTimeout(() => { pushHist(LP.search.kw); paintSearch(); }, now ? 0 : 170);
}

function renderSearch() {
  const st = LP.search;
  $('appTitle').textContent = '搜索题目';
  $('stat').textContent = ''; $('bar').style.width = '0%';

  const shell = $('sbar');
  if (!shell || !$('view').contains(shell)) {
    $('view').innerHTML = `
      <div class="card sbar-sticky" id="sbar" style="margin-bottom:14px">
        <div class="field" style="margin-top:0">
          <label>关键词（题干 / 选项 / 解析 / 题库名都能搜；空格分开＝每个词都要命中）　按 <b>/</b> 可直接聚焦这里</label>
          <div class="sbox">
            <input type="text" id="sq" value="${esc(st.kw || '')}" placeholder="例如：肾素　PaO2　树胶样肿" autocomplete="off" spellcheck="false">
            <button class="btn tiny" id="sqClear" title="清空" style="display:${st.kw ? '' : 'none'}">×</button>
          </div>
        </div>
        <div class="tools" id="shistRow" style="margin-top:8px"></div>
      </div>
      <div id="sres"></div>`;

    const el = $('sq');
    /* 中文输入法：组合期间绝不重画结果，等 compositionend 再搜 */
    el.addEventListener('compositionstart', () => { sComposing = true; });
    el.addEventListener('compositionend', () => {
      sComposing = false;
      st.kw = el.value;
      clearTimeout(sTimer);
      pushHist(st.kw);
      paintSearch();
    });
    el.addEventListener('input', () => {
      st.kw = el.value;
      const c = $('sqClear'); if (c) c.style.display = el.value ? '' : 'none';
      if (sComposing) return;                 // 拼音还在候选框里，先别搜
      scheduleSearch(false);
    });
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); clearTimeout(sTimer); st.kw = el.value; pushHist(st.kw); paintSearch(); }
      else if (e.key === 'Escape') { e.preventDefault(); st.kw = ''; el.value = ''; const c = $('sqClear'); if (c) c.style.display = 'none'; paintSearch(); }
    });
    on('sqClear', () => { st.kw = ''; el.value = ''; const c = $('sqClear'); if (c) c.style.display = 'none'; el.focus(); paintSearch(); });
    setTimeout(() => { try { el.focus(); } catch (e) {} }, 40);
  }
  paintSearch();
}

function paintSearch() {
  const st = LP.search, host = $('sres');
  if (!host) return;
  const kw = String(st.kw || '').trim();
  HL_KW = kw;
  let items = kw ? collect('all', kw) : [];
  const scope = st.scope || 'all';
  if (scope === 'wrong') items = items.filter(it => (it.rec.wrong || 0) > 0);
  else if (scope === 'fav') items = items.filter(it => FAV[it.k]);
  else if (scope === 'due') items = items.filter(it => isDue(it.k));
  else if (scope === 'undone') items = items.filter(it => !ANS[it.k]);
  const total = items.length;
  const shown = items.slice(0, 300);
  st.shown = shown;

  const scopes = [['all', '全部'], ['wrong', '错题'], ['fav', '收藏'], ['due', '待复习'], ['undone', '没做过的']];
  host.innerHTML = `
    <div class="card" style="margin-bottom:14px">
      <div class="tools" style="margin-top:0">
        <span class="tl">范围</span>
        ${scopes.map(([k, t]) => `<button class="chip${scope === k ? ' on' : ''}" data-scope="${k}">${t}</button>`).join('')}
        <span class="spacer-grow"></span>
        <span class="tl">${kw ? '命中 ' + total + ' 题' + (total > shown.length ? '（只显示前 ' + shown.length + ' 条）' : '') : '输入关键词开始搜索'}</span>
        ${shown.length ? '<button class="btn" id="sExp">导出这 ' + shown.length + ' 题</button>' : ''}
        ${shown.length ? '<button class="btn primary" id="sPaper">组成套卷做一遍</button>' : ''}
      </div>
    </div>
    ${shown.length ? shown.map(it => itemHtml(it, 'search')).join('')
      : (kw ? '<div class="card"><div class="empty">没搜到。换个关键词，或者把范围放宽到「全部」。</div></div>' : '')}`;
  HL_KW = '';
  paintHist();

  host.querySelectorAll('[data-scope]').forEach(c => c.onclick = () => { st.scope = c.dataset.scope; paintSearch(); });
  host.querySelectorAll('.wi').forEach(node => {
    const it = shown.find(x => x.k === node.dataset.k);
    if (it) bindItem(node, 'search', it);
  });
  on('sExp', () => doExport('search', shown, 'md', st));
  on('sPaper', () => makePaper('搜索套卷 · ' + shown.length + ' 题', shown.map(it => it.k)));
}

function paintHist() {
  const row = $('shistRow');
  if (!row) return;
  if (!SHIST.length) { row.innerHTML = '<span class="tl">搜过的关键词会留在这里，下次点一下就能再搜</span>'; return; }
  row.innerHTML = '<span class="tl">最近搜过</span>' + SHIST.map((k, i) => `<button class="chip" data-hist="${i}">${esc(k)}</button>`).join('') + '<button class="btn tiny ghost" id="histClear">清空</button>';
  row.querySelectorAll('[data-hist]').forEach(b => b.onclick = () => {
    const kw = SHIST[+b.dataset.hist] || '';
    const el = $('sq');
    LP.search.kw = kw;
    if (el) { el.value = kw; const c = $('sqClear'); if (c) c.style.display = 'none'; el.focus(); }
    paintSearch();
  });
  on('histClear', () => { SHIST = []; writeLS(HIST_KEY, []); paintHist(); });
}

/* 启动：改由 index.html 在所有模块都加载完之后统一调用 render()，
   否则直接打开 #/exam/... 或 #/kb 时，renderExam / renderKb 还没定义，页面会空白 */
