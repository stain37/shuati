/* ============================================================
   刷题站 · AI 助手 ai.js
   · 只用 OpenAI 兼容接口：本地 Ollama / LM Studio、云端 DeepSeek / OpenAI 都行
   · 生成的解析可以一键存进「本题解析」，也可以基于知识库答问
   · 页面：#/kb（AI 配置 + 知识库 + 试检索）
   · 答题页「AI 解析」按钮、错题本每题、解析编辑器里都能调出来
   ============================================================ */

const AI_LS = 'qbank.ai.v1';
const AI_PRESETS = {
  ollama:  { label: '本地 Ollama（免费、离线）', base: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b',
             models: ['qwen2.5:7b', 'qwen2.5:14b', 'qwen2.5:32b', 'deepseek-r1:8b', 'llama3.1:8b', 'gemma2:9b'],
             tip: '装好 Ollama 后执行：ollama pull qwen2.5:7b。要让网页能调用，需设环境变量 OLLAMA_ORIGINS=*（详见 AI知识库说明.md）。' },
  lmstudio:{ label: '本地 LM Studio', base: 'http://127.0.0.1:1234/v1', model: '', models: [],
             tip: 'LM Studio → Developer → Start Server，然后把「模型」填成它显示的模型名。' },
  deepseek:{ label: 'DeepSeek 云端 API', base: 'https://api.deepseek.com/v1', model: 'deepseek-flash',
             models: ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash'],
             tip: '在 platform.deepseek.com 生成 API Key 填到下面。deepseek-flash 便宜快、够用；deepseek-v4-pro 更强更贵。用云端时，只有命中的资料片段会发出去。' },
  kimi:    { label: 'Kimi / Moonshot 云端', base: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k',
             models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k', 'kimi-latest'],
             tip: '在 platform.moonshot.cn 生成 API Key。' },
  custom:  { label: '自定义（任意 OpenAI 兼容接口）', base: '', model: '', models: [],
             tip: '填类似 https://xxx/v1 的地址；本地服务一般不需要 Key。' }
};
/* ★ 纯净版：默认配置里不带任何 API 预置（服务=自定义、接口地址/模型/Key 全空），
   打开页面时①里是空白的，要谁用谁自己填；填好的东西只存在他那台电脑的浏览器里。 */
const AI_DEF = { preset: 'custom', base: '', model: '', key: '', temp: 0.3, topK: 4, maxChars: 3500, stream: true, sys: '', tmpl: false };
let AIC = readLS(AI_LS, null) || {};
Object.keys(AI_DEF).forEach(k => { if (AIC[k] == null) AIC[k] = AI_DEF[k]; });
function aiSave() { writeLS(AI_LS, AIC); }
function aiCfg() { return AIC; }
function aiBase(cfg) {
  let b = String((cfg || AIC).base || '').trim().replace(/\/+$/, '');
  if (b && !/\/v\d+$/.test(b) && !/\/api$/.test(b) && !/\/chat\/completions$/.test(b)) b += '/v1';
  return b;
}
function aiHeaders(cfg) {
  const h = { 'Content-Type': 'application/json' };
  if ((cfg || AIC).key) h['Authorization'] = 'Bearer ' + (cfg || AIC).key;
  return h;
}

/* ---------- 错误提示：尽量告诉用户到底哪里不对 ---------- */
function aiErrInfo(e) {
  if (!e) return { msg: '未知错误', hint: '' };
  if (e.name === 'AbortError') return { msg: '已停止', hint: '' };
  if (e instanceof TypeError || /Failed to fetch|NetworkError|load failed/i.test(e.message || '')) {
    return { msg: '连不上模型服务', hint: '① 服务没启动（Ollama 要开着）；② 浏览器直连被跨域挡了：把 OLLAMA_ORIGINS 设成 * ，或者用站点里的「本地服务器.bat」打开（http://localhost:5173），见 AI知识库说明.md。' };
  }
  const s = e.status;
  if (s === 401 || s === 403) return { msg: 'API Key 不对或没有权限', hint: '检查 Key 有没有复制全、有没有欠费。' };
  if (s === 404) return { msg: '接口地址不对', hint: '地址一般要以 /v1 结尾，例如 http://127.0.0.1:11434/v1。' };
  if (s === 400) {
    const b = String(e.body || '');
    if (/model/i.test(b)) return { msg: '模型名不存在', hint: '先在模型服务里拉取模型（Ollama: ollama pull 模型名），再点「拉取模型列表」挑一个。' };
    return { msg: '请求被拒绝（HTTP 400）', hint: b.slice(0, 200) };
  }
  return { msg: e.message || '出错', hint: '' };
}

