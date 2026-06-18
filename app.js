// ── CONSTANTS
const HOURS       = ['09:00','10:00','11:00','12:00','13:00','14:00','15:00','16:00','17:00'];
const LUNCH_IDX   = 4;
const WEEKDAYS    = ['Dom','Lun','Mar','Mer','Gio','Ven','Sab'];
const MONTH_NAMES = ['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno','Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'];
const MONTH_SHORT = ['Gen','Feb','Mar','Apr','Mag','Giu','Lug','Ago','Set','Ott','Nov','Dic'];
const ADO_API_VERSION = '7.1-preview';
const PROJECT_PALETTE = [
  '#7c6cfa','#fa6c8e','#4caf7d','#faa94c','#4cc9fa',
  '#c94cfa','#fa4c8e','#4cfaa9','#fa8e4c','#8efad4',
];
const todayStr = new Date().toDateString();

// ── COLUMN RESIZE STATE (defined early so colWidth() is available for renderTable)
const COL_WIDTH_KEY = 'rendicontazione_col_widths';
let colWidths = {};
const COL_DEFAULT = 100, COL_MIN = 60;
(function() { try { const r = localStorage.getItem(COL_WIDTH_KEY); if (r) colWidths = JSON.parse(r); } catch(e) {} })();
function colWidth(d) { return colWidths[d] ?? COL_DEFAULT; }
function saveColWidths() { try { localStorage.setItem(COL_WIDTH_KEY, JSON.stringify(colWidths)); } catch(e) {} }

// ── HELPERS
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function hexToRgb(hex) {
  const r=parseInt(hex.slice(1,3),16), g=parseInt(hex.slice(3,5),16), b=parseInt(hex.slice(5,7),16);
  return {r,g,b};
}
function tagBg(color) { const {r,g,b}=hexToRgb(color); return `rgba(${r},${g},${b},0.13)`; }
function tagBd(color) { const {r,g,b}=hexToRgb(color); return `rgba(${r},${g},${b},0.4)`; }
function projectColor(name) {
  if (!name) return PROJECT_PALETTE[0];
  if (adoProjectColors[name]) return adoProjectColors[name];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return PROJECT_PALETTE[Math.abs(h) % PROJECT_PALETTE.length];
}
function showToast(msg, duration=2800) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), duration);
}
function fmtH(mins) { return `${Math.floor(mins/60)}h${mins%60?` ${mins%60}m`:''}`; }
function projectDisplayName(name) { return adoProjectAliases[name] || name; }

// ── ADO STATE & PERSISTENCE
const ADO_CONFIG_KEY = 'rendicontazione_ado_cfg';
const ADO_CACHE_KEY  = 'rendicontazione_ado_cache';
let adoConfig   = { orgUrl: '', pat: '' };
let adoProjects = [];
let adoPbis     = [];
let adoTasks    = {};
let adoLastSync = null;
let adoProjectColors  = {};
let adoProjectAliases = {};
let hiddenPbis = new Set(); // pbiTitle nascosti dalla coverage bar
const HIDDEN_PBIS_KEY = 'rendicontazione_hidden_pbis';
(function(){ try { const r=localStorage.getItem(HIDDEN_PBIS_KEY); if(r) hiddenPbis=new Set(JSON.parse(r)); } catch(e){} })();
function saveHiddenPbis() { try { localStorage.setItem(HIDDEN_PBIS_KEY, JSON.stringify([...hiddenPbis])); } catch(e){} }
function toggleHidePbi(pbiTitle) { if(hiddenPbis.has(pbiTitle)) hiddenPbis.delete(pbiTitle); else hiddenPbis.add(pbiTitle); saveHiddenPbis(); renderCoverageBar(); }
const _fetchingPbis = new Set();

function loadAdoConfig() {
  try {
    const raw = localStorage.getItem(ADO_CONFIG_KEY);
    if (raw) {
      const c = JSON.parse(raw);
      adoConfig = { orgUrl: c.orgUrl||'', pat: c.pat||'' };
      adoProjectColors  = c.projectColors  || {};
      adoProjectAliases = c.projectAliases || {};
    }
  } catch(e) {}
}
function persistAdoConfig() {
  localStorage.setItem(ADO_CONFIG_KEY, JSON.stringify({ ...adoConfig, projectColors: adoProjectColors, projectAliases: adoProjectAliases }));
}
function loadAdoCache() {
  try {
    const raw = localStorage.getItem(ADO_CACHE_KEY);
    if (!raw) return;
    const c = JSON.parse(raw);
    adoProjects = c.adoProjects || [];
    adoPbis     = c.adoPbis     || [];
    adoTasks    = c.adoTasks    || {};
    adoLastSync = c.adoLastSync || null;
  } catch(e) {}
}
function saveAdoCache() {
  localStorage.setItem(ADO_CACHE_KEY, JSON.stringify({ adoProjects, adoPbis, adoTasks, adoLastSync }));
}
function clearAdoCache() {
  adoProjects = []; adoPbis = []; adoTasks = {}; adoLastSync = null;
  localStorage.removeItem(ADO_CACHE_KEY);
  updateAdoCacheInfo();
  renderAdoProjectColors();
  showToast('Cache ADO svuotata');
}

// ── ADO API
function adoHeaders() {
  return { 'Authorization': `Basic ${btoa(':'+adoConfig.pat)}`, 'Content-Type': 'application/json' };
}
async function adoFetch(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { ...adoHeaders(), ...(opts.headers||{}) } });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { const j = await res.json(); msg = j.message || msg; } catch(e) {}
    throw new Error(msg);
  }
  return res.json();
}
async function adoFetchProjects() {
  const base = adoConfig.orgUrl.replace(/\/$/, '');
  const data = await adoFetch(`${base}/_apis/projects?api-version=${ADO_API_VERSION}&$top=200`);
  return (data.value || []).map(p => ({ id: p.id, name: p.name }));
}
async function adoFetchPbis() {
  const base = adoConfig.orgUrl.replace(/\/$/, '');
  const wiql = { query: `SELECT [System.Id],[System.Title],[System.TeamProject],[System.State] FROM WorkItems WHERE [System.WorkItemType] = 'Product Backlog Item' AND [System.AssignedTo] = @Me AND [System.State] <> 'Removed' ORDER BY [System.ChangedDate] DESC` };
  const result = await adoFetch(`${base}/_apis/wit/wiql?api-version=${ADO_API_VERSION}&$top=500`, { method: 'POST', body: JSON.stringify(wiql) });
  if (!result.workItems || !result.workItems.length) return [];
  const ids = result.workItems.map(w => w.id);
  const items = [];
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    const d = await adoFetch(`${base}/_apis/wit/workitems?ids=${batch.join(',')}&fields=System.Id,System.Title,System.TeamProject,System.State&api-version=${ADO_API_VERSION}`);
    items.push(...(d.value || []));
  }
  return items.map(w => ({ id: w.id, title: w.fields['System.Title'], projectName: w.fields['System.TeamProject'], state: w.fields['System.State'] }));
}
async function adoFetchTasksForPbi(pbiId) {
  const base = adoConfig.orgUrl.replace(/\/$/, '');
  const item = await adoFetch(`${base}/_apis/wit/workitems/${pbiId}?$expand=relations&api-version=${ADO_API_VERSION}`);
  const childIds = (item.relations || []).filter(r => r.rel === 'System.LinkTypes.Hierarchy-Forward').map(r => { const m = r.url.match(/\/(\d+)$/); return m ? +m[1] : null; }).filter(Boolean);
  if (!childIds.length) return [];
  const fields = 'System.Id,System.Title,System.WorkItemType,System.State,Microsoft.VSTS.Scheduling.OriginalEstimate,Microsoft.VSTS.Scheduling.RemainingWork,Microsoft.VSTS.Scheduling.CompletedWork';
  const d = await adoFetch(`${base}/_apis/wit/workitems?ids=${childIds.join(',')}&fields=${fields}&api-version=${ADO_API_VERSION}`);
  return (d.value || []).filter(w => w.fields['System.WorkItemType'] === 'Task').map(w => {
    const orig = w.fields['Microsoft.VSTS.Scheduling.OriginalEstimate'] ?? null;
    const remaining = w.fields['Microsoft.VSTS.Scheduling.RemainingWork'] ?? null;
    const completed = w.fields['Microsoft.VSTS.Scheduling.CompletedWork'] ?? null;
    const estimate = orig ?? (remaining !== null && completed !== null ? remaining + completed : null) ?? completed ?? remaining;
    return { id: w.id, title: w.fields['System.Title'], pbiId, state: w.fields['System.State'], estimate, remaining, completed };
  });
}
async function loadTasksForPbi(pbiId) {
  if (adoTasks[pbiId] !== undefined || _fetchingPbis.has(pbiId)) return;
  _fetchingPbis.add(pbiId);
  try { adoTasks[pbiId] = await adoFetchTasksForPbi(pbiId); saveAdoCache(); }
  catch(e) { throw e; }
  finally { _fetchingPbis.delete(pbiId); }
}

// ── ADO MODAL
function openAdoModal() {
  document.getElementById('adoOrgUrl').value = adoConfig.orgUrl;
  document.getElementById('adoPat').value    = adoConfig.pat;
  document.getElementById('adoStatus').textContent = '';
  updateAdoCacheInfo(); renderAdoProjectColors();
  document.getElementById('adoModal').classList.add('open');
}
function closeAdoModal() { document.getElementById('adoModal').classList.remove('open'); }
function updateAdoCacheInfo() {
  const el = document.getElementById('adoCacheInfo');
  if (!adoProjects.length && !adoPbis.length) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  const syncStr = adoLastSync ? new Date(adoLastSync).toLocaleString('it-IT') : '—';
  el.innerHTML = `Progetti: <b>${adoProjects.length}</b> &nbsp;|&nbsp; PBI assegnati: <b>${adoPbis.length}</b><br>Ultimo sync: ${syncStr}`;
}
function renderAdoProjectColors() {
  const el = document.getElementById('adoProjectColorList');
  if (!el) return;
  if (!adoProjects.length) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.innerHTML = `<div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Progetti — nome · colore</div>
    <div class="tag-list" style="max-height:220px;margin-bottom:0">
      ${adoProjects.map((p,i) => {
        const color = projectColor(p.name), alias = adoProjectAliases[p.name] || '';
        return `<div class="tag-row" data-pi="${i}">
          <button class="tag-name-label" data-action="edit-alias" data-pi="${i}" title="${esc(p.name)}">${esc(alias || p.name)}</button>
          <input class="tag-name-input-inline" type="text" maxlength="32" placeholder="${esc(p.name)}" data-action="alias" data-pi="${i}" value="${esc(alias)}">
          <div class="tag-color-swatch" style="background:${color}"><input type="color" value="${color}" data-pi="${i}"></div>
          <button class="tag-del-btn" title="Reset alias e colore" data-reset="${i}" style="font-size:10px">↺</button>
        </div>`;
      }).join('')}
    </div>`;
}
async function saveAndSyncAdo() {
  const orgUrl = document.getElementById('adoOrgUrl').value.trim();
  const pat    = document.getElementById('adoPat').value.trim();
  if (!orgUrl || !pat) { showToast('Inserisci URL e PAT'); return; }
  adoConfig = { orgUrl, pat };
  persistAdoConfig();
  await runAdoSync({ silent: false });
}

