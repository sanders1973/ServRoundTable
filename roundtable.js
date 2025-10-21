/**
 * Round Table — Client-side app logic
 *
 * Major capabilities:
 * - Team registry in GitHub (`<DIR>/_teams/<TEAM>.json`) with optional passphrase
 * - GH-only Team picker (on load, populated from GitHub, not localStorage)
 * - Passphrase gating with per-team cached passphrases in localStorage
 * - Meeting sessions (TEAM -- NAME -- SESSION.txt), CSV/JSON export
 * - Reactions persisted within each user's own file (REACTIONS_B64), aggregated live
 * - Facilitator tools: timers, speaker order, counters
 * - Admin tools: create team (collapsible) and **bulk delete** by session or by team
 * - Smarter polling: ETag conditional + exponential backoff on 403/429
 * - Semi-arc gauges with needle (blue→green), filters, sort, diagnostics
 */

// ======= OWNER-EDITABLE CONFIG (defaults) =======
const CONFIG_DEFAULTS = {
  TEAM_NAME: "GNT SLT",
  OWNER: "sanders1973",
  REPO: "RoundTable",
  BRANCH: "main",
  DIR: "roundtable",
  POLL_INTERVAL_MS: 10000,
  // ⚠️ Fine-grained token with Contents: Read & Write on target repo
  GITHUB_TOKEN: "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"
};

// ======= RUNTIME STATE =======
let state = {
  nextPollTimeout: null,
  isSyncing: false,
  backoffMs: 0,
  lastApiError: null,
  liveSinceMs: Date.now(),
  cache: { dir: {}, files: {} },
  currentUpdates: [],
  reactionTotals: new Map(),
  myReactions: { updated_at: null, by_target: {} },
  sfilter: 'all',
  speaker: null,
  _rxDebounceTimer: null,
  teamRegistry: new Map(), // team => { team, passphrase, created_at, created_by }
  teamLocked: false,
  teamsFromGh: [],
};

// LocalStorage keys
const LS_KEYS = {
  TEAM_NAME: "RT_teamName",
  POLL_INTERVAL_MS: "RT_pollInterval",
  OWNER: "RT_owner",
  REPO: "RT_repo",
  BRANCH: "RT_branch",
  DIR: "RT_dir",
  NAME: "RT_myName",
  SESSION: "RT_session",
  THEME: "RT_theme",
  MODE: "RT_mode", // 'user' | 'facilitator'
  SPOKEN_FILTER: "RT_spokenFilter",
};
const LS_PASS_PREFIX = 'RT_teamPass::'; // + team name
const LS_SPEAKER_PREFIX = 'RT_speaker_'; // + sessionKey