/* ---------- 接口调用 ---------- */
async function aiModels() {
  const cfg = aiCfg();
  const res = await fetch(aiBase(cfg) + '/models', { headers: aiHeaders(cfg) });
  if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; e.body = await res.text().catch(() => ''); throw e; }
  const j = await res.json();
  const arr = (j && (j.data || j.models)) || [];
  return arr.map(x => x.id || x.name || x.model).filter(Boolean);
}
async function aiChat(messages, onDelta, signal) {
  const cfg = aiCfg();
  const url = aiBase(cfg) + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST', headers: aiHeaders(cfg), signal: signal,
    body: JSON.stringify({ model: cfg.model, messages: messages, temperature: +cfg.temp, stream: !!cfg.stream })
  });
  if (!res.ok) {
    const e = new Error('HTTP ' + res.status);
    e.status = res.status;
    e.body = await res.text().catch(() => '');
    throw e;
  }
  if (!cfg.stream || !res.body) {
    const j = await res.json();
    const c0 = (j.choices && j.choices[0]) || {};
    const c = (c0.message && c0.message.content) || c0.text || '';
    if (onDelta) onDelta(c);
    return c;
  }
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '', full = '', reas = '';      /* reas：推理模型的思考过程（deepseek-flash 这类会先吐它） */
  while (true) {
    const r = await reader.read();
    if (r.done) break;
    buf += dec.decode(r.value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line || line.charAt(0) === ':' || line.indexOf('data:') !== 0) continue;
      const d = line.slice(5).trim();
      if (d === '[DONE]') { if (onDelta) onDelta(full); return full; }
      try {
        const j = JSON.parse(d);
        const ch0 = (j.choices && j.choices[0]) || {};
        const d0 = ch0.delta || {};
        const c = d0.content || (ch0.message && ch0.message.content) || '';
        const rz = d0.reasoning_content || d0.reasoning || '';
        if (rz) reas += rz;
        if (c) { full += c; if (onDelta) onDelta(full, reas); }
        else if (rz && onDelta) onDelta(full, reas);      /* 只吐思考过程时也报一次，界面好显示「正在思考」 */
      } catch (err) {}
    }
  }
  if (onDelta) onDelta(full);
  return full;
}
/* ---------- ★ 纯净版：已去掉「预置 API 配置」这一套 ----------
   原来的做法：站点目录里放一个 AI配置.js（window.__AICFG__），页面一打开就自动把
   接口地址 / 模型 / API Key 填进「AI 服务」，还可以点按钮重读。本副本已整块移除：
   不再加载任何配置文件，也没有任何预置值。AI 配置全部在页面上手填，
   只存在这台电脑的浏览器里（localStorage 'qbank.ai.v1'），换电脑/清缓存就没了。
   下面是几个空实现，只为让原来的调用点不会报错。 */
function aiCfgFileName() { return ''; }
function aiApplyCfgFile() { return false; }
function aiLoadCfgFile() {}
/* 本机常见的 OpenAI 兼容服务，挨个探一遍，谁先回话就用谁 */
const AI_LOCAL_PROBES = [
  { preset: 'ollama',   base: 'http://127.0.0.1:11434/v1', label: 'Ollama' },
  { preset: 'lmstudio', base: 'http://127.0.0.1:1234/v1',  label: 'LM Studio' },
  { preset: 'custom',   base: 'http://127.0.0.1:8080/v1',  label: 'llama.cpp / LocalAI' },
  { preset: 'custom',   base: 'http://127.0.0.1:8000/v1',  label: 'vLLM / 其它' },
  { preset: 'custom',   base: 'http://127.0.0.1:5000/v1',  label: '其它本地服务' }
];
async function aiProbe(base) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 1800);
  try {
    const res = await fetch(base + '/models', { headers: aiHeaders({}), signal: ctl.signal });
    if (!res.ok) return null;
    const j = await res.json().catch(() => null);
    const arr = (j && (j.data || j.models)) || [];
    const ids = arr.map(x => (typeof x === 'string' ? x : (x.id || x.name || x.model))).filter(Boolean);
    return ids;
  } catch (e) { return null; } finally { clearTimeout(t); }
}
async function aiDetect(silent) {
  const st = $('aiState');
  const say = (t, cls) => { if (st) { st.textContent = t; st.className = 'aistate ' + (cls || ''); } };
  if (!silent) say('正在扫描本机常见的 AI 服务…');
  for (let i = 0; i < AI_LOCAL_PROBES.length; i++) {
    const p = AI_LOCAL_PROBES[i];
    const ids = await aiProbe(p.base);
    if (ids) {
      AIC.preset = p.preset; AIC.base = p.base; AIC.cfgAuto = false;
      if (ids.length) AIC.model = ids[0];
      aiSave();
      aiPaintForm(); aiFillModels(ids);
      say('发现 ' + p.label + '（' + p.base + '）' + (ids.length ? '，模型：' + ids.slice(0, 3).join(' / ') : '，但里面还没有模型，先 ollama pull 一个'), 'ok');
      if (!silent) toast('已自动填好：' + p.label);
      return { ok: true, probe: p, ids: ids };
    }
  }
  say('没扫到本机 AI 服务（Ollama 默认端口 11434、LM Studio 默认 1234）。装了 Ollama 请确认它正开着，并设好 OLLAMA_ORIGINS=*；或者在上面①里选 DeepSeek / Kimi，把接口地址和 API Key 填进去用云端模型。', 'bad');
  return { ok: false };
}

async function aiTest() {
  const st = $('aiState');
  const set = (t, cls) => { if (st) { st.textContent = t; st.className = 'aistate ' + (cls || ''); } };
  aiReadForm();
  set('测试中…');
  const t0 = Date.now();
  try {
    const ids = await aiModels();
    if (ids && ids.length) aiFillModels(ids);
    set('接口通（' + (Date.now() - t0) + ' ms' + (ids && ids.length ? '，' + ids.length + ' 个模型' : '') + '），再试生成…', 'ok');
  } catch (e) {
    const c = aiErrInfo(e);
    set('连接失败：' + c.msg + '　' + c.hint, 'bad');
    return;
  }
  try {
    const txt = await aiChat([{ role: 'user', content: '只回复两个字：可以' }], null, null);
    set('一切正常 · 模型回了「' + String(txt || '').trim().slice(0, 20) + '」', 'ok');
  } catch (e) {
    const c = aiErrInfo(e);
    set('生成失败：' + c.msg + '　' + c.hint, 'bad');
  }
}

