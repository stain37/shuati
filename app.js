/* ============================================================
   刷题站 · 核心 app.js
   题库：banks/*.js（registerBank）+ 本地导入 + 临时套卷
   存储：全部在浏览器 localStorage
     qbank.answers.v2  "bankId#qid" -> { sel:[], ok:bool, tries, wrong, ts, redo }
     qbank.favs.v2     收藏
     qbank.notes.v2    自定义解析 { text, imgs:[{name,src}] }
     qbank.local.v2    自建题库
     qbank.papers.v2   临时套卷定义
     qbank.answerfix.v1 手动修正的正确答案 { key -> ['A','B'] }
     qbank.srs.v1      复习曲线（模式 + 初始参数）
   ★ 兼容旧数据：老的 { sel, ok } 读取时自动补 tries/wrong，不会被清掉。
   ============================================================ */

/* ---------- 存储 ---------- */
const LS = {
  ans: 'qbank.answers.v2',
  banks: 'qbank.local.v2',
  set: 'qbank.settings.v2',
  fav: 'qbank.favs.v2',
  note: 'qbank.notes.v2',
  paper: 'qbank.papers.v2',
  fix: 'qbank.answerfix.v1',
  srs: 'qbank.srs.v1',
  cat: 'qbank.cats.v1'
};
const readLS = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
/* 写不进去要吵醒用户：localStorage 满了 / 被禁用时悄悄丢数据是最坑的 */
let _saveWarned = false;
function saveWarn(key, err) {
  if (_saveWarned) return; _saveWarned = true;
  try {
    let el = document.getElementById("saveWarnBar");
    if (!el) { el = document.createElement("div"); el.id = "saveWarnBar"; document.body.appendChild(el); }
    el.innerHTML = `<b>数据没存进浏览器！</b>存储空间可能满了（${esc(String((err && err.name) || err || "写入失败"))}，键：${esc(key)}）。请立刻导出备份：` +
      `<button class="btn tiny" id="saveWarnExp">导出全部数据</button><button class="btn tiny" id="saveWarnClose">知道了</button>`;
    document.getElementById("saveWarnExp").onclick = function () { if (typeof exportAllData === "function") exportAllData(); };
    document.getElementById("saveWarnClose").onclick = function () { el.remove(); };
  } catch (e) {}
}
const writeLS = (k, v) => {
  try { localStorage.setItem(k, JSON.stringify(v)); }
  catch (e) { if (String(k).indexOf("qbank.") === 0) saveWarn(k, e); return false; }
  return true;
};

/* ---------- 多标签安全：同时开两个标签页也不丢数据 ----------
   内存里的 ANS/FAV/NOTES… 只在打开页面时读一次。两个标签页各答各的，
   后写的那次会把先写的整份记录覆盖掉，而且没有任何提示。这里的做法：
     1) 写入前先读回最新存档，按每条记录的时间戳合并（谁新用谁的）；
     2) 删除记进墓碑表 qbank.tomb.v1，免得被另一个标签页的合并又「复活」；
     3) 监听 storage 事件：别的标签页一写，本页立刻把最新数据读进内存。
   记录没有时间戳时（老数据、旧收藏）以本页内存为准，但不会盖掉存档里更新的那条。 */
const TOMB_KEY = 'qbank.tomb.v1';
let TOMB = readLS(TOMB_KEY, {});            // { ans:{键:时间}, fav:{}, note:{}, fix:{}, paper:{}, wipe:{ans:时间} }
const TOMB_TTL = 7 * 86400000;

function tombAdd(kind, key) {
  const now = Date.now();
  const t = TOMB[kind] = TOMB[kind] || {};
  t[key] = now;
  Object.keys(t).forEach(x => { if (now - t[x] > TOMB_TTL) delete t[x]; });  // 顺手清理过期墓碑
  writeLS(TOMB_KEY, TOMB);
}
function tombWipe(kind) {                    // 整表清空（例如「清空作答记录」），别让旧记录被合并回来
  TOMB[kind] = {};
  TOMB.wipe = TOMB.wipe || {};
  TOMB.wipe[kind] = Date.now();
  writeLS(TOMB_KEY, TOMB);
}
function tombClear() { TOMB = { ans: {}, fav: {}, note: {}, fix: {}, paper: {}, wipe: {} }; writeLS(TOMB_KEY, TOMB); }
function recTs(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  return Math.max(+v.ts || 0, +v.upd || 0, +v.updatedAt || 0, +v.createdAt || 0);
}
/* 合并写入：mem 是内存里的对象（就地改成合并后的结果），返回是否写成功 */
function mergeWrite(key, mem, kind) {
  const isArr = Array.isArray(mem);
  const stored = readLS(key, isArr ? [] : {});
  const tomb = TOMB[kind] || {};
  const wipe = (TOMB.wipe || {})[kind] || 0;
  let out;
  if (isArr) {
    out = mem.filter(x => !(x && x.id != null && tomb[x.id]));                             // 本页删掉的（有墓碑）不再留
    const seen = {};
    out.forEach(x => { if (x && x.id != null) seen[x.id] = 1; });
    (stored || []).forEach(x => { if (x && x.id != null && !seen[x.id] && !tomb[x.id]) out.push(x); });   // 数组按 id 并集，但不复活墓碑
  } else {
    out = {};
    Object.keys(stored || {}).forEach(k => { if (!tomb[k] && recTs(stored[k]) >= wipe) out[k] = stored[k]; });
    Object.keys(mem).forEach(k => {
      const mine = mem[k], theirs = out[k];
      if (!theirs) { if (!(tomb[k] && tomb[k] >= recTs(mine))) out[k] = mine; return; }
      if (recTs(theirs) > recTs(mine)) return;    // 存档那条更新：保留存档的
      out[k] = mine;
    });
  }
  if (isArr) { mem.length = 0; out.forEach(x => mem.push(x)); }
  else { Object.keys(mem).forEach(k => delete mem[k]); Object.keys(out).forEach(k => { mem[k] = out[k]; }); }
  return writeLS(key, out);
}
/* 保存统一入口：全部走合并写入 */
const saveAns = () => mergeWrite(LS.ans, ANS, 'ans');
const saveFav = () => mergeWrite(LS.fav, FAV, 'fav');
const saveNotes = () => { const r = mergeWrite(LS.note, NOTES, 'note'); if (typeof bumpHay === 'function') bumpHay(); return r; };
const saveFix = () => { const r = mergeWrite(LS.fix, FIX, 'fix'); if (typeof bumpHay === 'function') bumpHay(); return r; };
const savePapers = () => mergeWrite(LS.paper, PAPERS, 'paper');

/* 别的标签页写了 → 把最新数据读进内存；正打字就先不重画，免得把输入冲掉 */
let _syncT = 0, _syncNeed = false;
window.addEventListener('storage', e => {
  if (!e || !e.key) return;
  const k = e.key;
  if (k === LS.ans) ANS = readLS(LS.ans, {});
  else if (k === LS.fav) FAV = readLS(LS.fav, {});
  else if (k === LS.note) NOTES = readLS(LS.note, {});
  else if (k === LS.fix) FIX = readLS(LS.fix, {});
  else if (k === LS.paper) { PAPERS = readLS(LS.paper, []); invalidateBanks(); }
  else if (k === LS.banks) { LOCAL = readLS(LS.banks, []); invalidateBanks(); }
  else if (k === LS.srs) SRS = readLS(LS.srs, {});
  else if (k === LS.cat) {                       // 别的标签页改了分类：直接让分类模块重画（它自己写自己，不再走下面的事件）
    if (typeof CAT !== 'undefined' && CAT && CAT.reload) { try { CAT.reload(); CAT.render(); } catch (err) {} }
    return;
  }
  else if (k === LS.set) { SET = Object.assign(SET, readLS(LS.set, {})); applyLook(); }
  else if (k === TOMB_KEY) TOMB = readLS(TOMB_KEY, {});
  else return;
  _syncNeed = true;
  clearTimeout(_syncT);
  _syncT = setTimeout(() => {
    if (!_syncNeed) return;
    _syncNeed = false;
    const el = document.activeElement;
    if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;   // 正在打字：先只更新内存
    try { render(); showSyncTip(); } catch (err) {}
  }, 250);
});
function showSyncTip() {
  let el = $('syncTip');
  if (!el) { el = document.createElement('div'); el.id = 'syncTip'; el.className = 'syncTip'; document.body.appendChild(el); }
  el.textContent = '已同步另一个标签页的改动';
  el.classList.add('show');
  clearTimeout(showSyncTip._t);
  showSyncTip._t = setTimeout(() => el.classList.remove('show'), 2600);
}

let ANS = readLS(LS.ans, {});
let LOCAL = readLS(LS.banks, []);
let FAV = readLS(LS.fav, {});
let NOTES = readLS(LS.note, {});
let PAPERS = readLS(LS.paper, []);     // [{ id, title, createdAt, keys:[] }]
let SET = readLS(LS.set, { expOnOk: true, autoNext: false, shuffle: false });
let FIX = readLS(LS.fix, {});          // 手动修正的正确答案（只在本机生效，题库文件不动）
let SRS = readLS(LS.srs, {});          // 复习曲线：模式 + 初始参数
/* 新增的外观设置：老数据里没有这两项，读出来补上默认值 */
const SET_DEF = { expOnOk: true, autoNext: false, shuffle: false, theme: 'auto', fs: 'm' };
Object.keys(SET_DEF).forEach(k => { if (SET[k] == null) SET[k] = SET_DEF[k]; });
const BACKUP_KEY = 'qbank.lastbackup.v1';   // 上次导出备份的时间

function migrate() {
  let changed = false;
  Object.keys(ANS).forEach(k => {
    const a = ANS[k];
    if (!a || typeof a !== 'object') return;
    if (typeof a.ok !== 'boolean') { a.ok = false; changed = true; }
    if (!Array.isArray(a.sel)) { a.sel = []; changed = true; }
    if (a.tries == null) { a.tries = 1; changed = true; }
    if (a.wrong == null) { a.wrong = a.ok ? 0 : 1; changed = true; }
    if (a.ts == null) { a.ts = 0; changed = true; }
    if (a.ivl == null) { a.ivl = 0; changed = true; }
    if (a.ease == null) { a.ease = 2.5; changed = true; }
    if (a.due == null) { a.due = a.ts || 0; changed = true; }
  });
  if (changed) saveAns();
}
migrate();

/* ---------- 外观：深色模式 + 字号 ---------- */
function applyLook() {
  const sysDark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const dark = (SET.theme === 'dark') || (SET.theme !== 'light' && sysDark);
  document.body.classList.toggle('dark', dark);
  document.body.classList.toggle('fs-s', SET.fs === 's');
  document.body.classList.toggle('fs-l', SET.fs === 'l');
  document.body.classList.toggle('fs-xl', SET.fs === 'xl');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#0f1420' : '#2563eb');
}
function setLook(k, v) { SET[k] = v; writeLS(LS.set, SET); applyLook(); }
if (window.matchMedia) {
  try { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (SET.theme !== 'light' && SET.theme !== 'dark') applyLook(); }); } catch (e) {}
}
applyLook();

/* ---------- 题库 ---------- */
let _bankCache = null;
function invalidateBanks() { _bankCache = null; if (typeof bumpHay === 'function') bumpHay(); }

function allBanks() {
  if (!_bankCache) {
    const base = (window.__BANKS__ || []).map(b => normalizeBank(b, 'builtin'))
      .concat(LOCAL.map(b => normalizeBank(b, 'local')));
    _bankCache = base.concat(paperBanks(base));
  }
  return _bankCache;
}
function baseBanks() { return allBanks().filter(b => !b.paper); }
function bankById(id) { return allBanks().find(b => b.id === id); }
function findQIn(base, k) {
  for (const b of base) {
    const pre = b.id + '#';
    if (k.indexOf(pre) === 0) {
      const qid = k.slice(pre.length);
      const q = b.questions.find(x => String(x.id) === String(qid));
      if (q) return { bank: b, q: q };
    }
  }
  return null;
}
function paperBanks(base) {
  const out = [];
  PAPERS.forEach(p => {
    const qs = [];
    (p.keys || []).forEach(k => {
      const f = findQIn(base, k);
      if (!f) return;
      qs.push(Object.assign({}, f.q, { id: 'p' + (qs.length + 1), _srcKey: k }));
    });
    if (qs.length) out.push({
      id: p.id, title: p.title || '临时套卷', subtitle: (p.exam ? '模拟考试 · ' : '临时套卷 · ') + qs.length + ' 题',
      paper: true, exam: !!p.exam, duration: p.duration || 0, createdAt: p.createdAt || 0, questions: qs
    });
  });
  return out;
}

