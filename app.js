/* Devotional session slides for Sai Rhythms published decks.
   Bhajan/prayer slides are rebuilt from the live Sai Rhythms list on every reload;
   slides added here are anchored to the slide they follow and survive reloads. */
(() => {
  'use strict';

  const CFG = window.BHAJAN_CONFIG || {};
  const RELAY = (CFG.relayUrl || '').trim();
  const LS = { state: 'bs.state.v1', deck: 'bs.deck.v1', pin: 'bs.pin.v1', zoom: 'bs.zoom.v1' };
  const SAI_ORIGIN = 'https://sairhythms.sathyasai.org';

  const DEFAULT_SETTINGS = {
    saiUrl: CFG.defaultSaiRhythmsUrl || '',
    template: CFG.defaultTemplate || 'akhanda',
    videos: '',
    videoOn: 'lyrics',
    maxLines: 10,
    longText: 'scroll',   // 'scroll' within one slide, or 'split' across slides
    showMeaning: true,
    showSinger: true,
    titleSlide: true,
    logo1: 'images/center-logo.png',
    logo1Pos: 'top-left',
    logo2: 'images/sssio-100.png',
    logo2Pos: 'top-right',
    logoSize: 'medium',
    showClock: true,
    videoSide: 'left',
    videoWidth: 45,     // % of the slide width
    videoZoom: 130,     // %
    videoFocusX: 50,    // % across the video to centre on
    videoFocusY: 40,    // % down the video to centre on
    videoFeather: 35,   // % of the video area that fades into the slide
  };

  let state = { settings: { ...DEFAULT_SETTINGS }, decks: {}, custom: [], hide: [], unhide: [], edits: {}, banner: '', ticker: { text: '', on: false, speed: 'slow' } };
  let loadError = '';
  let deck = null;          // { fetchedAt, raw }
  let model = null;         // normalized deck
  let seq = [];             // every entry incl. hidden (for the editor)
  let pages = [];           // what is presented
  let cur = 0;
  let template = null;
  let templates = [];
  let videoForced = true;   // V key toggles for the session
  let zoom = Number(lsGet(LS.zoom, 1)) || 1;   // text size, kept per laptop (projectors differ)
  let blackout = false;

  const $ = (s, r = document) => r.querySelector(s);
  const stage = $('#stage');
  const slideEl = $('#slide');
  const nextBox = $('#next-box');

  /* ---------------- utilities ---------------- */
  const decodeEl = document.createElement('textarea');
  function decode(s) { if (!s) return ''; decodeEl.innerHTML = String(s); return decodeEl.value; }
  function clean(s) {
    if (!s) return '';
    let t = decode(String(s)).replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div)>/gi, '\n').replace(/<[^>]+>/g, '');
    return decode(t).replace(/\u00a0/g, ' ').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').trim();
  }
  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function uid() { return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function absUrl(u) { if (!u) return ''; if (/^https?:\/\//i.test(u)) return u; if (u.startsWith('/')) return SAI_ORIGIN + u; return u; }
  function lsGet(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } }

  let toastTimer = null;
  function toast(msg, isError = false, ms = 5000) {
    const t = $('#toast');
    t.textContent = msg; t.className = isError ? 'error' : ''; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  /* ---------------- relay (Google Apps Script) ---------------- */
  async function relayGet(params) {
    const url = RELAY + (RELAY.includes('?') ? '&' : '?') + new URLSearchParams(params).toString();
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error('The relay answered ' + res.status + '.');
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'The relay could not complete that.');
    return data;
  }
  async function relayPost(body) {
    const res = await fetch(RELAY, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), redirect: 'follow' });
    if (!res.ok) throw new Error('The relay answered ' + res.status + '.');
    return res.json();
  }

  /* ---------------- state persistence ---------------- */
  async function loadState() {
    const local = lsGet(LS.state, null);
    if (local) mergeState(local);
    if (!RELAY) return;
    try {
      const data = await relayGet({ action: 'state' });
      if (data.state) { lastShared = JSON.stringify(data.state); mergeState(data.state); lsSet(LS.state, state); }
    } catch (e) {
      toast('Could not load the shared slide settings, so this laptop’s last copy is being used. ' + e.message, true, 8000);
    }
  }
  // Added slides, hidden slides and edits belong to one Sai Rhythms deck, so they're kept per deck link.
  // state.custom / hide / unhide / edits are the working copy for the deck currently selected.
  const deckKey = url => String(url || '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
  function cleanTicker(t) {
    t = t && typeof t === 'object' ? t : {};
    return { text: typeof t.text === 'string' ? t.text : '', on: !!t.on, speed: ['slow', 'medium', 'fast'].includes(t.speed) ? t.speed : 'slow' };
  }
  function cleanDeckData(d) {
    d = d || {};
    return {
      custom: Array.isArray(d.custom) ? d.custom : [],
      hide: Array.isArray(d.hide) ? d.hide : [],
      unhide: Array.isArray(d.unhide) ? d.unhide : [],
      edits: d.edits && typeof d.edits === 'object' ? d.edits : {},
      banner: typeof d.banner === 'string' ? d.banner : '',
      ticker: cleanTicker(d.ticker),
      cover: typeof d.cover === 'string' ? d.cover : '',
    };
  }
  function mergeState(s) {
    const settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
    const decks = s.decks && typeof s.decks === 'object' ? s.decks : {};
    // older saves kept one set of changes for everything: attach them to the deck that was in use
    if (!s.decks && (s.custom || s.hide || s.unhide || s.edits)) decks[deckKey(settings.saiUrl)] = cleanDeckData(s);
    state = { settings, decks, ...cleanDeckData(decks[deckKey(settings.saiUrl)]) };
  }
  function stashDeckData() {
    state.decks[deckKey(state.settings.saiUrl)] = { custom: state.custom, hide: state.hide, unhide: state.unhide, edits: state.edits, banner: state.banner, ticker: state.ticker, cover: state.cover };
  }
  function switchDeck(newUrl) {
    stashDeckData();
    state.settings.saiUrl = newUrl;
    Object.assign(state, cleanDeckData(state.decks[deckKey(newUrl)]));
  }

  let saveTimer = null;
  let lastSaveNote = '';
  let lastShared = '';   // the shared state as last saved or loaded, to spot changes made elsewhere
  function pruneOld() {
    const now = model && Date.parse(model.date);
    if (!now) return;
    const old = d => d && Date.parse(d) && Date.parse(d) < now;
    state.custom = state.custom.filter(c => !old(c.onlyDate));
    for (const k of Object.keys(state.edits)) if (old(state.edits[k].onlyDate)) delete state.edits[k];
  }
  let quietSave = false;
  function saveState(quiet = false) {
    quietSave = quiet;
    pruneOld();
    stashDeckData();
    lsSet(LS.state, state);
    setEditorStatus(RELAY ? 'Saving…' : 'Saved on this laptop (preview mode).');
    if (!RELAY) return;
    clearTimeout(saveTimer);
    lastLocalSave = Date.now();
    saveTimer = setTimeout(() => { saveTimer = null; pushState(); }, 600);
  }
  async function pushState(retry = true) {
    let pin = lsGet(LS.pin, '');
    if (!pin && quietSave) { setEditorStatus('Not shared yet: saved on this laptop only.'); lastSaveNote = 'Saved on this laptop only. Enter the PIN here to share with other laptops.'; broadcastStatus(); return; }
    if (!pin) { pin = await askPin(); if (!pin) { setEditorStatus('Not shared yet: saved on this laptop only. Enter the PIN to share changes.'); return; } }
    try {
      const r = await relayPost({ action: 'saveState', pin, state });
      if (r.ok) { lsSet(LS.pin, pin); setEditorStatus('Saved for every laptop.'); lastSaveNote = 'Saved for every laptop.'; lastShared = JSON.stringify(state); broadcastStatus(); return; }
      if (r.error === 'wrong-pin') {
        lsSet(LS.pin, '');
        if (quietSave) { lastSaveNote = 'Not shared: the PIN didn’t match. Saved on this laptop only.'; broadcastStatus(); return; }
        if (retry) { toast('That PIN didn’t match. Try again.', true); return pushState(false); }
        setEditorStatus('Not shared: the PIN didn’t match. Changes are saved on this laptop only.');
        return;
      }
      throw new Error(r.error || 'unknown error');
    } catch (e) {
      setEditorStatus('Not shared: ' + e.message + ' Changes are saved on this laptop only.');
    }
  }
  function askPin() {
    return new Promise(resolve => {
      const d = $('#pin-dialog'); const input = d.querySelector('input'); input.value = '';
      d.onclose = () => resolve(d.returnValue === 'ok' ? input.value.trim() : '');
      d.showModal();
    });
  }
  function setEditorStatus(t) { $('#editor-status').textContent = t; }

  /* ---------------- loading the deck ---------------- */
  async function loadDeck(manual = false) {
    const url = state.settings.saiUrl;
    try {
      let raw, fetchedAt;
      if (RELAY) {
        if (!url) throw new Error('No Sai Rhythms link is set. Add it in Settings.');
        const data = await relayGet({ action: 'deck', url });
        raw = data.deck; fetchedAt = data.fetchedAt;
      } else {
        const res = await fetch('data/sample-deck.json', { cache: 'no-store' });
        raw = await res.json(); fetchedAt = new Date().toISOString();
      }
      deck = { raw, fetchedAt, url }; loadError = '';
      lsSet(LS.deck, deck);
      const m = normalize(raw);
      const songs = m.items.filter(i => i.isSong && !i.hiddenSR).length;
      const prefix = RELAY ? 'Updated from Sai Rhythms' : 'Preview mode: showing the saved 14 Nov list';
      if (manual || !RELAY) toast(`${prefix}. ${songs} bhajan${songs === 1 ? '' : 's'} for ${m.date || 'this session'}.`);
      return true;
    } catch (e) {
      const cached = lsGet(LS.deck, null);
      const sameDeck = d => d && deckKey(d.url) === deckKey(url);
      if (sameDeck(deck)) { toast('Couldn’t reload: ' + e.message + ' Still showing the list loaded earlier.', true, 12000); return false; }
      if (sameDeck(cached)) { deck = cached; toast('Couldn’t reach Sai Rhythms (' + e.message + '). Showing the last copy of this list this laptop loaded.', true, 12000); return true; }
      deck = null; loadError = e.message;
      toast('Couldn’t load that deck: ' + e.message, true, 15000);
      return true;
    }
  }

  function pickPitch(e) {
    for (const k of ['pitch', 'singer_pitch', 'scale', 'shruti', 'shruthi']) if (e[k]) return clean(e[k]);
    for (const k of Object.keys(e)) if (/pitch/i.test(k) && typeof e[k] === 'string' && e[k].trim()) return clean(e[k]);
    return '';
  }

  function sanitizeHtml(html, entry) {
    const doc = new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html');
    const root = doc.body.firstElementChild;
    root.querySelectorAll('script,style,meta,link,iframe,object,embed,form,input,button,select,textarea,svg').forEach(n => n.remove());
    root.querySelectorAll('*').forEach(n => {
      for (const a of [...n.attributes]) {
        const nm = a.name.toLowerCase();
        if (nm === 'src' && n.tagName === 'IMG') continue;
        if (nm === 'colspan' || nm === 'rowspan') continue;
        n.removeAttribute(a.name);
      }
      if (n.tagName === 'IMG') {
        let src = n.getAttribute('src') || '';
        if (entry[src]) src = entry[src];
        src = absUrl(src);
        if (!/^https?:\/\//i.test(src)) n.remove(); else n.setAttribute('src', src);
      }
    });
    return root.innerHTML.replace(/(<br\s*\/?>\s*){3,}/gi, '<br><br>');
  }

  function normalize(raw) {
    const keys = Object.keys(raw || {}).filter(k => /^\d+$/.test(k)).sort((a, b) => a - b);
    let meta = {}; const entries = [];
    for (const k of keys) {
      const e = raw[k];
      if (!e || typeof e !== 'object') continue;
      if (e.title === 'slideshow_settings') meta = e; else entries.push(e);
    }
    const slots = (meta.timeslots || []).map(t => ({ name: t[0], type: t[1] }));
    const ordered = entries; // Sai Rhythms already lists entries in presentation order
    const occ = {};
    const items = ordered.map(e => {
      const slot = e.slot || '';
      const title = clean(e.title) || 'Untitled';
      const base = slot + '|' + title;
      occ[base] = (occ[base] || 0) + 1;
      const slotDef = slots.find(s => s.name === slot);
      let lyrics = clean(e.lyrics);
      if (lyrics.toLowerCase() === title.toLowerCase()) lyrics = '';
      let meaning = clean(e.meaning);
      if (!lyrics || meaning.toLowerCase() === title.toLowerCase() || meaning.toLowerCase() === lyrics.toLowerCase()) meaning = '';
      return {
        key: base + '|' + occ[base], slot, title,
        isSong: slotDef ? slotDef.type === 's' : !!e.singername,
        singer: clean(e.singername), pitch: pickPitch(e),
        lyrics, meaning,
        html: e.editable_content ? sanitizeHtml(e.editable_content, e) : '',
        hiddenSR: e.hidden_slide === 'y' || e.hidden_slide === true,
      };
    });
    return { name: clean(meta.song_list_name), date: clean(meta.deck_for_date), slots, items };
  }

  /* ---------------- building the slide sequence ---------------- */
  function build() {
    model = deck ? normalize(deck.raw) : { name: '', date: '', slots: [], items: [] };
    const s = state.settings;
    const gen = [];
    if (s.titleSlide && model.items.length) gen.push({ key: '__title__', slot: '', title: model.name || 'Devotional session', kind: 'title', date: model.date, sub: model.date });
    gen.push(...model.items);
    gen.forEach(applyEdit);

    const byAnchor = {};
    for (const c of activeCustom()) (byAnchor[c.after] = byAnchor[c.after] || []).push(c);
    const keys = new Set(gen.map(g => g.key));
    const orphans = activeCustom().filter(c => c.after !== '__start__' && !keys.has(c.after));

    seq = [];
    (byAnchor.__start__ || []).forEach(c => seq.push({ custom: c }));
    gen.forEach((it, idx) => {
      seq.push({ item: it });
      (byAnchor[it.key] || []).forEach(c => seq.push({ custom: c }));
      const nextSlot = gen[idx + 1] ? gen[idx + 1].slot : null;
      if (nextSlot !== it.slot) orphans.filter(c => c.slot === it.slot).forEach(c => seq.push({ custom: c, orphan: true }));
    });
    orphans.filter(c => !gen.some(g => g.slot === c.slot)).forEach(c => seq.push({ custom: c, orphan: true }));

    for (const en of seq) {
      if (en.item) {
        const k = en.item.key;
        en.hidden = state.hide.includes(k) || (en.item.hiddenSR && !state.unhide.includes(k));
      } else en.hidden = !!en.custom.hidden;
    }

    // background rotation per role
    const roleCount = {};
    const visible = seq.filter(en => !en.hidden);
    pages = [];
    visible.forEach((en, vi) => {
      const kinds = pageKinds(en);
      const role = kinds.role;
      roleCount[role] = (roleCount[role] || 0);
      const bgIndex = roleCount[role]++;
      // "Next" looks ahead to the next real (Sai Rhythms) item, skipping added slides
      let next = null;
      for (let j = vi + 1; j < visible.length; j++) { if (visible[j].item && visible[j].item.key !== '__title__') { next = visible[j].item; break; } }
      kinds.pages.forEach((p, pi) => pages.push({ en, ...p, role, bgIndex, pageNo: pi + 1, pageCount: kinds.pages.length, next }));
    });
    if (cur >= pages.length) cur = Math.max(0, pages.length - 1);
  }

  // A change made here applies if it was kept for every session, or if it was made for this session's date.
  function editApplies(e) { return e && (!e.onlyDate || e.onlyDate === (model && model.date)); }
  function activeCustom() { return state.custom.filter(c => !c.onlyDate || c.onlyDate === (model && model.date)); }
  const EDIT_FIELDS = ['title', 'sub', 'singer', 'pitch', 'lyrics', 'meaning', 'text'];
  function applyEdit(it) {
    const e = state.edits[it.key];
    it.orig = { title: it.title, sub: it.sub || '', singer: it.singer || '', pitch: it.pitch || '', lyrics: it.lyrics || '', meaning: it.meaning || '', text: it.html ? htmlToText(it.html) : '' };
    if (!editApplies(e)) { it.edited = false; return; }
    for (const f of EDIT_FIELDS) if (typeof e[f] === 'string') it[f] = e[f];
    if (typeof e.text === 'string') { it.html = ''; it.lyrics = e.text; }
    if (it.kind === 'title') it.date = it.sub;
    it.edited = true;
  }
  function htmlToText(html) {
    const d = document.createElement('div'); d.innerHTML = html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d)>/gi, '\n');
    d.querySelectorAll('td,th').forEach(c => c.append('   '));
    return (d.textContent || '').replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  function effMaxLines() { return Math.max(3, Math.round(state.settings.maxLines / zoom)); }

  function splitLines(text, max) {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length <= max) return [lines];
    const n = Math.ceil(lines.length / max), per = Math.ceil(lines.length / n), out = [];
    for (let i = 0; i < lines.length; i += per) out.push(lines.slice(i, i + per));
    return out;
  }
  function splitProse(text, maxChars = 650) {
    const sentences = text.replace(/\n+/g, ' \n ').match(/[^.!?\n]+[.!?]*["”’)]*\s*|\n/g) || [text];
    const out = []; let buf = '';
    for (const s of sentences) {
      if ((buf + s).length > maxChars && buf.trim()) { out.push(buf.trim()); buf = ''; }
      buf += s === '\n' ? '\n' : s;
    }
    if (buf.trim()) out.push(buf.trim());
    return out;
  }
  function isProse(text) {
    const lines = text.split('\n').filter(l => l.trim());
    const avg = lines.reduce((a, l) => a + l.length, 0) / (lines.length || 1);
    return lines.some(l => l.length > 180) || avg > 95;
  }

  const scrollMode = () => state.settings.longText !== 'split';
  function lyricParts(text) {
    if (scrollMode()) return [text.split('\n').map(l => l.trim()).filter(Boolean)];
    return splitLines(text, effMaxLines());
  }
  function proseParts(text) { return scrollMode() ? [text] : splitProse(text, 650 / zoom); }
  function pageKinds(en) {
    const s = state.settings;
    if (en.custom) {
      const c = en.custom;
      if (c.type === 'darshan') return { role: 'darshan', pages: [{ kind: 'darshan' }] };
      if (c.type === 'image') return { role: 'info', pages: [{ kind: 'image' }] };
      const body = (c.body || '').trim();
      if (!body) return { role: 'card', pages: [{ kind: 'card' }] };
      if (isProse(body)) return { role: 'info', pages: proseParts(body).map(t => ({ kind: 'prose', text: t })) };
      return { role: 'lyrics', pages: lyricParts(body).map(l => ({ kind: 'lyrics', lines: l })) };
    }
    const it = en.item;
    if (it.kind === 'title') return { role: 'title', pages: [{ kind: 'title' }] };
    if (it.html) return { role: 'info', pages: [{ kind: 'html' }] };
    if (it.lyrics && isProse(it.lyrics)) return { role: 'info', pages: proseParts(it.lyrics).map(t => ({ kind: 'prose', text: t })) };
    if (it.lyrics) return { role: 'lyrics', pages: lyricParts(it.lyrics).map(l => ({ kind: 'lyrics', lines: l })) };
    return { role: 'card', pages: [{ kind: 'card' }] };
  }

  /* ---------------- templates ---------------- */
  async function loadTemplates() {
    try { templates = await (await fetch('templates/index.json', { cache: 'no-store' })).json(); }
    catch { templates = [{ id: 'akhanda', name: 'Akhanda' }]; }
  }
  async function applyTemplate(id) {
    const tid = templates.some(t => t.id === id) ? id : (templates[0] && templates[0].id) || 'akhanda';
    try {
      const t = await (await fetch(`templates/${tid}/template.json`, { cache: 'no-store' })).json();
      t.id = tid; template = t;
    } catch {
      template = { id: tid, backgrounds: {} };
      toast('That design could not be loaded, so plain colours are used.', true);
    }
    $('#template-fonts').href = template.fonts || '';
    const vars = { '--title-font': template.titleFont, '--body-font': template.bodyFont, '--ink': template.ink, '--soft': template.soft, '--accent': template.accent, '--panel': template.panel, '--title-ink': template.titleInk };
    for (const [k, v] of Object.entries(vars)) if (v) stage.style.setProperty(k, v);
    // preload images
    Object.values(template.backgrounds || {}).flat().forEach(b => { if (b.src) { const i = new Image(); i.src = `templates/${tid}/${b.src}`; } });
  }
  function bgFor(role, index) {
    const B = (template && template.backgrounds) || {};
    const list = B[role] || B.lyrics || B.card || [];
    if (!list.length) return { css: 'linear-gradient(180deg,#E6F0FA,#FFFFFF)' };
    return list[index % list.length];
  }
  let bgFlip = false, lastBg = '';
  function setBackground(bg) {
    const css = bg.src ? `url("templates/${template.id}/${bg.src}")` : (bg.css || '#DCE9F6');
    if (css === lastBg) return;
    lastBg = css;
    const a = $('#bg-a'), b = $('#bg-b');
    const show = bgFlip ? a : b, hide = bgFlip ? b : a;
    show.style.background = css; show.style.backgroundSize = 'cover'; show.style.backgroundPosition = 'center';
    show.classList.add('on'); hide.classList.remove('on');
    bgFlip = !bgFlip;
  }

  /* ---------------- rendering ---------------- */
  function videoWanted(p) {
    if (!player.clips.length || !videoForced) return false;
    if (p.kind === 'darshan') return true;
    const on = state.settings.videoOn;
    if (on === 'off') return false;
    if (p.en.custom) return p.en.custom.video !== false && (p.kind === 'lyrics' || p.kind === 'card' || p.kind === 'image' || on === 'all');
    if (on === 'all') return p.kind !== 'title';
    if (p.kind !== 'lyrics') return false;
    return on === 'lyrics' || (on === 'songs' && p.en.item.isSong);
  }

  function render() {
    queueMicrotask(broadcastStatus);
    const p = pages[cur];
    $('#counter').textContent = pages.length ? `${cur + 1} / ${pages.length}` : '0 / 0';
    highlightEditorRow();
    if (!p) {
      slideEl.innerHTML = `<div class="col center"><div class="panel"><h1 class="s-title">No slides yet</h1><div class="s-meaning">${loadError ? 'The deck couldn’t be loaded: ' + esc(loadError) + '<br>' : ''}Check the Sai Rhythms link in Settings, then press Reload from list.</div></div></div>`;
      nextBox.hidden = true; stage.className = ''; return;
    }
    const bg = bgFor(p.role, p.bgIndex);
    setBackground(bg);
    const wantVideo = videoWanted(p);
    const vs = videoSettings();
    let colClass = 'center';
    // keep the last geometry while the video fades out, so it doesn't jump
    const setGeom = g => { stage.classList.remove('vs-left', 'vs-right', 'vs-big'); stage.classList.add(g); };
    if (p.kind === 'darshan') setGeom('vs-big');
    else if (wantVideo) { setGeom(vs.videoSide === 'right' ? 'vs-right' : 'vs-left'); colClass = vs.videoSide === 'right' ? 'left' : 'right'; }
    stage.classList.toggle('video-on', p.kind === 'darshan' || wantVideo);
    stage.classList.toggle('is-title', p.kind === 'title');                 // no top text on the title slide
    stage.classList.toggle('is-cover', p.kind === 'title' && !!state.cover); // a full picture replaces the title slide
    layoutVideo();
    player.setActive(wantVideo);

    slideEl.innerHTML = slideHtml(p, colClass);
    fitText();
    renderNext(p);
  }

  function leadHtml(it) {
    if (!it || !state.settings.showSinger || !it.isSong) return '';
    if (!it.singer && !it.pitch) return '';
    return `<div class="s-lead">${it.singer ? `<span>${esc(it.singer)}</span>` : ''}${it.pitch ? `<span class="pitch">${esc(it.pitch)}</span>` : ''}</div>`;
  }

  function slideHtml(p, colClass) {
    const it = p.en.item, c = p.en.custom;
    const title = it ? it.title : (c.title || '');
    const pageNote = p.pageCount > 1 ? `<div class="s-page">${p.pageNo} of ${p.pageCount}</div>` : '';
    switch (p.kind) {
      case 'title':
        if (state.cover) return `<div class="cover"><img src="${esc(absUrl(state.cover))}" alt="${esc(it.title)}" onerror="this.closest('.cover').classList.add('broken')"><div class="cover-msg">The title picture couldn’t be loaded. Check its link in Settings → Title slide.</div></div>`;
        return `<div class="col full"><div class="s-hero"><div class="s-card">${esc(it.title)}</div>${it.date ? `<div class="s-card-sub">${esc(it.date)}</div>` : ''}</div></div>`;
      case 'card':
        return `<div class="col ${colClass === 'center' ? 'full' : colClass}"><div class="s-card">${esc(title)}</div></div>`;
      case 'darshan':
        return '';
      case 'image': {
        const src = absUrl(c.image || '');
        return `<div class="col ${colClass === 'center' ? 'full' : colClass} has-image">${title ? `<h1 class="s-title">${esc(title)}</h1>` : ''}${src ? `<img class="s-image" src="${esc(src)}" alt="${esc(title)}">` : '<div class="s-meaning">Add a picture link to this slide in Edit slides.</div>'}</div>`;
      }
      case 'html':
        return `<div class="col center"><div class="panel"><h1 class="s-title">${esc(title)}</h1><div class="s-rule"></div><div class="s-html scroller">${it.html}</div></div></div>`;
      case 'prose':
        return `<div class="col center"><div class="panel"><h1 class="s-title">${esc(title)}</h1><div class="s-rule"></div><div class="s-prose scroller">${p.text.split(/\n+/).map(t => `<p>${esc(t)}</p>`).join('')}</div>${pageNote}</div></div>`;
      case 'lyrics': {
        const meaning = it && state.settings.showMeaning && it.meaning && p.pageNo === p.pageCount ? `<div class="s-meaning">${esc(it.meaning)}</div>` : '';
        return `<div class="col ${colClass}"><div class="panel"><h1 class="s-title">${esc(title)}</h1>${leadHtml(it)}<div class="s-rule"></div><div class="s-lyrics scroller">${p.lines.map(l => `<div>${esc(l)}</div>`).join('')}</div>${meaning}${pageNote}</div></div>`;
      }
    }
    return '';
  }

  function fitText() {
    const col = slideEl.querySelector('.col');
    if (!col) return;
    const box = col.querySelector('.panel') || col;
    let k = zoom;
    stage.style.setProperty('--k', k);
    const over = () => box.scrollHeight > box.clientHeight + 2 || box.scrollHeight > col.clientHeight + 2 || col.scrollHeight > col.clientHeight + 2 || box.scrollWidth > box.clientWidth + 2;
    let guard = 0;
    const sc = box.querySelector('.scroller');
    const floor = sc && scrollMode() ? (sc.classList.contains('s-lyrics') ? 0.72 : 0.6) * zoom : 0.42;   // below this size, scroll instead of shrinking
    const shrink = () => { while (over() && k > floor && guard++ < 60) { k -= 0.04; stage.style.setProperty('--k', k.toFixed(2)); } };
    shrink();
    // Zoomed in but no room: the lyrics matter more than the meaning, so drop the meaning and try again.
    const meaning = col.querySelector('.s-meaning');
    if (zoom > 1 && meaning && k < zoom - 0.05) { meaning.remove(); k = zoom; guard = 0; stage.style.setProperty('--k', k); shrink(); }
    if (sc && scrollMode() && over()) {
      box.classList.add('scrolling');
      sc.insertAdjacentHTML('afterend', '<div class="s-more" aria-hidden="true">▾ more</div>');
      sc.addEventListener('scroll', updateScrollHints, { passive: true });
      updateScrollHints();
      return;
    }
    // Prefer each lyric line on one line: shrink a little more if a line wraps.
    const lines = [...col.querySelectorAll('.s-lyrics > div')];
    if (!lines.length || zoom > 1) return; // when the text is zoomed in, bigger matters more than one-line lyrics
    const wraps = () => lines.some(d => d.offsetHeight > parseFloat(getComputedStyle(d).lineHeight) * 1.5);
    guard = 0;
    while (wraps() && k > 0.74 * zoom && guard++ < 30) { k -= 0.03; stage.style.setProperty('--k', k.toFixed(2)); }
  }

  function renderNext(p) {
    const it = p.en.item;
    const nx = p.next;
    const show = nx && (nx.isSong || (it && it.isSong));
    if (!show || p.kind === 'title') { nextBox.hidden = true; return; }
    const meta = nx.isSong && (nx.singer || nx.pitch)
      ? `<div class="nb-meta">${nx.singer ? `<span>${esc(nx.singer)}</span>` : ''}${nx.pitch ? `<span class="pitch">${esc(nx.pitch)}</span>` : ''}</div>` : '';
    nextBox.innerHTML = `<div class="nb-label">Next</div><div class="nb-title">${esc(nx.title)}</div>${meta}`;
    nextBox.hidden = false;
  }

  function go(i, fromEnd = false) {
    if (!pages.length) return;
    cur = Math.max(0, Math.min(pages.length - 1, i));
    render();
    const s = scroller();
    if (s && fromEnd) { s.scrollTop = s.scrollHeight; updateScrollHints(); }
  }
  /* long bhajans scroll within their slide: Next scrolls down first, then moves on */
  function scroller() { return slideEl.querySelector('.panel.scrolling .scroller'); }
  function updateScrollHints() {
    const s = scroller(); if (!s) return;
    const panel = s.closest('.panel');
    panel.classList.toggle('more-below', s.scrollTop + s.clientHeight < s.scrollHeight - 4);
    panel.classList.toggle('more-above', s.scrollTop > 4);
  }
  function stepScroll(dir, frac) {
    const s = scroller(); if (!s) return false;
    const behavior = stage.classList.contains('no-motion') ? 'auto' : 'smooth';
    if (dir > 0 && s.scrollTop + s.clientHeight < s.scrollHeight - 4) { s.scrollBy({ top: s.clientHeight * frac, behavior }); return true; }
    if (dir < 0 && s.scrollTop > 4) { s.scrollBy({ top: -s.clientHeight * frac, behavior }); return true; }
    return false;
  }
  function advance(frac = 0.8) { if (!stepScroll(1, frac)) go(cur + 1); }
  function retreat(frac = 0.8) { if (!stepScroll(-1, frac)) go(cur - 1, true); }

  /* ---------------- YouTube darshan video ---------------- */
  let videoPreview = null;   // live values while the Settings dialog is open
  function videoSettings() { return videoPreview || state.settings; }
  function layoutVideo() {
    const s = videoSettings();
    const vw = Math.round(Math.max(25, Math.min(70, +s.videoWidth || 45)) * 19.2);
    stage.style.setProperty('--vw', vw + 'px');
    stage.style.setProperty('--feather', Math.max(0, Math.min(70, +s.videoFeather || 0)) + '%');
    const el = $('#video-frame').firstElementChild; if (!el) return;
    const W = stage.classList.contains('vs-big') ? 1920 : vw, H = 1080;
    const base = Math.max(W / 16, H / 9), z = Math.max(1, (+s.videoZoom || 100) / 100);
    const w = 16 * base * z, h = 9 * base * z;
    let left = W / 2 - (+s.videoFocusX / 100) * w, top = H / 2 - (+s.videoFocusY / 100) * h;
    left = Math.min(0, Math.max(W - w, left)); top = Math.min(0, Math.max(H - h, top));
    Object.assign(el.style, { width: w + 'px', height: h + 'px', left: left + 'px', top: top + 'px' });
  }
  const player = {
    yt: null, ready: false, clips: [], idx: 0, active: false, apiRequested: false,
    parse(text) {
      const toSec = t => {
        if (t == null || t === '') return undefined;
        if (/^\d+$/.test(t)) return +t;
        const m = String(t).match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
        if (m && (m[1] || m[2] || m[3])) return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
        const parts = String(t).split(':').map(Number);
        if (parts.some(isNaN)) return undefined;
        return parts.reduce((a, n) => a * 60 + n, 0);
      };
      return (text || '').split('\n').map(l => l.trim()).filter(Boolean).map(line => {
        const id = (line.match(/(?:youtu\.be\/|[?&]v=|\/embed\/|\/live\/|\/shorts\/)([A-Za-z0-9_-]{11})/) || [])[1]
          || (/^[A-Za-z0-9_-]{11}$/.test(line.split(/\s+/)[0]) ? line.split(/\s+/)[0] : null);
        if (!id) return null;
        const urlT = (line.match(/[?&](?:t|start)=([0-9hms:]+)/) || [])[1];
        const range = line.replace(/^\S+/, '').trim().match(/^([0-9:]+)\s*[-–]\s*([0-9:]+)$/);
        const start = range ? toSec(range[1]) : toSec(urlT);
        const end = range ? toSec(range[2]) : undefined;
        return { id, start, end };
      }).filter(Boolean);
    },
    configure(text) {
      const clips = this.parse(text);
      const changed = JSON.stringify(clips) !== JSON.stringify(this.clips);
      this.clips = clips;
      if (!clips.length) { this.stop(); return; }
      if (!this.apiRequested) { this.apiRequested = true; const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; document.head.appendChild(s); }
      else if (this.ready && changed) { this.idx = 0; this.load(); }
    },
    create() {
      const c = this.clips[0];
      this.yt = new YT.Player('yt-player', {
        videoId: c.id,
        playerVars: { autoplay: 1, mute: 1, controls: 0, rel: 0, playsinline: 1, iv_load_policy: 3, disablekb: 1, fs: 0, start: c.start || 0, end: c.end, origin: location.origin },
        events: {
          onReady: () => { this.ready = true; this.yt.mute(); this.yt.playVideo(); layoutVideo(); },
          onStateChange: ev => { if (ev.data === YT.PlayerState.ENDED) this.advance(); },
          onError: () => setTimeout(() => this.advance(), 1500),
        },
      });
    },
    load() {
      const c = this.clips[this.idx % this.clips.length];
      if (!this.yt || !c) return;
      this.yt.loadVideoById({ videoId: c.id, startSeconds: c.start || 0, endSeconds: c.end });
      this.yt.mute();
    },
    advance() { this.idx = (this.idx + 1) % this.clips.length; this.load(); },
    stop() { try { this.yt && this.yt.stopVideo(); } catch { } },
    setActive(on) { this.active = on; },
  };
  window.onYouTubeIframeAPIReady = () => { if (player.clips.length) player.create(); };

  /* ---------------- editor drawer ---------------- */
  function entryLabel(en) {
    if (en.custom) {
      const c = en.custom;
      const kind = c.type === 'image' ? 'Picture' : c.type === 'darshan' ? 'Darshan video' : 'Text';
      return { title: c.title || (c.type === 'darshan' ? 'Darshan video' : 'Untitled slide'), sub: `Added here, ${kind.toLowerCase()}${c.onlyDate ? ', this session only' : ''}${en.orphan ? ' (the slide it followed is gone from the list)' : ''}` };
    }
    const it = en.item;
    if (it.key === '__title__') return { title: it.title, sub: it.edited ? 'Title slide, edited here' : 'Title slide' };
    const bits = [];
    if (it.isSong) bits.push(it.singer ? `Bhajan, ${it.singer}` : 'Bhajan'); else bits.push(it.html ? 'Information' : 'Prayer');
    if (it.pitch) bits.push(`pitch ${it.pitch}`);
    if (it.hiddenSR) bits.push('hidden on Sai Rhythms');
    if (it.edited) bits.push(state.edits[it.key] && state.edits[it.key].onlyDate ? 'edited for this session' : 'edited here');
    return { title: it.title, sub: bits.join(', ') };
  }
  function renderEditor() {
    const list = $('#slide-list');
    list.innerHTML = '';
    let lastSlot = null;
    seq.forEach((en, i) => {
      const slot = en.item ? en.item.slot : (en.custom.slot || '');
      if (en.item && slot !== lastSlot && slot) {
        const li = document.createElement('li'); li.className = 'sec'; li.textContent = slot; list.appendChild(li);
        lastSlot = slot;
      }
      const { title, sub } = entryLabel(en);
      const li = document.createElement('li');
      li.className = 'row' + (en.custom ? ' custom' : '') + (en.hidden ? ' hidden-slide' : '');
      li.dataset.i = i;
      const tools = [];
      tools.push(`<button data-r="hide">${en.hidden ? 'Show' : 'Hide'}</button>`);
      tools.push(`<button data-r="add" aria-label="Add a slide after ${esc(title)}">Add after</button>`);
      tools.push(`<button data-r="edit">Edit</button>`);
      if (en.custom) tools.push(`<button data-r="delete" class="danger">Delete</button>`);
      li.innerHTML = `<div class="r-main" data-r="goto" title="Show this slide"><div class="r-title">${esc(title)}</div><div class="r-sub">${esc(sub)}</div></div><div class="r-tools">${tools.join('')}</div>`;
      list.appendChild(li);
    });
    highlightEditorRow();
  }
  function highlightEditorRow() {
    const p = pages[cur];
    document.querySelectorAll('#slide-list .row').forEach(r => r.classList.toggle('current', !!p && seq[+r.dataset.i] === p.en));
  }
  $('#slide-list').addEventListener('click', e => {
    const btn = e.target.closest('[data-r]'); if (!btn) return;
    const row = btn.closest('.row'); const en = seq[+row.dataset.i]; if (!en) return;
    const act = btn.dataset.r;
    if (act === 'goto') { const pi = pages.findIndex(p => p.en === en); if (pi >= 0) go(pi); else toast('This slide is hidden. Choose Show to include it.'); }
    if (act === 'hide') toggleHidden(en);
    if (act === 'add') openSlideDialog(null, en);
    if (act === 'edit') { if (en.custom) openSlideDialog(en.custom); else openItemDialog(en.item); }
    if (act === 'delete') {
      if (!confirm(`Delete “${entryLabel(en).title}”?`)) return;
      state.custom = state.custom.filter(c => c !== en.custom); afterEdit();
    }
  });
  function toggleHidden(en) {
    if (en.custom) en.custom.hidden = !en.custom.hidden;
    else {
      const k = en.item.key;
      if (en.hidden) { state.hide = state.hide.filter(x => x !== k); if (en.item.hiddenSR && !state.unhide.includes(k)) state.unhide.push(k); }
      else { state.unhide = state.unhide.filter(x => x !== k); if (!en.item.hiddenSR) state.hide.push(k); }
    }
    afterEdit();
  }
  function afterEdit(focusEntryMatch) {
    const keep = pages[cur] && pages[cur].en;
    build();
    let idx = -1;
    if (focusEntryMatch) idx = pages.findIndex(p => p.en.custom === focusEntryMatch);
    if (idx < 0 && keep) idx = pages.findIndex(p => (keep.item && p.en.item && p.en.item.key === keep.item.key) || (keep.custom && p.en.custom === keep.custom));
    cur = idx >= 0 ? idx : Math.min(cur, Math.max(0, pages.length - 1));
    render(); renderEditor(); saveState();
  }

  /* add / edit custom slide */
  let dialogCtx = null;
  function openSlideDialog(custom, afterEntry) {
    const d = $('#slide-dialog'), f = $('#slide-form');
    dialogCtx = { custom, afterEntry };
    $('#slide-dialog-title').textContent = custom ? 'Edit slide' : 'Add a slide';
    f.type.value = custom ? custom.type : 'text';
    f.title.value = custom ? (custom.title || '') : '';
    f.body.value = custom ? (custom.body || '') : '';
    f.image.value = custom ? (custom.image || '') : '';
    f.video.checked = custom ? custom.video !== false : true;
    f.onlyDate.checked = custom ? !!custom.onlyDate : false;
    $('#slide-only-date').textContent = model && model.date ? model.date : 'this session';
    syncSlideDialog();
    d.showModal();
  }
  function syncSlideDialog() {
    const f = $('#slide-form'); const t = f.type.value;
    f.querySelectorAll('[data-for]').forEach(l => { l.hidden = !l.dataset.for.split(' ').includes(t); });
  }
  $('#slide-form').type.addEventListener('change', syncSlideDialog);
  $('#slide-dialog').addEventListener('close', () => {
    const d = $('#slide-dialog'); if (d.returnValue !== 'save' || !dialogCtx) return;
    const f = $('#slide-form');
    const data = { type: f.type.value, title: f.title.value.trim(), body: f.body.value.replace(/\s+$/, ''), image: f.image.value.trim(), video: f.video.checked, onlyDate: f.onlyDate.checked && model && model.date ? model.date : '' };
    let target;
    if (dialogCtx.custom) { Object.assign(dialogCtx.custom, data); target = dialogCtx.custom; }
    else {
      const a = dialogCtx.afterEntry;
      target = { id: uid(), hidden: false, ...data };
      if (!a) { target.after = '__start__'; target.slot = ''; state.custom.unshift(target); }
      else if (a.item) {
        target.after = a.item.key; target.slot = a.item.slot;
        // place before any slides already anchored to the same item → appears right after it
        const firstIdx = state.custom.findIndex(c => c.after === a.item.key);
        if (firstIdx >= 0) state.custom.splice(firstIdx, 0, target); else state.custom.push(target);
      } else {
        target.after = a.custom.after; target.slot = a.custom.slot;
        state.custom.splice(state.custom.indexOf(a.custom) + 1, 0, target);
      }
    }
    dialogCtx = null;
    afterEdit(target);
  });

  /* edit a slide that comes from Sai Rhythms (changes are stored as overrides) */
  let itemCtx = null;
  function openItemDialog(it) {
    const d = $('#item-dialog'), f = $('#item-form');
    itemCtx = it;
    const e = state.edits[it.key];
    const has = editApplies(e) ? e : {};
    const val = fld => typeof has[fld] === 'string' ? has[fld] : it.orig[fld];
    const show = new Set(['title']);
    if (it.kind === 'title') show.add('sub');
    else if (it.orig.text) show.add('text');
    else {
      show.add('lyrics');
      if (it.isSong) { show.add('singer'); show.add('pitch'); }
      if (it.orig.lyrics || it.isSong) show.add('meaning');
    }
    f.querySelectorAll('[data-field]').forEach(l => { l.hidden = !show.has(l.dataset.field); });
    for (const fld of EDIT_FIELDS) if (f[fld]) f[fld].value = val(fld);
    f.onlyDate.checked = e ? !!e.onlyDate : !!it.isSong;
    $('#item-only-date').textContent = model && model.date ? model.date : 'this session';
    $('#item-dialog-title').textContent = it.kind === 'title' ? 'Edit the title slide' : 'Edit slide';
    $('#item-reset').hidden = !e;
    f.dataset.show = [...show].join(' ');
    d.showModal();
  }
  $('#item-dialog').addEventListener('close', () => {
    const d = $('#item-dialog'), it = itemCtx; itemCtx = null;
    if (!it || (d.returnValue !== 'save' && d.returnValue !== 'reset')) return;
    if (d.returnValue === 'reset') { delete state.edits[it.key]; afterEdit(); toast('Back to the Sai Rhythms version.'); return; }
    const f = $('#item-form'), show = f.dataset.show.split(' '), e = {};
    const norm = s => String(s || '').replace(/\r/g, '').replace(/[ \t]+$/gm, '').trim();
    for (const fld of show) if (norm(f[fld].value) !== norm(it.orig[fld])) e[fld] = norm(f[fld].value);
    if (!Object.keys(e).length) delete state.edits[it.key];
    else { if (f.onlyDate.checked && model && model.date) e.onlyDate = model.date; state.edits[it.key] = e; }
    afterEdit();
  });

  /* title slide: text and optional picture */
  function titleOrig() { return { title: (model && model.name) || 'Devotional session', sub: (model && model.date) || '' }; }
  function titleSlideInfo() {
    const e = state.edits.__title__ || {}, o = titleOrig();
    return { title: typeof e.title === 'string' ? e.title : '', sub: typeof e.sub === 'string' ? e.sub : '', origTitle: o.title, origSub: o.sub, cover: state.cover || '' };
  }
  // Empty boxes mean "use what Sai Rhythms has" (center name and date).
  function setTitleSlide({ title, sub, cover }) {
    const o = titleOrig(), e = {};
    title = String(title || '').trim(); sub = String(sub || '').trim();
    if (title && title !== o.title) e.title = title;
    if (sub && sub !== o.sub) e.sub = sub;
    if (Object.keys(e).length) state.edits.__title__ = e; else delete state.edits.__title__;
    if (cover !== undefined) state.cover = String(cover || '').trim();
  }

  /* ---------------- text size (zoom) ---------------- */
  function setZoom(z) {
    const nz = Math.round(Math.max(0.6, Math.min(1.8, z)) * 10) / 10;
    if (nz === zoom) { toast(nz > 1 ? 'Text is at the largest size.' : 'Text is at the smallest size.', false, 1800); return; }
    zoom = nz; lsSet(LS.zoom, zoom);
    const keep = pages[cur] && pages[cur].en, keepPage = pages[cur] ? pages[cur].pageNo : 1;
    build();
    const same = en => keep && ((keep.item && en.item && en.item.key === keep.item.key) || (keep.custom && en.custom && en.custom.id === keep.custom.id));
    const first = pages.findIndex(p => same(p.en));
    if (first >= 0) { let i = first; while (pages[i + 1] && same(pages[i + 1].en) && pages[i].pageNo < keepPage) i++; cur = i; }
    render(); if (!$('#editor').hidden) renderEditor();
    toast(`Text size ${Math.round(zoom * 100)}%`, false, 1500);
  }

  /* ---------------- banner text and clock ---------------- */
  let clockTimer = null;
  const TICKER_SPEED = { slow: 70, medium: 105, fast: 150 };   // stage pixels per second
  let tickerSig = '';
  function renderTicker() {
    const t = state.ticker || cleanTicker();
    const items = (t.text || '').split('\n').map(s => s.trim()).filter(Boolean);
    const on = t.on && items.length > 0;
    stage.classList.toggle('has-ticker', on);
    const el = $('#ticker');
    el.hidden = !on;
    if (!on) { tickerSig = ''; return; }
    const sig = JSON.stringify([items, t.speed]);
    if (sig === tickerSig) return;              // unchanged: don't restart the scroll
    tickerSig = sig;
    const run = items.map(s => `<span class="tk-item">${esc(s)}</span><span class="tk-sep">✦</span>`).join('');
    const track = el.querySelector('.tk-track');
    track.style.animation = 'none';
    track.innerHTML = `<div class="tk-run">${run}</div><div class="tk-run" aria-hidden="true">${run}</div>`;
    requestAnimationFrame(() => {
      const w = track.firstElementChild.offsetWidth || 1000;
      track.style.setProperty('--tk-shift', -w + 'px');
      track.style.animation = `tk-scroll ${(w / (TICKER_SPEED[t.speed] || 70)).toFixed(1)}s linear infinite`;
    });
  }
  function renderOverlays() {
    renderTicker();
    const b = $('#banner'), text = (state.banner || '').trim();
    b.textContent = text; b.hidden = !text;
    stage.classList.toggle('has-banner', !!text);
    const c = $('#clock');
    clearInterval(clockTimer);
    if (state.settings.showClock) {
      const tick = () => { c.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
      tick(); clockTimer = setInterval(tick, 5000); c.hidden = false;
    } else c.hidden = true;
  }

  /* ---------------- logos ---------------- */
  const LOGO_H = { small: 80, medium: 110, large: 150 };
  function renderLogos() {
    const s = state.settings, wrap = $('#logos');
    wrap.innerHTML = '';
    stage.style.setProperty('--logo-h', (LOGO_H[s.logoSize] || 110) + 'px');
    const updateTop = () => {
      stage.classList.toggle('logo-top', !!wrap.querySelector('img.top-left:not([hidden]), img.top-right:not([hidden])'));
      const bl = wrap.querySelector('img.bottom-left:not([hidden])');   // keep the clock clear of a bottom-left logo
      stage.style.setProperty('--clock-left', bl && bl.complete && bl.naturalWidth ? (40 + bl.offsetWidth + 24) + 'px' : '40px');
    };
    [[s.logo1, s.logo1Pos], [s.logo2, s.logo2Pos]].forEach(([src, pos]) => {
      if (!src || !pos || pos === 'off') return;
      const img = new Image();
      img.className = 'logo ' + pos; img.alt = '';
      img.onerror = () => { img.hidden = true; updateTop(); };
      img.onload = updateTop;
      img.src = absUrl(src);
      wrap.appendChild(img);
    });
    updateTop();
  }

  /* ---------------- settings ---------------- */
  function openSettings() {
    const f = $('#settings-form'), s = state.settings;
    f.template.innerHTML = templates.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
    f.saiUrl.value = s.saiUrl; f.videos.value = s.videos; f.videoOn.value = s.videoOn; f.template.value = s.template;
    f.maxLines.value = s.maxLines; f.longText.value = s.longText || 'scroll'; f.showMeaning.checked = s.showMeaning; f.showSinger.checked = s.showSinger; f.titleSlide.checked = s.titleSlide;
    for (const n of VIDEO_FIELDS) f[n].value = s[n];
    f.banner.value = state.banner || ''; f.showClock.checked = !!s.showClock;
    { const t = titleSlideInfo(); f.titleText.value = t.title; f.titleText.placeholder = t.origTitle; f.titleSub.value = t.sub; f.titleSub.placeholder = t.origSub || 'Line under the title'; f.cover.value = t.cover; }
    f.tickerText.value = (state.ticker && state.ticker.text) || ''; f.tickerOn.checked = !!(state.ticker && state.ticker.on); f.tickerSpeed.value = (state.ticker && state.ticker.speed) || 'slow';
    showRangeValues();
    f.logo1.value = s.logo1 || ''; f.logo1Pos.value = s.logo1Pos || 'off'; f.logo2.value = s.logo2 || ''; f.logo2Pos.value = s.logo2Pos || 'off'; f.logoSize.value = s.logoSize || 'medium';
    $('#settings-dialog').showModal();
  }
  const VIDEO_FIELDS = ['videoSide', 'videoWidth', 'videoZoom', 'videoFocusX', 'videoFocusY', 'videoFeather'];
  function showRangeValues() {
    document.querySelectorAll('#settings-form [data-show-value]').forEach(o => { const i = $('#settings-form')[o.dataset.showValue]; o.textContent = i.value + '%'; });
  }
  $('#settings-form').addEventListener('input', e => {
    if (!VIDEO_FIELDS.includes(e.target.name)) return;
    const f = $('#settings-form');
    videoPreview = { ...state.settings };
    for (const n of VIDEO_FIELDS) videoPreview[n] = n === 'videoSide' ? f[n].value : +f[n].value;
    showRangeValues(); render();
  });
  $('#settings-dialog').addEventListener('close', async () => {
    videoPreview = null;
    if ($('#settings-dialog').returnValue !== 'save') { render(); return; }
    const f = $('#settings-form'), s = state.settings;
    const newUrl = f.saiUrl.value.trim();
    const urlChanged = newUrl !== s.saiUrl;
    const tplChanged = f.template.value !== s.template;
    const typedBanner = f.banner.value.trim(), bannerBefore = state.banner || '';
    const tickerBefore = cleanTicker(state.ticker);
    const titleBefore = titleSlideInfo();
    const typedTitle = { title: f.titleText.value.trim(), sub: f.titleSub.value.trim(), cover: f.cover.value.trim() };
    if (urlChanged) switchDeck(newUrl);           // the newly chosen deck brings its own top text…
    if (!urlChanged || typedBanner !== bannerBefore) state.banner = typedBanner;   // …unless it was just changed here
    const typedTicker = cleanTicker({ text: f.tickerText.value.trim(), on: f.tickerOn.checked, speed: f.tickerSpeed.value });
    if (!urlChanged || JSON.stringify(typedTicker) !== JSON.stringify(tickerBefore)) state.ticker = typedTicker;
    const titleTouched = typedTitle.title !== titleBefore.title || typedTitle.sub !== titleBefore.sub || typedTitle.cover !== titleBefore.cover;
    if (!urlChanged || titleTouched) setTitleSlide(typedTitle);
    Object.assign(s, {
      showClock: f.showClock.checked,
      videos: f.videos.value.trim(), videoOn: f.videoOn.value, template: f.template.value,
      maxLines: Math.max(4, Math.min(20, +f.maxLines.value || 10)), longText: f.longText.value,
      showMeaning: f.showMeaning.checked, showSinger: f.showSinger.checked, titleSlide: f.titleSlide.checked,
      videoSide: f.videoSide.value, videoWidth: +f.videoWidth.value, videoZoom: +f.videoZoom.value,
      videoFocusX: +f.videoFocusX.value, videoFocusY: +f.videoFocusY.value, videoFeather: +f.videoFeather.value,
      logo1: f.logo1.value.trim(), logo1Pos: f.logo1Pos.value, logo2: f.logo2.value.trim(), logo2Pos: f.logo2Pos.value, logoSize: f.logoSize.value,
    });
    player.configure(s.videos);
    renderLogos(); renderOverlays();
    if (tplChanged) { lastBg = ''; await applyTemplate(s.template); }
    if (urlChanged) await loadDeck(true);
    afterEdit();
    toast('Settings saved.');
  });
  $('#settings-form').addEventListener('click', e => {
    const a = e.target.closest('[data-act]'); if (!a) return;
    if (a.dataset.act === 'export') {
      stashDeckData();
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
      const link = document.createElement('a'); link.href = URL.createObjectURL(blob);
      link.download = `bhajan-slides-backup-${new Date().toISOString().slice(0, 10)}.json`; link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 2000);
    }
    if (a.dataset.act === 'import') $('#import-file').click();
  });
  $('#import-file').addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data.settings) throw new Error('This file isn’t a slides backup.');
      mergeState(data); $('#settings-dialog').close('cancel');
      player.configure(state.settings.videos); renderLogos(); renderOverlays(); lastBg = ''; await applyTemplate(state.settings.template); await loadDeck(true);
      afterEdit(); toast('Backup restored.');
    } catch (err) { toast('Couldn’t restore: ' + err.message, true); }
    e.target.value = '';
  });

  /* ---------------- reload ---------------- */
  async function applySharedChanges() {
    const before = state.settings.template;
    player.configure(state.settings.videos); renderLogos(); renderOverlays();
    if (state.settings.template !== before || !template || template.id !== state.settings.template) { lastBg = ''; await applyTemplate(state.settings.template); }
  }
  async function reload() {
    const keep = pages[cur] && pages[cur].en;
    toast('Reloading from Sai Rhythms…', false, 20000);
    const urlBefore = state.settings.saiUrl;
    await loadState();           // settings, edits and added slides saved from another tab or laptop
    await applySharedChanges();
    if (deckKey(urlBefore) !== deckKey(state.settings.saiUrl)) deck = null;
    const ok = await loadDeck(true);
    if (!ok) return;
    build();
    let idx = -1;
    if (keep) idx = pages.findIndex(p => (keep.item && p.en.item && p.en.item.key === keep.item.key) || (keep.custom && p.en.custom && p.en.custom.id === keep.custom.id));
    cur = idx >= 0 ? idx : Math.min(cur, Math.max(0, pages.length - 1));
    render(); renderEditor();
  }

  /* ---------------- input ---------------- */
  function toggleEditor(force) {
    const ed = $('#editor');
    const open = force ?? ed.hidden;
    ed.hidden = !open;
    if (open) { renderEditor(); setEditorStatus(RELAY ? 'Changes here are shared with every laptop.' : 'Preview mode: changes are saved on this laptop only.'); const c = $('#slide-list .row.current'); if (c) c.scrollIntoView({ block: 'center' }); }
  }
  function fullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => toast('Full screen was blocked. Press F11 instead.', true));
  }
  $('#controls').addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    ({ prev: () => retreat(), next: () => advance(), reload, editor: () => toggleEditor(), settings: openSettings, controls: openControls, fullscreen, smaller: () => setZoom(zoom - 0.1), larger: () => setZoom(zoom + 0.1) })[b.dataset.act]();
  });
  $('#editor').addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    if (b.dataset.act === 'close-editor') toggleEditor(false);
    if (b.dataset.act === 'add-start') openSlideDialog(null, null);
  });
  $('#viewport').addEventListener('click', e => {
    if (!$('#editor').hidden) return;
    if (e.target.closest('.scroller')) return;   // clicking inside lyrics shouldn't jump away
    if (e.clientX < window.innerWidth * 0.25) retreat(); else advance();
  });
  document.addEventListener('keydown', e => {
    if (document.querySelector('dialog[open]')) return;
    if (e.target.matches('input, textarea, select')) return;
    const k = e.key;
    if (k === 'ArrowDown') { e.preventDefault(); advance(0.35); }
    else if (k === 'ArrowUp') { e.preventDefault(); retreat(0.35); }
    else if (['ArrowRight', 'PageDown', ' ', 'Enter'].includes(k)) { e.preventDefault(); advance(); }
    else if (['ArrowLeft', 'PageUp', 'Backspace'].includes(k)) { e.preventDefault(); retreat(); }
    else if (k === 'Home') go(0);
    else if (k === 'End') go(pages.length - 1);
    else if (k === 'r' || k === 'R') reload();
    else if (k === 'e' || k === 'E') toggleEditor();
    else if (k === 'f' || k === 'F') fullscreen();
    else if (k === 'b' || k === 'B' || k === '.') { blackout = !blackout; $('#blackout').hidden = !blackout; }
    else if (k === 'v' || k === 'V') { videoForced = !videoForced; render(); toast(videoForced ? 'Darshan video on.' : 'Darshan video off for now.', false, 2000); }
    else if (k === '+' || k === '=' || k === 'Add') { e.preventDefault(); setZoom(zoom + 0.1); }
    else if (k === '-' || k === '_' || k === 'Subtract') { e.preventDefault(); setZoom(zoom - 0.1); }
    else if (k === '0') setZoom(1);
    else if (k === 'c' || k === 'C') openControls();
    else if (k === 'Escape') toggleEditor(false);
  });

  window.addEventListener('storage', async e => {
    if (e.key !== LS.state || !e.newValue) return;
    try {
      const urlBefore = state.settings.saiUrl;
      mergeState(JSON.parse(e.newValue));
      await applySharedChanges();
      if (deckKey(urlBefore) !== deckKey(state.settings.saiUrl)) await loadDeck(true);
      afterEditNoSave();
    } catch { /* ignore */ }
  });
  function afterEditNoSave() {
    const keep = pages[cur] && pages[cur].en;
    build();
    let idx = -1;
    if (keep) idx = pages.findIndex(p => (keep.item && p.en.item && p.en.item.key === keep.item.key) || (keep.custom && p.en.custom && p.en.custom.id === keep.custom.id));
    cur = idx >= 0 ? idx : Math.min(cur, Math.max(0, pages.length - 1));
    render(); if (!$('#editor').hidden) renderEditor();
  }

  /* ---------------- control page link ---------------- */
  // The control page (control.html) talks to this window through a BroadcastChannel (same browser, instant).
  const myId = Math.random().toString(36).slice(2, 9);
  const chan = 'BroadcastChannel' in window ? new BroadcastChannel('bhajan-slides') : null;
  function slideListForControl() {
    const out = []; let last = null;
    pages.forEach((p, i) => {
      if (p.en === last) return; last = p.en;
      const it = p.en.item, c = p.en.custom;
      out.push({ i, title: it ? it.title : (c.title || (c.type === 'darshan' ? 'Darshan video' : 'Added slide')), section: it ? it.slot : (c.slot || ''), song: !!(it && it.isSong), singer: it && it.isSong ? it.singer : '', pitch: it && it.isSong ? it.pitch : '', added: !!c });
    });
    return out;
  }
  function broadcastStatus() {
    if (!chan) return;
    const p = pages[cur];
    const title = p ? (p.en.item ? p.en.item.title : (p.en.custom.title || 'Added slide')) : '';
    chan.postMessage({
      type: 'status', id: myId, fullscreen: !!document.fullscreenElement, visible: document.visibilityState === 'visible', at: Date.now(),
      cur, total: pages.length, title, next: p && p.next ? { title: p.next.title, singer: p.next.isSong ? p.next.singer : '', pitch: p.next.isSong ? p.next.pitch : '' } : null,
      scroll: !!scroller(), blackout, video: videoForced, zoom,
      deck: model ? { name: model.name, date: model.date } : null, saiUrl: state.settings.saiUrl,
      banner: state.banner || '', ticker: cleanTicker(state.ticker), titleSlide: titleSlideInfo(), list: slideListForControl(),
      relay: !!RELAY, hasPin: !!lsGet(LS.pin, ''), saveNote: lastSaveNote,
    });
  }
  if (chan) chan.onmessage = async ev => {
    const m = ev.data || {};
    if (m.type === 'hello') { broadcastStatus(); return; }
    if (m.type !== 'cmd' || (m.target && m.target !== myId)) return;
    switch (m.cmd) {
      case 'next': advance(); break;
      case 'prev': retreat(); break;
      case 'goto': go(+m.i || 0); break;
      case 'gotoTitle': { const t = pages.findIndex(p => p.kind === 'title'); if (t >= 0) go(t); else toast('The title slide is turned off in Settings.', false, 3000); break; }
      case 'blackout': blackout = !blackout; $('#blackout').hidden = !blackout; break;
      case 'video': videoForced = !videoForced; render(); break;
      case 'reload': await reload(); break;
      case 'larger': setZoom(zoom + 0.1); break;
      case 'smaller': setZoom(zoom - 0.1); break;
      case 'ticker': state.ticker = cleanTicker(m.ticker); renderOverlays(); fitText(); saveState(true); break;
      case 'banner': state.banner = String(m.banner || '').trim(); renderOverlays(); render(); saveState(true); break;
      case 'titleSlide': setTitleSlide(m.titleSlide || {}); afterEditNoSave(); saveState(true); break;
      case 'pin': lsSet(LS.pin, String(m.pin || '')); lastSaveNote = 'Sharing…'; saveState(true); break;
    }
    broadcastStatus();
  };
  document.addEventListener('fullscreenchange', () => broadcastStatus());
  document.addEventListener('visibilitychange', () => broadcastStatus());
  function openControls() {
    const w = window.open('control.html', 'bhajan-controls', 'width=560,height=900');
    if (!w) toast('Your browser blocked the new window. Open srisathyasaipgh.github.io/control.html in a new window instead.', true, 9000);
  }

  // Changes saved on another laptop (or from a phone) reach this screen within about 20 seconds.
  async function pollShared() {
    if (!RELAY || document.querySelector('dialog[open]') || !$('#editor').hidden || saveTimer && Date.now() - lastLocalSave < 3000) return;
    try {
      const data = await relayGet({ action: 'state' });
      if (!data.state) return;
      const incoming = JSON.stringify(data.state);
      if (incoming === lastShared) return;
      lastShared = incoming;
      const urlBefore = state.settings.saiUrl;
      mergeState(data.state); lsSet(LS.state, state);
      await applySharedChanges();
      if (deckKey(urlBefore) !== deckKey(state.settings.saiUrl)) await loadDeck(true);
      afterEditNoSave();
    } catch { /* try again next time */ }
  }
  let lastLocalSave = 0;
  if (RELAY) setInterval(pollShared, 20000);

  let idleTimer = null;
  function wake() {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if ($('#editor').hidden && !document.querySelector('dialog[open]')) document.body.classList.add('idle'); }, 2500);
  }
  ['mousemove', 'mousedown', 'touchstart'].forEach(ev => document.addEventListener(ev, wake, { passive: true }));

  function scaleStage() {
    const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    stage.style.transform = `translate(${(window.innerWidth - 1920 * s) / 2}px, ${(window.innerHeight - 1080 * s) / 2}px) scale(${s})`;
  }
  window.addEventListener('resize', scaleStage);

  /* ---------------- start ---------------- */
  async function start() {
    scaleStage();
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) stage.classList.add('no-motion');
    await loadTemplates();
    await loadState();
    await applyTemplate(state.settings.template);
    await loadDeck(false);
    player.configure(state.settings.videos);
    renderLogos(); renderOverlays();
    build();
    if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch { } }
    render();
    $('#loading').remove();
    wake();
  }
  start();
})();