// ── SYNC
async function runAdoSync({ silent = false } = {}) {
  const ind = document.getElementById('saveIndicator');
  const status = document.getElementById('adoStatus');
  const btn = document.getElementById('adoSaveBtn');
  if (!silent && btn)  { btn.classList.add('btn-spinning'); btn.textContent = 'Sincronizzazione…'; }
  if (!silent && status) { status.style.color = 'var(--muted)'; status.textContent = '⟳ Recupero progetti…'; }
  if (ind) { ind.textContent = '⟳ Sync ADO…'; ind.style.opacity = '1'; }
  try {
    adoProjects = await adoFetchProjects();
    if (!silent && status) status.textContent = `⟳ ${adoProjects.length} progetti — recupero PBI assegnati…`;
    adoPbis = await adoFetchPbis();
    const validPbiIds = new Set(adoPbis.map(p => p.id));
    // Rimuovi task di PBI non più presenti, e invalida la cache di tutti gli altri
    // così al prossimo utilizzo vengono re-fetchati (task aggiunti/rimossi su ADO)
    Object.keys(adoTasks).forEach(id => { if (!validPbiIds.has(+id)) delete adoTasks[+id]; });
    adoTasks = {};  // reset completo: forza re-fetch task al primo utilizzo
    adoLastSync = Date.now();
    saveAdoCache();
    if (!silent && status) { status.style.color = 'var(--today-border)'; status.textContent = `✓ ${adoProjects.length} progetti · ${adoPbis.length} PBI sincronizzati`; }
    if (!silent) { updateAdoCacheInfo(); renderAdoProjectColors(); }
    render();
    if (ind) { ind.textContent = '✓ ADO sincronizzato'; ind.style.opacity = '1'; clearTimeout(ind._t); ind._t = setTimeout(() => ind.style.opacity = '0', 2500); }
  } catch(e) {
    console.warn('ADO sync failed:', e.message);
    if (!silent && status) { status.style.color = '#fa6c8e'; status.textContent = `✗ ${e.message}`; }
    if (ind) { ind.textContent = '⚠ ADO non raggiungibile'; ind.style.opacity = '1'; clearTimeout(ind._t); ind._t = setTimeout(() => ind.style.opacity = '0', 3500); }
  } finally {
    if (!silent && btn) { btn.classList.remove('btn-spinning'); btn.textContent = 'Salva & Sincronizza'; }
  }
}
async function autoSyncAdo() {
  if (!adoConfig.orgUrl || !adoConfig.pat) return;
  await runAdoSync({ silent: true });
  // Ri-scrolla a oggi dopo il re-render del sync
  requestAnimationFrame(() => {
    const th = document.querySelector('thead th.col-today');
    if (th) { const w = document.querySelector('.table-wrapper'); w.scrollLeft = th.offsetLeft - w.offsetWidth / 2 + th.offsetWidth / 2; }
  });
}

// ── ACTIVITY TYPES
const DEFAULT_TYPES = [
  { id: 'task',     label: 'Task',     color: '#7c6cfa' },
  { id: 'debug',    label: 'Debug',    color: '#fa6c8e' },
  { id: 'riunione', label: 'Riunione', color: '#4caf7d' },
];
let activityTypes = DEFAULT_TYPES.map(t => ({...t}));
function getTypeById(id) { return activityTypes.find(t => t.id === id) || { id, label: id, color: '#888' }; }

// ── SLOT NORMALISATION
function normaliseSlot(s) {
  if (!s) return null;
  const mins = [15,30,45,60].includes(s.mins) ? s.mins : 60;
  if (s.source === 'ado') return { source:'ado', projectName:s.projectName||'', pbiId:s.pbiId||null, pbiTitle:s.pbiTitle||'', taskId:s.taskId||null, taskTitle:s.taskTitle||'', desc:s.desc||'', mins };
  if (s.source === 'custom' || s.type) return { source:'custom', typeId: s.typeId||s.type||'task', desc:s.desc||'', mins };
  return null;
}
function normaliseCell(c) {
  if (!c) return [];
  if (!Array.isArray(c)) { const s = normaliseSlot(c); return s ? [s] : []; }
  return c.map(normaliseSlot).filter(Boolean);
}

// ── MONTHS STATE & PERSISTENCE
const STORAGE_KEY = 'rendicontazione_v1';
let months      = [];
let activeMonth = 0;
let selectedDay = null;
let popTarget=null, popSlots=[];
let dayPopTarget=null, dpType=null, dpAdoProject='', dpAdoPbiId=null, dpAdoPbiTitle='', dpAdoTaskId=null, dpAdoTaskTitle='', dpSource='custom';
let _taskCoverage=[];

function daysInMonth(y, m)  { return new Date(y, m+1, 0).getDate(); }
function makeMonthData(y, m) { return Array.from({length: daysInMonth(y,m)}, () => Array.from({length:9}, () => [])); }
function addMonthEntry(y, m) {
  if (months.find(x => x.year===y && x.month===m)) return false;
  months.push({year:y, month:m, data: makeMonthData(y,m)});
  months.sort((a,b) => a.year!==b.year ? a.year-b.year : a.month-b.month);
  return true;
}
function ensureCurrentAndNextMonth() {
  const now=new Date(), cy=now.getFullYear(), cm=now.getMonth();
  const ny=cm===11?cy+1:cy, nm=cm===11?0:cm+1;
  let added=false;
  if (addMonthEntry(cy,cm)) added=true;
  if (addMonthEntry(ny,nm)) added=true;
  return added;
}
function migrateData(entry) {
  const n = daysInMonth(entry.year, entry.month);
  const isOldFormat = Array.isArray(entry.data) && entry.data.length===2 && Array.isArray(entry.data[0]) && Array.isArray(entry.data[0][0]);
  let flat;
  if (isOldFormat) {
    flat = Array.from({length:n}, (_,idx) => { const half=Math.floor(idx/14), d=idx%14, src=entry.data[half]?.[d]; return Array.from({length:9}, (_,h) => normaliseCell(src?.[h])); });
  } else {
    flat = Array.from({length:n}, (_,idx) => { const src = entry.data[idx]; return Array.from({length:9}, (_,h) => normaliseCell(src?.[h])); });
  }
  entry.data = flat;
}
function saveState() {
  try {
    const added = ensureCurrentAndNextMonth();
    if (added) renderTabs();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ months, activeMonth, activityTypes }));
    const ind = document.getElementById('saveIndicator');
    if (ind) { ind.textContent = '✓ salvato'; ind.style.opacity='1'; clearTimeout(ind._t); ind._t = setTimeout(() => ind.style.opacity='0', 1800); }
  } catch(e) { console.warn('localStorage error', e); }
}
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const s = JSON.parse(raw);
    if (!s.months || !s.months.length) return false;
    months = s.months;
    months.forEach(migrateData);
    activeMonth = s.activeMonth ?? 0;
    if (s.activityTypes?.length) activityTypes = s.activityTypes;
    return true;
  } catch(e) { return false; }
}