function normalizeBank(b, source) {
  const qs = (b.questions || []).map((q, i) => normalizeQ(q, i + 1));
  const o = { id: b.id || ('bank-' + i2s()), title: b.title || '未命名题库', subtitle: b.subtitle || '', source: source, paper: false, cat: (b.cat == null || b.cat === '' ? null : String(b.cat)), questions: qs };
  if (b.ord != null) o.ord = +b.ord || 0;      // 目录内的手排顺序
  return o;
}
function normalizeQ(q, fallbackId) {
  const opts = (q.options || []).map(String);
  let ans = q.answer == null ? [] : (Array.isArray(q.answer) ? q.answer : String(q.answer).replace(/[^A-Ha-h]/g, '').split(''));
  ans = Array.from(new Set(ans.map(a => String(a).toUpperCase()))).filter(a => 'ABCDEFGH'.includes(a)).sort();
  const o = {
    id: (q.id == null ? fallbackId : q.id),
    stem: String(q.stem || ''),
    options: opts,
    answer: ans,
    explain: String(q.explain || ''),
    group: q.group ? String(q.group) : '',
    groupTitle: q.groupTitle ? String(q.groupTitle) : ''
  };
  if (q._srcKey) o._srcKey = q._srcKey;
  return o;
}
function i2s() { return Math.random().toString(36).slice(2, 8); }

const qType = (q, ans) => ((ans || q.answer || []).length > 1 ? 'X' : 'A');
const typeLabel = (q, ans) => ((ans || q.answer || []).length > 1 ? '多选' : '单选');
const key = (bankId, qid) => bankId + '#' + qid;
const kOf = (bank, q) => key(bank.id, q.id);
const favKey = (bank, q) => (bank.paper && q._srcKey) ? q._srcKey : key(bank.id, q.id);

/* 作答记录 */
function recOf(k) {
  const a = ANS[k];
  if (!a) return null;
  if (a.tries == null) { a.tries = 1; a.wrong = a.ok ? 0 : 1; a.ts = a.ts || 0; }
  return a;
}
const answered = k => { const a = ANS[k]; return !!a && !a.redo; };
/* 到期时间：答错的题当天回到队列，答对后按间隔排期 */
/* 复习排期只针对「做错过」的题——每日复习 = 错题集的排期 */
function inSrs(k) { const a = ANS[k]; return !!a && (a.wrong || 0) > 0; }
function dueOf(k) {
  const a = ANS[k];
  if (!a) return null;
  return (a.due == null ? (a.ts || 0) : a.due);
}
function isDue(k) {
  if (!inSrs(k)) return false;
  const d = dueOf(k);
  return d != null && d <= Date.now();
}
function rateOf(a) { if (!a || !a.tries) return 0; return Math.round((a.tries - (a.wrong || 0)) / a.tries * 100); }
function noteOf(k) { return NOTES[k] || null; }
function explainOf(k, q) { const n = NOTES[k]; return (n && n.text) ? n.text : (q.explain || ''); }

/* ============================================================
   复习曲线（SRS）：可选模式 + 可自定义初始参数
   ============================================================ */
const SRS_PRESETS = {
  sm2: { label: '经典（默认）', first: 1, second: 3, factor: 'ease', ease0: 2.5, easeUp: 0, easeDown: 0.2, minEase: 1.3, maxEase: 3, wrongIvl: 1, wrongToday: true, maxIvl: 365, daily: 0,
    desc: '答对：1 → 3 → 间隔×易度；答错：打回 1 天、易度 -0.2，当天重新排队' },
  anki: { label: 'Anki 风格', first: 1, second: 4, factor: 'ease', ease0: 2.5, easeUp: 0.15, easeDown: 0.2, minEase: 1.3, maxEase: 3, wrongIvl: 1, wrongToday: true, maxIvl: 365, daily: 0,
    desc: '毕业 1 → 4 天，之后间隔×易度；答对易度 +0.15，越熟的题间隔涨得越快' },
  fast: { label: '快速通过（间隔翻倍）', first: 1, second: 2, factor: 2, ease0: 2.5, easeUp: 0, easeDown: 0.2, minEase: 1.3, maxEase: 3, wrongIvl: 1, wrongToday: true, maxIvl: 30, daily: 0,
    desc: '间隔固定翻倍、最长 30 天：适合考前把整本题库刷熟' },
  sprint: { label: '考前冲刺（短周期）', first: 1, second: 1, factor: 1.5, ease0: 2.5, easeUp: 0, easeDown: 0.2, minEase: 1.3, maxEase: 3, wrongIvl: 1, wrongToday: true, maxIvl: 10, daily: 60,
    desc: '1 → 1 → ×1.5、最长 10 天，天天见面；默认每天最多复习 60 题' },
  longterm: { label: '长期记忆（慢速）', first: 2, second: 7, factor: 'ease', ease0: 2.6, easeUp: 0.1, easeDown: 0.15, minEase: 1.5, maxEase: 3.2, wrongIvl: 2, wrongToday: false, maxIvl: 500, daily: 0,
    desc: '2 → 7 → 间隔×易度，答错退 2 天再见：题少而稳，适合长期积累' },
  custom: { label: '自定义', first: 1, second: 3, factor: 'ease', ease0: 2.5, easeUp: 0, easeDown: 0.2, minEase: 1.3, maxEase: 3, wrongIvl: 1, wrongToday: true, maxIvl: 365, daily: 0,
    desc: '自定义：完全按下面填的参数来' }
};
const SRS_FIELDS = ['first', 'second', 'factor', 'ease0', 'easeUp', 'easeDown', 'minEase', 'maxEase', 'wrongIvl', 'wrongToday', 'maxIvl', 'daily'];
function srsCfg() {
  const mode = SRS_PRESETS[SRS.mode] ? SRS.mode : 'sm2';
  const p = SRS_PRESETS[mode];
  const c = { mode: mode, label: p.label, desc: p.desc };
  SRS_FIELDS.forEach(k => { c[k] = (SRS[k] == null ? p[k] : SRS[k]); });
  return c;
}
function srsSave() { writeLS(LS.srs, SRS); }
/* 选模式＝把该模式的推荐值一次性填好，之后还能逐项微调 */
function setSrsMode(mode) {
  if (!SRS_PRESETS[mode]) return;
  SRS.mode = mode;
  SRS_FIELDS.forEach(k => { SRS[k] = SRS_PRESETS[mode][k]; });
  srsSave();
}
/* 手动改任一项 → 自动变成「自定义」，其它项保留当前值 */
function srsSetField(f, v) {
  const c = srsCfg();
  SRS_FIELDS.forEach(k => { SRS[k] = c[k]; });
  SRS[f] = v;
  SRS.mode = 'custom';
  srsSave();
}
/* 只算下一档，便于预览 */
function srsNext(ivl, ease, ok, c) {
  c = c || srsCfg();
  if (ok) {
    if (!ivl || ivl < c.first) ivl = c.first;
    else if (ivl <= c.first) ivl = c.second;
    else ivl = Math.round(ivl * (c.factor === 'ease' ? ease : (+c.factor || 2)));
    ease = Math.min(c.maxEase, ease + (+c.easeUp || 0));
    ivl = Math.max(1, Math.min(c.maxIvl, ivl));
  } else {
    ivl = Math.max(1, +c.wrongIvl || 1);
    ease = Math.max(c.minEase, ease - (+c.easeDown || 0));
  }
  return { ivl: ivl, ease: Math.round(ease * 100) / 100 };
}
function srsPreview(c) {
  c = c || srsCfg();
  let ivl = 0, ease = +c.ease0 || 2.5;
  const out = [];
  for (let i = 0; i < 8; i++) { const r = srsNext(ivl, ease, true, c); ivl = r.ivl; ease = r.ease; out.push(ivl); }
  return out;
}
function srsPreviewText(c) {
  c = c || srsCfg();
  return '答对后的间隔：' + srsPreview(c).join(' → ') + ' 天　·　答错：'
    + (c.wrongToday ? '当天重新排队' : '退 ' + Math.max(1, +c.wrongIvl || 1) + ' 天')
    + '，易度 -' + (+c.easeDown || 0)
    + (c.daily ? '　·　每天最多复习 ' + c.daily + ' 题' : '');
}

/* ============================================================
   手动修正答案：只改本机的判分依据，题库文件不动
   键与错题本/收藏一致（套卷、模考里的题记在原题上）
   ============================================================ */
function fixOf(k) { const f = FIX[k]; return (Array.isArray(f) && f.length) ? f.slice() : null; }
function hasFix(k) { return !!fixOf(k); }
function ansOf(k, q) { return fixOf(k) || ((q && q.answer) ? q.answer : []); }
function setFix(k, letters) {
  letters = Array.from(new Set((letters || []).map(x => String(x).toUpperCase()).filter(a => 'ABCDEFGH'.includes(a)))).sort();
  if (letters.length) FIX[k] = letters; else delete FIX[k];
  saveFix();
}
/* 按新答案重判这条作答记录：原来是误判为错的，把错次数还回去 */
function rejudgeRec(k, letters) {
  const a = ANS[k];
  if (!a) return null;
  const wasOk = !!a.ok, ok = sameAns(a.sel || [], letters);
  a.ok = ok;
  if (ok && !wasOk) a.wrong = Math.max(0, (a.wrong || 0) - 1);
  if (!ok && wasOk) a.wrong = (a.wrong || 0) + 1;
  a.redo = false;
  srsUpdate(a, ok);
  return ok;
}
function rejudgeAll() {
  let n = 0;
  Object.keys(FIX).forEach(k => { if (ANS[k]) { rejudgeRec(k, FIX[k]); n++; } });
  if (n) saveAns();
  return n;
}
/* 答题页 / 错题本里共用的「改答案」小面板 */
function openAnsEditor(host, k, q, done) {
  if (!host) return;
  const cur = ansOf(k, q), orig = (q && q.answer) || [];
  const n = Math.min(8, Math.max(2, (q && q.options && q.options.length) || 4));
  const letters = 'ABCDEFGH'.slice(0, n).split('');
  const fixed = hasFix(k);
  host.innerHTML =
    '<div class="fixbox">' +
    '<div class="small muted">勾选这道题<b>正确</b>的选项；只改本机的判分依据，题库文件不动。</div>' +
    '<div class="fixrow">' + letters.map(L => '<label class="fixopt' + (cur.includes(L) ? ' on' : '') + '"><input type="checkbox" data-f="' + L + '"' + (cur.includes(L) ? ' checked' : '') + '><span>' + L + '</span></label>').join('') + '</div>' +
    '<div class="small muted">题库原答案 <b>' + (orig.join('') || '—') + '</b>' + (fixed ? '　·　已修正为 <b>' + cur.join('') + '</b>' : '') + '</div>' +
    '<label class="chk small" style="margin-top:6px"><input type="checkbox" id="fxRe" checked> 保存后顺带重判我做过的这道题（错次数和复习排期一起改）</label>' +
    '<div class="actions"><button class="btn primary" id="fxOk">保存</button>' +
    '<button class="btn" id="fxOrig"' + (fixed ? '' : ' disabled') + '>恢复题库原答案</button>' +
    '<button class="btn" id="fxCancel">取消</button></div></div>';
  host.querySelectorAll('.fixopt input').forEach(cb => cb.onchange = () => cb.parentNode.classList.toggle('on', cb.checked));
  const pick = () => Array.from(host.querySelectorAll('.fixopt input')).filter(cb => cb.checked).map(cb => cb.dataset.f);
  host.querySelector('#fxOk').onclick = () => {
    const L = pick();
    if (!L.length) { toast('至少勾一个正确选项'); return; }
    setFix(k, L);
    let msg = '已把答案改成 ' + (fixOf(k) || []).join('');
    if (host.querySelector('#fxRe').checked && ANS[k]) {
      const okk = rejudgeRec(k, fixOf(k));
      saveAns();
      msg += okk ? '，这道题已重判为答对' : '，按新答案仍算答错';
    }
    host.innerHTML = '';
    toast(msg);
    if (done) done();
  };
  host.querySelector('#fxOrig').onclick = () => {
    delete FIX[k];
    saveFix();
    if (ANS[k]) { rejudgeRec(k, orig); saveAns(); }
    host.innerHTML = '';
    toast('已恢复题库原答案');
    if (done) done();
  };
  host.querySelector('#fxCancel').onclick = () => { host.innerHTML = ''; };
}