// ======= UTILITIES =======
const $ = (sel) => document.querySelector(sel);
const nowIso = () => new Date().toISOString();
const fmtLocal = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleString(); };
const pad = (n)=> (n<10?"0":"")+n;
const todayYmd = ()=> { const d=new Date(); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; };
const toBase64 = (s)=> btoa(unescape(encodeURIComponent(String(s))));
const fromBase64 = (b)=> { try { return decodeURIComponent(escape(atob(b))); } catch { return ""; } };
function escapeHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;').replace(/'/g,'&#039;'); }
function linkify(t){ return String(t).replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noopener">$1<\/a>'); }

function getConfig(){
  const cfg = { ...CONFIG_DEFAULTS };
  const pick = (k)=>{ const v = localStorage.getItem(k); return v !== null && v !== undefined && v !== "" ? v : undefined; };
  cfg.TEAM_NAME = pick(LS_KEYS.TEAM_NAME) ?? cfg.TEAM_NAME;
  cfg.POLL_INTERVAL_MS = Number(pick(LS_KEYS.POLL_INTERVAL_MS) ?? cfg.POLL_INTERVAL_MS);
  cfg.OWNER = pick(LS_KEYS.OWNER) ?? cfg.OWNER;
  cfg.REPO = pick(LS_KEYS.REPO) ?? cfg.REPO;
  cfg.BRANCH = pick(LS_KEYS.BRANCH) ?? cfg.BRANCH;
  cfg.DIR = pick(LS_KEYS.DIR) ?? cfg.DIR;
  return cfg;
}

// Session: date-only default to today
function defaultSession(){ return todayYmd(); }
function fileNameFor(team, person, session){ return `${team} -- ${person} -- ${session}`.trim(); }
function filePathFor(team, person, session, cfg){ const fn = `${fileNameFor(team, person, session)}.txt`; const dir = cfg.DIR ? cfg.DIR.replace(/^\/+|\/+$/g, "") + "/" : ""; return dir + fn; }

function buildContentVars({ team, name, session, feeling, productivity, update, timestamp }){
  return [
    `TEAM="${team}"`,
    `NAME="${name}"`,
    `SESSION="${session}"`,
    `FEELING=${Number(feeling)}`,
    `PRODUCTIVITY=${Number(productivity)}`,
    `UPDATED_AT="${timestamp}"`,
    `UPDATE_B64="${toBase64(update ?? "")}"`,
  ].join("\n") + "\n";
}

function parseContentVars(text){
  const out = { team:"", name:"", session:"", feeling:null, productivity:null, update:"", updated_at:"", reactions: null };
  const lines = String(text).split(/\r?\n/);
  for (const raw of lines){
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('='); if (eq === -1) continue;
    const key = line.slice(0,eq).trim().toUpperCase();
    let val = line.slice(eq+1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1,-1);
    if (key === 'TEAM') out.team = val;
    else if (key === 'NAME') out.name = val;
    else if (key === 'SESSION') out.session = val;
    else if (key === 'FEELING') out.feeling = Number(val) || null;
    else if (key === 'PRODUCTIVITY') out.productivity = Number(val) || null;
    else if (key === 'UPDATED_AT') out.updated_at = val;
    else if (key === 'UPDATE_B64') out.update = fromBase64(val);
    else if (key === 'UPDATE') out.update = val;
    else if (key === 'REACTIONS_B64'){
      try { const obj = JSON.parse(fromBase64(val)||'{}'); if (obj && typeof obj === 'object') out.reactions = obj; } catch {}
    }
  }
  if (!out.reactions) out.reactions = { updated_at:null, by_target:{} };
  if (!out.reactions.by_target) out.reactions.by_target = {};
  return out;
}

function setLiveStatus({ label, color }){
  const dot = $('#liveDot'); const lbl = $('#liveLabel');
  if (dot) dot.setAttribute('fill', color || '#8e9bd6');
  if (lbl) lbl.textContent = label || 'Idle';
}
function setSaveStatus(msg, ok=true){ const el = $('#saveStatus'); if (el){ el.textContent = msg; el.style.color = ok ? '#b4bfed' : '#e74c3c'; } }
function recordApiError(err){ state.lastApiError = String(err?.message || err || ''); const el = $('#lastApiError'); if (el) el.textContent = state.lastApiError || 'None'; }
function updateLiveSinceTicker(){ const el = $('#liveSinceTicker'); if (!el) return; const ms = Date.now() - state.liveSinceMs; const s = Math.floor(ms/1000); const m = Math.floor(s/60); const rem = s%60; el.textContent = m ? `${m}m ${rem}s` : `${rem}s`; }

// ======= THEME & MODE =======
function setTheme(mode){ const m = (mode === 'light') ? 'light' : 'dark'; document.body.setAttribute('data-theme', m); const icon = $('#themeIcon'); const name = $('#themeName'); const btn = $('#themeToggle'); if (icon) icon.textContent = (m === 'dark') ? '🌙' : '☀️'; if (name) name.textContent = (m === 'dark') ? 'Dark' : 'Light'; if (btn) btn.setAttribute('aria-pressed', String(m === 'dark')); localStorage.setItem(LS_KEYS.THEME, m); }
function initTheme(){ const saved = localStorage.getItem(LS_KEYS.THEME) || 'dark'; setTheme(saved); $('#themeToggle')?.addEventListener('click', ()=>{ const cur = document.body.getAttribute('data-theme'); setTheme(cur === 'dark' ? 'light' : 'dark'); }); }
function setMode(mode){ const m = (mode === 'facilitator') ? 'facilitator' : 'user'; $('#userSection').hidden = (m !== 'user'); $('#facilitatorSection').hidden = (m !== 'facilitator'); $('#modeUserBtn')?.classList.toggle('active', m === 'user'); $('#modeFacBtn')?.classList.toggle('active', m === 'facilitator'); localStorage.setItem(LS_KEYS.MODE, m); }
function initMode(){ const saved = localStorage.getItem(LS_KEYS.MODE) || 'user'; setMode(saved); $('#modeUserBtn')?.addEventListener('click', ()=> setMode('user')); $('#modeFacBtn')?.addEventListener('click', ()=> setMode('facilitator')); }

// ======= GAUGES: semi-arc with needle (blue→green) =======
function setSemiGauge(kind, val){
  const arc = document.getElementById(`gauge${kind}Arc`);
  const needle = document.getElementById(`gauge${kind}Needle`);
  const label = document.getElementById(`gauge${kind}Val`);
  const container = document.getElementById(`gauge${kind}`);
  if (!arc || !needle || !label || !container) return;
  if (val === null || val === undefined || isNaN(val)){
    arc.style.strokeDasharray = `0 100`;
    needle.setAttribute('transform', 'rotate(-90 100 110)');
    label.textContent = '—';
    container.setAttribute('aria-valuenow', '0');
    return;
  }
  const clamped = Math.max(0, Math.min(10, Number(val)));
  const pct = Math.round((clamped/10)*100);
  arc.style.strokeDasharray = `${pct} 100`;
  const angle = -90 + (pct/100)*180; // -90° .. +90°
  needle.setAttribute('transform', `rotate(${angle} 100 110)`);
  label.textContent = clamped.toFixed(1);
  container.setAttribute('aria-valuenow', String(clamped));
}

// ======= GITHUB API =======
function ghHeaders(token, etag){ const h = { 'Accept': 'application/vnd.github+json', 'Authorization': token ? `token ${token}` : undefined, 'Content-Type': 'application/json' }; if (etag) h['If-None-Match'] = etag; return h; }
async function ghFetch(path, { method='GET', body, etag }={}){ const url = `https://api.github.com${path}`; return fetch(url, { method, headers: ghHeaders(CONFIG_DEFAULTS.GITHUB_TOKEN, etag), body: body ? JSON.stringify(body) : undefined }); }
async function ghGetJsonWithEtag(path, cacheObj){ const prev = cacheObj[path] || {}; const res = await ghFetch(path, { etag: prev.etag }); if (res.status === 304) return { notModified:true, etag:prev.etag, data:prev.data }; if (!res.ok){ throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`); } const etag = res.headers.get('ETag'); const data = await res.json(); cacheObj[path] = { etag, data }; return { notModified:false, etag, data }; }
async function ghGetContentsMeta(cfg, filePath){ const enc = encodeURIComponent(filePath).replace(/%2F/g,'/'); const path = `/repos/${cfg.OWNER}/${cfg.REPO}/contents/${enc}?ref=${encodeURIComponent(cfg.BRANCH)}`; const res = await ghFetch(path); if (res.status === 404) return null; if (!res.ok){ const text = await res.text(); const e = new Error(`${res.status} ${res.statusText}: ${text}`); e.status = res.status; throw e; } const json = await res.json(); return { sha: json.sha, size: json.size, path: json.path };
}
async function writeFileOverwriteStrict(cfg, filePath, contentString, commitMessage){
  const enc = encodeURIComponent(filePath).replace(/%2F/g,'/');
  const put = async (sha)=>{ const body = { message: commitMessage, content: toBase64(contentString), branch: cfg.BRANCH, committer: { name:'Round Table App', email:'roundtable@example.com' } }; if (sha) body.sha = sha; const path = `/repos/${cfg.OWNER}/${cfg.REPO}/contents/${enc}`; const res = await ghFetch(path, { method:'PUT', body }); if (res.status === 200 || res.status === 201) return res.json(); const text = await res.text(); const err = new Error(`${res.status} ${res.statusText}: ${text}`); err.status = res.status; throw err; };
  let meta = await ghGetContentsMeta(cfg, filePath);
  try { return await put(meta?.sha); }
  catch (e){ const msg = String(e.message||''); if (e.status === 422 || /422/.test(msg) || /\"sha\" wasn't supplied|sha/i.test(msg)){ meta = await ghGetContentsMeta(cfg, filePath); if (meta?.sha) return await put(meta.sha); return await put(undefined); } if (e.status === 409){ meta = await ghGetContentsMeta(cfg, filePath); if (meta?.sha) return await put(meta.sha); } throw e; }
}
async function deleteFile(cfg, filePath, sha, message){ const enc = encodeURIComponent(filePath).replace(/%2F/g,'/'); const body = { message, sha, branch: cfg.BRANCH, committer: { name:'Round Table App', email:'roundtable@example.com' } }; const path = `/repos/${cfg.OWNER}/${cfg.REPO}/contents/${enc}`; const res = await ghFetch(path, { method:'DELETE', body }); if (!res.ok){ const t = await res.text(); const e = new Error(`${res.status} ${res.statusText}: ${t}`); e.status = res.status; throw e; } return res.json(); }

async function listDirectory(cfg){ const dir = cfg.DIR ? cfg.DIR.replace(/^\/+|\/+$/g, '') : ''; const encDir = dir ? `/${encodeURIComponent(dir).replace(/%2F/g,'/')}` : ''; const ref = encodeURIComponent(cfg.BRANCH); const path = `/repos/${cfg.OWNER}/${cfg.REPO}/contents${encDir}?ref=${ref}`; try { const { data } = await ghGetJsonWithEtag(path, state.cache.dir); const items = Array.isArray(data) ? data : []; return items.filter(x => x && x.type === 'file' && /\.txt$/i.test(x.name)); } catch { return []; } }
async function readFileContent(cfg, fileItem){ const encPath = (typeof fileItem === 'string') ? encodeURIComponent(fileItem).replace(/%2F/g,'/') : encodeURIComponent(fileItem.path).replace(/%2F/g,'/'); const ref = encodeURIComponent(cfg.BRANCH); const path = `/repos/${cfg.OWNER}/${cfg.REPO}/contents/${encPath}?ref=${ref}`; const prev = state.cache.files[path] || {}; const res = await ghFetch(path, { etag: prev.etag }); if (res.status === 304) return prev.text || ''; if (!res.ok){ throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`); } const etag = res.headers.get('ETag'); const json = await res.json(); let text = ''; if (json?.content && json.encoding === 'base64') text = fromBase64(json.content.replace(/\n/g,'')); state.cache.files[path] = { ...(state.cache.files[path]||{}), etag, text, sha: json.sha }; return text; }