// ── HOLIDAY HELPERS
function easterDate(year) {
  const a=year%19, b=Math.floor(year/100), c=year%100, d=Math.floor(b/4), e=b%4, f=Math.floor((b+8)/25);
  const g=Math.floor((b-f+1)/3), h=(19*a+b-d-g+15)%30, i=Math.floor(c/4), k=c%4, l=(32+2*e+2*i-h-k)%7;
  const m=Math.floor((a+11*h+22*l)/451);
  return new Date(year, Math.floor((h+l-7*m+114)/31)-1, ((h+l-7*m+114)%31)+1);
}
function getItalianHolidays(year) {
  const ea=easterDate(year), addD=(d,n)=>new Date(d.getFullYear(),d.getMonth(),d.getDate()+n);
  const key=d=>`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const fixed=[[0,1,"Capodanno"],[0,6,"Epifania"],[3,25,"Liberazione"],[4,1,"Festa del Lavoro"],[5,2,"Repubblica"],[7,15,"Ferragosto"],[10,1,"Ognissanti"],[11,8,"Immacolata"],[11,25,"Natale"],[11,26,"S. Stefano"]];
  const map={};
  fixed.forEach(([mo,da,name])=>{ map[key(new Date(year,mo,da))]=name; });
  map[key(ea)]='Pasqua'; map[key(addD(ea,1))]='Lunedì Angelo';
  return map;
}
const holidayCache={};
function getHolidayName(date) {
  const y=date.getFullYear();
  if (!holidayCache[y]) holidayCache[y]=getItalianHolidays(y);
  return holidayCache[y][`${y}-${date.getMonth()}-${date.getDate()}`]||null;
}
function isWE(d)  { const dw=d.getDay(); return dw===0||dw===6; }
function isTod(d) { return d.toDateString()===todayStr; }
function getDate(mi,idx) { const m=months[mi]; return new Date(m.year,m.month,idx+1); }

// ── INIT
(function(){
  loadAdoConfig();
  loadAdoCache();
  const loaded = loadState();
  if (!loaded) addMonthEntry(2026, 3);
  ensureCurrentAndNextMonth();
  const now=new Date(), ci=months.findIndex(m=>m.year===now.getFullYear()&&m.month===now.getMonth());
  if (ci!==-1) activeMonth=ci;
  render();
  if (loaded) showToast('✓ Dati ripristinati');
  autoSyncAdo();
})();

// ── RENDER PIPELINE
function render() {
  renderTabs(); renderTable(); updateStats(); renderLegend(); reapplyDaySelection();
  const m=months[activeMonth];
  document.getElementById('headerSub').textContent=`${MONTH_NAMES[m.month]} ${m.year} — Attività giornaliera`;
}
function renderLegend() {
  const customHtml = activityTypes.map(t => `<span class="legend-item"><span class="ldot" style="background:${t.color}"></span> ${esc(t.label)}</span>`).join('');
  const adoHtml = adoProjects.slice(0,6).map(p => `<span class="legend-item"><span class="ldot" style="background:${projectColor(p.name)}"></span> ${esc(projectDisplayName(p.name))}</span>`).join('');
  document.getElementById('legendTags').innerHTML = customHtml + (adoHtml ? ' '+adoHtml : '');
}
function renderTabs() {
  document.getElementById('monthTabs').innerHTML = months.map((m,i) => `
    <button class="month-tab ${i===activeMonth?'active':''}" onclick="switchMonth(${i})">
      ${MONTH_SHORT[m.month]} ${m.year}
      ${months.length>1?`<span class="rm-month" onclick="event.stopPropagation();removeMonth(${i})">✕</span>`:''}
    </button>`).join('');
}
function switchMonth(i) { selectedDay=null; activeMonth=i; render(); saveState(); }
function removeMonth(i) {
  if (months.length===1) return showToast('Almeno un mese richiesto');
  if (!confirm(`Rimuovere ${MONTH_NAMES[months[i].month]} ${months[i].year}?`)) return;
  months.splice(i,1); activeMonth=Math.min(activeMonth,months.length-1);
  render(); saveState();
}

// ── TABLE RENDER
function renderTable() {
  const m=months[activeMonth], nDays=m.data.length;
  let html='<div class="table-wrapper"><table><thead><tr><th>Ora</th>';
  for (let d=0;d<nDays;d++) {
    const dt=getDate(activeMonth,d), we=isWE(dt), tod=isTod(dt), holiday=getHolidayName(dt), isSun=dt.getDay()===0;
    let cls=holiday?'col-holiday':we?'col-we':tod?'col-today':'';
    if (isSun) cls+=' col-week-end';
    const clickable=!holiday&&!we;
    if (clickable) cls+=' col-clickable';
    html+=`<th class="${cls.trim()}" data-col="${d}" ${clickable?`onclick="selectDay(${d})"`:''}  style="width:${colWidth(d)}px">
      <span class="day-label">${dt.getDate()} ${MONTH_SHORT[dt.getMonth()]}</span>
      <span class="weekday-label">${holiday?'🎉 '+holiday:WEEKDAYS[dt.getDay()]}</span>
      <span class="col-resize-handle"></span>
    </th>`;
  }
  html+='</tr></thead><tbody>';
  for (let h=0;h<9;h++) {
    const lunch=(h===LUNCH_IDX);
    html+=`<tr><td>${HOURS[h]}${lunch?' <span style="font-size:8px;opacity:.6">🍽</span>':''}</td>`;
    for (let d=0;d<nDays;d++) {
      const dt=getDate(activeMonth,d), we=isWE(dt), tod=isTod(dt), holiday=getHolidayName(dt), isSun=dt.getDay()===0;
      let tdCls=holiday?'col-holiday':we?'col-we':tod?'col-today':'';
      if (isSun) tdCls+=' col-week-end';
      tdCls=tdCls.trim();
      if (holiday) {
        if (h===0) html+=`<td class="${tdCls}" rowspan="9"><div class="cell-holiday" style="min-height:${9*50}px"><span>🎉</span><span class="holiday-name">${holiday}</span></div></td>`;
      } else if (lunch) {
        html+=`<td class="${tdCls}"><div class="cell-lunch">Pausa pranzo</div></td>`;
      } else {
        const slots=months[activeMonth].data[d][h];
        html+=`<td class="${tdCls}" data-d="${d}" data-h="${h}" style="width:${colWidth(d)}px">${renderCellInner(slots,activeMonth,d,h)}</td>`;
      }
    }
    html+='</tr>';
  }
  html+='</tbody></table></div>';
  document.getElementById('tableArea').innerHTML=html;
}

// ── CELL RENDERING
function slotColor(s) {
  if (s.source==='ado') return projectColor(s.projectName||'');
  return getTypeById(s.typeId).color;
}
function renderCellInner(slots, mi, d, h) {
  if (!slots || !slots.length)
    return `<div class="cell-empty" onclick="openPop(event,${mi},${d},${h})"></div>`;
  const bars = slots.map(s => {
    const color = slotColor(s), pct = Math.round(s.mins / 60 * 100);
    if (s.source === 'ado') {
      const projColor = color;
      const projName  = s.projectName ? projectDisplayName(s.projectName) : 'ADO';
      const taskLabel = s.taskTitle || s.pbiTitle || projName;
      const subLabel  = s.taskTitle && s.pbiTitle ? s.pbiTitle : (s.taskTitle ? projName : null);
      const minsLabel = s.mins < 60 ? `${s.mins}m` : '';
      return `<div class="slot-bar slot-bar-ado" style="height:${pct}%;background:${tagBg(projColor)};border-left:3px solid ${projColor}">
        <div class="slot-bar-inner">
          <span class="slot-task-title" style="color:${projColor}">${esc(taskLabel)}</span>
          <span class="slot-task-sub">${subLabel ? esc(subLabel) + (minsLabel ? ' · ' + minsLabel : '') : (minsLabel || esc(projName))}</span>
        </div>
        ${s.desc ? `<span class="slot-desc">${esc(s.desc)}</span>` : ''}
      </div>`;
    } else {
      const tag = getTypeById(s.typeId);
      return `<div class="slot-bar" style="height:${pct}%;background:${tagBg(color)};border-left:3px solid ${color}">
        <span class="slot-badge" style="color:${color}">${s.mins < 60 ? s.mins + 'm ' : ''}${esc(tag.label)}</span>
        ${s.desc ? `<span class="slot-desc">${esc(s.desc)}</span>` : ''}
      </div>`;
    }
  }).join('');
  return `<div class="cell-slots" onclick="openPop(event,${mi},${d},${h})">${bars}</div>`;
}
function updateCellDOM(mi, d, h) {
  const td=document.querySelector(`td[data-d="${d}"][data-h="${h}"]`);
  if (!td) return;
  td.innerHTML=renderCellInner(months[mi].data[d][h],mi,d,h);
}

// ── STATS
function updateStats() {
  const m=months[activeMonth];
  let workMins=0, fattMins=0, scrumMins=0, ferieMins=0;
  const ferieIds=new Set(activityTypes.filter(t=>/ferie/i.test(t.label)).map(t=>t.id));
  const loggedByTask = new Map();
  const missingPbis=new Set();
  m.data.forEach((dayHours,d) => {
    const dt=getDate(activeMonth,d);
    if (isWE(dt)||getHolidayName(dt)) return;
    dayHours.forEach((slots,h) => {
      if (h===LUNCH_IDX) return;
      workMins+=60;
      (slots||[]).forEach(s => {
        fattMins+=s.mins;
        if (s.source==='ado') {
          if (s.taskId) { scrumMins+=s.mins; loggedByTask.set(s.taskId, (loggedByTask.get(s.taskId)||0) + s.mins); }
          if (s.pbiId && adoTasks[s.pbiId]===undefined) missingPbis.add(s.pbiId);
        }
        if (s.source==='custom' && ferieIds.has(s.typeId)) ferieMins+=s.mins;
      });
    });
  });
  if (missingPbis.size && adoConfig?.orgUrl && adoConfig?.pat) {
    Promise.all([...missingPbis].map(id=>loadTasksForPbi(id).catch(()=>{}))).then(()=>updateStats());
  }
  // Costruisce coverage da TUTTI i task in cache, non solo quelli loggati
  const coverageMap = new Map();
  Object.entries(adoTasks).forEach(([pbiIdStr, tasks]) => {
    const pbiId = +pbiIdStr;
    const pbi   = adoPbis.find(p => p.id === pbiId);
    if (!pbi || !Array.isArray(tasks)) return;
    tasks.forEach(t => {
      if (t.state === 'Removed') return;
      const orig      = t.estimate  !== null ? Math.round(t.estimate  * 60) : null;
      const completed = t.completed !== null ? Math.round((t.completed||0) * 60) : null;
      const remaining = t.remaining !== null ? Math.round((t.remaining||0) * 60) : null;
      coverageMap.set(t.id, {
        taskId: t.id, title: t.title, pbiTitle: pbi.title,
        project: projectDisplayName(pbi.projectName||''), projectName: pbi.projectName||'',
        state: t.state, adoEstimate: orig, adoCompleted: completed, adoRemaining: remaining,
        logged: loggedByTask.get(t.id) || 0,
      });
    });
  });
  _taskCoverage = [...coverageMap.values()];
  const withEst = _taskCoverage.filter(t => t.adoEstimate !== null && t.adoEstimate > 0);
  const ok2     = withEst.filter(t => t.logged > 0 && t.logged >= t.adoEstimate).length;
  const missing = withEst.filter(t => t.logged === 0).length;
  const over    = withEst.filter(t => t.logged > t.adoEstimate).length;
  const total   = withEst.length;
  const allOk   = total > 0 && missing === 0 && over === 0;
  const badgeColor = total===0?'var(--muted)': allOk?'var(--today-border)': missing>0?'#fa6c8e':'#faa94c';
  const badgeLabel = total===0 ? '--' : `${ok2}/${total}`;
  const pct=workMins?Math.round(fattMins/workMins*100):0;
  document.getElementById('statsBar').innerHTML=`
    <div class="stat"><div class="stat-value">${fmtH(fattMins)}</div><div class="stat-label">Fatturazione</div></div>
    <div class="stat"><div class="stat-value" style="color:var(--accent)">${fmtH(scrumMins)}</div><div class="stat-label">Scrum</div></div>
    <div class="stat"><div class="stat-value" style="color:#faa94c">${fmtH(ferieMins)}</div><div class="stat-label">Ferie</div></div>
    <div class="stat"><div class="stat-value">${pct}%</div><div class="stat-label">Completamento</div></div>
    ${total>0?`<div class="stat stat-clickable" onclick="toggleCoverageBar()"><div class="stat-value" style="color:${badgeColor}">${badgeLabel}</div><div class="stat-label">Task ADO</div></div>`:''}`;
  renderCoverageBar();
}
function toggleCoverageBar() {
  const bar=document.getElementById('coverageBar');
  if (!bar) return;
  bar.classList.toggle('open');
  renderCoverageBar();
}
function renderCoverageBar() {
  const bar=document.getElementById('coverageBar');
  if (!bar||!bar.classList.contains('open')) return;
  if (!_taskCoverage.length) { bar.innerHTML='<div class="coverage-header"><span>Task ADO</span><button class="btn btn-secondary btn-sm" onclick="toggleCoverageBar()">X</button></div><span style="font-size:12px;color:var(--muted)">Nessun task in cache - apri una cella con un PBI per caricarli</span>'; return; }
  const byPbi = new Map();
  _taskCoverage.forEach(t => {
    if (!byPbi.has(t.pbiTitle)) byPbi.set(t.pbiTitle, { project: t.project, projectName: t.projectName, tasks: [] });
    byPbi.get(t.pbiTitle).tasks.push(t);
  });
  const visibleEntries = [...byPbi.entries()].filter(([pbiTitle]) => !hiddenPbis.has(pbiTitle));
  const hiddenEntries  = [...byPbi.entries()].filter(([pbiTitle]) => hiddenPbis.has(pbiTitle));
  const rows = visibleEntries.map(([pbiTitle, group]) => {
    const color = projectColor(group.projectName);
    const taskRows = group.tasks.map(t => {
      const hasEst    = t.adoEstimate !== null && t.adoEstimate > 0;
      const isOk      = hasEst && t.logged > 0 && t.logged >= t.adoEstimate;
      const isOver    = hasEst && t.logged > t.adoEstimate;
      const notLogged = t.logged === 0;
      const diff      = hasEst ? t.adoEstimate - t.logged : null;
      let statusIcon, statusColor;
      if (!hasEst)        { statusIcon='--';                   statusColor='var(--muted)'; }
      else if (isOver)    { statusIcon='+'+fmtH(-diff);        statusColor='#fa6c8e'; }
      else if (isOk)      { statusIcon='OK';                   statusColor='var(--today-border)'; }
      else if (notLogged) { statusIcon='! non loggato';        statusColor='#fa6c8e'; }
      else                { statusIcon='-'+fmtH(diff);         statusColor='#faa94c'; }
      const stateColor = t.state==='Done'?'#4caf7d':t.state==='In Progress'?'#faa94c':'var(--muted)';
      return `<div class="coverage-row">
        <div class="coverage-task">
          <span class="coverage-task-state" style="color:${stateColor}">${esc(t.state||'')}</span>
          ${esc(t.title)}
        </div>
        <div class="coverage-nums">
          <span class="coverage-logged" style="color:${t.logged>0?'var(--text)':'var(--muted)'}">${t.logged>0?fmtH(t.logged):'--'}</span>
          <span class="coverage-sep">/</span>
          <span class="coverage-expected">${hasEst?fmtH(t.adoEstimate):'?'}</span>
          <span class="coverage-status" style="color:${statusColor}">${statusIcon}</span>
        </div>
      </div>`;
    }).join('');
    return `<div class="coverage-pbi-group">
      <div class="coverage-pbi-header" style="border-left:3px solid ${color};padding-left:8px;margin-bottom:4px">
        <span class="coverage-pbi-proj" style="color:${color};font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;font-family:'DM Mono',monospace">${esc(group.project)}</span>
        <span class="coverage-pbi-title" style="display:block;font-size:11px;font-weight:600;color:var(--text)">${esc(pbiTitle)}</span>
        <button onclick="toggleHidePbi('${esc(pbiTitle).replace(/'/g,'\\\'')}')" style="margin-left:auto;padding:2px 7px;border-radius:4px;border:1px solid var(--border);background:transparent;color:var(--muted);font-size:10px;cursor:pointer" title="Nascondi PBI">Nascondi</button>
      </div>
      ${taskRows}
    </div>`;
  }).join('');
  const hiddenSection = hiddenEntries.length ? `
    <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
      <span style="font-size:10px;color:var(--muted);font-family:'DM Mono',monospace">PBI nascosti (${hiddenEntries.length})</span>
      ${hiddenEntries.map(([pbiTitle, group]) => {
        const color = projectColor(group.projectName);
        return `<div style="display:flex;align-items:center;gap:8px;padding:5px 8px;margin-top:4px;border-radius:6px;background:var(--surface2);border:1px solid var(--border);opacity:.6">
          <span style="width:6px;height:6px;border-radius:50%;background:${color};flex-shrink:0"></span>
          <span style="flex:1;font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(pbiTitle)}</span>
          <button onclick="toggleHidePbi('${esc(pbiTitle).replace(/'/g,'\\\'')}')" style="padding:2px 7px;border-radius:4px;border:1px solid var(--border);background:transparent;color:var(--accent);font-size:10px;cursor:pointer">Mostra</button>
        </div>`;
      }).join('')}
    </div>` : '';
  bar.innerHTML=`<div class="coverage-header"><span>Task ADO</span><button class="btn btn-secondary btn-sm" onclick="toggleCoverageBar()">X</button></div>${rows}${hiddenSection}`;
}

// ── DAY SELECTION
function selectDay(d) {
  selectedDay=(selectedDay===d)?null:d;
  document.querySelectorAll('.col-day-selected').forEach(el=>el.classList.remove('col-day-selected'));
  if (selectedDay!==null) {
    const ths=document.querySelectorAll('thead th');
    if (ths[selectedDay+1]) ths[selectedDay+1].classList.add('col-day-selected');
    document.querySelectorAll(`td[data-d="${selectedDay}"]`).forEach(el=>el.classList.add('col-day-selected'));
  }
  renderDayStats();
}
function renderDayStats() {
  const bar=document.getElementById('dayStatsBar');
  if (!bar) return;
  if (selectedDay===null||!months[activeMonth]) { bar.style.display='none'; return; }
  const m=months[activeMonth];
  if (selectedDay>=m.data.length) { bar.style.display='none'; return; }
  const dt=getDate(activeMonth,selectedDay);
  const byProject={}, byType={};
  m.data[selectedDay].forEach((slots,h)=>{
    if (h===LUNCH_IDX) return;
    (slots||[]).forEach(s=>{
      if (s.source==='ado') {
        const k=s.projectName||'ADO';
        if (!byProject[k]) byProject[k]={fatt:0,scrum:0};
        byProject[k].fatt+=s.mins;
        if (s.taskId) byProject[k].scrum+=s.mins;
      } else {
        if (!byType[s.typeId]) byType[s.typeId]=0;
        byType[s.typeId]+=s.mins;
      }
    });
  });
  const projEntries=Object.entries(byProject), typeEntries=Object.entries(byType);
  const dayStr=`${WEEKDAYS[dt.getDay()]} ${dt.getDate()} ${MONTH_SHORT[dt.getMonth()]}`;
  const statBlock=(color,value,label)=>`<div class="stat"><div class="stat-value" style="color:${color}">${value}</div><div class="stat-label">${label}</div></div>`;
  const fattBlocks=[
    ...projEntries.map(([name,v])=>statBlock(projectColor(name),fmtH(v.fatt),esc(projectDisplayName(name).slice(0,14)))),
    ...typeEntries.map(([id,v])=>{const t=getTypeById(id);return statBlock(t.color,fmtH(v),esc(t.label));})
  ].join('');
  const scrumBlocks=projEntries.filter(([,v])=>v.scrum>0).map(([name,v])=>statBlock('var(--accent)',fmtH(v.scrum),esc(projectDisplayName(name).slice(0,14)))).join('');
  const rowLabel=(txt)=>`<span class="day-stats-row-label">${txt}</span>`;
  const bodyHtml= projEntries.length||typeEntries.length ? `
    <div class="day-stats-row">${rowLabel('Fatturazione')}${fattBlocks}</div>
    <div class="day-stats-row">${rowLabel('Scrum')}${scrumBlocks||'<span style="color:var(--muted);font-size:12px">—</span>'}</div>`
    : '<span style="font-size:12px;color:var(--muted);font-family:\'DM Mono\',monospace">Nessun dato</span>';
  bar.style.display='flex';
  bar.innerHTML=`
    <div class="day-stats-header">
      <div class="day-stats-label">${dayStr}</div><div style="flex:1"></div>
      <button class="btn btn-secondary btn-sm" onclick="openDayPop(event,${activeMonth},${selectedDay})">☀ Riempi giorno</button>
      <button class="btn btn-secondary btn-sm" onclick="selectDay(${selectedDay})">✕</button>
    </div>
    <div class="day-stats-body">${bodyHtml}</div>`;
}
function reapplyDaySelection() {
  const bar=document.getElementById('dayStatsBar');
  if (!bar) return;
  if (selectedDay===null) { bar.style.display='none'; return; }
  const ths=document.querySelectorAll('thead th');
  if (ths[selectedDay+1]) ths[selectedDay+1].classList.add('col-day-selected');
  document.querySelectorAll(`td[data-d="${selectedDay}"]`).forEach(el=>el.classList.add('col-day-selected'));
  renderDayStats();
}

// ── EDIT POPOVER
function openPop(e, mi, d, h) {
  e.stopPropagation();
  popTarget={mi,d,h};
  const existing = months[mi].data[d][h]||[];
  if (existing.length) {
    popSlots = existing.map(s=>({...s}));
  } else {
    const prev = findPrevSlots(mi, d, h);
    popSlots = prev ? prev.map(s=>({...s})) : [defaultSlot()];
  }
  renderPopoverSlots();
  const pop=document.getElementById('editPopover');
  pop.classList.add('open');
  pop.style.top=(window.scrollY+16)+'px';
  pop.style.left=Math.round((window.innerWidth-300)/2)+'px';
}
function findPrevSlots(mi, d, h) {
  const data = months[mi].data[d];
  for (let i = h - 1; i >= 0; i--) {
    if (i === LUNCH_IDX) continue;
    const slots = data[i];
    if (slots && slots.length) return slots;
  }
  return null;
}
function defaultSlot() {
  if (adoProjects.length && adoPbis.length) return {source:'ado',projectName:'',pbiId:null,pbiTitle:'',taskId:null,taskTitle:'',desc:'',mins:60};
  return {source:'custom',typeId:activityTypes[0]?.id||'task',desc:'',mins:60};
}
function renderPopoverSlots() {
  const usedMins=popSlots.reduce((s,x)=>s+x.mins,0), remaining=60-usedMins;
  let html=`<div class="slot-editor" id="slotEditor">`;
  popSlots.forEach((s,i) => { html+=renderSlotRow(s,i); });
  html+=`</div>`;
  if (remaining>0) html+=`<button class="ep-add-slot-btn" id="addSlotBtn">＋ Aggiungi slot (${remaining} min rimasti)</button>`;
  document.getElementById('epTypes').innerHTML=html;
  popSlots.forEach((s,i)=>{ const inp=document.querySelector(`#slotEditor .slot-desc-input[data-si="${i}"]`); if (inp) inp.value=s.desc||''; });
}
function renderSlotRow(s, i) {
  const isAdo=s.source==='ado';
  const color=slotColor(s);
  const minsHtml=[15,30,45,60].map(m=>{
    const active=s.mins===m;
    const st=active?`background:${tagBg(color)};color:${color};border-color:${color}`:'';
    return `<button class="slot-mins-btn${active?' active':''}" data-si="${i}" data-mins="${m}" style="${st}">${m}'</button>`;
  }).join('');
  const pbisForProject=isAdo&&s.projectName?adoPbis.filter(p=>p.projectName===s.projectName):[];
  const tasksForPbi=isAdo&&s.pbiId!==null?(adoTasks[s.pbiId]||[]):[];
  const tasksLoading=isAdo&&s.pbiId!==null&&adoTasks[s.pbiId]===undefined;

  // Card informativa task ADO (visibile solo se task selezionato e dati in cache)
  let adoTaskCard = '';
  if (isAdo && s.taskId && s.pbiId !== null) {
    const td = (adoTasks[s.pbiId]||[]).find(t => t.id === s.taskId);
    if (td) {
      const orig      = td.estimate  !== null ? Math.round(td.estimate  * 60) : null;
      const completed = td.completed !== null ? Math.round((td.completed||0) * 60) : null;
      const remaining = td.remaining !== null ? Math.round((td.remaining||0) * 60) : null;
      const pct       = orig && orig > 0 ? Math.min(100, Math.round((completed||0) / orig * 100)) : null;
      const stateColor = td.state === 'Done' ? '#4caf7d' : td.state === 'In Progress' ? '#faa94c' : 'var(--muted)';
      adoTaskCard = `<div class="slot-ado-card" style="border-left-color:${color};background:${tagBg(color)}">
        <div class="slot-ado-card-header">
          <span class="slot-ado-card-proj" style="color:${color}">${esc(projectDisplayName(s.projectName||''))}</span>
          <span class="slot-ado-card-state" style="color:${stateColor}">${esc(td.state||'')}</span>
        </div>
        <div class="slot-ado-card-title">${esc(s.pbiTitle||'')} <span style="opacity:.5">›</span> ${esc(s.taskTitle||'')}</div>
        <div class="slot-ado-card-hours">
          ${orig      !== null ? `<span class="slot-ado-hour-chip">📋 Stima <b>${fmtH(orig)}</b></span>` : ''}
          ${completed !== null ? `<span class="slot-ado-hour-chip">✓ Completato <b>${fmtH(completed)}</b></span>` : ''}
          ${remaining !== null ? `<span class="slot-ado-hour-chip" style="color:${remaining>0?'#faa94c':'#4caf7d'}">⏳ Rimanente <b>${fmtH(remaining)}</b></span>` : ''}
        </div>
        ${pct !== null ? `<div class="slot-ado-progress-wrap"><div class="slot-ado-progress-bar" style="width:${pct}%;background:${color}"></div></div>` : ''}
      </div>`;
    }
  }

  const adoHtml=`<div class="slot-ado-fields"${isAdo?'':' style="display:none"'}>
    <select class="slot-ado-project ado-select" data-si="${i}" style="${isAdo&&s.projectName?`border-color:${color}`:''}">
      <option value="">— Progetto —</option>
      ${adoProjects.map(p=>`<option value="${esc(p.name)}"${s.projectName===p.name?' selected':''}>${esc(projectDisplayName(p.name))}</option>`).join('')}
    </select>
    <select class="slot-ado-pbi ado-select" data-si="${i}"${!s.projectName?' disabled':''}>
      <option value="">— PBI —</option>
      ${pbisForProject.map(p=>`<option value="${p.id}" data-title="${esc(p.title)}"${s.pbiId===p.id?' selected':''}>${esc(p.title)}</option>`).join('')}
    </select>
    <select class="slot-ado-task ado-select" data-si="${i}"${!s.pbiId?' disabled':''}>
      <option value="">— Task (opzionale) —</option>
      ${tasksForPbi.map(t=>`<option value="${t.id}" data-title="${esc(t.title)}"${s.taskId===t.id?' selected':''}>${esc(t.title)}</option>`).join('')}
    </select>
    ${tasksLoading?'<div class="slot-ado-loading">⟳ Caricamento task…</div>':''}
    ${adoTaskCard}
  </div>`;
  const customHtml=`<div class="slot-custom-fields"${!isAdo?'':' style="display:none"'}>
    <div class="slot-type-row">
      ${activityTypes.map(t=>{
        const sel=!isAdo&&t.id===s.typeId;
        return `<button class="ep-type-btn${sel?' sel':''}" style="background:${sel?tagBg(t.color):'var(--surface)'};border-color:${sel?t.color:'var(--border)'};color:${sel?t.color:'var(--muted)'}" data-si="${i}" data-typeid="${t.id}">${esc(t.label)}</button>`;
      }).join('')}
    </div>
  </div>`;
  return `<div class="slot-edit-row" data-si="${i}" style="border-left:3px solid ${color}">
    <div class="slot-edit-header">
      <div class="slot-mins-btns">${minsHtml}</div>
      ${popSlots.length>1?`<button class="slot-del-btn" data-si="${i}">✕</button>`:''}
    </div>
    <div class="slot-source-row">
      <button class="slot-src-btn${isAdo?' active':''}" data-si="${i}" data-src="ado" ${isAdo?`style="border-color:${color};color:${color};background:${tagBg(color)}"`:''}> ☁ ADO</button>
      <button class="slot-src-btn${!isAdo?' active':''}" data-si="${i}" data-src="custom">✎ Custom</button>
    </div>
    ${adoHtml}${customHtml}
    <input class="slot-desc-input" type="text" placeholder="Descrizione…" maxlength="80" data-si="${i}" value="">
  </div>`;
}