/* ---------- 运行时状态 ---------- */
const QZ = { bankId: null, filter: 'all', cur: null, pending: {}, order: null };
const SS = {
  get: k => { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
  set: (k, v) => { try { sessionStorage.setItem(k, v); } catch (e) {} },
  del: k => { try { sessionStorage.removeItem(k); } catch (e) {} }
};

/* ---------- 小工具 ---------- */
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
/* 安全绑定：id 不存在也不会中断后面的绑定 */
function on(id, fn, ev) { const el = $(id); if (el) el['on' + (ev || 'click')] = fn; return el; }
function toast(msg, ms) {
  const d = document.createElement('div');
  d.textContent = msg;
  d.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);background:rgba(17,24,39,.92);color:#fff;padding:10px 16px;border-radius:10px;font-size:14px;z-index:999;max-width:80vw;text-align:center';
  document.body.appendChild(d);
  setTimeout(() => d.remove(), ms || 1700);
}
function download(name, text, mime) {
  const blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts), p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function stamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
}
const safeName = s => String(s).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);

/* ---------- 路由 ---------- */
function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const parts = h.split('/');
  if (parts[0] === 'bank' && parts[1]) return { name: 'quiz', bankId: parts[1] };
  if (parts[0] === 'import') return { name: 'import' };
  if (parts[0] === 'wrong') return { name: 'wrong' };
  if (parts[0] === 'fav') return { name: 'fav' };
  if (parts[0] === 'exam' && parts[1]) return { name: 'exam', bankId: parts[1] };
  if (parts[0] === 'review') return { name: 'wrong' };   // 复习入口已并入错题本
  if (parts[0] === 'search') return { name: 'search' };
  if (parts[0] === 'kb') return { name: 'kb' };
  if (parts[0] === 'stats') return { name: 'stats' };
  return { name: 'home' };
}
function go(hash) {
  if (location.hash === hash) render(); else location.hash = hash;
}

/* ---------- 「继续上次」：记住最近做的是哪个题库、哪一题 ----------
   以前每题号都存在 qbank.last.<题库id> 里，但首页不知道最近开的是哪个题库。
   这里再记一条总的，首页就能直接把「继续刷题」摆在最上面。 */
const LAST_BANK_KEY = 'qbank.lastbank.v1';
function rememberLast(bank, qid) {
  if (!bank || bank.paper) return;          // 临时套卷随时可能被删，不记
  writeLS(LAST_BANK_KEY, { bankId: bank.id, qid: qid == null ? null : qid, ts: Date.now() });
}
function lastPos() {
  const v = readLS(LAST_BANK_KEY, null);
  if (!v || !v.bankId) return null;
  const b = bankById(v.bankId);
  if (!b || !b.questions || !b.questions.length) return null;
  let done = 0, ok = 0;
  b.questions.forEach(x => { const a = ANS[kOf(b, x)]; if (a && !a.redo) { done++; if (a.ok) ok++; } });
  let idx = b.questions.findIndex(x => String(x.id) === String(v.qid));
  if (idx < 0) idx = 0;
  return { bank: b, done: done, ok: ok, n: b.questions.length, idx: idx, ts: +v.ts || 0 };
}
window.addEventListener('hashchange', render);
/* 任何一个脚本文件顶层抛错也留个提示，而不是白屏 */
window.addEventListener('error', e => { if (e && e.message) showFatal(e.error || e.message); });
window.addEventListener('unhandledrejection', e => { if (e && e.reason) showFatal(e.reason); });

/* render 出错不再白屏：留一条错误提示，能复制能重载 */
let FATAL_SHOWN = false;
function showFatal(err) {
  const msg = (err && (err.stack || err.message)) || String(err == null ? '未知错误' : err);
  try { console.error('[刷题站]', err); } catch (e) {}
  if (FATAL_SHOWN) return;
  FATAL_SHOWN = true;
  const bar = document.createElement('div');
  bar.id = 'fatalBar';
  bar.innerHTML = '<div class="fb-in"><b>页面出错了。</b><span class="fb-msg"></span>'
    + '<div class="fb-acts"><button class="btn tiny" id="fbCopy">复制错误</button>'
    + '<button class="btn tiny primary" id="fbReload">重新加载</button>'
    + '<button class="btn tiny" id="fbClose">关掉</button></div>'
    + '<div class="small muted">常见原因：题库文件格式不对，或浏览器缓存是旧的（按 Ctrl+F5 强刷一次）。你的作答记录不会因为这次报错丢失。</div></div>';
  document.body.appendChild(bar);
  const m = bar.querySelector('.fb-msg');
  if (m) m.textContent = ' ' + String(msg).split('\n')[0].slice(0, 300);
  const cp = bar.querySelector('#fbCopy');
  if (cp) cp.onclick = () => {
    const t = document.createElement('textarea');
    t.value = String(msg); document.body.appendChild(t); t.select();
    try { document.execCommand('copy'); toast('错误信息已复制'); } catch (e) { toast('复制失败，请手动选中'); }
    t.remove();
  };
  const rl = bar.querySelector('#fbReload');
  if (rl) rl.onclick = () => location.reload();
  const cl = bar.querySelector('#fbClose');
  if (cl) cl.onclick = () => { bar.remove(); FATAL_SHOWN = false; };
}
function render() {
  try { renderInner(); }
  catch (err) { showFatal(err); }
}
function renderInner() {
  const r = route();
  document.querySelectorAll('.mask').forEach(m => m.classList.remove('show'));
  const full = (r.name === 'quiz' || r.name === 'exam');
  document.body.classList.toggle('quiz', full);
  $('nav').style.display = r.name === 'quiz' ? 'flex' : 'none';
  $('chips').style.display = r.name === 'quiz' ? 'flex' : 'none';
  $('btnGrid').style.display = full ? '' : 'none';
  $('btnQuizSet').style.display = full ? '' : 'none';
  $('btnHome').style.display = r.name === 'home' ? 'none' : '';
  $('btnGoWrong').style.display = full ? 'none' : '';
  $('btnGoFav').style.display = full ? 'none' : '';
  $('btnGoSearch').style.display = full ? 'none' : '';
  if ($('btnGoKb')) $('btnGoKb').style.display = full ? 'none' : '';
  if ($('btnSetAll')) $('btnSetAll').style.display = full ? 'none' : '';

  /* 考试没交卷就想跳走：先确认，免得倒计时在后台自己跑 */
  if (typeof examActive === 'function' && examActive() && r.name !== 'exam') {
    if (!confirm('考试还没交卷。离开的话倒计时仍会继续，确定离开？')) { go('#/exam/' + EX.id); return; }
    stopExamTimer();
  }

  if (r.name === 'home') renderHome();
  else if (r.name === 'import') renderImport();
  else if (r.name === 'wrong') { if (typeof renderWrong === 'function') renderWrong(); }
  else if (r.name === 'fav') { if (typeof renderFav === 'function') renderFav(); }
  else if (r.name === 'search') { if (typeof renderSearch === 'function') renderSearch(); }
  else if (r.name === 'stats') renderStats();
  else if (r.name === 'kb') { if (typeof renderKb === 'function') renderKb(); }
  else if (r.name === 'exam') { if (typeof renderExam === 'function') renderExam(r.bankId); }
  else renderQuiz(r.bankId);
}

/* ============================================================
   首页
   ============================================================ */
/* 备份提醒：本机浏览器数据一旦被清就没了，没备份过或超过 7 天就提示一下 */
function backupHint() {
  const last = +readLS(BACKUP_KEY, 0) || 0;
  if (!last) return '<div class="note err" style="margin:0 0 10px">还没有导出过备份。清一次浏览器缓存、或者换设备，刷题记录就全没了，建议现在导出一份。</div>';
  const days = Math.floor((Date.now() - last) / 86400000);
  if (days >= 7) return '<div class="note" style="margin:0 0 10px">上次备份是 ' + days + ' 天前（' + fmtTime(last) + '），建议再导出一份。</div>';
  return '<div class="small muted" style="margin:0 0 10px">上次备份：' + fmtTime(last) + '</div>';
}

/* 今日学习看板：今日已答 / 今日正确率 / 连续刷题天数 */
function todayStats() {
  const dayOf = ts => { const d = new Date(ts); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); };
  const today = dayOf(Date.now());
  const days = {};
  const weekAgo = Date.now() - 7 * 86400000;
  let dNum = 0, dOk = 0, weekN = 0;
  Object.keys(ANS).forEach(k => {
    const a = ANS[k]; if (!a || !a.ts) return;
    const d = dayOf(a.ts);
    days[d] = 1;
    if (a.ts >= weekAgo) weekN++;
    if (d === today) { dNum++; if (a.ok) dOk++; }
  });
  let streak = 0;
  const base = new Date(); base.setHours(0, 0, 0, 0);
  for (let i = 0; i < 3650; i++) {
    const d = dayOf(base.getTime() - i * 86400000);
    if (days[d]) streak++;
    else if (i > 0) break;      // 今天还没做不算断
  }
  return { dNum: dNum, dOk: dOk, streak: streak, weekN: weekN };
}