// === Registry helpers ===
function safeJoin(...parts){ return parts.filter(Boolean).join('/').replace(/\\+/g,'/').replace(/\/\/+$/,''); }
function dirRoot(cfg){ return cfg.DIR ? cfg.DIR.replace(/^\/+|\/+$/g, '') : ''; }
function registryDir(cfg){ const root = dirRoot(cfg); return root ? `${root}/_teams` : `_teams`; }
async function listRegistry(cfg){ const reg = registryDir(cfg); const enc = encodeURIComponent(reg).replace(/%2F/g,'/'); const ref = encodeURIComponent(cfg.BRANCH); const path = `/repos/${cfg.OWNER}/${cfg.REPO}/contents/${enc}?ref=${ref}`; try { const { data } = await ghGetJsonWithEtag(path, state.cache.dir); const items = Array.isArray(data) ? data : []; return items.filter(x => x && x.type === 'file' && /\.json$/i.test(x.name)); } catch(e){ return []; } }
async function readJsonFile(cfg, path){ const enc = encodeURIComponent(path).replace(/%2F/g,'/'); const ref = encodeURIComponent(cfg.BRANCH); const api = `/repos/${cfg.OWNER}/${cfg.REPO}/contents/${enc}?ref=${ref}`; const prev = state.cache.files[api] || {}; const res = await ghFetch(api, { etag: prev.etag }); if (res.status === 304) { try { return JSON.parse(prev.text || '{}'); } catch { return {}; } } if (!res.ok){ const t = await res.text(); throw new Error(`${res.status} ${res.statusText}: ${t}`); } const etag = res.headers.get('ETag'); const json = await res.json(); let text=''; if (json?.content && json.encoding==='base64') text = fromBase64(json.content.replace(/\n/g,'')); state.cache.files[api] = { ...(state.cache.files[api]||{}), etag, text, sha: json.sha }; try { return JSON.parse(text||'{}'); } catch { return {}; } }

// ======= REACTIONS: aggregate & write to my own file =======
function emptyReactions(){ return {"👍":0,"✅":0,"❤️":0}; }
function clone(obj){ return JSON.parse(JSON.stringify(obj||{})); }

async function aggregateReactions(parsedList){
  const totals = new Map();
  for (const u of parsedList){
    const byTarget = (u.reactions?.by_target) || {};
    for (const [base, flags] of Object.entries(byTarget)){
      const entry = totals.get(base) || emptyReactions();
      if (flags['👍']) entry['👍'] = (entry['👍']||0) + 1;
      if (flags['✅']) entry['✅'] = (entry['✅']||0) + 1;
      if (flags['❤️']) entry['❤️'] = (entry['❤️']||0) + 1;
      totals.set(base, entry);
    }
  }
  return totals;
}

function myBaseForCurrent(){ const cfg = getConfig(); const name = (localStorage.getItem(LS_KEYS.NAME) || $('#nameInput')?.value || '').trim(); const session = ($('#sessionFilter')?.value || '').trim() || defaultSession(); if (!name) return null; return fileNameFor(cfg.TEAM_NAME, name, session); }

async function ensureMyFileExists(cfg){
  const name = (localStorage.getItem(LS_KEYS.NAME) || $('#nameInput')?.value || '').trim(); if (!name) throw new Error('Please enter your name first.');
  const session = ($('#sessionFilter')?.value || '').trim() || defaultSession();
  const path = filePathFor(cfg.TEAM_NAME, name, session, cfg);
  const meta = await ghGetContentsMeta(cfg, path);
  if (meta) return path;
  const payload = { team: cfg.TEAM_NAME, name, session, feeling: 0, productivity: 0, update: '', timestamp: nowIso() };
  const content = buildContentVars(payload);
  await writeFileOverwriteStrict(cfg, path, content, `Round Table: init file for ${name} (${cfg.TEAM_NAME} — ${session})`);
  return path;
}

async function upsertMyReactions(cfg){
  const base = myBaseForCurrent(); if (!base) { alert('Enter your name to react.'); return; }
  const name = (localStorage.getItem(LS_KEYS.NAME) || $('#nameInput')?.value || '').trim();
  const session = ($('#sessionFilter')?.value || '').trim() || defaultSession();
  const path = await ensureMyFileExists(cfg);
  let text = '';
  try { text = await readFileContent(cfg, { path }); } catch { text = ''; }
  const lines = String(text||'').split(/\r?\n/);
  const idx = lines.findIndex(l => /^\s*REACTIONS_B64\s*=/.test(l));
  const payload = { updated_at: nowIso(), by_target: clone(state.myReactions.by_target) };
  const encoded = toBase64(JSON.stringify(payload));
  if (idx >= 0) lines[idx] = `REACTIONS_B64="${encoded}"`; else lines.push(`REACTIONS_B64="${encoded}"`);
  const newText = lines.join('\n');
  await writeFileOverwriteStrict(cfg, path, newText, `Round Table: reactions update for ${name} (${CONFIG_DEFAULTS.TEAM_NAME} — ${session})`);
}

function scheduleWriteMyReactions(){
  const cfg = getConfig();
  if (state._rxDebounceTimer) clearTimeout(state._rxDebounceTimer);
  state._rxDebounceTimer = setTimeout(async ()=>{
    try { await upsertMyReactions(cfg); } catch(e){ recordApiError(e); }
    finally { state._rxDebounceTimer = null; setTimeout(refreshBoard, 400); }
  }, 500);
}