document.getElementById('editPopover').addEventListener('click', e => {
  e.stopPropagation();
  if (e.target.id==='addSlotBtn') { addSlot(); return; }
  const el=e.target.closest('[data-si]');
  if (!el) return;
  const si=+el.dataset.si;
  if (el.dataset.src!==undefined) {
    const src=el.dataset.src;
    if (src===popSlots[si].source) return;
    if (src==='ado') popSlots[si]={source:'ado',projectName:'',pbiId:null,pbiTitle:'',taskId:null,taskTitle:'',desc:popSlots[si].desc,mins:popSlots[si].mins};
    else popSlots[si]={source:'custom',typeId:activityTypes[0]?.id||'task',desc:popSlots[si].desc,mins:popSlots[si].mins};
    renderPopoverSlots(); return;
  }
  if (el.dataset.typeid!==undefined && el.dataset.mins===undefined) { popSlots[si].typeId=el.dataset.typeid; renderPopoverSlots(); return; }
  if (el.dataset.mins!==undefined) {
    const nm=+el.dataset.mins, otherSum=popSlots.reduce((s,x,j)=>j===si?s:s+x.mins,0);
    if (otherSum+nm>60) { showToast(`Max 60 min — rimangono ${60-otherSum} min`); return; }
    popSlots[si].mins=nm; renderPopoverSlots(); return;
  }
  if (el.classList.contains('slot-del-btn')) { popSlots.splice(si,1); renderPopoverSlots(); }
});
document.getElementById('editPopover').addEventListener('change', async e => {
  const el=e.target, si=+el.dataset.si;
  if (el.classList.contains('slot-ado-project')) {
    popSlots[si].projectName=el.value; popSlots[si].pbiId=null; popSlots[si].pbiTitle='';
    popSlots[si].taskId=null; popSlots[si].taskTitle='';
    renderPopoverSlots();
  } else if (el.classList.contains('slot-ado-pbi')) {
    popSlots[si].pbiId=el.value?+el.value:null;
    popSlots[si].pbiTitle=el.selectedOptions[0]?.dataset?.title||'';
    popSlots[si].taskId=null; popSlots[si].taskTitle='';
    const pbi=popSlots[si].pbiId;
    if (pbi) {
      const cached=adoTasks[pbi];
      if (Array.isArray(cached) && cached.length>0 && cached[0].completed===undefined) delete adoTasks[pbi];
      if (adoTasks[pbi]===undefined) { renderPopoverSlots(); try { await loadTasksForPbi(pbi); } catch(err) { showToast('Errore task: '+err.message); } }
    }
    renderPopoverSlots();
  } else if (el.classList.contains('slot-ado-task')) {
    popSlots[si].taskId=el.value?+el.value:null;
    popSlots[si].taskTitle=el.selectedOptions[0]?.dataset?.title||'';
    renderPopoverSlots();
  }
});
document.getElementById('editPopover').addEventListener('input', e => {
  const inp=e.target.closest('.slot-desc-input');
  if (inp) popSlots[+inp.dataset.si].desc=inp.value;
});
function addSlot() {
  const used=popSlots.reduce((s,x)=>s+x.mins,0), remaining=60-used;
  if (remaining<=0) return;
  const mins=[15,30,45,60].find(m=>m<=remaining)||remaining;
  popSlots.push({...defaultSlot(), mins});
  renderPopoverSlots();
}
function saveCell() {
  if (!popTarget) return;
  const {mi,d,h}=popTarget;
  const filtered=popSlots.filter(s=>s.source==='ado'?s.pbiId||s.projectName:s.typeId);
  closePop();
  months[mi].data[d][h]=filtered;
  updateCellDOM(mi,d,h);
  updateStats(); renderDayStats(); saveState();
}
function deleteCell() {
  if (!popTarget) return;
  const {mi,d,h}=popTarget;
  months[mi].data[d][h]=[];
  closePop(); updateCellDOM(mi,d,h); updateStats(); renderDayStats(); saveState();
}
function closePop() { document.getElementById('editPopover').classList.remove('open'); popTarget=null; }