/* ---------- 提示词 ---------- */
const AI_SYS_BASE = [
  '你是我的私人刷题助教，面向中国的考试。用简体中文和 Markdown 回答，不要客套话。',
  '严格按我这次的要求来写；我没提格式，就自己看情况组织，不要硬套固定小节。',
  '如果我给了【参考资料】：优先使用资料里的说法，并在句末标出 [1] [2] 这样的编号；资料没覆盖的地方可以补充你自己的知识，但要注明「（模型补充）」。',
  '不要编造资料的出处；不确定的地方直说不确定。'
].join('\n');
/* 想要固定四段的讲解格式时才加这段（配置里勾「套用模板」） */
const AI_SYS_TMPL = [
  '这次的输出按这个结构写：',
  '**答案**：只写选项字母',
  '**为什么**：一步步讲清楚推理，点出考的是哪个知识点',
  '**其它选项**：每一项一句话，说明错在哪',
  '**易错点 / 记忆**：1-2 条，能给口诀就给口诀'
].join('\n');
function aiSysText() {
  let s = AI_SYS_BASE;
  if (AIC.tmpl) s += '\n\n' + AI_SYS_TMPL;
  if (AIC.sys) s += '\n\n额外要求：' + AIC.sys;
  return s;
}
function aiUserText(q, ctxText, userQ, k) {
  const parts = [];
  if (q) {
    if (q.group) parts.push('【共用题干】' + q.group);
    parts.push('【题目】' + q.stem);
    if (q.options && q.options.length) parts.push('【选项】\n' + q.options.map((o, i) => 'ABCDEFGH'[i] + '. ' + o).join('\n'));
    const ans = (typeof ansOf === 'function') ? ansOf(k || '', q) : (q.answer || []);   /* k：这道题的键（套卷题是原题键），别再往 q 上挂 __k */
    if (ans && ans.length) parts.push('【题库答案】' + ans.join(''));
    if (q.explain) parts.push('【题库自带解析】' + String(q.explain).slice(0, 600));
  }
  if (ctxText) parts.push('【参考资料】\n' + ctxText);
  if (userQ) parts.push('【我的问题】' + userQ);
  else parts.push('【任务】请给出这道题的完整解析。');
  return parts.join('\n\n');
}
function aiMyRecText(k) {
  if (!k || typeof ANS === 'undefined' || !ANS[k]) return '';
  const a = ANS[k];
  return '【我的作答】' + ((a.sel || []).join('') || '—') + '（错 ' + (a.wrong || 0) + ' 次 / 共 ' + (a.tries || 0) + ' 次作答）';
}
async function aiContext(q, userQ) {
  const cfg = aiCfg();
  const query = [q && q.group, q && q.stem, (q && q.options || []).join(' '), userQ].filter(Boolean).join(' ');
  if (!cfg.topK || typeof kbSearch !== 'function') return { hits: [], text: '', count: 0 };
  /* 资料文件是懒加载的：第一次真正用到时才去挂 知识库.js */
  if (typeof kbEnsureFilesLoaded === 'function') { try { await kbEnsureFilesLoaded(); } catch (e) {} }
  const ids = (typeof kbSelected === 'function') ? kbSelected() : [];
  if (!ids.length) return { hits: [], text: '', count: 0 };
  let hits = [];
  try { hits = await kbSearch(query, ids, +cfg.topK || 4); } catch (e) { hits = []; }
  const per = Math.max(400, Math.floor((+cfg.maxChars || 3500) / Math.max(1, hits.length)));
  const blocks = [];
  let used = 0;
  hits.forEach(h => {
    const t = h.text.slice(0, per);
    if (used + t.length > (+cfg.maxChars || 3500) && blocks.length) return;
    used += t.length;
    blocks.push('[' + (blocks.length + 1) + '] 《' + h.doc + (h.head ? ' · ' + h.head : '') + '》（知识库：' + h.kb + '）\n' + t);
  });
  return { hits: hits.slice(0, blocks.length), text: blocks.join('\n\n'), count: blocks.length };
}