function renderHome() {
  QZ.bankId = null;
  $('appTitle').textContent = '刷题站';

  const banks = baseBanks();
  const papers = allBanks().filter(b => b.paper);
  let totalQ = 0, totalDone = 0, totalOk = 0, wrongN = 0, dueN = 0;
  banks.forEach(b => b.questions.forEach(q => {
    totalQ++;
    const k = kOf(b, q), a = ANS[k];
    if (a && !a.redo) { totalDone++; if (a.ok) totalOk++; }
    if (a && (a.wrong || 0) > 0) wrongN++;
    if (isDue(k)) dueN++;
  }));
  const srsCap = +srsCfg().daily || 0;
  const favN = Object.keys(FAV).filter(k => FAV[k]).length;
  const TODAY = todayStats();

  const list = banks.map(b => {
    let done = 0, ok = 0, wr = 0;
    b.questions.forEach(q => {
      const a = ANS[kOf(b, q)];
      if (a && !a.redo) { done++; if (a.ok) ok++; }
      if (a && (a.wrong || 0) > 0) wr++;
    });
    const pct = b.questions.length ? Math.round(done / b.questions.length * 100) : 0;
    const acc = done ? Math.round(ok / done * 100) : 0;
    return `
      <div class="card bank">
        <div class="info">
          <div class="name">${esc(b.title)}${b.source === 'local' ? '<span class="pill local">自建</span>' : '<span class="pill">内置</span>'}</div>
          <div class="meta">${b.subtitle ? esc(b.subtitle) + '　' : ''}${b.questions.length} 题　已答 ${done}${wr ? `　<span class="warn">错题 ${wr}</span>` : ''}　正确率 ${acc}%</div>
          <div class="prog"><i style="width:${pct}%"></i></div>
        </div>
        <div class="acts">
          <button class="btn primary" data-start="${b.id}">${done ? '继续刷题' : '开始刷题'}</button>
          <button class="btn" data-wrong="${b.id}">错题 ${wr}</button>
          <button class="btn" data-rand="${b.id}">随机 30 题</button>
          <button class="btn" data-export="${b.id}">导出</button>
          ${b.source === 'local' ? `<button class="btn" data-edit="${b.id}">编辑</button><button class="btn danger" data-del="${b.id}">删除</button>` : ''}
        </div>
      </div>`;
  }).join('');

  const paperList = papers.map(b => {
    let done = 0, ok = 0;
    b.questions.forEach(q => { const a = ANS[kOf(b, q)]; if (a && !a.redo) { done++; if (a.ok) ok++; } });
    return `
      <div class="card bank paper-card">
        <div class="info">
          <div class="name">${esc(b.title)}<span class="pill paper">${b.exam ? '模拟考试' : '临时套卷'}</span></div>
          <div class="meta">${b.questions.length} 题　已做 ${done}　正确率 ${done ? Math.round(ok / done * 100) : 0}%</div>
          <div class="prog"><i style="width:${b.questions.length ? done / b.questions.length * 100 : 0}%"></i></div>
        </div>
        <div class="acts">
          <button class="btn primary" data-start="${b.id}">${done ? '继续' : '开始'}${b.exam ? '考试' : '做题'}</button>
          <button class="btn danger" data-delpaper="${b.id}">删除${b.exam ? '试卷' : '套卷'}</button>
        </div>
      </div>`;
  }).join('');

  /* 继续上次：最近开过的题库放到最上面，免去每次翻列表找上次做到哪 */
  const last = lastPos();
  const resumeHtml = last ? `
    <div class="resume">
      <div class="rinfo">
        <div class="rtitle">${esc(last.bank.title)}</div>
        <div class="rmeta">上次做到 第 ${last.idx + 1} / ${last.n} 题 · 已答 ${last.done} · 正确率 ${last.done ? Math.round(last.ok / last.done * 100) : 0}%${last.ts ? ' · ' + fmtTime(last.ts) : ''}</div>
        <div class="prog"><i style="width:${last.n ? Math.round(last.done / last.n * 100) : 0}%"></i></div>
      </div>
      <button class="btn primary" id="toResume">继续刷题</button>
    </div>` : '';

  const bytes = storageBytes();
  $('view').innerHTML = `
    <div class="hero">
      <h1>刷题站</h1>
      <p>选择题即时判分，选错立刻出解析。错题自动进错题本，可批量收藏 / 移除 / 清空次数 / 组成套卷再做一遍，也能改解析、按需导出。</p>
      <div class="hstat">
        <div><b>${banks.length}</b>个题库</div>
        <div><b>${totalQ}</b>道题</div>
        <div><b>${totalDone}</b>已答</div>
        <div><b>${totalDone ? Math.round(totalOk / totalDone * 100) : 0}%</b>正确率</div>
        <div><b>${wrongN}</b>错题</div>
        <div><b>${favN}</b>收藏</div>
        <div><b>${dueN}</b>待复习</div>
      </div>
      <div class="hstat today">
        <div><b>${TODAY.dNum}</b>今日已答</div>
        <div><b>${TODAY.dNum ? Math.round(TODAY.dOk / TODAY.dNum * 100) : 0}%</b>今日正确率</div>
        <div><b>${TODAY.streak}</b>连续天数</div>
        <div><b>${TODAY.weekN}</b>近 7 天</div>
      </div>
    </div>
    ${resumeHtml}
    <div class="row-inline" style="margin:18px 0 12px">
      <button class="btn primary" id="toImport">＋ 导入 / 新建题库</button>
      ${dueN ? `<button class="btn primary" id="toReview">今日复习 ${srsCap && dueN > srsCap ? srsCap + ' / ' + dueN : dueN} 题</button>` : ''}
      <button class="btn" id="toWrong">错题本${wrongN ? '（' + wrongN + (dueN ? ' · 待复习' + dueN : '') + '）' : ''}</button>
      <button class="btn" id="toFav">收藏${favN ? '（' + favN + '）' : ''}</button>
      <button class="btn" id="toSearch">搜索题目</button>
      <button class="btn" id="toRand">随机抽 30 题</button>
      <button class="btn" id="toStats">学习统计</button>
      <button class="btn" id="toHelp">快捷键</button>
      <span class="small muted" id="storeUse" style="flex:1;min-width:180px">数据存在本机浏览器，共占用约 ${(bytes / 1024 / 1024).toFixed(2)} MB（本地估算，正在算真实占用…）。</span>
    </div>
    ${papers.length ? `<h2 class="sec">临时套卷</h2>${paperList}` : ''}
    <h2 class="sec">我的题库</h2>
    ${list || '<div class="card"><div class="empty">还没有题库，点上面的按钮加一个吧。</div></div>'}
    <div class="card" style="margin-top:16px">
      <div class="name" style="font-weight:700;margin-bottom:6px">数据备份</div>
      <div class="small muted" style="margin-bottom:10px">作答记录、错题、收藏、自定义解析都存在本机浏览器里。换电脑或清缓存前，建议导出备份。</div>
      ${backupHint()}
      <div class="row-inline">
        <button class="btn" id="expAll">导出全部数据</button>
        <button class="btn" id="impAll">导入数据（恢复）</button>
        <input type="file" id="impAllFile" accept=".json" style="display:none">
      </div>
    </div>`;

  $('stat').textContent = `${totalDone}/${totalQ}`;
  $('bar').style.width = (totalQ ? totalDone / totalQ * 100 : 0) + '%';
  on('toImport', () => go('#/import'));
  on('toWrong', () => go('#/wrong'));
  on('toFav', () => go('#/fav'));
  on('toSearch', () => go('#/search'));
  on('toRand', () => randomPaper(baseBanks(), 30));
  on('toStats', () => go('#/stats'));
  on('toHelp', showHelp);
  on('toReview', () => startReview(60));
  on('toResume', () => { if (last) startBank(last.bank.id); });
  on('expAll', exportAllData);
  on('impAll', () => $('impAllFile').click());
  on('impAllFile', importAllData, 'change');

  document.querySelectorAll('[data-start]').forEach(el => el.onclick = () => startBank(el.dataset.start));
  document.querySelectorAll('[data-wrong]').forEach(el => el.onclick = () => { QZ.filter = 'wrong'; startBank(el.dataset.wrong); });
  document.querySelectorAll('[data-export]').forEach(el => el.onclick = () => exportBank(bankById(el.dataset.export)));
  document.querySelectorAll('[data-rand]').forEach(el => el.onclick = () => randomPaper([bankById(el.dataset.rand)], 30));
  document.querySelectorAll('[data-delpaper]').forEach(el => el.onclick = () => deletePaper(el.dataset.delpaper));
  document.querySelectorAll('[data-edit]').forEach(el => el.onclick = () => {
    const b = bankById(el.dataset.edit);
    SS.set('editing', b.id);
    SS.set('importText', JSON.stringify({ id: b.id, title: b.title, subtitle: b.subtitle, questions: b.questions }, null, 2));
    go('#/import');
  });
  document.querySelectorAll('[data-del]').forEach(el => el.onclick = () => {
    const b = bankById(el.dataset.del);
    if (!confirm(`删除题库「${b.title}」？该题库的作答记录、收藏、自定义解析也会一起清掉，不可恢复。`)) return;
    b.questions.forEach(q => {
      const k = kOf(b, q);
      delete ANS[k]; delete FAV[k]; delete NOTES[k];
      tombAdd('ans', k); tombAdd('fav', k); tombAdd('note', k);   // 记墓碑：别的标签页不会把它合并回来
    });
    LOCAL = LOCAL.filter(x => x.id !== b.id);
    try { localStorage.removeItem('qbank.last.' + b.id); } catch (e) {}   // 顺手清掉「上次做到哪」的键
    invalidateBanks();
    writeLS(LS.banks, LOCAL); saveAns(); saveFav(); saveNotes();
    if (typeof BF !== 'undefined' && BF && BF.autoSave) { try { BF.autoSave(); } catch (e) {} }
    toast('已删除'); render();
  });
  /* 目录式题库浏览（cat.js）：把首页的统计卡之后整段换成「目录 + 卡片」视图 */
  if (typeof CAT !== 'undefined' && CAT && CAT.renderHook) { try { CAT.renderHook(); } catch (err) { console.error('CAT', err); } }
  if (typeof BFF !== 'undefined' && BFF && BFF.boot) { try { BFF.boot(); } catch (err) { console.error('BFF', err); } }
  paintStorageUse();   // 占用改成问浏览器（含知识库），回来再回填数字
}

/* 随机抽题：把题库打乱后取前 n 道，组成临时套卷直接做 */
function randomPaper(banks, n) {
  const keys = [];
  (banks || []).forEach(b => { if (b && b.questions) b.questions.forEach(q => keys.push(kOf(b, q))); });
  if (!keys.length) { toast('还没有题目'); return; }
  for (let i = keys.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = keys[i]; keys[i] = keys[j]; keys[j] = t;
  }
  const c = Math.min(n, keys.length);
  makePaper('随机 ' + c + ' 题', keys.slice(0, c));
}

function startBank(bankId) {
  const b = bankById(bankId); if (!b || !b.questions.length) return;
  QZ.order = null;
  if (b.exam) { rememberLast(b, null); go('#/exam/' + b.id); return; }
  const last = readLS('qbank.last.' + b.id, null);
  QZ.cur = (last && b.questions.some(q => String(q.id) === String(last))) ? last : b.questions[0].id;
  rememberLast(b, QZ.cur);
  go('#/bank/' + b.id);
}

/* 临时套卷 */
function makePaper(title, keys, opts) {
  opts = opts || {};
  keys = Array.from(new Set(keys));
  if (!keys.length) { toast('先勾选题目'); return; }
  let id = (opts.exam ? 'exam-' : 'paper-') + Date.now().toString(36);
  while (PAPERS.some(p => p.id === id)) id += '-' + i2s();   // 防撞车
  const p = { id: id, title: title || ((opts.exam ? '模拟考试 · ' : '套卷 · ') + keys.length + ' 题'), createdAt: Date.now(), keys: keys, exam: !!opts.exam, duration: opts.duration || 0 };
  PAPERS.push(p);
  savePapers();
  invalidateBanks();
  const mins = Math.round((opts.duration || 0) / 60);
  toast(opts.exam
    ? ('已生成试卷：' + keys.length + ' 题，' + (mins ? '限时 ' + mins + ' 分钟' : '不限时'))
    : ('已生成套卷：' + keys.length + ' 题，做完会计入原来的错题次数'));
  go((opts.exam ? '#/exam/' : '#/bank/') + id);
}
function deletePaper(id) {
  const p = PAPERS.find(x => x.id === id);
  if (!p) return;
  if (!confirm('删除这个套卷？套卷本身的作答记录会清掉（原本题库的错题次数保留）。')) return;
  const b = allBanks().find(x => x.id === id);
  if (b) b.questions.forEach(q => { const k = kOf(b, q); delete ANS[k]; tombAdd('ans', k); });
  PAPERS = PAPERS.filter(x => x.id !== id);
  tombAdd('paper', id);      // 记墓碑：别的标签页/合并写入不会把这个套卷加回来
  savePapers(); saveAns();
  invalidateBanks();
  toast('已删除套卷'); render();
}

function storageBytes() {
  let n = 0;
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); n += (k || '').length + (localStorage.getItem(k) || '').length; } } catch (e) {}
  return n * 2;
}
/* 真实占用要问浏览器：知识库存在 IndexedDB 里，localStorage 根本数不出来 */
async function storageUse() {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      if (e && (e.usage || e.quota)) return { used: e.usage || 0, quota: e.quota || 0, real: true };
    }
  } catch (err) {}
  return { used: storageBytes(), quota: 0, real: false };
}
async function paintStorageUse() {
  const u = await storageUse();
  const el = $('storeUse');
  if (!el) return;                       // 页面已经画到别处去了
  const mb = x => (x / 1024 / 1024).toFixed(2);
  el.textContent = '数据存在本机浏览器，共占用约 ' + mb(u.used) + ' MB'
    + (u.quota ? '（浏览器给的额度约 ' + Math.round(u.quota / 1024 / 1024) + ' MB）' : '')
    + (u.real ? '，含知识库。' : '，只算了 localStorage，知识库没算进来。');
}

function exportBank(b) {
  if (!b) return;
  if (typeof BF !== 'undefined' && BF && BF.exportBankHook) { try { BF.exportBankHook(b); return; } catch (e) {} }
  const data = { id: b.id, title: b.title, subtitle: b.subtitle, questions: b.questions.map(q => ({ id: q.id, stem: q.stem, options: q.options, answer: q.answer, explain: q.explain, group: q.group, groupTitle: q.groupTitle })) };
  download(safeName(b.title) + '.json', JSON.stringify(data, null, 2), 'application/json');
}

/* 顶层的分类表（惰性取值：cat.js 还没加载时也安全） */
function catRows() {
  try { if (typeof CAT !== 'undefined' && CAT && CAT.all) return CAT.all().map(c => ({ id: c.id, title: c.title, parent: c.parent, order: c.order })); } catch (e) {}
  return readLS(LS.cat, []) || [];
}