// ── DAY POPOVER
function openDayPop(e, mi, d) {
  e.stopPropagation();
  dayPopTarget={mi,d};
  dpSource=adoProjects.length&&adoPbis.length?'ado':'custom';
  dpType=activityTypes[0]?.id||'task';
  dpAdoProject=''; dpAdoPbiId=null; dpAdoPbiTitle=''; dpAdoTaskId=null; dpAdoTaskTitle='';
  const dt=getDate(mi,d);
  document.getElementById('dpTitle').innerHTML=`${WEEKDAYS[dt.getDay()]} ${dt.getDate()} ${MONTH_SHORT[dt.getMonth()]} <span>${dt.getFullYear()}</span>`;
  const workHours=HOURS.filter((_,i)=>i!==LUNCH_IDX);
  ['dpFrom','dpTo'].forEach(id=>{
    const sel=document.getElementById(id);
    sel.innerHTML=workHours.map((h,i)=>`<option value="${i<LUNCH_IDX?i:i+1}">${h}</option>`).join('');
    if (id==='dpTo') sel.value=String(HOURS.length-1);
  });
  document.getElementById('dpFrom').onchange=()=>dpAutoTo();
  renderDpContent();
  const pop=document.getElementById('dayPopover');
  pop.classList.add('open');
  pop.style.top=(window.scrollY+16)+'px';
  pop.style.left=Math.round((window.innerWidth-280)/2)+'px';
}
function renderDpContent() {
  const container=document.getElementById('dpTypes');
  const srcBtns=`<div class="slot-source-row" style="margin-bottom:10px">
    <button class="slot-src-btn${dpSource==='ado'?' active':''}" onclick="dpSetSource('ado')">☁ ADO</button>
    <button class="slot-src-btn${dpSource==='custom'?' active':''}" onclick="dpSetSource('custom')">✎ Custom</button>
  </div>`;
  let inner='';
  if (dpSource==='ado') {
    const pbisForProject=dpAdoProject?adoPbis.filter(p=>p.projectName===dpAdoProject):[];
    const tasksForPbi=dpAdoPbiId!==null?(adoTasks[dpAdoPbiId]||[]):[];
    const tasksLoading=dpAdoPbiId!==null&&adoTasks[dpAdoPbiId]===undefined;
    inner=`<div>
      <select class="ado-select" style="margin-bottom:6px" onchange="dpSetAdoProject(this.value)">
        <option value="">— Progetto —</option>
        ${adoProjects.map(p=>`<option value="${esc(p.name)}"${dpAdoProject===p.name?' selected':''}>${esc(projectDisplayName(p.name))}</option>`).join('')}
      </select>
      <select class="ado-select" ${!dpAdoProject?'disabled':''} onchange="dpSetAdoPbi(this.value,this.selectedOptions[0]?.dataset?.title||'')">
        <option value="">— PBI —</option>
        ${pbisForProject.map(p=>`<option value="${p.id}" data-title="${esc(p.title)}"${dpAdoPbiId===p.id?' selected':''}>${esc(p.title)}</option>`).join('')}
      </select>
      ${tasksLoading?'<div class="slot-ado-loading">⟳ Caricamento task…</div>':''}
      <select class="ado-select" ${!dpAdoPbiId||tasksLoading?'disabled':''} onchange="dpSetAdoTask(this.value?+this.value:null,this.selectedOptions[0]?.dataset?.title||'')">
        <option value="">— Task —</option>
        ${tasksForPbi.map(t=>`<option value="${t.id}" data-title="${esc(t.title)}"${dpAdoTaskId===t.id?' selected':''}>${esc(t.title)}</option>`).join('')}
      </select>
    </div>`;
  } else {
    inner=activityTypes.map(t=>{
      const sel=t.id===dpType;
      return `<button class="dp-type-btn${sel?' sel':''}" style="background:${sel?tagBg(t.color):'var(--surface)'};border-color:${sel?t.color:'var(--border)'};color:${sel?t.color:'var(--muted)'}" data-dptype="${t.id}">${esc(t.label)}</button>`;
    }).join('');
  }
  container.innerHTML=srcBtns+`<div class="dp-type-row" id="dpTypeInner">${inner}</div>`;
}
function dpSetSource(src) { dpSource=src; renderDpContent(); }
function dpSetAdoProject(v) { dpAdoProject=v; dpAdoPbiId=null; dpAdoPbiTitle=''; dpAdoTaskId=null; dpAdoTaskTitle=''; renderDpContent(); }
async function dpSetAdoPbi(v, title) {
  dpAdoPbiId=v?+v:null; dpAdoPbiTitle=title; dpAdoTaskId=null; dpAdoTaskTitle='';
  if (dpAdoPbiId!==null && adoTasks[dpAdoPbiId]===undefined) { renderDpContent(); try { await loadTasksForPbi(dpAdoPbiId); } catch(e) {} }
  renderDpContent();
}
function dpSetAdoTask(v, title) { dpAdoTaskId=v||null; dpAdoTaskTitle=title; dpAutoTo(); }
function dpAutoTo() {
  if (!dpAdoTaskId || dpAdoPbiId===null) return;
  const task=(adoTasks[dpAdoPbiId]||[]).find(t=>t.id===dpAdoTaskId);
  const hours=task?(task.remaining??task.estimate??null):null;
  if (!hours||hours<=0) return;
  const from=+document.getElementById('dpFrom').value;
  let count=0, h=from;
  while (h<HOURS.length) { if (h!==LUNCH_IDX) { count++; if (count>=Math.ceil(hours)) break; } h++; }
  document.getElementById('dpTo').value=String(Math.min(h,HOURS.length-1));
}
document.getElementById('dpTypes').addEventListener('click', e => {
  e.stopPropagation();
  const btn=e.target.closest('[data-dptype]');
  if (!btn) return;
  dpType=btn.dataset.dptype; renderDpContent();
});
function dpSelectAllDay() {
  document.getElementById('dpFrom').value='0';
  document.getElementById('dpTo').value=String(HOURS.length-1);
}
function applyDayPop() {
  if (!dayPopTarget) return;
  const {mi,d}=dayPopTarget;
  const from=+document.getElementById('dpFrom').value, to=+document.getElementById('dpTo').value;
  if (from>to) { showToast('Ora inizio deve precedere ora fine'); return; }
  let slot;
  if (dpSource==='ado') {
    if (!dpAdoProject) { showToast('Seleziona un progetto'); return; }
    slot={source:'ado',projectName:dpAdoProject,pbiId:dpAdoPbiId,pbiTitle:dpAdoPbiTitle,taskId:dpAdoTaskId,taskTitle:dpAdoTaskTitle,desc:'',mins:60};
  } else {
    slot={source:'custom',typeId:dpType,desc:'',mins:60};
  }
  for (let h=from;h<=to;h++) {
    if (h===LUNCH_IDX) continue;
    months[mi].data[d][h]=[{...slot}];
    updateCellDOM(mi,d,h);
  }
  closeDayPop(); updateStats(); renderDayStats(); saveState();
}
function closeDayPop() { document.getElementById('dayPopover').classList.remove('open'); dayPopTarget=null; }
function clearDay() {
  if (!dayPopTarget) return;
  const {mi,d}=dayPopTarget;
  for (let h=0;h<HOURS.length;h++) { if (h===LUNCH_IDX) continue; months[mi].data[d][h]=[]; updateCellDOM(mi,d,h); }
  closeDayPop(); updateStats(); renderDayStats(); saveState();
}

