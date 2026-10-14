/* ============================================================
   刷题站 · exam.js  模拟考试模式
   状态：EX（存在 sessionStorage，刷新页面不丢）
   交卷时才统一写入 ANS，并按 SRS 排期；套卷题会累加回原题
   ============================================================ */
let EX = loadEX();
let exTimer = null;

function loadEX() {
  try {
    const d = JSON.parse(sessionStorage.getItem('shuati.exam') || 'null');
    if (d && d.id) { d.marks = new Set(d.marks || []); return d; }
  } catch (e) {}
  return null;
}
function saveEX() {
  if (!EX) return;
  try {
    sessionStorage.setItem('shuati.exam', JSON.stringify({
      id: EX.id, answers: EX.answers, marks: Array.from(EX.marks),
      submitted: EX.submitted, startedAt: EX.startedAt, duration: EX.duration || 0, endAt: EX.endAt,
      results: EX.results || null, usedMs: EX.usedMs || 0
    }));
  } catch (e) {}
}
function clearEX() { EX = null; try { sessionStorage.removeItem('shuati.exam'); } catch (e) {} }

function fmtClock(ms) {
  if (ms < 0) ms = 0;
  const t = Math.floor(ms / 1000), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const p = n => String(n).padStart(2, '0');
  return (h ? p(h) + ':' : '') + p(m) + ':' + p(s);
}

function renderExam(paperId) {
  const bank = bankById(paperId);
  if (!bank) { go('#/'); return; }
  const conf = PAPERS.find(p => p.id === paperId) || {};
  document.body.classList.add('quiz');

  if (!EX || EX.id !== paperId) {
    if (EX && !EX.submitted && !confirm('还有一场考试没交卷，开始新的一场会作废它。继续？')) { go('#/'); return; }
    const mins = conf.duration || 0;
    EX = {
      id: paperId, answers: {}, marks: new Set(), submitted: false,
      startedAt: Date.now(), duration: mins,
      endAt: mins ? Date.now() + mins * 1000 : 0,          // duration=0 表示不限时
      results: null
    };
    saveEX();
  }
  startTimer();
  $('appTitle').textContent = bank.title;
  if (EX.submitted) paintExamResult(bank);
  else paintExamQuestion(bank);
}

function examActive() { return !!(EX && !EX.submitted); }
function stopExamTimer() { clearInterval(exTimer); }

function startTimer() {
  clearInterval(exTimer);
  exTimer = setInterval(() => {
    if (!EX || EX.submitted || !((EX.duration || 0) > 0)) { clearInterval(exTimer); return; }  // 不限时不跑计时器
    const left = EX.endAt - Date.now();
    const el = $('exClock');
    if (el) {
      el.textContent = fmtClock(left);
      el.classList.toggle('urgent', left < 5 * 60000);
    }
    if (left <= 0) { clearInterval(exTimer); submitExam(true); }
  }, 500);
}