/* 全量备份 / 恢复：知识库正文也一起带走（来自 知识库.js 的文件库不在里面） */
async function exportAllData() {
  let tipCats = 0;
  const data = { app: 'shuati', version: 4, exportedAt: new Date().toISOString(), answers: ANS, banks: LOCAL, cats: catRows(), favs: FAV, notes: NOTES, papers: PAPERS, settings: SET, fixes: FIX, srs: SRS };
  let tip = '';
  try {
    if (typeof kbExportAll === 'function') {
      toast('正在打包知识库…', 1200);
      const kb = await kbExportAll();
      if (kb && (kb.list || []).length) { data.kb = kb; tip = '，含 ' + kb.list.length + ' 个自己导入的知识库'; }
      if (kb && (kb.autoN || 0)) tip += '（另有 ' + kb.autoN + ' 个来自 知识库.js 的文件库不打包，换电脑后重新生成或复制那个文件即可）';
    }
  } catch (err) { tip = '（知识库打包失败：' + (err.message || err) + '）'; }
  download('刷题站-全部数据-' + stamp() + '.json', JSON.stringify(data), 'application/json');
  writeLS(BACKUP_KEY, Date.now());
  toast('已导出备份' + tip, 3600);
}
function importAllData(e) {
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const d = JSON.parse(r.result);
      if (!d || typeof d !== 'object') throw new Error('格式不对');
      const cnt = k => Object.keys(d[k] || {}).length;
      const kbCnt = (d.kb && (d.kb.list || []).length) || 0;
      if (!confirm(`即将导入：作答 ${cnt('answers')} 条、自建题库 ${(d.banks || []).length} 个、收藏 ${cnt('favs')} 条、自定义解析 ${cnt('notes')} 条、修正答案 ${cnt('fixes')} 条${kbCnt ? '、知识库 ' + kbCnt + ' 个' : ''}。\n\n导入会与现有数据合并（同一条以导入的为准），不会删除其它记录。继续？`)) return;
      Object.assign(ANS, d.answers || {});
      Object.assign(FAV, d.favs || {});
      Object.assign(NOTES, d.notes || {});
      Object.assign(FIX, d.fixes || {});
      if (Array.isArray(d.banks)) d.banks.forEach(b => { if (b && b.id && !LOCAL.some(x => x.id === b.id)) LOCAL.push(b); });
      let tipCats = 0;                                          // 导入进来的分类数（原先漏了声明，导致导入完弹「导入失败：tipCats is not defined」）
      if (Array.isArray(d.cats) && d.cats.length) {            // 分类树跟着一起恢复
        if (typeof CAT !== 'undefined' && CAT && CAT.importCats) {
          try { const r = CAT.importCats(d.cats); tipCats = (r.added || 0) + (r.updated || 0); } catch (err) {}
        } else {
          const have = readLS(LS.cat, []) || [];
          const seen = {}; have.forEach(c => { if (c && c.id) seen[c.id] = 1; });
          let n = 0;
          d.cats.forEach(c => {
            if (!c || !c.id || seen[c.id]) return;
            have.push({ id: String(c.id), title: String(c.title || '未命名分类'), parent: (c.parent == null ? null : String(c.parent)), order: (c.order == null ? 999 : (+c.order || 0)) });
            seen[c.id] = 1; n++;
          });
          writeLS(LS.cat, have); tipCats = n;
        }
      }
      if (Array.isArray(d.papers)) d.papers.forEach(p => { if (p && p.id && !PAPERS.some(x => x.id === p.id)) PAPERS.push(p); });
      if (d.settings) Object.assign(SET, d.settings);
      if (d.srs) Object.assign(SRS, d.srs);
      let kbN = 0;
      if (d.kb && typeof kbImportAll === 'function') { try { kbN = kbImportAll(d.kb) || 0; } catch (err) {} }
      tombClear();   // 导入＝以这份备份为准，清掉本机墓碑，别把要恢复的记录挡回去
      migrate();
      invalidateBanks();
      saveAns(); saveFav(); saveNotes(); writeLS(LS.banks, LOCAL); savePapers(); writeLS(LS.set, SET);
      saveFix(); writeLS(LS.srs, SRS);
      if (typeof BF !== 'undefined' && BF && BF.autoSave) { try { BF.autoSave(); } catch (e) {} }
      toast('导入完成' + (tipCats ? '（含 ' + tipCats + ' 个分类）' : '') + (kbN ? '，含 ' + kbN + ' 个知识库' : '')); render();
    } catch (err) { alert('导入失败：' + err.message); }
  };
  r.readAsText(f, 'utf-8');
  e.target.value = '';
}

/* ============================================================
   答题页
   ============================================================ */
function renderQuiz(bankId) {
  const bank = bankById(bankId);
  if (!bank) { go('#/'); return; }
  if (bank.exam) { go('#/exam/' + bank.id); return; }   // 模考走专用页面
  QZ.bankId = bankId;
  $('appTitle').textContent = bank.title;

  const pool = poolOf(bank);
  if (!pool.length) {
    $('view').innerHTML = `<div class="card"><div class="empty">这里暂时没有题目，换个分类看看。</div></div>`;
    $('stat').textContent = ''; $('bar').style.width = '0%';
    renderChips(bank);
    return;
  }
  if (QZ.cur == null || !pool.some(q => String(q.id) === String(QZ.cur))) QZ.cur = pool[0].id;
  const q = pool.find(x => String(x.id) === String(QZ.cur));
  const k = kOf(bank, q);
  const locked = answered(k);
  const rec = recOf(k);
  const picked = locked ? (rec.sel || []) : (QZ.pending[q.id] || []);
  const fk = favKey(bank, q);
  const faved = !!FAV[fk];
  const custom = !!noteOf(fk);
  const fixedAns = hasFix(fk);

  const opts = q.options.map((t, i) => {
    const K = 'ABCDEFGH'[i];
    let cls = 'opt';
    if (locked) {
      if (ansOf(fk, q).includes(K)) cls += ' right';
      else if (picked.includes(K)) cls += ' wrong';
    } else if (picked.includes(K)) cls += ' sel';
    return `<button class="${cls}" data-k="${K}" ${locked ? 'disabled' : ''}><span class="k">${K}</span><span>${esc(t)}</span></button>`;
  }).join('');

  const pos = pool.findIndex(x => String(x.id) === String(q.id)) + 1;
  $('view').innerHTML = `
    <div class="card">
      <div class="qhead">
        <span class="qno">第 ${q.id} 题</span>
        <span class="tag">${typeLabel(q, ansOf(fk, q))}</span>
        ${q.groupTitle ? `<span class="tag g">${esc(q.groupTitle)}</span>` : ''}
        ${bank.paper ? `<span class="tag paper-tag">临时套卷</span>` : ''}
        ${fixedAns ? `<span class="tag g" title="答案是你手动改过的，只在本机生效">答案已修正</span>` : ''}
        ${rec && rec.tries ? `<span class="tag g">本题作答 ${rec.tries} 次 · 错 ${rec.wrong || 0} 次</span>` : ''}
        <span class="spacer-grow"></span>
        <button class="btn fav-btn${faved ? ' on' : ''}" id="btnFav">${faved ? '★ 已收藏' : '☆ 收藏'}</button>
      </div>
      ${q.group ? `<div class="gstem"><b>共用题干：</b>${esc(q.group)}</div>` : ''}
      <div class="stem">${esc(q.stem)}</div>
      <div class="opts">${opts}</div>
      <div class="actions">
        ${qType(q, ansOf(fk, q)) === 'X' ? `<button class="btn primary" id="doSubmit" ${locked || !picked.length ? 'disabled' : ''}>提交答案</button>` : ''}
        ${rec ? `<button class="btn" id="doRedo">再答一次</button>` : ''}
        <button class="btn" id="doNote">${custom ? '改解析（已自定义）' : '改解析'}</button>
        <button class="btn" id="doFix" title="题库答案写错了 / 自己点错了：可以在这里改，只影响本机的判分">${fixedAns ? '改答案（已修正）' : '改答案'}</button>
        <button class="btn" id="doAI" title="让 AI 写解析（可以带上本地知识库的资料）">AI 解析</button>
      </div>
      <div class="fb" id="fb"></div>
      <div class="keyhint">
        <span><span class="kbd">A</span>–<span class="kbd">H</span> 选选项</span>
        <span><span class="kbd">Enter</span> 提交 / 下一题</span>
        <span><span class="kbd">←</span><span class="kbd">→</span> 翻页</span>
        <span><span class="kbd">S</span> 收藏</span>
        <span><span class="kbd">K</span> 答题卡</span>
        <span><span class="kbd">?</span> 全部快捷键</span>
      </div>
      <div id="noteHost"></div>
      <div id="fixHost"></div>
      <div id="aiHost"></div>
    </div>`;

  $('view').querySelectorAll('.opt').forEach(el => el.onclick = () => onPick(bank, q, el.dataset.k));
  on('doSubmit', () => judge(bank, q, QZ.pending[q.id] || []));
  on('doRedo', () => redo(bank, q));
  on('doNote', () => openNoteEditor(fk, $('noteHost'), q, render));
  on('doFix', () => openAnsEditor($('fixHost'), fk, q, render));
  on('doAI', () => { if (typeof aiOpenPanel === 'function') aiOpenPanel($('aiHost'), fk, q); else toast('AI 模块没加载（ai.js）'); });
  on('btnFav', () => toggleFav(fk));

  showFb(bank, q);
  rememberLast(bank, q.id);
  $('jumpInfo').innerHTML = '<b>' + pos + ' / ' + pool.length + '</b><span>答题卡</span>';

  let done = 0, ok = 0, wr = 0;
  bank.questions.forEach(x => {
    const a = ANS[kOf(bank, x)];
    if (a && !a.redo) { done++; if (a.ok) ok++; }
    if (a && (a.wrong || 0) > 0) wr++;
  });
  $('stat').textContent = `${done}/${bank.questions.length}${wr ? ' · 错' + wr : ''}`;
  $('bar').style.width = (done / bank.questions.length * 100) + '%';
  renderChips(bank);
}

function toggleFav(k) {
  if (FAV[k]) { delete FAV[k]; tombAdd('fav', k); toast('已取消收藏'); } else { FAV[k] = Date.now(); toast('已收藏'); }
  if (!saveFav()) toast('保存失败：浏览器存储空间可能已满');
  render();
}

function poolOf(bank) {
  let arr = bank.questions.slice();
  if (SET.shuffle) {
    if (!QZ.order || QZ.order.bankId !== bank.id) {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
      QZ.order = { bankId: bank.id, ids: a.map(q => q.id) };
    }
    const map = {}; bank.questions.forEach(q => map[q.id] = q);
    arr = QZ.order.ids.map(id => map[id]);
  }
  if (QZ.filter === 'single') arr = arr.filter(q => ansOf(favKey(bank, q), q).length === 1);
  else if (QZ.filter === 'multi') arr = arr.filter(q => ansOf(favKey(bank, q), q).length > 1);
  else if (QZ.filter === 'wrong') arr = arr.filter(q => { const a = ANS[kOf(bank, q)]; return a && (a.wrong || 0) > 0; });
  else if (QZ.filter === 'fav') arr = arr.filter(q => FAV[favKey(bank, q)]);
  else if (QZ.filter === 'due') arr = arr.filter(q => isDue(kOf(bank, q)));
  return arr;
}

function renderChips(bank) {
  const n = f => poolCount(bank, f);
  const defs = [['all', '全部 ' + bank.questions.length], ['single', '单选 ' + n('single')], ['multi', '多选 ' + n('multi')],
                ['wrong', '错题 ' + n('wrong')], ['fav', '收藏 ' + n('fav')], ['due', '待复习 ' + n('due')]];
  $('chips').innerHTML = defs.map(([k, t]) => `<button class="chip${QZ.filter === k ? ' on' : ''}" data-f="${k}">${t}</button>`).join('');
  $('chips').querySelectorAll('.chip').forEach(c => c.onclick = () => {
    QZ.filter = c.dataset.f;
    const p = poolOf(bank);
    if (p.length && !p.some(q => String(q.id) === String(QZ.cur))) QZ.cur = p[0].id;
    render();
  });
}
function poolCount(bank, f) {
  if (f === 'all') return bank.questions.length;
  if (f === 'single') return bank.questions.filter(q => ansOf(favKey(bank, q), q).length === 1).length;
  if (f === 'multi') return bank.questions.filter(q => ansOf(favKey(bank, q), q).length > 1).length;
  if (f === 'wrong') return bank.questions.filter(q => { const a = ANS[kOf(bank, q)]; return a && (a.wrong || 0) > 0; }).length;
  if (f === 'fav') return bank.questions.filter(q => FAV[favKey(bank, q)]).length;
  if (f === 'due') return bank.questions.filter(q => isDue(kOf(bank, q))).length;
  return 0;
}

function onPick(bank, q, K) {
  if (answered(kOf(bank, q))) return;
  if (qType(q, ansOf(favKey(bank, q), q)) === 'X') {
    const cur = QZ.pending[q.id] || (QZ.pending[q.id] = []);
    const i = cur.indexOf(K);
    if (i >= 0) cur.splice(i, 1); else cur.push(K);
    render();
    return;
  }
  judge(bank, q, [K]);
}

/* ---------- 作答写入 + 间隔重复 ---------- */
const DAY = 86400000;
function sameAns(a, b) { return a.slice().map(String).sort().join('') === b.slice().map(String).sort().join(''); }

/* 按当前复习曲线算下一档（设置里可换模式/改参数） */
function srsUpdate(rec, ok, now) {
  now = now || Date.now();
  const c = srsCfg();
  const r = srsNext((rec.ivl == null ? 0 : rec.ivl), (rec.ease == null ? (+c.ease0 || 2.5) : rec.ease), ok, c);
  rec.ease = r.ease;
  rec.ivl = r.ivl;
  rec.due = ok ? (now + r.ivl * DAY) : (c.wrongToday ? now : now + r.ivl * DAY);
}

/* 写一条作答记录（含 SRS），返回是否答对 */
function commitAnswer(k, sel, answer) {
  const ok = sameAns(sel, answer);
  const prev = ANS[k] || {};
  const rec = {
    sel: sel.slice(), ok: ok,
    tries: (prev.tries || 0) + 1,
    wrong: (prev.wrong || 0) + (ok ? 0 : 1),
    ts: Date.now(), redo: false,
    ease: (prev.ease == null ? (+srsCfg().ease0 || 2.5) : prev.ease),
    ivl: (prev.ivl == null ? 0 : prev.ivl)
  };
  srsUpdate(rec, ok);
  ANS[k] = rec;
  return ok;
}