// ── TAG MANAGER
function openTagManager() { renderTagList(); document.getElementById('tagModal').classList.add('open'); }
function closeTagManager() {
  document.querySelectorAll('#tagList .tag-row.editing').forEach(row=>{
    const i=+row.dataset.idx, val=row.querySelector('.tag-name-input-inline').value.trim();
    if (val) activityTypes[i].label=val;
    row.classList.remove('editing');
  });
  document.getElementById('tagModal').classList.remove('open');
  render(); saveState();
}
function renderTagList() {
  const list=document.getElementById('tagList');
  list.innerHTML=activityTypes.map((t,i)=>`
    <div class="tag-row" data-idx="${i}">
      <button class="tag-name-label" data-action="edit" data-idx="${i}"></button>
      <input class="tag-name-input-inline" type="text" maxlength="24" data-action="label" data-idx="${i}">
      <div class="tag-color-swatch" data-idx="${i}" style="background:${t.color}"><input type="color" data-action="color" data-idx="${i}"></div>
      <button class="tag-del-btn" data-action="delete" data-idx="${i}" title="Rimuovi">✕</button>
    </div>`).join('');
  activityTypes.forEach((t,i)=>{
    const row=list.querySelector(`.tag-row[data-idx="${i}"]`);
    row.querySelector('.tag-name-label').textContent=t.label;
    row.querySelector('.tag-name-input-inline').value=t.label;
    row.querySelector('input[type="color"]').value=t.color;
  });
}
let _tagDeletePending=false;
document.getElementById('tagList').addEventListener('mousedown',e=>{ if (e.target.closest('[data-action="delete"]')) _tagDeletePending=true; });
document.getElementById('tagList').addEventListener('click', e=>{
  e.stopPropagation(); _tagDeletePending=false;
  const el=e.target.closest('[data-action]'); if (!el) return;
  const idx=+el.dataset.idx, action=el.dataset.action;
  if (action==='edit') { const row=el.closest('.tag-row'); row.classList.add('editing'); const inp=row.querySelector('.tag-name-input-inline'); inp.focus(); inp.select(); }
  if (action==='delete') deleteTag(idx);
});
document.getElementById('tagList').addEventListener('input', e=>{
  const el=e.target, idx=+el.dataset.idx;
  if (el.dataset.action==='color') { activityTypes[idx].color=el.value; el.closest('.tag-color-swatch').style.background=el.value; }
  if (el.dataset.action==='label') { activityTypes[idx].label=el.value; el.closest('.tag-row').querySelector('.tag-name-label').textContent=el.value; }
});
document.getElementById('tagList').addEventListener('keydown', e=>{
  if (e.key==='Enter'||e.key==='Escape') {
    const row=e.target.closest('.tag-row'); if (!row) return;
    const val=e.target.value.trim(); if (val) activityTypes[+row.dataset.idx].label=val;
    row.classList.remove('editing');
  }
});
document.getElementById('tagList').addEventListener('focusout', e=>{
  const row=e.target.closest('.tag-row.editing'); if (!row) return;
  setTimeout(()=>{ if (_tagDeletePending||row.contains(document.activeElement)) return; const val=row.querySelector('.tag-name-input-inline').value.trim(); if (val) activityTypes[+row.dataset.idx].label=val; row.classList.remove('editing'); },150);
});
function deleteTag(i) {
  if (activityTypes.length<=1) { showToast('Almeno un tag richiesto'); return; }
  const id=activityTypes[i].id;
  let inUse=0;
  months.forEach(m=>m.data.forEach(day=>day.forEach(slots=>(slots||[]).forEach(s=>{ if (s.source==='custom'&&s.typeId===id) inUse++; }))));
  if (inUse) { showToast(`⚠ Tag usato in ${inUse} slot — svuotali prima`, 4000); return; }
  activityTypes.splice(i,1); renderTagList();
}
function addTag() {
  const nameEl=document.getElementById('newTagName'), colorEl=document.getElementById('newTagColor');
  const label=nameEl.value.trim(); if (!label) { nameEl.focus(); return; }
  activityTypes.push({id:'tag_'+Date.now(),label,color:colorEl.value});
  nameEl.value=''; renderTagList();
}