/* ---------- 面板：答题页 / 错题本 / 解析编辑器里共用 ---------- */
let AI_LAST = {};   /* 每个 host 的会话状态 */
function aiPanelHtml(host) {
  const L = [];
  L.push('<div class="aipanel">');
  L.push('<div class="aihead"><b>AI 解析</b> <span class="small muted ai-model"></span><span class="spacer-grow"></span><a class="small" href="#/kb">设置 / 知识库</a></div>');
  L.push('<div class="aichips"><span class="small muted" title="点标签就能切换用不用它，可以多选；第一个「总库 · 全部」等于一次全选">用哪些资料</span><span class="aichipbox"></span><button class="btn tiny ai-all">全选</button><button class="btn tiny ai-none">清空</button><span class="small muted aichint"></span></div>');
  L.push('<div class="aibar aiquick"><textarea class="ai-askq" rows="2" placeholder="先写你要什么（留空就自由发挥，不套格式）。例如：只讲 B 为什么错 / 用表格对比四个选项 / 按考纲口吻，200 字内"></textarea></div>');
  L.push('<div class="aibar">');
  L.push('<button class="btn primary ai-go">生成解析</button>');
  L.push('<button class="btn ai-ask" title="把框里写的话当成追问，接着上面的对话继续问">继续问</button>');
  L.push('<button class="btn ai-stop" disabled>停止</button>');
  L.push('<button class="btn ai-copy">复制</button>');
  L.push('<button class="btn ai-copyq" title="把这道题 + 命中的资料 + 要求复制到剪贴板，粘到 Chatbox 等客户端里问">复制提问</button>');
  L.push('<button class="btn ai-save">' + (host.dataset.aiuse === '1' ? '写进解析框' : '存入本题解析') + '</button>');
  L.push('<span class="aistate small"></span>');
  L.push('</div>');
  L.push('<div class="aiout small"></div>');
  L.push('<div class="aisrc small muted"></div>');
  L.push('</div>');
  return L.join('');
}
const AI_KB_ALL = '__all__';
let aiChipExcept = null;   /* 正在被点击的那个知识库标签框：不重建它，避免点击丢失 */
function aiChipHtml() {
  const list = (typeof kbList === 'function') ? kbList() : [];
  const sel = new Set((typeof kbSelected === 'function') ? kbSelected() : []);
  if (!list.length) return '<span class="small muted">还没有知识库（去 <a href="#/kb">AI 与知识库</a> 导入资料；不选也能用，只是纯靠模型知识）</span>';
  const allOn = list.every(k => sel.has(k.id));
  const chars = list.reduce((a, b) => a + (b.chars || 0), 0);
  let h = '<span class="aichip aichip-all' + (allOn ? ' on' : '') + '" data-kb="' + AI_KB_ALL + '" title="一键选定全部资料：'
    + list.length + ' 个库 / ' + chars.toLocaleString() + ' 字">总库 · 全部</span>';
  h += list.map(k => '<span class="aichip' + (sel.has(k.id) ? ' on' : '') + '" data-kb="' + k.id + '" title="' + (k.chars || 0).toLocaleString() + ' 字">' + esc(k.name) + '</span>').join('');
  return h;
}
function aiChipHintText() {
  const list = (typeof kbList === 'function') ? kbList() : [];
  const sel = (typeof kbSelected === 'function') ? kbSelected() : [];
  if (!list.length) return '（还没有知识库，点上面「设置 / 知识库」去导入资料）';
  if (!sel.length) return '（一个都没选：这次回答只靠模型自己的知识）';
  return '';
}
function paintAiChips() {
  const html = aiChipHtml();
  const hint = aiChipHintText();
  document.querySelectorAll('.aipanel .aichips').forEach(row => {
    const box = row.querySelector('.aichipbox');
    if (box && box !== aiChipExcept) box.innerHTML = html;
    const h = row.querySelector('.aichint');
    if (h) h.textContent = (box === aiChipExcept) ? h.textContent : hint;
  });
  document.querySelectorAll('.aipanel .ai-model').forEach(el => { el.textContent = AIC.model ? ('模型 ' + AIC.model) : '没配模型'; });
}
/* 就地刷新某个标签框（不重建 DOM，所以连着点多个标签也不会丢） */
function paintAiChipsIn(box) {
  if (!box) return;
  const list = (typeof kbList === 'function') ? kbList() : [];
  const sel = new Set((typeof kbSelected === 'function') ? kbSelected() : []);
  const allOn = list.length > 0 && list.every(k => sel.has(k.id));
  box.querySelectorAll('.aichip').forEach(ch => {
    ch.classList.toggle('on', ch.dataset.kb === AI_KB_ALL ? allOn : sel.has(ch.dataset.kb));
  });
  const hint = box.parentNode ? box.parentNode.querySelector('.aichint') : null;
  if (hint) hint.textContent = aiChipHintText();
}
function aiPanelBind(host) {
  const q = sel => host.querySelector(sel);
  const aiAskText = () => { const el = q('.ai-askq'); return el ? (el.value || '').trim() : ''; };
  q('.ai-go').onclick = () => {                 /* 生成解析：带上你写的要求，从头生成（不点就不会开始） */
    const st0 = AI_LAST[host.dataset.aiid];
    if (st0) { st0.text = ''; st0.msgs = []; }
    aiRun(host, aiAskText());
  };
  q('.ai-ask').onclick = () => { const v = aiAskText(); if (!v) { toast('先在框里写一句要问的'); return; } aiRun(host, v); };
  q('.ai-askq').onkeydown = e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); q('.ai-go').click(); } };
  q('.ai-stop').onclick = () => { const st = AI_LAST[host.dataset.aiid]; if (st && st.ctl) st.ctl.abort(); };
  q('.ai-copy').onclick = () => { const st = AI_LAST[host.dataset.aiid]; aiCopy(st ? st.text : '', host); };
  q('.ai-copyq').onclick = () => {
    const st = AI_LAST[host.dataset.aiid];
    if (!st) return;
    aiCopy(aiSysText() + '\n\n' + aiUserText(st.q, (st.ctx && st.ctx.text) || '', '', st.k), host);
  };
  q('.ai-save').onclick = () => aiSaveOut(host);
  q('.ai-all').onclick = () => { kbSelAll(true); paintAiChips(); };
  q('.ai-none').onclick = () => { kbSelAll(false); paintAiChips(); };
  host.querySelector('.aichipbox').addEventListener('click', e => {
    const c = e.target.closest('.aichip');
    if (!c) return;
    const box = c.parentNode;
    const on = !c.classList.contains('on');
    aiChipExcept = box;                                       /* 先声明：本框别被重建（kbSetSel 内部会调 paintAiChips） */
    try {
      if (c.dataset.kb === AI_KB_ALL) kbSelAll(on);           /* 「总库 · 全部」= 一键选定所有资料 */
      else kbSetSel(c.dataset.kb, on);
      paintAiChips();                                         /* 只刷新别的面板 */
    } finally { aiChipExcept = null; }
    paintAiChipsIn(box);                                      /* 本框就地切 class，不重建 DOM */
  });
}
function aiOpenPanel(host, k, q, onUse) {
  if (!host) return;
  if (typeof kbEnsureFilesLoaded === 'function') kbEnsureFilesLoaded().then(() => { try { paintAiChips(); } catch (e) {} });
  if (!host.dataset.aiid) {
    host.dataset.aiid = 'ai' + Math.random().toString(36).slice(2, 8);
    if (onUse) host.dataset.aiuse = '1';
    AI_LAST[host.dataset.aiid] = { k: k, q: q, onUse: onUse, text: '', msgs: [], running: false, ctl: null, ctx: null };
    host.innerHTML = aiPanelHtml(host);
    aiPanelBind(host);
  }
  paintAiChips();
  host.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  const st = AI_LAST[host.dataset.aiid];
  if (!st.text && !st.running) {
    /* 不自动开始：等你自己写完要求，再点「生成解析」 */
    const out = host.querySelector('.aiout');
    if (out) out.innerHTML = '<span class="muted">还没开始。先在上面写你要什么（可以留空），再点「生成解析」；写好追问后点「继续问」。</span>';
    aiState(host, '就绪 · 等你的要求');
    const ta = host.querySelector('.ai-askq');
    if (ta) { try { ta.focus({ preventScroll: true }); } catch (e) { try { ta.focus(); } catch (e2) {} } }
  }
}
function aiState(host, msg, cls) {
  const el = host.querySelector('.aistate');
  if (el) { el.textContent = msg || ''; el.className = 'aistate small ' + (cls || ''); }
}
function aiPaintOut(host, text, force) {
  const out = host.querySelector('.aiout');
  if (!out) return;
  const now = Date.now();
  if (!force && host._aiT && now - host._aiT < 80) return;
  host._aiT = now;
  out.innerHTML = (typeof mdToHtml === 'function') ? mdToHtml(text) : esc(text).replace(/\n/g, '<br>');
  if (force) host.scrollIntoView({ block: 'nearest' });
}
function aiPaintSrc(host, ctx) {
  const box = host.querySelector('.aisrc');
  if (!box) return;
  if (!ctx || !ctx.hits || !ctx.hits.length) {
    box.innerHTML = (typeof kbList === 'function' && kbList().length)
      ? '<span class="small muted">本次没用知识库（没勾选，或没命中相关内容）</span>'
      : '';
    return;
  }
  box.innerHTML = '参考资料：' + ctx.hits.map((h, i) => '<span class="aitag" title="' + esc(h.snip) + '">[' + (i + 1) + '] ' + esc(h.doc) + '</span>').join('');
}
async function aiRun(host, userQ) {
  const st = AI_LAST[host.dataset.aiid];
  if (!st || st.running) return;
  if (!AIC.base || !AIC.model) { aiState(host, '先在「设置 / 知识库」里填接口地址和模型', 'bad'); return; }
  const fresh = !userQ;
  if (fresh) { st.text = ''; st.msgs = []; }
  st.running = true; st.ctl = new AbortController();
  host.querySelector('.ai-stop').disabled = false;
  host.querySelector('.ai-go').disabled = true;
  aiState(host, '正在检索资料…');
  let ctx = { hits: [], text: '', count: 0 };
  try { ctx = await aiContext(st.q, userQ); } catch (e) {}
  const rec = aiMyRecText(st.k);
  if (!st.msgs.length) {
    const u = aiUserText(st.q, ctx.text, userQ, st.k) + (rec ? '\n\n' + rec : '');
    st.msgs = [{ role: 'system', content: aiSysText() }, { role: 'user', content: u }];
  } else {
    st.msgs.push({ role: 'user', content: (ctx.text ? '【参考资料】\n' + ctx.text + '\n\n' : '') + (userQ || '继续') });
  }
  st.ctx = ctx;
  aiPaintSrc(host, ctx);
  aiPaintOut(host, fresh ? '' : st.text, true);
  aiState(host, ctx.count ? ('已取 ' + ctx.count + ' 段资料，正在生成…') : '正在生成…');
  try {
    const full = await aiChat(st.msgs, (txt, rz) => {
      st.text = txt; st.reason = rz || st.reason;
      if (!txt && st.reason) {                       /* 推理模型在「想」的阶段：别让框子看起来是死的 */
        const o = host.querySelector('.aiout');
        if (o) o.innerHTML = '<span class="small muted">模型正在思考…（已想 ' + st.reason.length + ' 字）</span>';
        aiState(host, '正在思考…', '');
        return;
      }
      aiPaintOut(host, txt);
    }, st.ctl.signal);
    st.text = full || st.text;
    let onlyReason = false;
    if (!st.text && st.reason) {                     /* 正文为空但有思考过程：把这个情况说清楚 */
      st.text = st.reason; st.reason = ''; onlyReason = true;
    }
    st.msgs.push({ role: 'assistant', content: st.text });
    aiPaintOut(host, st.text, true);
    if (onlyReason) aiState(host, '模型只回了思考过程，没给正文，点「继续问」试试', 'bad');
    else aiState(host, st.text ? '完成' : '模型没返回内容', st.text ? 'ok' : 'bad');
  } catch (e) {
    const c = aiErrInfo(e);
    if (c.msg === '已停止') aiState(host, '已停止', '');
    else {
      const out = host.querySelector('.aiout');
      if (out) out.innerHTML = '<span class="bad-text">AI 出错：' + esc(c.msg) + '</span><div class="small muted" style="margin-top:6px">' + esc(c.hint) + '</div>';
      aiState(host, '出错', 'bad');
    }
  } finally {
    st.running = false;
    host.querySelector('.ai-stop').disabled = true;
    host.querySelector('.ai-go').disabled = false;
  }
}
function aiSaveOut(host) {
  const st = AI_LAST[host.dataset.aiid];
  if (!st || !st.text) { toast('还没有内容'); return; }
  const text = st.text.trim();
  if (!text) return;
  if (typeof st.onUse === 'function') { st.onUse(text); toast('已写进解析框，记得点保存'); return; }
  if (!st.k || typeof NOTES === 'undefined') { toast('这道题没有可保存的位置'); return; }
  const old = NOTES[st.k] || {};
  NOTES[st.k] = { text: text, imgs: old.imgs || [], ts: Date.now(), ai: true };
  if (!saveNotes()) { toast('保存失败：浏览器存储满了'); return; }
  toast('已存为本题解析');
  if (typeof render === 'function') render();
}
function aiCopy(t, host) {
  if (!t) { toast('还没有内容'); return; }
  const done = () => { if (host) aiState(host, '已复制', 'ok'); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t).then(done, () => aiCopyFallback(t, done));
  } else aiCopyFallback(t, done);
}
function aiCopyFallback(t, done) {
  try {
    const ta = document.createElement('textarea');
    ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    if (done) done();
  } catch (e) { toast('复制失败，请手动选中'); }
}