function judge(bank, q, sel) {
  const k = kOf(bank, q);
  const ans = ansOf(favKey(bank, q), q);      // 手工修正过的答案优先
  const ok = commitAnswer(k, sel, ans);
  /* 套卷 / 模考：把这次对错累加到原题上（SRS 一并生效） */
  if (bank.paper && q._srcKey) commitAnswer(q._srcKey, sel, ans);
  delete QZ.pending[q.id];
  saveAns();
  render();
  /* 判完分把反馈（对错 + 解析）滚进视野：手机上尤其需要，不然要点完还得自己往下翻 */
  const fbEl = $('fb');
  if (fbEl && (!ok || SET.expOnOk)) {
    setTimeout(() => { try { fbEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { fbEl.scrollIntoView(); } }, 60);
  }
  if (ok && SET.autoNext) setTimeout(() => step(1), 650);
}

function redo(bank, q) {
  const k = kOf(bank, q);
  if (!ANS[k]) return;
  ANS[k].redo = true;
  delete QZ.pending[q.id];
  saveAns();
  render();
}

function showFb(bank, q) {
  const k = kOf(bank, q), fb = $('fb');
  const st = answered(k) ? ANS[k] : null;
  if (!st) { fb.className = 'fb'; fb.innerHTML = ''; return; }
  const showExp = st.ok ? SET.expOnOk : true;
  const fk = favKey(bank, q);
  const custom = !!noteOf(fk);
  let extra = '';
  if (bank.paper && q._srcKey && ANS[q._srcKey]) {
    const s = ANS[q._srcKey];
    extra = `<div class="small muted" style="margin-bottom:6px">原题累计：作答 ${s.tries || 0} 次 · 错 ${s.wrong || 0} 次 · 正确率 ${rateOf(s)}%</div>`;
  }
  fb.className = 'fb show ' + (st.ok ? 'ok' : 'bad');
  fb.innerHTML = `
    <div class="res">${st.ok ? '✅ 回答正确' : '❌ 回答错误'}</div>
    <div class="ans">正确答案：<b>${ansOf(fk, q).join('') || '—'}</b>${hasFix(fk) ? ' <span class="mini-tag" title="这是你手动修正过的答案">已修正</span>' : ''}　你的选择：<b>${(st.sel || []).join('') || '—'}</b>　
      <span class="muted">累计作答 ${st.tries || 1} 次 · 错 ${st.wrong || 0} 次 · 正确率 ${rateOf(st)}%</span></div>
    ${extra}
    ${showExp
      ? `<div class="exp"><span class="lb">解析${custom ? '（自定义）' : ''}：</span>${renderRich(fk, explainOf(fk, q))}</div>`
      : `<div class="exp muted">（已答对，解析已隐藏，可在「设置」中开启）</div>`}`;
}

function renderRich(k, text) {
  const n = noteOf(k);
  let html = (typeof mdToHtml === 'function') ? mdToHtml(text) : esc(text);
  if (n && n.imgs && n.imgs.length) {
    html += '<div class="rich-imgs">' + n.imgs.map(im => `<img src="${im.src}" alt="${esc(im.name || '')}" loading="lazy">`).join('') + '</div>';
  }
  return html;
}

function step(d) {
  const bank = bankById(QZ.bankId); if (!bank) return;
  const p = poolOf(bank); if (!p.length) return;
  const i = p.findIndex(x => String(x.id) === String(QZ.cur));
  const j = Math.min(p.length - 1, Math.max(0, (i < 0 ? 0 : i) + d));
  QZ.cur = p[j].id;
  writeLS('qbank.last.' + bank.id, QZ.cur);
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

let GRIDF = 'all';        // 答题卡筛选：all / wrong / undone（只影响显示，不影响题号）
function renderGrid() {
  if (route().name === 'exam' && typeof renderExamGrid === 'function') { renderExamGrid(); return; }
  const bank = bankById(QZ.bankId); if (!bank) return;
  const body = $('gridBody');
  let done = 0, wrong = 0;
  bank.questions.forEach(q => { const a = ANS[kOf(bank, q)]; if (a && !a.redo) done++; if (a && (a.wrong || 0) > 0) wrong++; });

  /* 题多的时候（几百题）只想看错题或没做的，这里给个筛子 */
  const f = $('gridFilter');
  if (f) {
    const defs = [['all', '全部 ' + bank.questions.length], ['wrong', '做错 ' + wrong], ['undone', '没做 ' + Math.max(0, bank.questions.length - done)]];
    f.innerHTML = defs.map(([k, t]) => `<button class="chip${GRIDF === k ? ' on' : ''}" data-gf="${k}">${t}</button>`).join('');
    f.querySelectorAll('.chip').forEach(c => c.onclick = () => { GRIDF = c.dataset.gf; renderGrid(); });
  }
  const shown = bank.questions.filter(q => {
    const a = ANS[kOf(bank, q)];
    if (GRIDF === 'wrong') return !!(a && (a.wrong || 0) > 0);
    if (GRIDF === 'undone') return !(a && !a.redo);
    return true;
  });

  body.innerHTML = `<div class="sec-t">${esc(bank.title)}　共 ${bank.questions.length} 题　已答 ${done}　做错 ${wrong}${GRIDF === 'all' ? '' : '　（当前只显示 ' + shown.length + ' 题）'}</div>`
    + (shown.length ? `<div class="grid">` + shown.map(q => {
      const k = kOf(bank, q), a = ANS[k];
      const no = bank.questions.indexOf(q) + 1;     // 用原题号，筛选后也不会串号
      const cls = 'gnum' + (a && (a.wrong || 0) > 0 ? ' err' : (a ? ' done' : '')) + (String(q.id) === String(QZ.cur) ? ' cur' : '');
      return `<button class="${cls}" data-j="${esc(q.id)}">${no}</button>`;
    }).join('') + `</div>` : '<div class="empty">这个筛选下没有题目。</div>');

  body.querySelectorAll('.gnum').forEach(b => b.onclick = () => {
    QZ.cur = (isNaN(+b.dataset.j) ? b.dataset.j : +b.dataset.j);
    writeLS('qbank.last.' + bank.id, QZ.cur);
    if (typeof rememberLast === 'function') rememberLast(bank, QZ.cur);
    closeAll(); render(); window.scrollTo({ top: 0 });
  });
}
function closeAll() { document.querySelectorAll('.mask').forEach(m => m.classList.remove('show')); }

/* ============================================================
   导入 / 新建题库
   ============================================================ */
let EDIT_ID = '';
function renderImport() {
  $('appTitle').textContent = '导入 / 新建题库';
  $('stat').textContent = ''; $('bar').style.width = '0%';
  const editing = SS.get('editing') || '';
  const remembered = SS.get('importText') || '';
  SS.del('importText'); SS.del('editing');
  EDIT_ID = editing;

  $('view').innerHTML = `
    <h2 class="sec">${editing ? '编辑题库' : '导入 / 新建题库'}</h2>
    <div class="card">
      ${editing ? `<div class="note">正在编辑已有题库，保存后会覆盖它（作答记录、收藏、自定义解析保留）。</div>` : ''}
      <div class="field">
        <label>题库名称（文本格式里写 # 名称 也可以自动识别）</label>
        <input type="text" id="bankTitle" placeholder="例如：生化 第一章 蛋白质结构与功能">
      </div>
      <div class="field">
        <label>题目内容（纯文本或 JSON）</label>
        <textarea id="ta" placeholder="把题目粘到这里…"></textarea>
      </div>
      <div class="actions">
        <button class="btn" id="pickFile">从文件读取</button>
        <input type="file" id="fileInput" accept=".txt,.json,.md" style="display:none">
        <button class="btn" id="doPreview">解析预览</button>
        <button class="btn primary" id="doSave">保存题库</button>
        <button class="btn ghost" id="doFormat">填入示例格式</button>
      </div>
      <div id="preview"></div>
    </div>

    <details class="card" style="margin-top:14px">
      <summary style="cursor:pointer;font-weight:700">支持的文本格式（点开看模板）</summary>
      <pre class="fmt"># 生化 第一章 蛋白质

1. 蛋白质分子中四级结构的特征是
A. 在三级结构的基础上进一步折叠而成
B. 分子中必定含有辅因子
C. 依赖肽键维系稳定性
D. 一定由两条或两条以上的多肽链组成
答案：D
解析：四级结构由两条以上多肽链（亚基）聚合而成。

2. 关于某疾病，下列说法正确的有
A. …
B. …
C. …
D. …
答案：ABD
解析：多选题答案连写即可。</pre>
      <div class="hint" style="margin-top:10px">
        · 题号 <b>1.</b> / <b>1、</b> 可写可省；选项行必须用 <b>A.</b> / <b>A、</b> / <b>A)</b> 开头。<br>
        · <b># 名称</b> 设为题库名；<b>## 说明</b> 会成为后面题目的「共用题干」（病例题、B 型题很好用）。<br>
        · <b>答案：</b> 单选写 <b>D</b>，多选写 <b>ABD</b>；<b>解析：</b> 后面可以写多行。<br>
        · 也支持 JSON：<b>[{"stem":"…","options":["…"],"answer":["D"],"explain":"…"}]</b>
      </div>
    </details>`;

  $('ta').value = remembered;
  /* 批量导入整个文件夹（bf-folder.js） */
  if (typeof BFF !== 'undefined' && BFF && BFF.attach) { try { BFF.attach(); } catch (e) {} }
  on('pickFile', () => $('fileInput').click());
  on('fileInput', e => {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => { $('ta').value = r.result; toast('已读取 ' + f.name); };
    r.readAsText(f, 'utf-8');
  }, 'change');
  on('doFormat', () => { $('ta').value = SAMPLE; });
  on('doPreview', doPreview);
  on('doSave', doSave);
}

function parseInput(text, nameHint) {
  const t = (text || '').trim();
  if (!t) return { error: '内容是空的' };
  if (t[0] === '{' || t[0] === '[') {
    try {
      const j = JSON.parse(t);
      const b = Array.isArray(j) ? { questions: j } : j;
      const qs = (b.questions || []).map((q, i) => normalizeQ(q, i + 1));
      if (!qs.length) return { error: 'JSON 里没找到题目（需要 questions 数组）' };
      return { bank: { title: b.title || nameHint || '未命名题库', subtitle: b.subtitle || '', questions: qs }, warns: [] };
    } catch (e) { return { error: 'JSON 解析失败：' + e.message }; }
  }
  return parseText(t, nameHint);
}

const SAMPLE = `# 我的题库

1. 下列选项中可使骨骼肌松弛的是
A. 促使Ca2+进入运动神经末梢
B. 减少细胞外液的Mg2+浓度
C. 抑制胆碱酯酶的活性
D. 阻断终板膜非选择性通道
答案：D
解析：终板膜上N2型ACh受体被阻断后，ACh不能引起终板电位，骨骼肌松弛。`;

function parseText(text, nameHint) {
  const lines = text.split(/\r?\n/);
  const warns = [];
  let bankTitle = '', group = '', cur = null;
  const out = [];
  const RE_OPT = /^\s*([A-Ha-h])\s*[.、．)）:：]\s*(.+)$/;
  const RE_ANS = /^\s*(?:正确)?答案\s*[:：]?\s*([A-Ha-h][A-Ha-h\s,，、\/|]*)\s*$/;
  const RE_EXP = /^\s*(?:解析|解释|考点)\s*[:：]?\s*(.*)$/;
  const RE_NUM = /^\s*(?:第\s*)?(\d+)\s*(?:[.、．)）:：]|\s)\s*(.+)$/;

  const finish = () => {
    if (!cur) return;
    cur.stem = cur.stem.trim();
    cur.explain = cur.explain.trim();
    if (!cur.stem) { cur = null; return; }
    if (cur.options.length < 2) warns.push(`「${cur.stem.slice(0, 14)}…」选项少于2个`);
    if (!cur.answer.length) warns.push(`「${cur.stem.slice(0, 14)}…」没有答案，已跳过`);
    const bad = cur.answer.some(a => 'ABCDEFGH'.indexOf(a) >= cur.options.length);
    if (bad) warns.push(`「${cur.stem.slice(0, 14)}…」答案超出选项范围`);
    if (cur.stem && cur.options.length >= 2 && cur.answer.length && !bad) {
      out.push({ id: out.length + 1, stem: cur.stem, options: cur.options, answer: cur.answer, explain: cur.explain, group: cur.group, groupTitle: cur.groupTitle });
    }
    cur = null;
  };
  const newQ = (stem, g) => ({ stem: stem, options: [], answer: [], explain: '', group: g || '', groupTitle: g ? '共用题干' : '', mode: 'stem' });

  for (const raw of lines) {
    const s = raw.replace(/\s+$/, '').trim();
    if (!s) continue;
    const mG = s.match(/^#{2,}\s+(\S.*)$/) || s.match(/^#{2,}(?![\d#\s])(.+)$/);   /* ##共用题干 / ## 共用题干 都认 */
    if (mG) { finish(); group = mG[1].trim(); continue; }
    const mT = s.match(/^#\s+(\S.*)$/) || s.match(/^#(?![\d#\s])(.+)$/);              /* #题库名 / # 题库名 都认，#1 开头的不算标题 */
    if (mT) { if (!bankTitle) bankTitle = mT[1].trim(); continue; }
    const mAns = s.match(RE_ANS);
    if (mAns && cur) { cur.answer = Array.from(new Set(mAns[1].toUpperCase().replace(/[^A-H]/g, '').split(''))).sort(); cur.mode = 'explain'; continue; }
    const mExp = s.match(RE_EXP);
    if (mExp && cur) { cur.explain = mExp[1] || ''; cur.mode = 'explain'; continue; }
    const mOpt = s.match(RE_OPT);
    if (mOpt && cur && !cur.answer.length && cur.options.length < 8) { cur.options.push(mOpt[2].trim()); cur.mode = 'opt'; continue; }
    const mNum = s.match(RE_NUM);
    if (mNum && mNum[2] && mNum[2].trim().length > 1) {
      if (!cur) { cur = newQ(mNum[2].trim(), group); continue; }
      if (cur.answer.length || cur.options.length) { finish(); cur = newQ(mNum[2].trim(), group); continue; }
    }
    if (!cur) { cur = newQ(s, group); continue; }
    if (cur.mode === 'explain' || (cur.answer.length && cur.options.length)) cur.explain += (cur.explain ? '\n' : '') + s;
    else if (cur.mode === 'opt') { cur.explain += (cur.explain ? '\n' : '') + s; cur.mode = 'explain'; }
    else cur.stem += (cur.stem ? '\n' : '') + s;
  }
  finish();
  if (!out.length) return { error: '没解析出题目，检查一下选项是不是用 A. B. C. D. 开头、答案是不是写成了「答案：D」' };
  return { bank: { title: bankTitle || nameHint || '未命名题库', subtitle: '', questions: out }, warns: warns };
}

function doPreview() {
  const r = parseInput($('ta').value, $('bankTitle').value.trim());
  const host = $('preview');
  if (r.error) { host.innerHTML = `<div class="note err">${esc(r.error)}</div>`; return; }
  const qs = r.bank.questions;
  if (!$('bankTitle').value.trim()) $('bankTitle').value = r.bank.title;
  const single = qs.filter(q => q.answer.length === 1).length;
  const dup = dupCheck(qs, EDIT_ID);
  host.innerHTML = `
    <div class="note ok">解析成功：<b>${qs.length}</b> 题（单选 ${single}，多选 ${qs.length - single}）</div>
    ${r.warns.length ? `<div class="note">${r.warns.map(esc).join('<br>')}</div>` : ''}
    ${dupHtml(dup)}
    <div class="sec-t">前 3 题预览</div>
    ${qs.slice(0, 3).map(q => `
      <div class="card" style="margin-bottom:10px">
        <div class="qno small">第 ${q.id} 题 · ${q.answer.length > 1 ? '多选' : '单选'}</div>
        ${q.group ? `<div class="gstem"><b>共用题干：</b>${esc(q.group)}</div>` : ''}
        <div style="margin:6px 0">${esc(q.stem)}</div>
        <div class="small">${q.options.map((o, i) => esc('ABCDEFGH'[i] + '. ' + o)).join('<br>')}</div>
        <div class="small" style="margin-top:6px;color:var(--ok)">答案：${q.answer.join('')}</div>
        ${q.explain ? `<div class="small muted" style="margin-top:4px">解析：${esc(q.explain)}</div>` : ''}
      </div>`).join('')}`;
}

function doSave() {
  const r = parseInput($('ta').value, $('bankTitle').value.trim());
  if (r.error) { $('preview').innerHTML = `<div class="note err">${esc(r.error)}</div>`; return; }
  const title = $('bankTitle').value.trim() || r.bank.title;
  const qs = r.bank.questions.map((q, i) => normalizeQ(q, i + 1));
  if (EDIT_ID) {
    const bank = LOCAL.find(b => b.id === EDIT_ID);
    if (bank) {
      bank.title = title;
      bank.subtitle = (r.bank.subtitle || '自建题库') + ' · ' + qs.length + ' 题';
      bank.questions = qs;
      invalidateBanks();
      writeLS(LS.banks, LOCAL);
      toast('已更新：' + title);
      go('#/bank/' + bank.id);
      return;
    }
  }
  let id = 'local-' + Date.now().toString(36);
  while (LOCAL.some(b => b.id === id)) id += '-' + i2s();    // 导入的题库里若带了重复 id 也不会串台
  const bank = { id: id, title: title, subtitle: (r.bank.subtitle || '自建题库') + ' · ' + qs.length + ' 题', questions: qs };
  LOCAL.push(bank);
  invalidateBanks();
  writeLS(LS.banks, LOCAL);
  if (typeof BF !== 'undefined' && BF && BF.autoSave) { try { BF.autoSave(); } catch (e) {} }
  toast('已保存：' + title);
  go('#/bank/' + bank.id);
}

/* ============================================================
   学习统计
   ============================================================ */
/* 近 n 天每天做了多少题、对了几道（只算有时间的记录，老数据 ts=0 归不到某天） */
function statsDaily(days) {
  const base = new Date(); base.setHours(0, 0, 0, 0);
  const out = [], idx = {};
  const dk = d => d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(base.getTime() - i * 86400000);
    const o = { key: dk(d), label: (d.getMonth() + 1) + '/' + d.getDate(), n: 0, ok: 0 };
    idx[o.key] = o; out.push(o);
  }
  Object.keys(ANS).forEach(k => {
    const a = ANS[k]; if (!a || !a.ts) return;
    const o = idx[dk(new Date(a.ts))];
    if (!o) return;
    o.n++; if (a.ok) o.ok++;
  });
  return out;
}

/* 今天该复习的题：到期的错题，早到期的排前面 */
function dueKeys(limit) {
  const out = [];
  baseBanks().forEach(b => b.questions.forEach(q => { const k = kOf(b, q); if (isDue(k)) out.push(k); }));
  out.sort((a, b) => (dueOf(a) || 0) - (dueOf(b) || 0));
  return limit ? out.slice(0, limit) : out;
}
function startReview(limit) {
  const cap = +srsCfg().daily || 0;                  // 0 = 不限
  const max = Math.min(limit && limit > 0 ? limit : 9999, cap || 9999);
  const ks = dueKeys(max);
  if (!ks.length) { toast('今天没有到期的复习，休息一下'); return; }
  makePaper('今日复习 · ' + ks.length + ' 题', ks);
}

function renderStats() {
  $('appTitle').textContent = '学习统计';
  $('stat').textContent = ''; $('bar').style.width = '0%';

  const banks = baseBanks();
  let recN = 0, okN = 0, triesN = 0, undated = 0;
  Object.keys(ANS).forEach(k => {
    const a = ANS[k]; if (!a) return;
    if (!a.ts) { undated++; return; }
    recN++; triesN += (a.tries || 1); if (a.ok) okN++;
  });
  const T = todayStats();

  const days = statsDaily(14);
  const maxN = Math.max(1, ...days.map(d => d.n));
  const sumN = days.reduce((a, d) => a + d.n, 0), sumOk = days.reduce((a, d) => a + d.ok, 0);
  const dueN = dueKeys(0).length;

  const rows = banks.map(b => {
    let done = 0, ok = 0, wr = 0;
    b.questions.forEach(q => {
      const a = ANS[kOf(b, q)];
      if (a && !a.redo) { done++; if (a.ok) ok++; }
      if (a && (a.wrong || 0) > 0) wr++;
    });
    return { b: b, done: done, wr: wr, n: b.questions.length, acc: done ? Math.round(ok / done * 100) : 0 };
  });

  const tops = [];
  banks.forEach(b => b.questions.forEach(q => {
    const a = ANS[kOf(b, q)];
    if (a && (a.wrong || 0) > 0) tops.push({ b: b, q: q, a: a });
  }));
  tops.sort((x, y) => (y.a.wrong || 0) - (x.a.wrong || 0) || (y.a.tries || 0) - (x.a.tries || 0));

  $('view').innerHTML = `
    <div class="card">
      <div class="stats">
        <div><b>${recN}</b><span>累计做题</span></div>
        <div><b>${triesN}</b><span>累计作答次数</span></div>
        <div><b>${recN ? Math.round(okN / recN * 100) : 0}%</b><span>累计正确率</span></div>
        <div><b>${T.dNum}</b><span>今日已答</span></div>
        <div><b>${T.streak}</b><span>连续天数</span></div>
        <div><b>${dueN}</b><span>待复习</span></div>
      </div>
      ${undated ? `<div class="small muted" style="margin-top:8px">另有 ${undated} 条早期记录没有日期（老版本数据），不计入下面的趋势图。</div>` : ''}
    </div>

    <h2 class="sec">近 14 天</h2>
    <div class="card">
      <div class="chart">
        ${days.map(d => `<div class="cbar${d.n ? '' : ' zero'}" title="${d.key}：${d.n} 题${d.n ? '，正确率 ' + Math.round(d.ok / d.n * 100) + '%' : ''}">
          <b>${d.n || ''}</b><i style="height:${Math.max(2, Math.round(d.n / maxN * 92))}px"></i><span>${d.label}</span>
        </div>`).join('')}
      </div>
      <div class="small muted" style="margin-top:8px">这 14 天共 <b>${sumN}</b> 题${sumN ? '，平均正确率 ' + Math.round(sumOk / sumN * 100) + '%' : ''}。</div>
      ${dueN ? `<div class="tools"><button class="btn primary" id="stReview">开始今日复习（${dueN} 题）</button></div>` : ''}
    </div>

    <h2 class="sec">各题库正确率</h2>
    ${rows.map(r => `<div class="card" style="margin-bottom:10px;padding:12px 14px">
      <div class="srow">
        <span class="sname">${esc(r.b.title)}</span>
        <span class="sbar"><i style="width:${r.acc}%"></i></span>
        <span class="sval">${r.acc}%　已答 ${r.done}/${r.n}　错题 ${r.wr}</span>
      </div>
    </div>`).join('') || '<div class="card"><div class="empty">还没有题库</div></div>'}

    <h2 class="sec">错得最多的题</h2>
    <div class="card">
      ${tops.length ? tops.slice(0, 12).map((t, i) => `<div class="srow">
        <span class="sval" style="flex:0 0 22px">${i + 1}</span>
        <span class="sname" style="flex:1 1 auto" title="${esc(t.q.stem)}">${esc(t.q.stem.slice(0, 40))}${t.q.stem.length > 40 ? '…' : ''}</span>
        <span class="sval">错 ${t.a.wrong || 0} / 做 ${t.a.tries || 0}</span>
        <button class="btn tiny" data-gobank="${t.b.id}" data-goto="${esc(String(t.q.id))}">去做</button>
      </div>`).join('') : '<div class="empty">还没有错题，继续保持。</div>'}
    </div>`;

  on('stReview', () => startReview(60));
  document.querySelectorAll('[data-gobank]').forEach(el => el.onclick = () => {
    const b = bankById(el.dataset.gobank); if (!b) return;
    QZ.filter = 'all'; QZ.order = null; QZ.cur = el.dataset.goto;
    go('#/bank/' + b.id);
  });
}

/* ============================================================
   导入查重：粘贴的题库和已有题库、以及自身有没有重复题干
   ============================================================ */
const normStem = s => String(s || '').replace(/\s+/g, '').replace(/[，。；：、？！,.;:?!（）()【】\[\]"'“”‘’]/g, '').toLowerCase();

function dupCheck(qs, excludeId) {
  const have = {};
  baseBanks().forEach(b => {
    if (b.id === excludeId) return;
    b.questions.forEach(q => {
      const k = normStem(q.stem); if (!k) return;
      (have[k] = have[k] || { titles: {} }).titles[b.title] = 1;
    });
  });
  const self = {}, dup = [], repeat = [];
  qs.forEach(q => {
    const k = normStem(q.stem); if (!k) return;
    if (have[k]) dup.push({ stem: q.stem, titles: Object.keys(have[k].titles) });
    if (self[k]) repeat.push(q.stem); else self[k] = 1;
  });
  return { dup: dup, repeat: repeat };
}
function dupHtml(d) {
  if (!d.dup.length && !d.repeat.length) return '';
  const cut = s => esc(String(s).slice(0, 44)) + (String(s).length > 44 ? '…' : '');
  return (d.dup.length ? `<div class="note">有 <b>${d.dup.length}</b> 题和现有题库里的题干重复（只是提醒，不会自动合并）：<br>${d.dup.slice(0, 5).map(x => '· ' + cut(x.stem) + ' <span class="muted">（' + esc(x.titles.join('、')) + '）</span>').join('<br>')}${d.dup.length > 5 ? '<br>…' : ''}</div>` : '')
    + (d.repeat.length ? `<div class="note">粘贴的内容里有 <b>${d.repeat.length}</b> 题题干重复：<br>${d.repeat.slice(0, 5).map(x => '· ' + cut(x)).join('<br>')}</div>` : '');
}

/* ============================================================
   快捷键帮助
   ============================================================ */
function showHelp() {
  let m = $('helpMask');
  if (!m) {
    m = document.createElement('div');
    m.className = 'mask'; m.id = 'helpMask';
    m.innerHTML = `<div class="sheet">
      <div class="shead"><h3>快捷键与操作</h3><span class="spacer-grow"></span><button class="btn tiny" id="helpClose2">关闭</button></div>
      <div class="hint">手机上直接点就行，这些是电脑上用的。</div>
      <div class="sec-t">答题</div>
      <div class="help-row"><span class="kbd">A</span><span class="kbd">B</span><span class="kbd">C</span><span class="kbd">D</span><span class="spacer-grow"></span><span class="muted">选选项（也可按 1 2 3 4）</span></div>
      <div class="help-row"><span class="kbd">Enter</span><span class="spacer-grow"></span><span class="muted">多选题提交答案；单选或已判分＝下一题</span></div>
      <div class="help-row"><span class="kbd">←</span><span class="kbd">→</span><span class="spacer-grow"></span><span class="muted">上一题 / 下一题</span></div>
      <div class="help-row"><span class="kbd">S</span><span class="spacer-grow"></span><span class="muted">收藏 / 取消收藏当前题</span></div>
      <div class="help-row"><span class="kbd">K</span><span class="spacer-grow"></span><span class="muted">打开答题卡（可按「做错 / 没做」筛选）</span></div>
      <div class="sec-t">其它</div>
      <div class="help-row"><span class="kbd">/</span><span class="spacer-grow"></span><span class="muted">跳到搜索框（搜索页里）</span></div>
      <div class="help-row"><span class="kbd">?</span><span class="spacer-grow"></span><span class="muted">打开这个帮助</span></div>
      <div class="help-row"><span class="kbd">Esc</span><span class="spacer-grow"></span><span class="muted">关闭弹窗</span></div>
      <div class="sec-t">顺手提一句</div>
      <div class="small muted" style="line-height:2">
        · 首页最上面是「继续刷题」，直接接着上次的题号。<br>
        · 顶栏 <b>◐</b> 一键切换 跟随系统 / 浅色 / 深色。<br>
        · 底栏中间的数字点开就是答题卡；答完自动把解析滚到眼前。<br>
        · 错题本、收藏页的批量与导出收在「批量操作与导出」里，点一下展开。
      </div>
      <div class="actions"><button class="btn primary" id="helpClose">知道了</button></div>
    </div>`;
    document.body.appendChild(m);
    m.addEventListener('click', ev => { if (ev.target === m) m.classList.remove('show'); });
  }
  m.classList.add('show');
  on('helpClose', () => m.classList.remove('show'));
  on('helpClose2', () => m.classList.remove('show'));
}

/* ============================================================
   事件绑定（全部走 on()，某个 id 缺失也不会影响其它按钮）
   ============================================================ */
on('prev', () => step(-1));
on('next', () => step(1));
on('btnGrid', () => { renderGrid(); $('gridMask').classList.add('show'); });
on('jumpInfo', () => { renderGrid(); $('gridMask').classList.add('show'); });
on('gridClose', closeAll);
on('btnHome', () => go('#/'));
on('appTitle', () => go('#/'));
on('btnGoWrong', () => go('#/wrong'));
on('btnGoFav', () => go('#/fav'));
on('btnGoSearch', () => go('#/search'));
on('btnGoKb', () => go('#/kb'));
on('goKb2', () => { if (typeof closeAll === 'function') closeAll(); go('#/kb'); });
/* 设置面板里的「复习曲线」id ↔ 参数名 */
const SRS_UI = { srsFirst: 'first', srsSecond: 'second', srsFactor: 'factor', srsEase0: 'ease0', srsEaseUp: 'easeUp', srsEaseDown: 'easeDown', srsMinEase: 'minEase', srsMaxIvl: 'maxIvl', srsWrongIvl: 'wrongIvl', srsDaily: 'daily' };
function srsPaintEls() {
  const c = srsCfg();
  const sel = $('srsMode');
  if (sel) {
    sel.innerHTML = Object.keys(SRS_PRESETS).map(m => '<option value="' + m + '">' + SRS_PRESETS[m].label + '</option>').join('');
    sel.value = c.mode;
  }
  Object.keys(SRS_UI).forEach(id => { const el = $(id); if (el) el.value = c[SRS_UI[id]]; });
  const f = $('srsFactor');
  if (f && f.value !== String(c.factor)) {
    const o = document.createElement('option');
    o.value = String(c.factor); o.textContent = '× ' + c.factor;
    f.appendChild(o); f.value = String(c.factor);
  }
  const wt = $('srsWrongToday'); if (wt) wt.checked = !!c.wrongToday;
  if ($('srsDesc')) $('srsDesc').textContent = c.desc;
  if ($('srsPreview')) $('srsPreview').textContent = srsPreviewText(c);
}
/* 改动时只刷新说明和预览，不动正在输入的那个框 */
function srsRepaint() {
  const c = srsCfg();
  if ($('srsDesc')) $('srsDesc').textContent = c.desc;
  if ($('srsPreview')) $('srsPreview').textContent = srsPreviewText(c);
  const sel = $('srsMode'); if (sel && sel.value !== c.mode) sel.value = c.mode;
}
function openSettings() {
  $('setExpOnOk').checked = SET.expOnOk;
  $('setAutoNext').checked = SET.autoNext;
  $('setShuffle').checked = SET.shuffle;
  if ($('setTheme')) $('setTheme').value = SET.theme || 'auto';
  if ($('setFs')) $('setFs').value = SET.fs || 'm';
  if (!SRS_PRESETS[SRS.mode]) SRS.mode = 'sm2';
  srsPaintEls();
  $('setMask').classList.add('show');
}
on('btnQuizSet', openSettings);
on('btnSetAll', openSettings);
on('setTheme', e => { setLook('theme', e.target.value); paintThemeBtn(); }, 'change');
on('setFs', e => setLook('fs', e.target.value), 'change');
on('closeSet', closeAll);
on('setExpOnOk', e => { SET.expOnOk = e.target.checked; writeLS(LS.set, SET); render(); }, 'change');
on('setAutoNext', e => { SET.autoNext = e.target.checked; writeLS(LS.set, SET); }, 'change');
on('setShuffle', e => { SET.shuffle = e.target.checked; writeLS(LS.set, SET); QZ.order = null; render(); }, 'change');
on('resetAll', () => {
  if (!confirm('清空全部题库的作答记录？错题、收藏、自定义解析、临时套卷会被保留。不可恢复。')) return;
  tombWipe('ans'); ANS = {}; saveAns(); closeAll(); render(); toast('已清空作答记录');
});
/* 复习曲线：换档位 / 逐项改参数 / 一键重置 / 统一易度 / 按修正答案重判 */
on('srsMode', e => { setSrsMode(e.target.value); srsPaintEls(); }, 'change');
Object.keys(SRS_UI).forEach(id => on(id, e => {
  const f = SRS_UI[id];
  let v = e.target.value;
  if (f === 'factor') v = (v === 'ease' ? 'ease' : (+v || 2));
  else v = +v || 0;
  srsSetField(f, v);
  srsRepaint();
}, 'change'));
on('srsWrongToday', e => { srsSetField('wrongToday', !!e.target.checked); srsRepaint(); }, 'change');
on('srsReset', () => {
  const m = SRS_PRESETS[SRS.mode] ? SRS.mode : 'sm2';
  setSrsMode(m); srsPaintEls();
  toast('已填回「' + SRS_PRESETS[m].label + '」的推荐值');
});
on('srsSyncEase', () => {
  const c = srsCfg(), n = Object.keys(ANS).length;
  if (!n) { toast('还没有作答记录'); return; }
  if (!confirm('把现有 ' + n + ' 条作答记录的易度统一改成 ' + c.ease0 + '？间隔和到期时间不变。')) return;
  Object.keys(ANS).forEach(k => { ANS[k].ease = +c.ease0 || 2.5; });
  saveAns(); toast('已统一易度');
});
on('fixAllRe', () => {
  const n = Object.keys(FIX).length;
  if (!n) { toast('还没有改过任何题的答案'); return; }
  if (!confirm('按修正后的答案重判这 ' + n + ' 道题的历史记录？错次数和复习排期会一起变。')) return;
  const c = rejudgeAll();
  toast('已重判 ' + c + ' 道题');
  render();
});
on('expAll2', exportAllData);

/* ---------- 顶栏「◐」：一键切换外观 ---------- */
const THEME_ORDER = ['auto', 'light', 'dark'];
const THEME_ICON = { auto: '◐', light: '☀', dark: '🌙' };
const THEME_LABEL = { auto: '跟随系统', light: '浅色', dark: '深色' };
function paintThemeBtn() {
  const el = $('btnTheme'); if (!el) return;
  const t = THEME_LABEL[SET.theme] ? SET.theme : 'auto';
  el.textContent = THEME_ICON[t];
  el.title = '外观：' + THEME_LABEL[t] + '（点一下切换）';
}
on('btnTheme', () => {
  const cur = THEME_LABEL[SET.theme] ? SET.theme : 'auto';
  const next = THEME_ORDER[(THEME_ORDER.indexOf(cur) + 1) % THEME_ORDER.length];
  setLook('theme', next);
  const sel = $('setTheme'); if (sel) sel.value = next;
  paintThemeBtn();
  toast('外观已切成「' + THEME_LABEL[next] + '」');
});
if (window.matchMedia) {
  try { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => paintThemeBtn()); } catch (e) {}
}
paintThemeBtn();
document.querySelectorAll('.mask').forEach(m => m.onclick = e => { if (e.target === m) closeAll(); });

document.addEventListener('keydown', e => {
  const tag = (e.target && e.target.tagName) || '';
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(tag) || !!(e.target && e.target.isContentEditable);
  /* ? 打开快捷键帮助，Esc 关掉所有弹窗（任何页面都能用） */
  if (!typing && (e.key === '?' || (e.key === '/' && e.shiftKey))) { e.preventDefault(); showHelp(); return; }
  if (e.key === 'Escape') { closeAll(); return; }
  const rn = route().name;
  /* 搜索页：按 / 直接跳到搜索框 */
  if (rn === 'search' && !typing && e.key === '/') {
    const el = $('sq');
    if (el) { el.focus(); el.select(); e.preventDefault(); }
    return;
  }
  if (rn !== 'quiz' && rn !== 'exam') return;
  if (typing) return;
  const k = e.key.toUpperCase();
  if (/^[A-H]$/.test(k) || /^[1-8]$/.test(k)) {
    const K = /^[A-H]$/.test(k) ? k : 'ABCDEFGH'[+k - 1];
    const o = document.querySelector(`.opt[data-k="${K}"]`);
    if (o && !o.disabled) o.click();
    e.preventDefault(); return;
  }
  if (rn === 'exam') {
    if (e.key === 'Enter' || e.key === 'ArrowRight') { if (typeof examStep === 'function') examStep(1); e.preventDefault(); return; }
    if (e.key === 'ArrowLeft') { if (typeof examStep === 'function') examStep(-1); e.preventDefault(); return; }
    return;
  }
  const bank = bankById(QZ.bankId);
  const q = bank && bank.questions.find(x => String(x.id) === String(QZ.cur));
  /* S 收藏本题、K 打开答题卡 —— 不用去够鼠标（A–H 留给选项） */
  if (k === 'S' && bank && q) { toggleFav(favKey(bank, q)); e.preventDefault(); return; }
  if (k === 'K') { renderGrid(); const gm = $('gridMask'); if (gm) gm.classList.add('show'); e.preventDefault(); return; }
  if (e.key === 'Enter') {
    if (q && !answered(kOf(bank, q)) && qType(q, ansOf(favKey(bank, q), q)) === 'X' && (QZ.pending[q.id] || []).length) judge(bank, q, QZ.pending[q.id]);
    else step(1);
    e.preventDefault();
  }
  if (e.key === 'ArrowLeft') step(-1);
  if (e.key === 'ArrowRight') step(1);
});