// ── ADD MONTH MODAL
function openAddModal() {
  const m=months[activeMonth]; let ny=m.year, nm=m.month+1;
  if (nm>11) { nm=0; ny++; }
  document.getElementById('newYear').value=ny;
  document.getElementById('newMonth').value=nm;
  document.getElementById('modalOverlay').classList.add('open');
}
function closeModal() { document.getElementById('modalOverlay').classList.remove('open'); }
function confirmAddMonth() {
  const y=+document.getElementById('newYear').value, mo=+document.getElementById('newMonth').value;
  if (!addMonthEntry(y,mo)) { showToast('Mese già presente'); return; }
  activeMonth=months.findIndex(x=>x.year===y&&x.month===mo);
  closeModal(); render(); saveState();
}

// ── EXCEL EXPORT
function slotText(s) {
  if (s.source==='ado') {
    const parts=[s.projectName,s.pbiTitle,s.taskTitle].filter(Boolean);
    const label=parts.join(' / '), minsStr=s.mins<60?` (${s.mins}min)`:'';
    return s.desc?`[${label}${minsStr}] ${s.desc}`:`[${label}${minsStr}]`;
  }
  const tag=getTypeById(s.typeId), minsStr=s.mins<60?` (${s.mins}min)`:'';
  return s.desc?`[${tag.label}${minsStr}] ${s.desc}`:`[${tag.label}${minsStr}]`;
}
function downloadXLSX() {
  const wb=XLSX.utils.book_new();
  months.forEach(m=>{
    const nDays=m.data.length, rows=[];
    const hdr=['Ora'];
    for (let d=0;d<nDays;d++) hdr.push(new Date(m.year,m.month,d+1));
    rows.push(hdr);
    for (let h=0;h<9;h++) {
      const row=[HOURS[h]];
      for (let d=0;d<nDays;d++) {
        const dt=new Date(m.year,m.month,d+1), holiday=getHolidayName(dt);
        if (holiday) row.push(`🎉 ${holiday}`);
        else if (h===LUNCH_IDX) row.push('— Pausa pranzo —');
        else { const slots=m.data[d][h]||[]; row.push(slots.length?slots.map(slotText).join(' | '):null); }
      }
      rows.push(row);
    }
    const ws=XLSX.utils.aoa_to_sheet(rows);
    for (let C=1;C<=nDays;C++) { const a=XLSX.utils.encode_cell({r:0,c:C}); if (ws[a]) { ws[a].t='d'; ws[a].z='dd/mm/yyyy'; } }
    ws['!cols']=[{wch:8},...Array(nDays).fill({wch:24})];
    XLSX.utils.book_append_sheet(wb,ws,`${MONTH_SHORT[m.month]} ${m.year}`);
  });
  XLSX.writeFile(wb,`Rendicontazione_${months[0].year}.xlsx`);
  showToast(`✓ Excel scaricato — ${months.length} ${months.length===1?'foglio':'fogli'}`);
}

// ── CLEAR MONTH
function clearCurrentMonth() {
  const m=months[activeMonth];
  if (!confirm(`Svuotare ${MONTH_NAMES[m.month]} ${m.year}?`)) return;
  months[activeMonth].data=makeMonthData(m.year,m.month);
  renderTable(); updateStats(); saveState();
}

// ── SCROLL TO TODAY
function scrollToToday() {
  const now=new Date(), ci=months.findIndex(m=>m.year===now.getFullYear()&&m.month===now.getMonth());
  if (ci===-1) { showToast('Mese corrente non presente'); return; }
  if (ci!==activeMonth) { activeMonth=ci; render(); }
  requestAnimationFrame(()=>{
    const todayTh=document.querySelector('thead th.col-today');
    if (!todayTh) { showToast('Oggi non è un giorno lavorativo'); return; }
    const wrapper=document.querySelector('.table-wrapper');
    wrapper.scrollTo({left:todayTh.offsetLeft-wrapper.offsetWidth/2+todayTh.offsetWidth/2,behavior:'smooth'});
    setTimeout(()=>{
      const todayD=now.getDate()-1;
      [todayTh,...document.querySelectorAll(`td[data-d="${todayD}"]`)].forEach(el=>{
        el.classList.remove('today-glow'); void el.offsetWidth; el.classList.add('today-glow');
        el.addEventListener('animationend',()=>el.classList.remove('today-glow'),{once:true});
      });
    },500);
  });
}

// ── MIGRAZIONE CUSTOM → ADO
function openMigraModal() {
  if (!adoProjects.length) { showToast('Prima sincronizza ADO (☁ ADO → Salva & Sincronizza)'); return; }
  const fromSel = document.getElementById('migraFromType');
  fromSel.innerHTML = activityTypes.map(t => `<option value="${esc(t.id)}">${esc(t.label)}</option>`).join('');
  document.getElementById('migraFromDesc').value = '';
  const projSel = document.getElementById('migraToProject');
  projSel.innerHTML = `<option value="">— Progetto —</option>` + adoProjects.map(p => `<option value="${esc(p.name)}">${esc(projectDisplayName(p.name))}</option>`).join('');
  const pbiSel = document.getElementById('migraToPbi');
  pbiSel.innerHTML = '<option value="">— PBI —</option>'; pbiSel.disabled = true;
  const taskSel = document.getElementById('migraToTask');
  taskSel.innerHTML = '<option value="">— Task —</option>'; taskSel.disabled = true;
  renderMigraPreview();
  document.getElementById('migraModal').classList.add('open');
}
function closeMigraModal() { document.getElementById('migraModal').classList.remove('open'); }
function migraProjectChanged() {
  const projectName = document.getElementById('migraToProject').value;
  const pbiSel = document.getElementById('migraToPbi'), taskSel = document.getElementById('migraToTask');
  const pbis = projectName ? adoPbis.filter(p => p.projectName === projectName) : [];
  pbiSel.innerHTML = `<option value="">— PBI —</option>` + pbis.map(p => `<option value="${p.id}" data-title="${esc(p.title)}">${esc(p.title)}</option>`).join('');
  pbiSel.disabled = !projectName;
  taskSel.innerHTML = '<option value="">— Task —</option>'; taskSel.disabled = true;
  renderMigraPreview();
}
async function migraPbiChanged() {
  const pbiSel = document.getElementById('migraToPbi'), taskSel = document.getElementById('migraToTask'), loadingEl = document.getElementById('migraTaskLoading');
  const pbiId = pbiSel.value ? +pbiSel.value : null;
  taskSel.innerHTML = '<option value="">— Task —</option>'; taskSel.disabled = true;
  if (pbiId) {
    if (adoTasks[pbiId] === undefined) { loadingEl.style.display = 'block'; try { await loadTasksForPbi(pbiId); } catch(e) { showToast('Errore task: ' + e.message); } finally { loadingEl.style.display = 'none'; } }
    const tasks = adoTasks[pbiId] || [];
    taskSel.innerHTML = `<option value="">— Task —</option>` + tasks.map(t => `<option value="${t.id}" data-title="${esc(t.title)}">${esc(t.title)}</option>`).join('');
    taskSel.disabled = !tasks.length;
  }
  renderMigraPreview();
}
function countMigraMatches() {
  const typeId = document.getElementById('migraFromType').value;
  const filter = document.getElementById('migraFromDesc').value.trim().toLowerCase();
  let n = 0;
  months.forEach(m => m.data.forEach(day => day.forEach(slots => (slots||[]).forEach(s => { if (s.source === 'custom' && s.typeId === typeId) if (!filter || (s.desc||'').toLowerCase().includes(filter)) n++; }))));
  return n;
}
function renderMigraPreview() {
  const count = countMigraMatches(), projectName = document.getElementById('migraToProject').value;
  const preview = document.getElementById('migraPreview'), applyBtn = document.getElementById('migraApplyBtn');
  if (count === 0) { preview.textContent = 'Nessun slot corrispondente'; preview.style.color = 'var(--muted)'; applyBtn.disabled = true; applyBtn.textContent = 'Sostituisci'; }
  else { preview.textContent = `${count} slot ${projectName ? 'pronti per la migrazione' : '— seleziona progetto destinazione'}`; preview.style.color = projectName ? 'var(--today-border)' : 'var(--accent)'; applyBtn.disabled = !projectName; applyBtn.textContent = projectName ? `Sostituisci ${count} slot` : 'Sostituisci'; }
}
function applyMigration() {
  const typeId = document.getElementById('migraFromType').value;
  const filter = document.getElementById('migraFromDesc').value.trim().toLowerCase();
  const projectName = document.getElementById('migraToProject').value;
  if (!projectName) { showToast('Seleziona progetto destinazione'); return; }
  const pbiSel = document.getElementById('migraToPbi'), taskSel = document.getElementById('migraToTask');
  const pbiId = pbiSel.value ? +pbiSel.value : null, pbiTitle = pbiSel.selectedOptions[0]?.dataset?.title || '';
  const taskId = taskSel.value ? +taskSel.value : null, taskTitle = taskSel.selectedOptions[0]?.dataset?.title || '';
  let count = 0;
  months.forEach(m => m.data.forEach(day => day.forEach(slots => {
    (slots||[]).forEach((s, i) => { if (s.source === 'custom' && s.typeId === typeId) if (!filter || (s.desc||'').toLowerCase().includes(filter)) { slots[i] = { source:'ado', projectName, pbiId, pbiTitle, taskId, taskTitle, desc:s.desc, mins:s.mins }; count++; } });
  })));
  saveState(); render(); closeMigraModal();
  showToast(`✓ ${count} slot migrati → ${[projectName, pbiTitle, taskTitle].filter(Boolean).join(' / ')}`, 4000);
}