// ======= SPEAKER ORDER (per-session persisted) =======
function sessionKey(){ const cfg = getConfig(); const sess = ($('#sessionFilter')?.value || '').trim() || defaultSession(); return `${cfg.TEAM_NAME}::${sess}`; }
function loadSpeakerState(){ const raw = localStorage.getItem(LS_SPEAKER_PREFIX + sessionKey()); if (!raw) return { spoken: [], speakingNow: null, readyOrder: [] }; try { const s = JSON.parse(raw); return { spoken: s.spoken||[], speakingNow: s.speakingNow||null, readyOrder: s.readyOrder||[] }; } catch { return { spoken: [], speakingNow: null, readyOrder: [] }; } }
function saveSpeakerState(s){ state.speaker = s; localStorage.setItem(LS_SPEAKER_PREFIX + sessionKey(), JSON.stringify(s)); updateSpeakerCounts(); }
function clearSpeakerState(){ saveSpeakerState({ spoken: [], speakingNow: null, readyOrder: [] }); }
function updateSpeakerCounts(){ const s = state.speaker || loadSpeakerState(); const updates = state.currentUpdates; const names = new Set(updates.map(u=> u.name)); const spokenCt = (s.spoken||[]).filter(n=> names.has(n)).length; const remainingCt = Math.max(0, names.size - spokenCt); $('#speakerCounts').textContent = `Remaining: ${remainingCt} • Spoken: ${spokenCt}`; }

function shuffle(arr){ for (let i=arr.length-1; i>0; i--){ const j = Math.floor(Math.random()*(i+1)); [arr[i],arr[j]]=[arr[j],arr[i]]; } return arr; }
function applySpeakerOrdering(updates){ const s = state.speaker || loadSpeakerState(); const spokenSet = new Set(s.spoken||[]); const byName = new Map(updates.map(u=> [u.name, u])); const ready = updates.filter(u=> !spokenSet.has(u.name)); const readyNames = new Set(ready.map(u=> u.name)); const savedOrder = (s.readyOrder||[]).filter(n=> readyNames.has(n)); const leftover = ready.filter(u=> !savedOrder.includes(u.name)).map(u=> u.name); const finalReadyNames = [...savedOrder, ...leftover]; const speaking = s.speakingNow && readyNames.has(s.speakingNow) ? s.speakingNow : null; const readyOrdered = (speaking ? [speaking] : []).concat(finalReadyNames.filter(n=> n!==speaking)).map(n=> byName.get(n)).filter(Boolean); const spokenOrdered = (s.spoken||[]).map(n=> byName.get(n)).filter(Boolean); return readyOrdered.concat(spokenOrdered); }
function nextSpeaker(){ const updates = state.currentUpdates; if (!updates.length) return; const s = state.speaker || loadSpeakerState(); const spokenSet = new Set(s.spoken||[]); const ready = updates.map(u=>u.name).filter(n=> !spokenSet.has(n)); if (!ready.length){ s.speakingNow = null; s.readyOrder = []; saveSpeakerState(s); renderUpdates(state.currentUpdates); return; } const order = shuffle(ready.slice()); s.readyOrder = order; s.speakingNow = order[0] || null; saveSpeakerState(s); renderUpdates(state.currentUpdates); }
function speakerFinished(){ const s = state.speaker || loadSpeakerState(); if (!s.speakingNow) return; if (!s.spoken.includes(s.speakingNow)) s.spoken.push(s.speakingNow); s.readyOrder = s.readyOrder.filter(n=> n!==s.speakingNow); s.speakingNow = null; saveSpeakerState(s); renderUpdates(state.currentUpdates); speakerClear(); }

// ======= TEAM DISCOVERY (GH-only for picker) & REGISTRY =======
function getStoredPass(team){ return localStorage.getItem(LS_PASS_PREFIX + team) || ''; }
function setStoredPass(team, pass){ localStorage.setItem(LS_PASS_PREFIX + team, pass || ''); }

async function discoverTeamsFromGitHub(cfg, dirItems){
  const regItems = await listRegistry(cfg); const regMap = new Map();
  for (const it of regItems){ try { const obj = await readJsonFile(cfg, it.path); if (obj && obj.team){ regMap.set(String(obj.team), { team: String(obj.team), passphrase: obj.passphrase || '', created_at: obj.created_at||'', created_by: obj.created_by||'' }); } } catch {}
  }
  state.teamRegistry = regMap;
  const legacy = new Set();
  for (const it of (dirItems||[])){
    const nm = (it.name||'').replace(/\.txt$/i,'');
    const team = nm.split(' -- ')[0]?.trim(); if (team) legacy.add(team);
  }
  // Prefer registry names + any legacy-only names
  const teams = [...new Set([ ...regMap.keys(), ...legacy ])];
  state.teamsFromGh = teams.sort((a,b)=> a.localeCompare(b));
  populateTeamSwitcher();
  populateDeleteTeamSelect();
}

function verifyPassForSelectedTeam(){
  const cfg = getConfig(); const team = cfg.TEAM_NAME; const reg = state.teamRegistry.get(team);
  const inp = $('#teamPassInput'); const msg = $('#passMsg');
  if (!reg || !reg.passphrase){ state.teamLocked = false; if (msg) msg.textContent = 'No pass needed'; inp?.classList.remove('error'); return true; }
  const entered = (inp?.value || getStoredPass(team) || '').trim();
  if (!entered || entered !== String(reg.passphrase)){
    state.teamLocked = true; if (msg) msg.textContent = 'Passphrase required or incorrect'; inp?.classList.add('error'); return false;
  }
  state.teamLocked = false; if (msg) msg.textContent = 'Verified ✓'; inp?.classList.remove('error'); if (inp && inp.value !== entered) inp.value = entered; setStoredPass(team, entered); return true;
}