/* ---------- #/kb 页面：AI 配置 + 知识库 + 试用说明 ---------- */
function aiConfigHtml() {
  const L = [];
  L.push('<div class="card kbcard">');
  L.push('<div class="kbhead">① AI 服务 <span class="small muted">配置只存在本机浏览器，不会上传</span></div>');
  L.push('<div class="tools"><span class="tl">服务</span><select class="num" id="aiPreset"></select>');
  L.push('<button class="btn" id="aiTestBtn">测试连接</button>');
  L.push('<button class="btn" id="aiDetectBtn" title="自动扫描本机常见的 AI 服务（Ollama 11434 / LM Studio 1234 / 8080 / 8000）">自动检测本机服务</button>');
  L.push('<button class="btn" id="aiWipe" title="清掉这台电脑浏览器里存的那份配置（接口地址 / 模型 / API Key）。站点文件里本来就没有你的 Key。">清空本机配置</button>');
  L.push('<span class="aistate" id="aiState"></span></div>');
  L.push('<div class="tools"><span class="tl">接口地址</span><input class="num grow" id="aiBase" placeholder="例如 https://api.deepseek.com/v1 或 http://127.0.0.1:11434/v1"></div>');
  L.push('<div class="tools"><span class="tl">模型</span><input class="num grow" id="aiModel" list="aiModelList" placeholder="例如 deepseek-flash / qwen2.5:7b"><datalist id="aiModelList"></datalist>');
  L.push('<button class="btn" id="aiGetModels">拉取模型列表</button></div>');
  L.push('<div class="small muted" id="aiModelHint"></div>');
  L.push('<div class="tools"><span class="tl">API Key</span><input class="num grow" id="aiKey" type="password" placeholder="本地模型留空就行"><button class="btn" id="aiKeyShow">显示</button></div>');
  L.push('<div class="tools"><span class="tl">温度</span><input class="num" id="aiTemp" type="number" min="0" max="2" step="0.1" style="width:78px">');
  L.push('<span class="tl" title="每次回答问题，从知识库里捞几段资料给它当参考。片段本身最长约 560 字；一般 4 段够用，想让 AI 多做对比就 5~6 段。">检索片段数</span><input class="num" id="aiTopK" type="number" min="0" max="12" step="1" style="width:78px">');
  L.push('<span class="tl" title="这些参考资料加起来最多送给模型多少字。要跟上面的片段数配套：片段数 × 620 字以内才不会被截断。">资料上限</span><input class="num" id="aiMaxChars" type="number" min="600" max="20000" step="200" style="width:92px">');
  L.push('<label class="chk"><input type="checkbox" id="aiStream"> 流式输出</label></div>');
  L.push('<div class="small muted" id="aiRagTip"></div>');
  L.push('<div class="tools"><span class="tl">额外要求（可选）</span><input class="num grow" id="aiSys" placeholder="例如：只讲 B 为什么错 / 用表格对比四个选项 / 200 字内"></div>');
  L.push('<div class="tools"><label class="chk"><input type="checkbox" id="aiTmpl"> 套用「答案 / 为什么 / 其它选项 / 易错点」模板</label><span class="small muted">不勾就完全按你的要求写，不套任何固定格式</span></div>');
  L.push('<div class="small muted" id="aiTip"></div>');
  L.push('<div class="small" id="aiCfgNote"></div>');
  L.push('</div>');
  return L.join('');
}
function aiHelpHtml() {
  const L = [];
  L.push('<div class="card kbcard">');
  L.push('<div class="kbhead">④ 怎么用</div>');
  L.push('<div class="small">1）先在①里配好 AI：<b>没有任何模型</b>就先装 <a href="https://ollama.com/download" target="_blank" rel="noopener">Ollama</a>，装完在命令行跑 <code>ollama pull qwen2.5:7b</code>，然后点「测试连接」。</div>');
  L.push('<div class="small" style="margin-top:6px">2）在②里建知识库：小资料直接粘贴或导入 txt/md；<b>整本书</b>放到站点目录的 <code>资料/</code> 里，双击 <code>转知识库.bat</code>，刷新页面就会自动出现。</div>');
  L.push('<div class="small" style="margin-top:6px">3）做题时点题目下方的「AI 解析」：它会先用③里能命中的资料片段当参考，再让模型写解析；满意就点「存入本题解析」。</div>');
  L.push('<div class="small" style="margin-top:6px">4）AI 面板顶上那排就是 <b>选知识库</b>：标签前面写着「<b>用哪些资料</b>」，<b>点一下亮 / 再点灭</b>，能多选；第一个 <b>总库 · 全部</b> 是一键全选；一个都不选就是纯靠模型知识回答（右边会有小字提醒）。你选过之后会记住，下次打开还是这些。</div>');
  L.push('<div class="small" style="margin-top:6px">5）<b>自带资料库 / 加自己的书</b>：这个站点已经内置 6 个资料库（西综 157 篇、内科 75、外科 43、生化 34、生理 4、病理 1，共 314 个文件、约 315 万字），在②里能看到、能单独勾选。要把自己的书加进来：丢进站点目录的 <code>资料\</code> 文件夹，双击 <code>转知识库.bat</code>（需要 Python），刷新网页就有；也可以在②里直接粘贴文本建小库。</div>');
  L.push('<div class="small" style="margin-top:6px">6）Chatbox 本体没有对外接口（无端口/无命令行），所以刷题站没法替你点它。要用 Chatbox 答，就在面板上点 <b>复制提问</b>：题目＋命中资料＋要求都复制走，粘进 Chatbox 问，再把答案贴回「写解析」即可。</div>');
  L.push('<div class="small muted" style="margin-top:8px">隐私：资料只在你的电脑上；用本地 Ollama 时一个字都不出网。用云端 API 时，只把命中的那几段资料连同题目发出去。</div>');
  L.push('<div class="small muted" style="margin-top:4px">出问题看 <code>使用说明.md</code>（先看这份）和 <code>AI知识库说明.md</code>：里面写了怎么配 API、Ollama 跨域设置、用 <code>本地服务器.bat</code> 打开站点、Word/PDF 怎么转文字。</div>');
  L.push('</div>');
  return L.join('');
}
function aiFillModels(ids) {
  const dl = $('aiModelList');
  if (dl) dl.innerHTML = ids.map(i => '<option value="' + esc(i) + '"></option>').join('');
  if (ids.length && !AIC.model) { AIC.model = ids[0]; $('aiModel').value = ids[0]; aiSave(); }
}
function aiReadForm() {
  const v = id => { const el = $(id); return el ? el.value : undefined; };
  if (v('aiBase') != null) AIC.base = (v('aiBase') || '').trim();
  if (v('aiModel') != null) AIC.model = (v('aiModel') || '').trim();
  if (v('aiKey') != null) AIC.key = v('aiKey');
  if (v('aiTemp') != null) AIC.temp = +v('aiTemp') || 0;
  if (v('aiTopK') != null) AIC.topK = Math.max(0, Math.min(12, +v('aiTopK') || 0));
  if (v('aiMaxChars') != null) AIC.maxChars = Math.max(600, Math.min(20000, +v('aiMaxChars') || 3500));
  if ($('aiStream')) AIC.stream = !!$('aiStream').checked;
  if ($('aiTmpl')) AIC.tmpl = !!$('aiTmpl').checked;
  if (v('aiSys') != null) AIC.sys = (v('aiSys') || '').trim();
  AIC.cfgAuto = false;        /* 你自己改过，就不再让 AI配置.js 覆盖 */
  aiSave();
  if (typeof aiRagTip === 'function') aiRagTip();
}
/* 「检索片段数 × 资料上限」的实时提示：知识库一个片段最长约 560 字，这两个数要配套才不会白截 */
function aiRagTip() {
  const el = $('aiRagTip');
  if (!el) return;
  const k = Math.max(0, Math.min(12, +AIC.topK || 0));
  const mc = Math.max(600, +AIC.maxChars || 3500);
  if (!k) { el.innerHTML = '检索片段数 = 0：这次回答<b>不用知识库</b>，只靠模型自己知道的东西。'; return; }
  const per = Math.max(400, Math.floor(mc / k));
  const keep = Math.max(1, Math.floor(mc / 620));      /* 560 字正文 + 约 60 字出处行 */
  const fit = Math.max(1, Math.floor(mc / (per + 60)));  /* 截断后真正塞得进去几段 */
  if (per >= 620) {
    el.innerHTML = '当前配法：<b>' + k + ' 段</b>，每段最多 ' + per + ' 字（片段最长约 560 字，所以每段都是<b>整段</b>）→ 一次最多送出约 ' + (k * 620 / 1000).toFixed(1) + ' 千字参考资料。<b>这样是合适的。</b>';
  } else {
    el.innerHTML = '<span class="aistate bad">当前配法：' + k + ' 段，但每段只剩 ' + per + ' 字</span> → 片段本身有 500 多字，会<b>被截断</b>；而且总量一到 ' + mc + ' 字就停，实际只进得去约 ' + fit + ' 段（还都是残段）。想每段都完整：把「检索片段数」降到 <b>' + keep + '</b>，或把「资料上限」提到 <b>' + (k * 620) + '</b> 字左右。';
  }
}
function aiPaintForm() {
  const sel = $('aiPreset');
  if (sel) {
    sel.innerHTML = Object.keys(AI_PRESETS).map(p => '<option value="' + p + '">' + esc(AI_PRESETS[p].label) + '</option>').join('');
    sel.value = AIC.preset || 'ollama';
  }
  const set = (id, v) => { const el = $(id); if (el) el.value = v == null ? '' : v; };
  set('aiBase', AIC.base); set('aiModel', AIC.model); set('aiKey', AIC.key);
  set('aiTemp', AIC.temp); set('aiTopK', AIC.topK); set('aiMaxChars', AIC.maxChars); set('aiSys', AIC.sys || '');
  if ($('aiTmpl')) $('aiTmpl').checked = !!AIC.tmpl;
  const ms = (AI_PRESETS[AIC.preset] || {}).models || [];
  if (ms.length) aiFillModels(ms);                      /* 常用模型名直接进下拉，不用先联网拉 */
  if ($('aiModelHint')) $('aiModelHint').innerHTML = ms.length
    ? '这个服务常用的模型：' + ms.map(m => '<code>' + esc(m) + '</code>').join(' / ') + '（点「模型」框就能选）；也可以点「拉取模型列表」拿服务端真实可用的名字。'
    : '点「拉取模型列表」可以从服务端拿真实可用的模型名（本地服务要先启动）。';
  if ($('aiStream')) $('aiStream').checked = !!AIC.stream;
  if ($('aiTip')) $('aiTip').textContent = (AI_PRESETS[AIC.preset] || {}).tip || '';
  if (typeof aiRagTip === 'function') aiRagTip();
  if ($('aiCfgNote')) {
    $('aiCfgNote').innerHTML = '<span class="muted">这个版本<b>没有任何预置的 API 配置</b>：在上面①的「服务」下拉里选一个（DeepSeek / Kimi / 本地 Ollama…），把接口地址、模型、API Key 填上，点「测试连接」就能用 —— 填好的东西只存在这台电脑的浏览器里，站点文件里没有你的 Key。</span>';
  }
}
function aiBindConfig() {
  on('aiPreset', e => {
    const p = e.target.value;
    AIC.preset = p;
    const def = AI_PRESETS[p] || {};
    if (def.base) AIC.base = def.base;
    const ms = def.models || [];
    /* 换了服务就把模型也换成这个服务能用的：现在填的名字不在清单里就换成默认的 */
    if (ms.length && ms.indexOf(AIC.model) < 0) AIC.model = (def.model && ms.indexOf(def.model) >= 0) ? def.model : ms[0];
    else if (!AIC.model && def.model) AIC.model = def.model;
    aiSave();
    aiPaintForm();          /* 地址、模型、下拉清单、提示一次性刷新 */
  }, 'change');
  on('aiTmpl', aiReadForm, 'change');
  on('aiWipe', () => {
    if (!confirm('清空这台电脑的浏览器里保存的 AI 配置（接口地址 / 模型 / API Key）？\n\n注意：站点文件夹里本来就没有你的 Key；这里清掉的是浏览器里存的那份。')) return;
    try { localStorage.removeItem(AI_LS); } catch (e) {}
    AIC = {};
    Object.keys(AI_DEF).forEach(k => { AIC[k] = AI_DEF[k]; });
    aiSave();
    aiPaintForm();
    const st = $('aiState'); if (st) { st.textContent = '已清空本机配置'; st.className = 'aistate ok'; }
  });
  ['aiBase', 'aiModel', 'aiKey', 'aiTemp', 'aiTopK', 'aiMaxChars', 'aiSys'].forEach(id => on(id, aiReadForm, 'change'));
  on('aiStream', aiReadForm, 'change');
  on('aiTestBtn', aiTest);
  on('aiDetectBtn', () => aiDetect(false));
  on('aiGetModels', async () => {
    aiReadForm();
    const st = $('aiState');
    if (st) { st.textContent = '拉取中…'; st.className = 'aistate'; }
    try {
      const ids = await aiModels();
      aiFillModels(ids);
      if (st) { st.textContent = '拿到 ' + ids.length + ' 个模型，点模型框挑一个'; st.className = 'aistate ok'; }
    } catch (e) {
      const c = aiErrInfo(e);
      if (st) { st.textContent = c.msg + '　' + c.hint; st.className = 'aistate bad'; }
    }
  });
  on('aiKeyShow', () => { const el = $('aiKey'); if (el) el.type = el.type === 'password' ? 'text' : 'password'; });
}
function renderKb() {
  /* 知识库列表要等 知识库.js 挂上才有内容：懒加载，加载完再重画一次 */
  if (typeof kbEnsureFilesLoaded === 'function') kbEnsureFilesLoaded().then(r => { if (r && r.added) { try { render(); } catch (e) {} } });
  if (typeof aiIngestCfg === 'function') aiIngestCfg();
  $('view').innerHTML = '<h2 class="sec">AI 与知识库</h2>' + aiConfigHtml()
    + (typeof kbSectionHtml === 'function' ? kbSectionHtml() : '')
    + aiHelpHtml();
  aiPaintForm();
  aiBindConfig();
  if (typeof kbBind === 'function') kbBind($('view'));
}

/* 纯净版：没有 AI配置.js 这一套，启动时什么都不用读。 */
function aiIngestCfg() {}