// ── FERIE
function openFerieModal() {
  const ferieType = activityTypes.find(t => /ferie/i.test(t.label));
  if (!ferieType) { showToast('⚠ Crea prima un tag chiamato "Ferie" nel gestore tag'); return; }
  const now = new Date();
  const pad = n => String(n).padStart(2,'0');
  const todayStr = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
  document.getElementById('ferieFrom').value = todayStr;
  document.getElementById('ferieTo').value   = todayStr;
  updateFeriePreview();
  document.getElementById('ferieModal').classList.add('open');
}
function closeFerieModal() { document.getElementById('ferieModal').classList.remove('open'); }
function updateFeriePreview() {
  const from = document.getElementById('ferieFrom').value;
  const to   = document.getElementById('ferieTo').value;
  const btn  = document.getElementById('ferieApplyBtn');
  const prev = document.getElementById('feriePreview');
  if (!from || !to || from > to) {
    prev.textContent = 'Seleziona un intervallo valido';
    prev.style.color = '#fa6c8e';
    btn.disabled = true;
    return;
  }
  // Conta giorni lavorativi (no weekend, no festivi) nell'intervallo
  let count = 0;
  const d = new Date(from);
  const end = new Date(to);
  while (d <= end) {
    if (!isWE(d) && !getHolidayName(d)) count++;
    d.setDate(d.getDate() + 1);
  }
  prev.textContent = count > 0
    ? `${count} giorn${count===1?'o lavorativo':'i lavorativi'} selezionat${count===1?'o':'i'}`
    : 'Nessun giorno lavorativo nell’intervallo';
  prev.style.color = count > 0 ? 'var(--today-border)' : '#faa94c';
  btn.disabled = count === 0;
}
function applyFerie() {
  const from = new Date(document.getElementById('ferieFrom').value);
  const to   = new Date(document.getElementById('ferieTo').value);
  const ferieType = activityTypes.find(t => /ferie/i.test(t.label));
  if (!ferieType) return;
  const slot = { source:'custom', typeId: ferieType.id, desc:'', mins:60 };
  let count = 0;
  const d = new Date(from);
  while (d <= to) {
    if (!isWE(d) && !getHolidayName(d)) {
      // Trova o crea il mese corrispondente
      const y = d.getFullYear(), m = d.getMonth();
      let mi = months.findIndex(x => x.year===y && x.month===m);
      if (mi === -1) { addMonthEntry(y, m); mi = months.findIndex(x => x.year===y && x.month===m); }
      const dayIdx = d.getDate() - 1;
      for (let h = 0; h < HOURS.length; h++) {
        if (h === LUNCH_IDX) continue;
        months[mi].data[dayIdx][h] = [{ ...slot }];
      }
      count++;
    }
    d.setDate(d.getDate() + 1);
  }
  closeFerieModal();
  render(); saveState();
  showToast(`🏖 ${count} giorn${count===1?'o':'i'} di ferie inserit${count===1?'o':'i'}`, 3500);
}

// ── CLOSE ON OUTSIDE CLICK
document.addEventListener('click', e=>{
  const pop=document.getElementById('editPopover'), dayPop=document.getElementById('dayPopover');
  const modal=document.getElementById('modalOverlay'), tagModal=document.getElementById('tagModal');
  const adoModal=document.getElementById('adoModal'), migraModal=document.getElementById('migraModal');
  const ferieModal=document.getElementById('ferieModal');
  if (pop.classList.contains('open')&&!pop.contains(e.target)) closePop();
  if (dayPop.classList.contains('open')&&!dayPop.contains(e.target)) closeDayPop();
  if (modal.classList.contains('open')&&e.target===modal) closeModal();
  if (tagModal.classList.contains('open')&&e.target===tagModal) closeTagManager();
  if (adoModal.classList.contains('open')&&e.target===adoModal) closeAdoModal();
  if (migraModal.classList.contains('open')&&e.target===migraModal) closeMigraModal();
  if (ferieModal.classList.contains('open')&&e.target===ferieModal) closeFerieModal();
});

// ── ADO PROJECT COLOR & ALIAS PICKERS
(function() {
  const container = document.getElementById('adoProjectColorList');
  function saveAlias(row, val) {
    const name = adoProjects[+row.dataset.pi]?.name;
    if (!name) return;
    const trimmed = val.trim();
    if (trimmed && trimmed !== name) adoProjectAliases[name] = trimmed;
    else delete adoProjectAliases[name];
    row.querySelector('.tag-name-label').textContent = trimmed || name;
    row.classList.remove('editing');
    persistAdoConfig(); renderLegend(); updateStats(); renderTable();
  }
  container.addEventListener('input', e => {
    const el = e.target;
    if (el.type === 'color' && el.dataset.pi !== undefined) { const name = adoProjects[+el.dataset.pi]?.name; if (!name) return; adoProjectColors[name] = el.value; el.closest('.tag-color-swatch').style.background = el.value; }
    if (el.dataset.action === 'alias') { const row = el.closest('.tag-row'); row.querySelector('.tag-name-label').textContent = el.value.trim() || (adoProjects[+el.dataset.pi]?.name || ''); }
  });
  container.addEventListener('change', e => { if (e.target.type !== 'color') return; persistAdoConfig(); renderLegend(); updateStats(); renderTable(); });
  container.addEventListener('click', e => {
    const reset = e.target.closest('[data-reset]');
    if (reset) { const name = adoProjects[+reset.dataset.reset]?.name; if (!name) return; delete adoProjectColors[name]; delete adoProjectAliases[name]; persistAdoConfig(); renderAdoProjectColors(); renderLegend(); updateStats(); renderTable(); return; }
    const editBtn = e.target.closest('[data-action="edit-alias"]');
    if (editBtn) { const row = editBtn.closest('.tag-row'); row.classList.add('editing'); const inp = row.querySelector('.tag-name-input-inline'); inp.focus(); inp.select(); }
  });
  container.addEventListener('keydown', e => { const row = e.target.closest('.tag-row.editing'); if (!row) return; if (e.key === 'Enter' || e.key === 'Escape') { saveAlias(row, e.key === 'Escape' ? (adoProjectAliases[adoProjects[+row.dataset.pi]?.name] || '') : e.target.value); } });
  container.addEventListener('focusout', e => { const row = e.target.closest('.tag-row.editing'); if (!row) return; setTimeout(() => { if (row.contains(document.activeElement)) return; saveAlias(row, row.querySelector('.tag-name-input-inline').value); }, 120); });
})();

// ── POPOVER DRAG & RESIZE
(function(){
  const pop=document.getElementById('editPopover');
  const handle=document.getElementById('popDragHandle');
  const resizeHandle=document.getElementById('popResizeHandle');
  let dragging=false,ox=0,oy=0,resizing=false,rsx=0,rsy=0,rsw=0,rsh=0;
  handle.addEventListener('mousedown',e=>{
    if (e.button!==0) return; dragging=true;
    const r=pop.getBoundingClientRect(); ox=e.clientX-r.left; oy=e.clientY-r.top;
    handle.style.cursor='grabbing'; e.preventDefault(); e.stopPropagation();
  });
  resizeHandle.addEventListener('mousedown',e=>{
    if (e.button!==0) return; resizing=true;
    rsx=e.clientX; rsy=e.clientY; rsw=pop.offsetWidth; rsh=pop.offsetHeight;
    e.preventDefault(); e.stopPropagation();
  });
  document.addEventListener('mousemove',e=>{
    if (dragging) {
      let x=Math.max(0,Math.min(window.innerWidth-pop.offsetWidth, e.clientX-ox));
      let y=Math.max(0,Math.min(window.innerHeight-pop.offsetHeight, e.clientY-oy));
      pop.style.left=x+'px'; pop.style.top=y+'px';
    }
    if (resizing) {
      const w=Math.max(180,rsw+(e.clientX-rsx)), h=Math.max(160,rsh+(e.clientY-rsy));
      pop.style.width=w+'px'; pop.style.height=h+'px';
      const slotEditor=document.getElementById('slotEditor');
      if (slotEditor) {
        const fixed=(pop.querySelector('.pop-drag-handle')?.offsetHeight||0)+(pop.querySelector('#epTypes')?.offsetHeight||0)+(pop.querySelector('.ep-actions')?.offsetHeight||0)+39;
        slotEditor.style.maxHeight=Math.max(80,h-fixed)+'px';
      }
    }
  });
  document.addEventListener('mouseup',()=>{ if (dragging){dragging=false;handle.style.cursor='grab';} resizing=false; });
})();

// ── COLUMN RESIZE (drag handle on each th)
(function(){
  let active = null;
  document.addEventListener('mousedown', e => {
    const handle = e.target.closest('.col-resize-handle');
    if (!handle) return;
    e.preventDefault(); e.stopPropagation();
    const th = handle.closest('th');
    if (!th || th.dataset.col === undefined) return;
    const colIdx = +th.dataset.col;
    handle.classList.add('resizing');
    active = { colIdx, startX: e.clientX, startW: colWidth(colIdx), th, handle };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', e => {
    if (!active) return;
    const newW = Math.max(COL_MIN, active.startW + (e.clientX - active.startX));
    colWidths[active.colIdx] = newW;
    active.th.style.width = newW + 'px';
    document.querySelectorAll(`td[data-d="${active.colIdx}"]`).forEach(td => td.style.width = newW + 'px');
    const table = document.querySelector('.table-wrapper table');
    if (table) {
      const nDays = months[activeMonth]?.data.length || 28;
      const extra = Object.entries(colWidths).reduce((s,[,w]) => s + (w - COL_DEFAULT), 0);
      table.style.minWidth = (66 + nDays * COL_DEFAULT + extra) + 'px';
    }
  });
  document.addEventListener('mouseup', () => {
    if (!active) return;
    active.handle.classList.remove('resizing');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    saveColWidths();
    active = null;
  });
})();