function examStep(d) {
  const bank = bankById(EX && EX.id);
  if (!bank) return;
  const n = bank.questions.length;
  EX.idx = Math.min(n - 1, Math.max(0, (EX.idx || 0) + d));
  saveEX();
  paintExamQuestion(bank);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function paintExamQuestion(bank) {
  const qs = bank.questions;
  if (EX.idx == null || EX.idx >= qs.length) EX.idx = 0;
  const i = EX.idx, q = qs[i];
  const fk = q._srcKey || kOf(bank, q);      // 答案修正按原题键生效
  const sel = EX.answers[q.id] || [];
  const marked = EX.marks.has(q.id);
  const answeredN = qs.filter(x => (EX.answers[x.id] || []).length).length;
  const timed = (EX.duration || 0) > 0;

  const opts = q.options.map((t, j) => {
    const K = 'ABCDEFGH'[j];
    return `<button class="opt${sel.includes(K) ? ' sel' : ''}" data-k="${K}"><span class="k">${K}</span><span>${esc(t)}</span></button>`;
  }).join('');

  $('view').innerHTML = `
    <div class="card">
      <div class="exbar">
        ${timed ? `<span class="exclock" id="exClock">${fmtClock(EX.endAt - Date.now())}</span>`
                : `<span class="exclock flat">不限时</span>`}
        <span class="small muted">已答 ${answeredN} / ${qs.length}</span>
        <span class="spacer-grow"></span>
        <button class="btn${marked ? ' fav-btn on' : ''}" id="exMark">${marked ? '★ 已标记' : '☆ 标记'}</button>
        <button class="btn primary" id="exSubmit">交卷</button>
      </div>
      <div class="qhead">
        <span class="qno">第 ${i + 1} / ${qs.length} 题</span>
        <span class="tag">${ansOf(fk, q).length > 1 ? '多选' : '单选'}</span>
        ${q.groupTitle ? `<span class="tag g">${esc(q.groupTitle)}</span>` : ''}
        <span class="tag exam-tag">模拟考试</span>
      </div>
      ${q.group ? `<div class="gstem"><b>共用题干：</b>${esc(q.group)}</div>` : ''}
      <div class="stem">${esc(q.stem)}</div>
      <div class="opts">${opts}</div>
      <div class="actions">
        <button class="btn" id="exPrev" ${i === 0 ? 'disabled' : ''}>上一题</button>
        <button class="btn" id="exNext" ${i === qs.length - 1 ? 'disabled' : ''}>下一题</button>
        <button class="btn" id="exClear" ${sel.length ? '' : 'disabled'}>清空本题</button>
      </div>
      <div class="hint" style="margin-top:10px">考试中不显示对错；交卷后统一批改并计入错题次数与复习排期。</div>
    </div>`;

  $('view').querySelectorAll('.opt').forEach(el => el.onclick = () => {
    const K = el.dataset.k;
    const cur = EX.answers[q.id] || (EX.answers[q.id] = []);
    if (ansOf(fk, q).length > 1) {
      const j = cur.indexOf(K);
      if (j >= 0) cur.splice(j, 1); else cur.push(K);
    } else {
      EX.answers[q.id] = [K];
    }
    saveEX();
    paintExamQuestion(bank);
  });
  on('exMark', () => { EX.marks.has(q.id) ? EX.marks.delete(q.id) : EX.marks.add(q.id); saveEX(); paintExamQuestion(bank); });
  on('exSubmit', () => submitExam(false));
  on('exPrev', () => examStep(-1));
  on('exNext', () => examStep(1));
  on('exClear', () => { EX.answers[q.id] = []; saveEX(); paintExamQuestion(bank); });

  $('stat').textContent = `${answeredN}/${qs.length}`;
  $('bar').style.width = (answeredN / qs.length * 100) + '%';
  $('jumpInfo').textContent = `${i + 1} / ${qs.length}`;
}

function submitExam(auto) {
  const bank = bankById(EX && EX.id);
  if (!bank) { clearEX(); go('#/'); return; }
  const qs = bank.questions;
  const blanks = qs.filter(q => !(EX.answers[q.id] || []).length).length;
  if (!auto) {
    const msg = blanks ? `还有 ${blanks} 题没作答。确定交卷？` : '确定交卷？交卷后本次成绩会计入错题次数和复习排期。';
    if (!confirm(msg)) return;
  }
  const rev = [];
  let correct = 0;
  qs.forEach(q => {
    const sel = EX.answers[q.id] || [];
    if (!sel.length) { rev.push({ qid: q.id, sel: [], ok: null }); return; }
    const fk = q._srcKey || kOf(bank, q);                                // 答案被手工改过时按原题键判分
    const ok = commitAnswer(kOf(bank, q), sel, ansOf(fk, q));
    if (q._srcKey) commitAnswer(q._srcKey, sel, ansOf(q._srcKey, q));   // 累加回原题 + SRS
    if (ok) correct++;
    rev.push({ qid: q.id, sel: sel.slice(), ok: ok });
  });
  saveAns();
  EX.submitted = true;
  EX.results = rev;
  EX.usedMs = Date.now() - EX.startedAt;
  clearInterval(exTimer);
  saveEX();
  toast(auto ? '时间到，已自动交卷' : '已交卷');
  render();
}

function paintExamResult(bank) {
  const qs = bank.questions;
  const map = {};
  (EX.results || []).forEach(r => map[r.qid] = r);
  const correct = (EX.results || []).filter(r => r.ok === true).length;
  const wrongN = (EX.results || []).filter(r => r.ok === false).length;
  const blank = qs.length - correct - wrongN;
  const score = qs.length ? Math.round(correct / qs.length * 100) : 0;
  const used = fmtClock(EX.usedMs || 0);

  const rows = qs.map((q, i) => {
    const r = map[q.id] || { sel: [], ok: null };
    const badge = r.ok === true ? '<span class="mini-tag ok">对</span>'
      : r.ok === false ? '<span class="mini-tag bad">错</span>' : '<span class="mini-tag">未答</span>';
    const fk = q._srcKey || kOf(bank, q);
    return `
      <div class="card wi">
        <div class="wi-head">
          <span class="wno">第 ${i + 1} 题</span>${badge}
          <span class="wmeta">正确答案：${ansOf(fk, q).join('')}${hasFix(fk) ? ' <span class="mini-tag">已修正</span>' : ''}　我的选择：${(r.sel || []).join('') || '—'}</span>
        </div>
        <div class="wi-body" style="margin-top:8px;border-top:none;padding-top:0">
          ${q.group ? `<div class="gstem"><b>共用题干：</b>${esc(q.group)}</div>` : ''}
          <div class="stem-sm">${esc(q.stem)}</div>
          <div class="opts-sm">${q.options.map((o, j) => {
            const K = 'ABCDEFGH'[j], right = ansOf(fk, q).includes(K), mine = (r.sel || []).includes(K);
            return `<div class="o ${right ? 'r' : ''}${mine && !right ? ' w' : ''}"><b>${K}</b>${esc(o)}${right ? '<span class="mini-tag ok">正确</span>' : ''}${mine && !right ? '<span class="mini-tag bad">我选的</span>' : ''}</div>`;
          }).join('')}</div>
          <div class="exp">${renderRich(fk, explainOf(fk, q))}</div>
        </div>
      </div>`;
  }).join('');

  $('view').innerHTML = `
    <div class="card" style="margin-bottom:14px">
      <div class="stats">
        <div><b>${score}</b><span>得分（百分制）</span></div>
        <div><b>${correct}/${qs.length}</b><span>答对</span></div>
        <div><b>${wrongN}</b><span>答错</span></div>
        <div><b>${blank}</b><span>未答</span></div>
        <div><b>${used}</b><span>用时</span></div>
      </div>
      <div class="row-inline" style="margin-top:14px">
        <button class="btn primary" id="exAgain">再用这套题考一次</button>
        <button class="btn" id="exHome">回首页</button>
        <span class="small muted">本次成绩已计入错题次数和复习排期。</span>
      </div>
    </div>
    ${rows}`;

  on('exHome', () => go('#/'));
  on('exAgain', () => {
    const conf = PAPERS.find(p => p.id === bank.id) || {};
    const keys = conf.keys || [];
    if (!keys.length) { toast('这套试卷的题目已经找不到来源了'); return; }
    clearEX();
    makePaper('再考一次 · ' + keys.length + ' 题', keys, { exam: true, duration: conf.duration || 0 });
  });
}

/* 题号面板（考试版）：显示已答 / 标记 */
function renderExamGrid() {
  const bank = bankById(EX && EX.id);
  if (!bank) return;
  const body = $('gridBody');
  body.innerHTML = `<div class="sec-t">${esc(bank.title)}　已答 ${bank.questions.filter(q => (EX.answers[q.id] || []).length).length}/${bank.questions.length}（黄点＝标记）</div>
    <div class="grid">` + bank.questions.map((q, i) => {
    const done = (EX.answers[q.id] || []).length;
    const marked = EX.marks.has(q.id);
    const cls = 'gnum' + (done ? ' done' : '') + (marked ? ' marked' : '') + (i === EX.idx ? ' cur' : '');
    return `<button class="${cls}" data-i="${i}">${i + 1}</button>`;
  }).join('') + `</div>`;
  body.querySelectorAll('.gnum').forEach(b => b.onclick = () => {
    EX.idx = +b.dataset.i;
    saveEX();
    closeAll();
    paintExamQuestion(bank);
    window.scrollTo({ top: 0 });
  });
}

/* 离开页面前提醒 */
window.addEventListener('beforeunload', e => {
  if (EX && !EX.submitted) { e.preventDefault(); e.returnValue = ''; return ''; }
});