function populateTeamSwitcher(){ const sel = $('#teamSwitcher'); if (!sel) return; const teams = state.teamsFromGh || []; const cur = getConfig().TEAM_NAME; sel.innerHTML = teams.map(t=> `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join(''); // choose existing if present, else first GH team
  let pick = teams.includes(cur) ? cur : (teams[0] || cur);
  sel.value = pick; if (pick !== cur){ localStorage.setItem(LS_KEYS.TEAM_NAME, pick); $('#teamNameDisplay').textContent = pick; }
}
function initTeamSwitcher(){ const inp = $('#teamPassInput'); const msg = $('#passMsg'); $('#teamSwitcher')?.addEventListener('change', ()=>{ const t = $('#teamSwitcher').value; localStorage.setItem(LS_KEYS.TEAM_NAME, t); $('#teamNameDisplay').textContent = t; const saved = getStoredPass(t); if (inp) inp.value = saved || ''; if (msg) msg.textContent = ''; clearSpeakerState(); refreshBoard(); }); if (inp){ inp.addEventListener('input', ()=>{ const t = getConfig().TEAM_NAME; setStoredPass(t, inp.value||''); const ok = verifyPassForSelectedTeam(); if (ok) refreshBoard(); }); } }

function initTeamCreate(){ const btn = $('#addTeamBtn'); const inp = $('#newTeamInput'); const pinp = $('#newTeamPassInput'); if (!btn || !inp) return; btn.addEventListener('click', async ()=>{ const t = (inp.value||'').trim(); const pass = (pinp?.value||'').trim(); if (!t) return; const cfg = getConfig(); const path = safeJoin(registryDir(cfg), `${t.replace(/[\\/]/g,'-')}.json`); const data = { team: t, passphrase: pass || '', created_at: nowIso(), created_by: (localStorage.getItem(LS_KEYS.NAME)||'facilitator') }; try { await writeFileOverwriteStrict(cfg, path, JSON.stringify(data, null, 2) + '\n', `Round Table: register team ${t}`); // refresh teams from GH only
      const dirItems = await listDirectory(cfg); await discoverTeamsFromGitHub(cfg, dirItems); localStorage.setItem(LS_KEYS.TEAM_NAME, t); setStoredPass(t, pass||''); $('#teamNameDisplay').textContent = t; $('#teamSwitcher').value = t; if ($('#teamPassInput')) $('#teamPassInput').value = pass || ''; if ($('#passMsg')) $('#passMsg').textContent = pass ? 'Verified ✓' : 'No pass needed'; inp.value=''; if (pinp) pinp.value=''; clearSpeakerState(); await refreshBoard(); } catch(e){ recordApiError(e); alert('Failed to create team. Check token permissions.'); } }); }

// ======= ADMIN BULK DELETE =======
function extractSessionsFromFiles(files, team){ const set = new Set(); for (const it of (files||[])){ const nm = (it.name||'').replace(/\.txt$/i,''); const parts = nm.split(' -- '); if (parts.length>=3 && parts[0].trim() === team) set.add(parts[2].trim()); } return [...set].sort(); }
function populateDeleteTeamSelect(){ const sel = $('#delTeamSelect'); if (!sel) return; const teams = state.teamsFromGh || []; sel.innerHTML = teams.map(t=> `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join(''); }
async function populateDeleteSessionSelect(){ const cfg = getConfig(); const files = await listDirectory(cfg); const sessions = extractSessionsFromFiles(files, cfg.TEAM_NAME); const sel = $('#delSessionSelect'); if (!sel) return; sel.innerHTML = sessions.map(s=> `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join(''); }

async function deleteBySession(session){ const cfg = getConfig(); if (!verifyPassForSelectedTeam()){ alert('Enter the correct passphrase for this team first.'); return; } if (!session){ alert('Pick a session to delete.'); return; } const ok = confirm(`Delete ALL files for session "${session}" in team "${cfg.TEAM_NAME}"? This cannot be undone.`); if (!ok) return; const files = await listDirectory(cfg); const targets = files.filter(it => (it.name||'').startsWith(cfg.TEAM_NAME + ' -- ') && (it.name||'').endsWith(` -- ${session}.txt`)); for (const it of targets){ try { const meta = await ghGetContentsMeta(cfg, it.path); if (meta?.sha) await deleteFile(cfg, it.path, meta.sha, `Round Table: delete session ${session} (${cfg.TEAM_NAME})`); } catch(e){ recordApiError(e); } } await refreshBoard(); await populateDeleteSessionSelect(); }

async function deleteByTeam(team){ const cfg = getConfig(); const reg = state.teamRegistry.get(team); // verify pass if available
  const stored = getStoredPass(team);
  if (reg && reg.passphrase && stored !== reg.passphrase){ alert(`Enter the passphrase for team "${team}" (switch to it in the header and provide the passphrase) before deleting.`); return; }
  const ok = confirm(`Delete ALL files for team "${team}" across ALL sessions? This cannot be undone.`); if (!ok) return; const files = await listDirectory(cfg); const targets = files.filter(it => (it.name||'').startsWith(team + ' -- ')); for (const it of targets){ try { const meta = await ghGetContentsMeta(cfg, it.path); if (meta?.sha) await deleteFile(cfg, it.path, meta.sha, `Round Table: delete team ${team}`); } catch(e){ recordApiError(e); }
  // remove registry json
  const regPath = safeJoin(registryDir(cfg), `${team.replace(/[\\/]/g,'-')}.json`); try { const meta = await ghGetContentsMeta(cfg, regPath); if (meta?.sha) await deleteFile(cfg, regPath, meta.sha, `Round Table: remove team registry ${team}`); } catch(e) { /* ignore */ }
  // refresh picker
  const dirItems = await listDirectory(cfg); await discoverTeamsFromGitHub(cfg, dirItems); if ($('#teamSwitcher').value !== cfg.TEAM_NAME) { /* noop */ } await refreshBoard(); await populateDeleteSessionSelect(); }

function hookAdminDelete(){ $('#deleteSessionBtn')?.addEventListener('click', ()=>{ const s = $('#delSessionSelect')?.value || ''; deleteBySession(s); }); $('#deleteTeamBtn')?.addEventListener('click', ()=>{ const t = $('#delTeamSelect')?.value || ''; if (!t) return; deleteByTeam(t); }); }

// ======= RENDERING =======
function moodClass(n){ if (n >= 8) return 'ok'; if (n <= 3) return 'bad'; return 'warn'; }
function formatMultiline(text){ const lines = String(text||"").split(/\r?\n/); return lines.map(line => `<div>${linkify(escapeHtml(line || '')) || '&nbsp;'}</div>`).join(''); }
function cardHtml(u){ const feel = Number(u.feeling)||0; const prod = Number(u.productivity)||0; const moodEmoji = feel>=9?'🤩':feel>=7?'😄':feel>=5?'🙂':feel>=3?'😐':'😞'; const s = state.speaker || loadSpeakerState(); const spokenSet = new Set((s.spoken||[])); const isSpeaking = s.speakingNow && s.speakingNow === u.name; const isSpoken = spokenSet.has(u.name); const badges = [ isSpeaking ? '<span class="tag live">Speaking now</span>' : '', isSpoken ? '<span class="tag spoken">Spoken</span>' : '' ].filter(Boolean).join(' '); const totals = state.reactionTotals.get(u.__base) || emptyReactions(); const mine = (state.myReactions.by_target || {})[u.__base] || {}; return `
    <div class="update-card" data-base="${escapeHtml(u.__base)}" data-name="${escapeHtml(u.name)}">
      <div class="update-head">
        <div class="who">${escapeHtml(u.name || 'Unknown')} ${badges ? badges : ''} <span class="muted">• ${escapeHtml(u.session||'')}</span></div>
        <div class="when">${escapeHtml(fmtLocal(u.updated_at || ''))}</div>
      </div>
      <div class="muted" style="margin-bottom:6px;">
        ${moodEmoji} Mood: <b class="${moodClass(feel)}">${feel || '-'}</b>
        &nbsp;•&nbsp;
        Productivity: <b class="${moodClass(prod)}">${prod || '-'}</b>
      </div>
      <div>${formatMultiline(u.update)}</div>
      <div class="reactions">
        <button class="react-btn ${mine['👍']?'active':''}" data-react="👍" type="button">👍 <span class="cnt" data-react-cnt> ${totals['👍']||0}</span></button>
        <button class="react-btn ${mine['✅']?'active':''}" data-react="✅" type="button">✅ <span class="cnt" data-react-cnt> ${totals['✅']||0}</span></button>
        <button class="react-btn ${mine['❤️']?'active':''}" data-react="❤️" type="button">❤️ <span class="cnt" data-react-cnt> ${totals['❤️']||0}</span></button>
      </div>
    </div>`; }

function renderTeamSnapshot(updates){ const avg = (arr)=> arr.length ? (arr.reduce((a,b)=>a+b,0) / arr.length) : 0; const feelings = updates.map(u=> Number(u.feeling)).filter(n=> !isNaN(n)); const prods = updates.map(u=> Number(u.productivity)).filter(n=> !isNaN(n)); const avgFeeling = feelings.length ? avg(feelings) : null; const avgProd = prods.length ? avg(prods) : null; $('#updatesCount').textContent = String(updates.length); setSemiGauge('Feeling', avgFeeling); setSemiGauge('Productivity', avgProd); updateSpeakerCounts(); }

function applySpokenFilter(list){ const f = state.sfilter || 'all'; if (f === 'all') return list; const s = state.speaker || loadSpeakerState(); const spoken = new Set((s.spoken||[])); if (f === 'ready') return list.filter(u=> !spoken.has(u.name)); if (f === 'spoken') return list.filter(u=> spoken.has(u.name)); return list; }
function matchFilter(u, [sessionNeedle, textNeedle]){ if (sessionNeedle){ const sn = sessionNeedle.toLowerCase(); if (!(u.session||'').toLowerCase().includes(sn)) return false; } if (!textNeedle) return true; const n = textNeedle.toLowerCase(); return ((u.name||'').toLowerCase().includes(n) || (u.team||'').toLowerCase().includes(n) || (u.update||'').toLowerCase().includes(n)); }
function renderUpdates(updates){ const grid = $('#updatesGrid'); if (!grid) return; const sessionVal = $('#sessionFilter').value.trim(); const filterVal = $('#filterInput').value.trim(); const filtered = applySpokenFilter(updates.filter(u=> matchFilter(u, [sessionVal, filterVal]))); const s = state.speaker || loadSpeakerState(); const hasSpeakerState = (s.speakingNow || (s.spoken||[]).length || (s.readyOrder||[]).length); const list = hasSpeakerState ? applySpeakerOrdering(filtered) : filtered.slice(); grid.innerHTML = list.map(cardHtml).join(''); }
function renderMyLast(u){ const el = $('#myLastCard'); if (!el) return; if (!u) { el.textContent = 'No submission yet.'; return; } el.innerHTML = cardHtml(u); }

// ======= SAVE / LOAD =======
async function saveMyUpdate(evt){ evt?.preventDefault?.(); const cfg = getConfig(); if (!CONFIG_DEFAULTS.GITHUB_TOKEN || CONFIG_DEFAULTS.GITHUB_TOKEN.includes('PASTE_GITHUB_TOKEN_HERE')){ setSaveStatus('Missing GitHub token in roundtable.js — please set CONFIG_DEFAULTS.GITHUB_TOKEN.', false); return; } const name = $('#nameInput').value.trim(); const session = ($('#sessionInput').value.trim() || defaultSession()); const feeling = Number($('#feelingInput').value); const productivity = Number($('#productivityInput').value); const updateText = $('#updateInput').value.trim(); if (!name){ setSaveStatus('Please enter your name before saving.', false); $('#nameInput').focus(); return; } localStorage.setItem(LS_KEYS.NAME, name); localStorage.setItem(LS_KEYS.SESSION, session); $('#sessionFilter').value = session; const payload = { team:getConfig().TEAM_NAME, name, session, feeling, productivity, update: updateText, timestamp: nowIso() }; const filePath = filePathFor(getConfig().TEAM_NAME, name, session, cfg); const content = buildContentVars(payload); const commitMessage = `Round Table: update for ${name} (${cfg.TEAM_NAME} — ${session})`; try { setLiveStatus({ label:'Saving…', color:'#6a8bff' }); setSaveStatus('Saving…'); await writeFileOverwriteStrict(cfg, filePath, content, commitMessage); setSaveStatus('Saved!'); setLiveStatus({ label:'Synced', color:'#2ecc71' }); await refreshBoard(); renderMyLast({ ...payload, updated_at: payload.timestamp }); } catch (e){ console.error(e); recordApiError(e); setSaveStatus(`Save failed: ${e.message}`, false); setLiveStatus({ label:'Error', color:'#e74c3c' }); } }

async function refreshBoard(){ if (state.isSyncing) return; const cfg = getConfig(); state.isSyncing = true; setLiveStatus({ label: state.backoffMs ? `Syncing (backoff ${Math.round(state.backoffMs/1000)}s)…` : 'Syncing…', color:'#6a8bff' }); $('#updatesGrid').setAttribute('aria-busy','true'); try { const list = await listDirectory(cfg); await discoverTeamsFromGitHub(cfg, list); const tOk = verifyPassForSelectedTeam(); if (!tOk){ state.currentUpdates = []; state.reactionTotals = new Map(); $('#updatesCount').textContent = '0'; setSemiGauge('Feeling', null); setSemiGauge('Productivity', null); $('#updatesGrid').innerHTML = `<div class="update-card">This team is passphrase‑protected. Enter the passphrase to view updates.</div>`; $('#lastRefresh').textContent = new Date().toLocaleTimeString(); setLiveStatus({ label:'Locked', color:'#e6b34b' }); state.backoffMs = 0; await populateDeleteSessionSelect(); return; } const teamNeedle = String(cfg.TEAM_NAME).toLowerCase(); const sessionNeedle = $('#sessionFilter').value.trim().toLowerCase(); const teamFiles = list.filter(it => (it.name||'').toLowerCase().startsWith(teamNeedle + ' -- ')); const sessionFiles = sessionNeedle ? teamFiles.filter(it => (it.name||'').toLowerCase().endsWith(` -- ${sessionNeedle}.txt`)) : teamFiles; const parsed = []; for (const it of sessionFiles){ const text = await readFileContent(cfg, it); const meta = parseContentVars(text); meta.__txtPath = it.path; meta.__base = (it.name||'').replace(/\.txt$/i,''); parsed.push(meta); } state.currentUpdates = parsed; state.reactionTotals = await aggregateReactions(parsed); const myBase = myBaseForCurrent(); const me = parsed.find(u => u.__base === myBase); state.myReactions = me?.reactions || { updated_at:null, by_target:{} }; renderTeamSnapshot(parsed); renderUpdates(parsed); $('#lastRefresh').textContent = new Date().toLocaleTimeString(); setLiveStatus({ label:'Updated', color:'#2ecc71' }); state.backoffMs = 0; await populateDeleteSessionSelect(); } catch (e){ console.error(e); recordApiError(e); setLiveStatus({ label:'Sync error', color:'#e74c3c' }); const msg = String(e.message||''); if (/^403\b|^429\b|rate limit/i.test(msg)) state.backoffMs = state.backoffMs ? Math.min(state.backoffMs*2, 60000) : 5000; } finally { state.isSyncing = false; $('#updatesGrid').setAttribute('aria-busy','false'); scheduleNextPoll(); } }

function scheduleNextPoll(){ const cfg = getConfig(); const base = Math.max(2000, Number(cfg.POLL_INTERVAL_MS)||10000); const wait = base + (state.backoffMs||0); if (state.nextPollTimeout) clearTimeout(state.nextPollTimeout); state.nextPollTimeout = setTimeout(refreshBoard, wait); }

// ======= CSV/JSON EXPORT =======
function buildCsv(rows){ const esc = (v)=> '"'+ String(v ?? "").replace(/"/g,'""') +'"'; const head = ["Team","Session","Name","Feeling","Productivity","UpdatedAt","Update"]; const body = rows.map(r=> [r.team, r.session, r.name, r.feeling, r.productivity, r.updated_at, r.update].map(esc).join(',')); return head.map(esc).join(',') + "\n" + body.join("\n"); }
function downloadBlob(filename, mime, text){ const blob = new Blob([text], { type:mime }); const url = URL.createObjectURL(blob); const a = $('#downloadAnchor') || Object.assign(document.createElement('a'), { style:'display:none' }); if (!a.parentNode) document.body.appendChild(a); a.href = url; a.download = filename; a.click(); setTimeout(()=> URL.revokeObjectURL(url), 1000); }
function exportCsvCurrentSession(){ const sessionVal = $('#sessionFilter').value.trim(); const rows = state.currentUpdates.filter(u => !sessionVal || (u.session||'').includes(sessionVal)); const csv = buildCsv(rows); const cfg = getConfig(); downloadBlob(`${cfg.TEAM_NAME}-${sessionVal||'all'}.csv`, 'text/csv', csv); }
function exportJsonCurrentSession(){ const sessionVal = $('#sessionFilter').value.trim(); const rows = state.currentUpdates.filter(u => !sessionVal || (u.session||'').includes(sessionVal)); const json = JSON.stringify(rows, null, 2); const cfg = getConfig(); downloadBlob(`${cfg.TEAM_NAME}-${sessionVal||'all'}.json`, 'application/json', json); }

// ======= DIAGNOSTICS =======
async function runDiagnostics(){ const cfg = getConfig(); const set = (sel, txt)=>{ const el=$(sel); if (el) el.textContent = txt; }; const setStatus = (t)=>{ const el=$('#diagStatus'); if (el) el.textContent = t; }; try { setStatus('Checking token…'); const resUser = await ghFetch('/user'); const scopes = resUser.headers.get('X-OAuth-Scopes') || resUser.headers.get('x-oauth-scopes') || '(fine-grained or hidden)'; set('#diagTokenScope', scopes || 'Unknown'); setStatus('Checking branch…'); const resBranch = await ghFetch(`/repos/${cfg.OWNER}/${cfg.REPO}/branches/${encodeURIComponent(cfg.BRANCH)}`); if (!resBranch.ok) throw new Error(`Branch check failed: ${resBranch.status}`); setStatus('Checking directory…'); const dir = cfg.DIR ? `/${encodeURIComponent(cfg.DIR).replace(/%2F/g,'/')}` : ''; const resDir = await ghFetch(`/repos/${cfg.OWNER}/${cfg.REPO}/contents${dir}?ref=${encodeURIComponent(cfg.BRANCH)}`); if (resDir.status === 404) set('#diagBranchDir', `Branch ${cfg.BRANCH} OK • Directory '${cfg.DIR || '/'}' not found (will be created on first save)`); else if (resDir.ok) set('#diagBranchDir', `Branch ${cfg.BRANCH} OK • Directory '${cfg.DIR || '/'}' OK`); else set('#diagBranchDir', `Directory check error: ${resDir.status}`); setStatus('Done'); } catch (e){ recordApiError(e); setStatus('Error — see Last API error'); } }

// ======= FACILITATOR TIMERS (with overtime flash) =======
let meetingTimerId = null, meetingEndAt = null, meetingRemainingMs = null;
let speakerTimerId = null, speakerEndAt = null, speakerRemainingMs = null;
function fmtMeeting(ms){ const totalS = Math.max(0, Math.round(ms/1000)); const m = Math.floor(totalS/60); const s = totalS % 60; return `${m}:${pad(s)}`; }
function fmtSpeaker(ms){ const totalS = Math.max(0, Math.round(ms/1000)); const m = Math.floor(totalS/60); const s = totalS % 60; return `${pad(m)}:${pad(s)}`; }
function meetingUpdate(){ const disp = $('#meetingDisplay'); if (!disp) return; const ms = Math.max(0, (meetingEndAt||0) - Date.now()); meetingRemainingMs = ms; disp.textContent = fmtMeeting(ms); if (ms <= 0){ clearInterval(meetingTimerId); meetingTimerId = null; } }
function speakerUpdate(){ const disp = $('#speakerDisplay'); if (!disp) return; const ms = Math.max(0, (speakerEndAt||0) - Date.now()); speakerRemainingMs = ms; disp.textContent = fmtSpeaker(ms); if (ms <= 0){ disp.classList.add('overtime'); clearInterval(speakerTimerId); speakerTimerId = null; } }
function meetingStart(){ const mins = Math.max(1, Number($('#meetingMinutesInput').value) || 45); const startMs = (meetingRemainingMs != null ? meetingRemainingMs : mins*60000); meetingEndAt = Date.now() + startMs; clearInterval(meetingTimerId); meetingTimerId = setInterval(meetingUpdate, 250); meetingUpdate(); }
function meetingStop(){ if (meetingTimerId){ clearInterval(meetingTimerId); meetingTimerId = null; } }
function meetingReset(){ meetingStop(); meetingRemainingMs = null; const mins = Math.max(1, Number($('#meetingMinutesInput').value) || 45); $('#meetingDisplay').textContent = fmtMeeting(mins*60000); }
function speakerStart(){ const disp = $('#speakerDisplay'); disp.classList.remove('overtime'); const mins = Math.max(0.1, Number($('#speakerMinutesInput').value) || 2); const startMs = (speakerRemainingMs != null ? speakerRemainingMs : mins*60000); speakerEndAt = Date.now() + startMs; clearInterval(speakerTimerId); speakerTimerId = setInterval(speakerUpdate, 250); speakerUpdate(); }
function speakerStop(){ if (speakerTimerId){ clearInterval(speakerTimerId); speakerTimerId = null; } }
function speakerClear(){ speakerStop(); const disp = $('#speakerDisplay'); disp.classList.remove('overtime'); speakerRemainingMs = null; const mins = Math.max(0.1, Number($('#speakerMinutesInput').value) || 2); disp.textContent = fmtSpeaker(mins*60000); }
function hookFacilitator(){ $('#meetingStart')?.addEventListener('click', meetingStart); $('#meetingStop')?.addEventListener('click', meetingStop); $('#meetingReset')?.addEventListener('click', meetingReset); $('#meetingMinutesInput')?.addEventListener('change', meetingReset); $('#speakerStart')?.addEventListener('click', speakerStart); $('#speakerStop')?.addEventListener('click', speakerStop); $('#speakerClear')?.addEventListener('click', speakerClear); $('#speakerMinutesInput')?.addEventListener('change', ()=>{ if (!speakerTimerId) speakerClear(); }); $('#nextSpeakerBtn')?.addEventListener('click', nextSpeaker); $('#speakerFinishedBtn')?.addEventListener('click', speakerFinished); $('#clearSpokenBtn')?.addEventListener('click', ()=>{ clearSpeakerState(); renderUpdates(state.currentUpdates); }); meetingReset(); speakerClear(); hookAdminDelete(); }

// ======= UI HOOKS =======
function applySettingsToUi(cfg){ $('#teamNameDisplay').textContent = cfg.TEAM_NAME || 'Team'; const savedName = localStorage.getItem(LS_KEYS.NAME); if (savedName) $('#nameInput').value = savedName; const today = todayYmd(); $('#sessionInput').value = today; $('#sessionFilter').value = today; const pass = getStoredPass(cfg.TEAM_NAME); if ($('#teamPassInput')) $('#teamPassInput').value = pass || ''; if ($('#passMsg')) $('#passMsg').textContent = ''; }
function hookInputs(){ const feel = $('#feelingInput'); const feelB = $('#feelingBubble'); feel?.addEventListener('input', ()=>{ feelB.textContent = feel.value; setBubbleHue(feelB, feel.value); }); feelB.textContent = feel?.value || '5'; setBubbleHue(feelB, feel?.value || 5); const prod = $('#productivityInput'); const prodB = $('#productivityBubble'); prod?.addEventListener('input', ()=>{ prodB.textContent = prod.value; setBubbleHue(prodB, prod.value); }); prodB.textContent = prod?.value || '5'; setBubbleHue(prodB, prod?.value || 5); document.querySelectorAll('.chip[data-feel]').forEach(chip=> chip.addEventListener('click', ()=>{ const v = chip.getAttribute('data-feel'); feel.value = v; feel.dispatchEvent(new Event('input')); document.querySelectorAll('.chip[data-feel]').forEach(c=>c.classList.remove('active')); chip.classList.add('active'); })); $('#updateForm')?.addEventListener('submit', saveMyUpdate); $('#manualRefreshBtn')?.addEventListener('click', refreshBoard); $('#clearBtn')?.addEventListener('click', ()=>{ $('#updateInput').value=''; }); $('#filterInput')?.addEventListener('input', ()=> renderUpdates(state.currentUpdates)); $('#sessionFilter')?.addEventListener('input', ()=> { state.speaker = loadSpeakerState(); updateSpeakerCounts(); renderUpdates(state.currentUpdates); }); $('#sortBySelect')?.addEventListener('change', ()=> renderUpdates(state.currentUpdates)); $('#exportCsvBtn')?.addEventListener('click', exportCsvCurrentSession); $('#exportJsonBtn')?.addEventListener('click', exportJsonCurrentSession); $('#runDiagnosticsBtn')?.addEventListener('click', runDiagnostics); const seg = $('#spokenSeg'); if (seg){ seg.addEventListener('click', (e)=>{ const btn = e.target.closest('.seg.spk'); if (!btn) return; seg.querySelectorAll('.seg').forEach(b=> b.classList.remove('active')); btn.classList.add('active'); state.sfilter = btn.getAttribute('data-sfilter') || 'all'; localStorage.setItem(LS_KEYS.SPOKEN_FILTER, state.sfilter); renderUpdates(state.currentUpdates); }); const savedF = localStorage.getItem(LS_KEYS.SPOKEN_FILTER) || 'all'; state.sfilter = savedF; seg.querySelectorAll('.seg').forEach(b=> b.classList.remove('active')); const activ = seg.querySelector(`.seg[data-sfilter="${savedF}"]`) || $('#spkAllBtn'); activ?.classList.add('active'); }
  // Reaction click (delegate)
  $('#updatesGrid')?.addEventListener('click', async (e)=>{ const btn = e.target.closest('.react-btn'); if (!btn) return; const card = e.target.closest('.update-card'); if (!card) return; const base = card.getAttribute('data-base'); const emoji = btn.getAttribute('data-react'); const cfg = getConfig(); const myMap = state.myReactions.by_target || (state.myReactions.by_target = {}); const cur = myMap[base] || {}; const had = !!cur[emoji]; cur[emoji] = !had; myMap[base] = cur; state.myReactions.updated_at = nowIso(); const totals = state.reactionTotals.get(base) || emptyReactions(); totals[emoji] = Math.max(0, (totals[emoji]||0) + (had ? -1 : +1)); state.reactionTotals.set(base, totals); const cntSpan = btn.querySelector('[data-react-cnt]'); if (cntSpan) cntSpan.textContent = ` ${totals[emoji]||0}`; btn.classList.toggle('active', !had); scheduleWriteMyReactions(); }); }

function setBubbleHue(el, val){ const v = Math.max(1, Math.min(10, Number(val)||5)); const t = (v-1)/9; const hue = Math.round(220 + (140-220)*t); el.style.background = `hsl(${hue} 70% 20% / .25)`; el.style.borderColor = `hsl(${hue} 70% 40% / .35)`; }

// ======= INIT =======
function startLiveSince(){ setInterval(updateLiveSinceTicker, 1000); updateLiveSinceTicker(); }
async function init(){ initTheme(); initMode(); applySettingsToUi(getConfig()); initTeamSwitcher(); initTeamCreate(); state.speaker = loadSpeakerState(); hookInputs(); hookFacilitator(); startLiveSince(); // Initial GH-only team population occurs inside refreshBoard() via discoverTeamsFromGitHub
  await refreshBoard(); }

document.addEventListener('DOMContentLoaded', init);
