
/* =====================================================================
 * SCML Explorer — Premiere
 * ---------------------------------------------------------------------
 * Single-page editor for Brashmonkey Spriter (.scml) character files.
 * Renders the character on an HTML5 canvas with bones, sprites, and
 * animation playback. Lets the user nudge/rotate/scale any bone or
 * sprite with a correction layer (so the original SCML data is
 * never touched), save those corrections, and export a "fixed"
 * viewer that bakes the corrections in as the new defaults.
 *
 * File layout (when refactored):
 *   index.html   — page structure + external script/link tags
 *   style.css    — all styling, grouped by component
 *   app.js       — this file: all application logic
 *   data.js      — SCML data (folders, entities, images) as window.SCML_DATA
 *   corrections.js — user corrections as window.SCML_CORRECTIONS
 *
 * Section map of this file:
 *   1.  Data load & global state
 *   2.  Image cache + color filters
 *   3.  Math helpers (angles, interpolation, color space)
 *   4.  Naming, bones & objects
 *   5.  Correction layer (user-applied dx/dy/dAngle/dsx/dsy/dshear)
 *   6.  Timeline interpolation (curve_type easing)
 *   7.  Draw-order (z-index) reordering
 *   8.  Mainline keyframe resolution (which bones/objects are active at time t)
 *   9.  World-space bounding box (for spritesheet framing)
 *  10.  Canvas backdrop (size box)
 *  11.  Canvas setup (resize, world<->canvas mapping, world pivot cache)
 *  12.  Rendering (sprites, bones, labels, size box)
 *  13.  Hit testing (which bone/sprite is under the cursor)
 *  14.  Edit panel (right-side form, shows real world position)
 *  15.  Float toolbar (drag-to-move, real position+size)
 *  16.  Tracker (timeline rows with eye/keyframe)
 *  17.  Playback (play/pause loop, speed, step)
 *  18.  Drag (translate/rotate/scale handles)
 *  19.  Pan (alt+drag / middle-mouse-drag to pan the canvas)
 *  20.  Selection management
 *  21.  Undo/redo
 *  22.  Autosave
 *  23.  Color filter UI (picker, scope, add/remove)
 *  24.  Asset manager modal
 *  25.  New animation modal
 *  26.  Load project modal
 *  27.  Spritesheet export modal + preview
 *  28.  File modal (save/load JSON, export fixed viewer)
 *  29.  Window/UI bootstrap (init on DOMContentLoaded)
 * ===================================================================== */


// =====================================================================
// 1. Data load & global state
// ---------------------------------------------------------------------
// SCML data lives in data.js (window.SCML_DATA). Corrections live in
// corrections.js (window.SCML_CORRECTIONS). The fallback to inline
// <script id="data-holder"> / <script id="corrections-holder"> tags
// keeps older "Export fixed viewer" outputs working without changes.
// =====================================================================
if (!window.SCML_DATA) {
  const d = document.getElementById('data-holder');
  if (d) {
    try { window.SCML_DATA = JSON.parse(d.textContent); } catch (e) {}
  }
}
const DEFAULT_DATA = window.SCML_DATA;
let folders = DEFAULT_DATA.folders;
let entities = DEFAULT_DATA.entities;
let images = DEFAULT_DATA.images;

// User-applied corrections. Same data shape as before — either a
// wrapper object {corrections, animStartOffsets, colorFilters} or a
// bare corrections object (older format, keyed by numeric entity index).
if (!window.SCML_CORRECTIONS) {
  const c = document.getElementById('corrections-holder');
  if (c) {
    try { window.SCML_CORRECTIONS = JSON.parse(c.textContent || '{}'); } catch (e) {}
  }
}
let _loadedAppState = window.SCML_CORRECTIONS || {};
let corrections = ('corrections' in _loadedAppState) ? _loadedAppState.corrections : _loadedAppState;

// =====================================================================
// "Export fixed viewer" support
// ---------------------------------------------------------------------
// The export feature takes the current page, fetches style.css / app.js
// from the network (we're a browser; we can't read arbitrary local
// files), inlines them, and bakes in the current data + corrections
// as <script id="data-holder"> / <script id="corrections-holder">
// tags. The exported HTML is self-contained and works from file://.
// =====================================================================
const _dataMarkerStart = '<script id="data-holder" type="application/json">';
const _correctionsMarkerStart = '<script id="corrections-holder" type="application/json">';
const _scriptEnd = '</' + 'script>';
// Placeholder: when exporting, we replace this block with the actual
// data + corrections HTML so the exported file is self-contained.
const _exportPlaceholder = '/*__SCML_EXPORT_DATA_PLACEHOLDER__*/';

const imgCache = {};
function getImage(folderId, fileId) {
  const key = folderId + '_' + fileId;
  if (imgCache[key]) return imgCache[key];
  const im = new Image();
  im.src = images[key];
  imgCache[key] = im;
  return im;
}

// ---------- color filters (hue-based palette swap, shading-preserving) ----------
let colorFilters = []; // { id, sourceHex, targetHex, tolerance, scope }
if (Array.isArray(_loadedAppState.colorFilters)) colorFilters = _loadedAppState.colorFilters;
let filterIdCounter = colorFilters.length ? Math.max(...colorFilters.map(f => f.id || 0)) + 1 : 1;
const filteredImgCache = {};

function hexToRgb(hex) {
  hex = hex.replace('#', '');
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}
function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) { h = s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h /= 6;
  }
  return [h * 360, s, l];
}
function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3); g = hue2rgb(p, q, h); b = hue2rgb(p, q, h - 1 / 3);
  }
  return [r * 255, g * 255, b * 255];
}
function hueDist(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}
// Every filter is scoped to one specific sprite (folder,file) -- there is no more
// "whole project, every sprite" option. `animScope` additionally narrows it to just
// one animation; null means it applies to that sprite wherever it appears.
function applicableFilters(folderId, fileId, animName) {
  return colorFilters.filter(f =>
    f.spriteRef && f.spriteRef.folder === folderId && f.spriteRef.file === fileId &&
    (!f.animScope || f.animScope === animName)
  );
}
function filtersHashFor(list) {
  return list.map(f => f.id + f.sourceHex + f.targetHex + f.tolerance).join('|');
}

// Applies every applicable color filter to one image, once, caching the result on an
// offscreen canvas keyed by (image, animation context, applicable filter set).
// Near-grayscale pixels (outlines, highlights) are left untouched so recoloring
// doesn't wash out linework.
function getFilteredImage(folderId, fileId, animName) {
  const base = getImage(folderId, fileId);
  const applicable = applicableFilters(folderId, fileId, animName);
  if (applicable.length === 0) return base;
  const key = folderId + '_' + fileId + '::' + filtersHashFor(applicable);
  if (filteredImgCache[key]) return filteredImgCache[key];
  const ready = ('complete' in base ? base.complete === true : true) && ((base.naturalWidth || base.width) > 0);
  if (!ready) return base;
  const srcW = base.naturalWidth || base.width, srcH = base.naturalHeight || base.height;
  const off = document.createElement('canvas');
  off.width = srcW; off.height = srcH;
  const octx = off.getContext('2d');
  octx.drawImage(base, 0, 0);
  let imgData;
  try { imgData = octx.getImageData(0, 0, srcW, srcH); } catch (e) { return base; }
  const d = imgData.data;
  const filterHsl = applicable.map(f => ({ src: rgbToHsl(...hexToRgb(f.sourceHex)), tgt: rgbToHsl(...hexToRgb(f.targetHex)), tol: f.tolerance }));
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const [h, s, l] = rgbToHsl(d[i], d[i + 1], d[i + 2]);
    if (s < 0.12) continue; // skip near-grayscale (outlines/highlights)
    for (const f of filterHsl) {
      if (hueDist(h, f.src[0]) <= f.tol) {
        const newSat = Math.max(s, f.tgt[1] * 0.5);
        const [r2, g2, b2] = hslToRgb(f.tgt[0], newSat, l);
        d[i] = r2; d[i + 1] = g2; d[i + 2] = b2;
        break;
      }
    }
  }
  octx.putImageData(imgData, 0, 0);
  filteredImgCache[key] = off;
  return off;
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 1800);
}

// ---------- math helpers ----------
function toRad(deg) { return deg * Math.PI / 180; }

function lerpAngle(a, b, f, spin) {
  if (spin === 0) return a;
  let diff = b - a;
  if (spin === 1) { if (diff < 0) diff += 360; }
  else if (spin === -1) { if (diff > 0) diff -= 360; }
  else { diff = ((diff + 180) % 360 + 360) % 360 - 180; }
  let r = a + diff * f;
  r = ((r % 360) + 360) % 360;
  return r;
}
function lerp(a, b, f) { return a + (b - a) * f; }

function applyParentTransform(child, parent) {
  const px = parent.scaleX * child.x;
  const py = parent.scaleY * child.y;
  const rad = toRad(parent.angle);
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const wx = px * cos - py * sin + parent.x;
  const wy = px * sin + py * cos + parent.y;
  let angle = child.angle;
  if (parent.scaleX * parent.scaleY < 0) angle *= -1;
  angle = ((angle + parent.angle) % 360 + 360) % 360;
  return {
    x: wx, y: wy, angle: angle,
    scaleX: child.scaleX * parent.scaleX,
    scaleY: child.scaleY * parent.scaleY,
    // Spec (unmapFromParent): alpha multiplies down the parent chain, so a
    // fading bone fades everything attached to it too.
    alpha: (child.alpha === undefined ? 1 : child.alpha) * (parent.alpha === undefined ? 1 : parent.alpha)
  };
}

// Corrections now have two layers per bone/object:
//   .global   -- applies to every animation (old behavior, default)
//   .perAnim[animName] -- overrides .global for just that one animation
// getCorrection (used during rendering) resolves perAnim-for-this-anim-if-present,
// else global. ensureCorrection (used while editing) writes to whichever layer the
// "Edit scope" control is currently set to.
function blankCorrection() { return { dx: 0, dy: 0, dAngle: 0, dsx: 1, dsy: 1, dshear: 0 }; }

function migrateCorrectionEntry(entry) {
  // Old format was a flat {dx,dy,dAngle,dsx,dsy} object applying to all animations.
  if (entry && ('global' in entry || 'perAnim' in entry)) return entry;
  if (entry) return { global: { ...blankCorrection(), ...entry }, perAnim: {} };
  return { global: blankCorrection(), perAnim: {} };
}

function getCorrection(entityIdx, kind, id, animName) {
  const e = corrections[entityIdx];
  if (!e || !e[kind] || !e[kind][id]) return null;
  const entry = migrateCorrectionEntry(e[kind][id]);
  if (animName && entry.perAnim && entry.perAnim[animName]) return entry.perAnim[animName];
  return entry.global || null;
}
// editScope: 'all' (write to .global, applies everywhere) or 'this' (write to
// .perAnim[currentAnim.name], applies only to the animation being worked on).
let editScope = 'all';

// Custom display names set via the Asset Manager or hierarchy panel. Keyed by id
// alone -- renames are project-wide, so "sprite #14" becomes "head" the same way
// whether you're looking at the light or dark skin. Shows up everywhere that item
// is referenced (hierarchy, data panels, edit selection, floating toolbar).
let boneNames = {};
let objectNames = {};
function displayNameFor(kind, id) {
  const map = kind === 'bones' ? boneNames : objectNames;
  return map[id] || null;
}
function defaultNameFor(kind, id, entity) {
  if (kind === 'bones') return entity.bones[id] || ('bone ' + id);
  return 'sprite #' + id;
}
function nameFor(kind, id, entity) {
  return displayNameFor(kind, id) || defaultNameFor(kind, id, entity);
}
function setName(kind, id, value) {
  const map = kind === 'bones' ? boneNames : objectNames;
  if (value && value.trim()) map[id] = value.trim();
  else delete map[id];
}
function ensureCorrection(entityIdx, kind, id, animName, scope) {
  if (!corrections[entityIdx]) corrections[entityIdx] = { bones: {}, objects: {} };
  if (!corrections[entityIdx][kind]) corrections[entityIdx][kind] = {};
  corrections[entityIdx][kind][id] = migrateCorrectionEntry(corrections[entityIdx][kind][id]);
  const entry = corrections[entityIdx][kind][id];
  if (scope === 'this' && animName) {
    if (!entry.perAnim[animName]) entry.perAnim[animName] = blankCorrection();
    return entry.perAnim[animName];
  }
  return entry.global;
}
function applyCorrection(world, c) {
  if (!c) return world;
  return {
    x: world.x + (c.dx || 0),
    y: world.y + (c.dy || 0),
    angle: ((world.angle + (c.dAngle || 0)) % 360 + 360) % 360,
    scaleX: world.scaleX * (c.dsx === undefined ? 1 : c.dsx),
    scaleY: world.scaleY * (c.dsy === undefined ? 1 : c.dsy),
    shear: (world.shear || 0) + (c.dshear || 0),
    // No user-editable alpha correction (not exposed in the edit UI) -- just
    // carry the authored opacity through so it isn't dropped by this rebuild.
    alpha: world.alpha === undefined ? 1 : world.alpha
  };
}

// ---------- timeline interpolation ----------
// Easing helpers straight from BrashMonkey's official SCML pseudo-code spec.
function easeLinear(a, b, t) { return (b - a) * t + a; }
function easeQuadratic(a, b, c, t) { return easeLinear(easeLinear(a, b, t), easeLinear(b, c, t), t); }
function easeCubic(a, b, c, d, t) { return easeLinear(easeQuadratic(a, b, c, t), easeQuadratic(b, c, d, t), t); }

// Computes the eased progress "t" between keyA and its next key, honoring curve_type.
function curveT(keyA, rawT) {
  const type = String(keyA.curve_type === undefined ? '0' : keyA.curve_type);
  if (type === '1' || type === 'instant' || type === 'INSTANT') return 0;
  if (type === '2' || type === 'quadratic' || type === 'QUADRATIC') return easeQuadratic(0, keyA.c1 || 0, 1, rawT);
  if (type === '3' || type === 'cubic' || type === 'CUBIC') return easeCubic(0, keyA.c1 || 0, keyA.c2 || 0, 1, rawT);
  return rawT; // linear (default, type 0)
}

// Spec (BrashMonkey ScmlReference "keyFromRef"): anchor on ref.key directly (not a
// time-search), and when at the timeline's last key on a NON-looping animation, just
// hold that key -- never interpolate back toward the first key.
function getTimelineValueAt(timeline, refKeyIndex, timeMs, animLength, looping) {
  const keys = timeline.keys;
  const idxA = Math.min(parseInt(refKeyIndex, 10) || 0, keys.length - 1);
  const keyA = keys[idxA];
  if (keys.length === 1) return { ...keyA.transform, folder: keyA.folder, file: keyA.file };

  let idxB = idxA + 1;
  if (idxB >= keys.length) {
    if (looping) idxB = 0;
    else return { ...keyA.transform, folder: keyA.folder, file: keyA.file };
  }
  const keyB = keys[idxB];
  let tA = keyA.time, tB = keyB.time;
  if (tB < tA) tB += animLength; // wrapped past the loop point

  const rawF = tB === tA ? 0 : Math.max(0, Math.min(1, (timeMs - tA) / (tB - tA)));
  const f = curveT(keyA, rawF);
  const a = keyA.transform, b = keyB.transform;
  return {
    x: lerp(a.x, b.x, f),
    y: lerp(a.y, b.y, f),
    angle: lerpAngle(a.angle, b.angle, f, keyA.spin === undefined ? 1 : keyA.spin),
    scaleX: lerp(a.scaleX, b.scaleX, f),
    scaleY: lerp(a.scaleY, b.scaleY, f),
    alpha: lerp(a.alpha === undefined ? 1 : a.alpha, b.alpha === undefined ? 1 : b.alpha, f),
    folder: keyA.folder, file: keyA.file
  };
}

// ---------- draw-order (z-index) reordering ----------
// Scoped to the mainline key currently being viewed (this animation, this moment in
// time) -- z_index is genuinely per-keyframe SCML data, so reordering it project-wide
// would silently overwrite an artist's intentional per-animation layering elsewhere.
function collectDescendantObjectIds(boneId, mkey) {
  const ids = new Set();
  const boneChildren = {};
  mkey.bone_refs.forEach(br => {
    const p = br.parent === null ? 'root' : br.parent;
    (boneChildren[p] = boneChildren[p] || []).push(br.id);
  });
  const objByParentBone = {};
  mkey.object_refs.forEach(orf => {
    const p = orf.parent === null ? 'root' : orf.parent;
    (objByParentBone[p] = objByParentBone[p] || []).push(orf.id);
  });
  (function walk(bId) {
    (objByParentBone[bId] || []).forEach(oid => ids.add(oid));
    (boneChildren[bId] || []).forEach(walk);
  })(boneId);
  return ids;
}

function reorderZIndex(mkey, movingIds, direction) {
  // object_refs are drawn in ascending z_index order, so the LAST item in this
  // sorted list is the one rendered on top (frontmost) -- "top"/"bring to front"
  // must move toward the END of the list, not the start.
  const sorted = mkey.object_refs.slice().sort((a, b) => a.z_index - b.z_index);
  const ids = sorted.map(o => o.id);
  const isMoving = id => movingIds.has(id);
  const movingItems = ids.filter(isMoving);
  const staticItems = ids.filter(id => !isMoving(id));
  if (movingItems.length === 0) return false;
  const firstMovingIdx = ids.findIndex(isMoving);
  const staticBefore = ids.slice(0, firstMovingIdx).filter(id => !isMoving(id)).length;
  let newStaticIndex;
  if (direction === 'down') newStaticIndex = Math.max(0, staticBefore - 1);       // toward back
  else if (direction === 'up') newStaticIndex = Math.min(staticItems.length, staticBefore + 1); // toward front
  else if (direction === 'bottom') newStaticIndex = 0;                            // fully back
  else newStaticIndex = staticItems.length;                                       // 'top' -- fully front
  const newIds = [...staticItems.slice(0, newStaticIndex), ...movingItems, ...staticItems.slice(newStaticIndex)];
  newIds.forEach((id, idx) => {
    const ref = mkey.object_refs.find(o => o.id === id);
    if (ref) ref.z_index = idx;
  });
  return true;
}

function moveSelectedInDrawOrder(direction) {
  if (!selected) { toast('Select a bone or sprite first.'); return; }
  const mkey = getMainlineKeys(currentAnim, normalizeAnimTime(currentAnim, t));
  const movingIds = selected.kind === 'objects'
    ? new Set([selected.id])
    : collectDescendantObjectIds(selected.id, mkey);
  if (movingIds.size === 0) { toast('Nothing drawable under that selection.'); return; }
  pushUndo();
  const changed = reorderZIndex(mkey, movingIds, direction);
  if (changed) { render(); scheduleAutosave(); }
  else { undoStack.pop(); updateUndoRedoButtons(); }
}


function getMainlineKeys(anim, timeMs) {
  const keys = anim.mainline;
  let keyA = keys[0];
  for (let i = 0; i < keys.length; i++) { if (keys[i].time <= timeMs) keyA = keys[i]; }
  return keyA;
}

// Per-animation loop/transition start offset. Not part of the SCML spec (there's no
// such concept in the format) -- purely a tool feature so playback and spritesheet
// export can begin partway into a cycle, for smoother animation-to-animation blends.
// Keyed by animation name (shared across skins, since names match across entities).
let animStartOffsets = {};
if (_loadedAppState.animStartOffsets && typeof _loadedAppState.animStartOffsets === 'object') animStartOffsets = _loadedAppState.animStartOffsets;
function getStartOffset(anim) { return animStartOffsets[anim.name] || 0; }

// Clamp/wrap the play-head the way the spec's Animation.setCurrentTime does:
// NO_LOOPING clamps at length (holds last frame), LOOPING wraps with modulo.
// The start offset is folded in before that clamp/wrap so it's honored consistently
// in both looping and non-looping animations.
function normalizeAnimTime(anim, timeMs) {
  const shifted = timeMs + getStartOffset(anim);
  if (anim.looping === false) return Math.max(0, Math.min(shifted, anim.length));
  if (anim.length <= 0) return 0;
  let t = shifted % anim.length;
  if (t < 0) t += anim.length;
  return t;
}

function computeFrame(entityIdx, anim, rawTimeMs) {
  const timeMs = normalizeAnimTime(anim, rawTimeMs);
  const looping = anim.looping !== false;
  const mkey = getMainlineKeys(anim, timeMs);
  const boneWorld = {};
  const remaining = mkey.bone_refs.slice();
  let guard = 0;
  while (remaining.length && guard++ < 1000) {
    for (let i = remaining.length - 1; i >= 0; i--) {
      const br = remaining[i];
      if (br.parent !== null && !(br.parent in boneWorld)) continue;
      const tl = anim.timelines[br.timeline];
      const local = getTimelineValueAt(tl, br.key, timeMs, anim.length, looping);
      let world = br.parent !== null ? applyParentTransform(local, boneWorld[br.parent]) : { ...local };
      world = applyCorrection(world, getCorrection(entityIdx, 'bones', br.id, anim.name));
      boneWorld[br.id] = world;
      remaining.splice(i, 1);
    }
  }
  const objects = mkey.object_refs.map(orf => {
    const tl = anim.timelines[orf.timeline];
    const local = getTimelineValueAt(tl, orf.key, timeMs, anim.length, looping);
    let world = orf.parent !== null ? applyParentTransform(local, boneWorld[orf.parent]) : { ...local };
    world = applyCorrection(world, getCorrection(entityIdx, 'objects', orf.id, anim.name));
    return { id: orf.id, zIndex: orf.z_index, folder: local.folder, file: local.file, world };
  }).sort((a, b) => a.zIndex - b.zIndex);
  return { boneWorld, objects, boneRefs: mkey.bone_refs };
}

// ---------- world-space bounding box (used to frame spritesheet exports consistently) ----------
function computeObjectWorldCorners(obj) {
  const finfo = folders[obj.folder].files[obj.file];
  const w = finfo.width, h = finfo.height, pu = finfo.pivot_x, pv = finfo.pivot_y;
  const wtx = obj.world;
  const rad = toRad(wtx.angle);
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return [[0, 0], [w, 0], [0, h], [w, h]].map(([col, row]) => {
    const lux = col - pu * w, luy = (1 - pv) * h - row;
    const sx = lux * wtx.scaleX, sy = luy * wtx.scaleY;
    return [wtx.x + (sx * cos - sy * sin), wtx.y + (sx * sin + sy * cos)];
  });
}

function computeAnimationWorldBBox(entityIdx, anim, sampleCount = 24) {
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (let i = 0; i < sampleCount; i++) {
    const t = anim.length * i / sampleCount;
    const { objects } = computeFrame(entityIdx, anim, t);
    for (const obj of objects) {
      if (obj.folder === null || obj.folder === undefined) continue;
      for (const [wx, wy] of computeObjectWorldCorners(obj)) {
        if (wx < minx) minx = wx; if (wx > maxx) maxx = wx;
        if (wy < miny) miny = wy; if (wy > maxy) maxy = wy;
      }
    }
  }
  if (!isFinite(minx)) { minx = miny = -1; maxx = maxy = 1; }
  return { minx, maxx, miny, maxy };
}

let _bboxCacheKey = null, _bboxCacheVal = null;
function getCachedAnimBBox(entityIdx, anim) {
  const key = entityIdx + '_' + anim.name + '_' + (typeof stateVersion === 'undefined' ? 0 : stateVersion);
  if (_bboxCacheKey === key) return _bboxCacheVal;
  _bboxCacheVal = computeAnimationWorldBBox(entityIdx, anim);
  _bboxCacheKey = key;
  return _bboxCacheVal;
}


const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
// ---------- canvas backdrop sizing ----------
function updateCanvasBackdrop() {
  const canvas = document.getElementById('canvas');
  const backdrop = document.getElementById('canvasBackdrop');
  if (!canvas || !backdrop) return;
  const rect = canvas.getBoundingClientRect();
  const parent = canvas.parentElement.getBoundingClientRect();
  const left = rect.left - parent.left;
  const top = rect.top - parent.top;
  backdrop.style.left = left + 'px';
  backdrop.style.top = top + 'px';
  backdrop.style.width = rect.width + 'px';
  backdrop.style.height = rect.height + 'px';
}
window.addEventListener('resize', updateCanvasBackdrop);
new ResizeObserver(updateCanvasBackdrop).observe(document.getElementById('canvas'));

// Resize the canvas internal pixel buffer to the wrap on init and on
// every window resize. This gives the user scrollable headroom to drag
// sprites toward any edge without them being clipped at the canvas
// internal pixel boundary (the previous 900×900 buffer clipped sprites
// at the chess-background edge, which made the work area feel cramped).
//
// Note: the initial setTimeout call only resizes the canvas — it does
// NOT call render(), because render() references module-scope `let`
// variables (currentEntityIdx, currentEntity, etc.) that haven't been
// declared yet at this point in the script. Calling render() here
// would hit a TDZ error. The actual first render happens from init()
// at the bottom of the file, after all the state is initialized.
(function setupCanvasResize() {
  let firstCall = true;
  function doResize() {
    resizeCanvasToWrap();
    if (!firstCall) render();
    firstCall = false;
  }
  window.addEventListener('resize', doResize);
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(doResize).observe(document.getElementById('canvasWrap'));
  }
  // Initial sizing — wait for layout to settle (fonts, flex, etc.)
  setTimeout(doResize, 0);
})();

let VIEW_SCALE = 0.28;
let VIEW_OFFSET_X = 0;
let VIEW_OFFSET_Y = 0;
// ORIGIN is the canvas-internal pixel where world (0, 0) maps to. We keep
// it at the center-lower of the canvas, and the canvas itself is resized
// to match the wrap on init + window resize — so the character always
// sits in the center-lower of the visible work area, and the user can
// drag a sprite to any of the four edges (and beyond, via scroll) without
// it being clipped by the canvas internal pixel buffer.
let ORIGIN_X = canvas.width / 2;
let ORIGIN_Y = canvas.height * 0.82;
const ROTATE_HANDLE_R = 55;
const SCALE_HANDLE_R = 85;

function worldToCanvas(x, y) { return [ORIGIN_X + VIEW_OFFSET_X + x * VIEW_SCALE, ORIGIN_Y + VIEW_OFFSET_Y - y * VIEW_SCALE]; }
function worldToLocal(x, y, originX, originY, viewScale) { return [originX + x * viewScale, originY - y * viewScale]; }

// Resize the canvas internal pixel buffer. The previous fixed 900×900
// buffer was the source of "sprite gets cut off at the chess-background
// edge": the wrap is typically ~876×339 display pixels (the preview
// column is short and wide), but the canvas internal was a square
// 900×900, so any sprite whose world position translated to
// canvas-internal coords outside 0..900 was clipped — and at high zoom
// the character itself could already be touching that boundary.
//
// Now the canvas internal is at least the wrap's display size, with
// generous headroom (1800×1200 minimum) so a sprite can be dragged to
// any edge of the work area without being clipped, and the size box
// (which can be 2000+ pixels wide) fits comfortably. The CSS no longer
// pins the canvas to the wrap, so the wrap scrolls when the canvas is
// larger — the user can scroll the view to follow a sprite they've
// dragged off the visible area.
function resizeCanvasToWrap() {
  const wrap = document.getElementById('canvasWrap');
  if (!wrap) return;
  const rect = wrap.getBoundingClientRect();
  // Min size: large enough to fit typical size boxes (which can be
  // 2000+ world units) plus headroom on all sides. The canvas displays
  // at this internal-pixel size (no CSS scaling), so the character on
  // screen is roughly 1 canvas-internal pixel = 1 display pixel —
  // VIEW_SCALE controls how zoomed-in the world looks.
  const w = Math.max(1800, Math.round(rect.width * 2));
  const h = Math.max(1200, Math.round(rect.height * 3));
  const sizeChanged = canvas.width !== w || canvas.height !== h;
  if (sizeChanged) {
    canvas.width = w;
    canvas.height = h;
  }
  ORIGIN_X = canvas.width / 2;
  ORIGIN_Y = canvas.height * 0.82;
  // After a size change, scroll the wrap so the origin (where the
  // character sits) is centered in the visible area. The user can
  // scroll freely from there to follow sprites they've dragged off.
  if (sizeChanged) {
    wrap.scrollLeft = Math.max(0, ORIGIN_X - rect.width / 2);
    wrap.scrollTop = Math.max(0, ORIGIN_Y - rect.height * 0.55);
  }
}
function canvasToWorldDelta(dx, dy) { return [dx / VIEW_SCALE, -dy / VIEW_SCALE]; }
// angle as seen on screen (canvas space) for a given world-space angle in degrees
function canvasAngleForWorldAngle(deg) { return -deg; }
function canvasAngleOf(mx, my, px, py) { return Math.atan2(-(my - py), mx - px) * 180 / Math.PI; }

let lastBonePoints = [];   // {id, x, y}
let lastObjectHits = [];   // {id, ax,ay,bx,by,ex,ey,w,h,pu,pv, zIndex}
let lastWorldById = {};    // key "bones:ID" / "objects:ID" -> {x,y,angle,scaleX,scaleY} (world, canvas pivot cached too)
let lastPivotById = {};    // key -> [canvasX, canvasY]

function selKey() { return selected ? (selected.kind + ':' + selected.id) : null; }

// Draws a list of computeFrame() objects into any 2D context at any origin/scale.
// Shared by the live canvas view and the spritesheet exporter so they can never drift
// apart. Returns hit-test records for the caller to use if it wants them.
function paintSprites(pctx, objects, viewScale, originX, originY, opts = {}, animName = null) {
  const hits = [];
  // opts.dimInactive: when true, sprites that aren't in the current mainline key
  // are drawn at reduced opacity (so the dev can see what's "on" at this frame).
  const dimInactive = !!opts.dimInactive;
  for (const obj of objects) {
    if (obj.folder === null || obj.folder === undefined) continue;
    const finfo = folders[obj.folder].files[obj.file];
    const img = getFilteredImage(obj.folder, obj.file, animName);
    const w = finfo.width, h = finfo.height;
    const pu = finfo.pivot_x, pv = finfo.pivot_y;
    const wtx = obj.world;
    const rad = toRad(wtx.angle);
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const ax = cos * wtx.scaleX * viewScale, ay = -sin * wtx.scaleX * viewScale;
    const bx = sin * wtx.scaleY * viewScale, by = cos * wtx.scaleY * viewScale;
    const [ex, ey] = worldToLocal(wtx.x, wtx.y, originX, originY, viewScale);
    // Decide dim state, folded together with the sprite's own authored
    // opacity (SCML <object a="..."> keys -- fade in/out), if any.
    const isActive = !dimInactive || (opts.activeObjectIds ? opts.activeObjectIds.has(obj.id) : true);
    const dimAlpha = isActive ? 1 : 0.25;
    const ownAlpha = wtx.alpha === undefined ? 1 : wtx.alpha;
    pctx.save();
    pctx.globalAlpha = dimAlpha * ownAlpha;
    pctx.setTransform(ax, ay, bx, by, ex, ey);
    // Skew is composed as a *separate* transform on top of the already-verified
    // rotation/scale matrix above, rather than folded into ax/bx by hand -- that's
    // exactly the kind of hand-derived sign math that caused the sprite-flip bug
    // earlier, so it's kept isolated and simple here instead.
    if (wtx.shear) pctx.transform(1, 0, Math.tan(toRad(wtx.shear)), 1, 0, 0);
    // An HTMLImageElement reports `.complete` as a real boolean once settled; a canvas
    // (used for color-filtered sprites) has no such property at all. Treat "has no
    // .complete property" as ready (it's a canvas, always drawable) but require an
    // actual `true` when the property does exist, so a still-decoding image is
    // skipped for this frame instead of being handed to drawImage half-loaded.
    const ready = ('complete' in img ? img.complete === true : true) && ((img.naturalWidth || img.width) > 0);
    if (ready) pctx.drawImage(img, -pu * w, -(1 - pv) * h, w, h);
    pctx.restore();
    if (opts.recordHits) hits.push({ id: obj.id, ax, ay, bx, by, ex, ey, w, h, pu, pv, zIndex: obj.zIndex });
    if (opts.highlightSelected && selKey() === 'objects:' + obj.id) {
      pctx.save();
      pctx.setTransform(ax, ay, bx, by, ex, ey);
      pctx.strokeStyle = '#ffd479'; pctx.lineWidth = 3 / viewScale;
      pctx.strokeRect(-pu * w, -(1 - pv) * h, w, h);
      pctx.restore();
    }
  }
  return hits;
}

// Draws the size-box fill + outline + label, in screen space. Called
// BEFORE paintSprites so the fill sits underneath the character.
function paintSizeBoxBackground(entityIdx, entity, anim, objects, boneWorld) {
  const sizeBoxEl = document.getElementById('showSizeBox');
  if (!sizeBoxEl || !sizeBoxEl.checked) return;
  const bbox = getCachedAnimBBox(entityIdx, anim);
  const [bx0, by0] = worldToCanvas(bbox.minx, bbox.maxy);
  const [bx1, by1] = worldToCanvas(bbox.maxx, bbox.miny);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // Fill the stage with the user's chosen backdrop color (RGBA).
  ctx.fillStyle = getCurrentBackdropColor();
  ctx.fillRect(bx0, by0, bx1 - bx0, by1 - by0);
  // Outline
  ctx.strokeStyle = 'rgba(126, 232, 194, 0.5)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(bx0, by0, bx1 - bx0, by1 - by0);
  ctx.setLineDash([]);
  ctx.fillStyle = '#7ee8c2';
  ctx.font = '11px monospace';
  const animLabel = `${anim.name}: ${Math.round(bbox.maxx - bbox.minx)} × ${Math.round(bbox.maxy - bbox.miny)}`;
  ctx.fillText(animLabel, bx0 + 4, Math.max(12, by0 - 6));
  if (selected && selected.kind === 'objects') {
    const obj = objects.find(o => o.id === selected.id);
    if (obj && obj.folder !== null && obj.folder !== undefined) {
      const finfo = folders[obj.folder].files[obj.file];
      ctx.fillStyle = '#ffd479';
      ctx.fillText(`${nameFor('objects', obj.id, entity)}: ${finfo.width} × ${finfo.height}px (native)`, bx0 + 4, Math.max(12, by0 - 6) + 14);
    }
  }
  ctx.restore();
}

function drawFrame(entityIdx, entity, anim, timeMs) {
  const { boneWorld, objects, boneRefs } = computeFrame(entityIdx, anim, timeMs);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  lastBonePoints = [];
  lastWorldById = {};
  lastPivotById = {};

  // Cache the canvas wrap's screen rect so the label pass can place labels
  // in screen space (constant pixel size, not affected by zoom).
  const _wrap = document.getElementById('canvasWrap');
  window._canvasWrapRect = _wrap ? _wrap.getBoundingClientRect() : null;
  const canvasWrapRect = window._canvasWrapRect;

  // Build sets of active bone/object ids at the current mainline key, so we can dim
  // the parts of the character that aren't visible at this frame.
  const _activeBones = new Set();
  const _activeObjects = new Set();
  const _mkey = getMainlineKeys(anim, normalizeAnimTime(anim, t));

  // ---- size box: draw FIRST so sprites paint on top of it ----
  paintSizeBoxBackground(entityIdx, entity, anim, objects, boneWorld);
  for (const br of _mkey.bone_refs) _activeBones.add(br.id);
  for (const orf of _mkey.object_refs) _activeObjects.add(orf.id);

  if (document.getElementById('showSprites').checked) {
    const visibleObjects = objects.filter(o => trackVisible['objects:' + o.id] !== false);
    lastObjectHits = paintSprites(ctx, visibleObjects, VIEW_SCALE, ORIGIN_X + VIEW_OFFSET_X, ORIGIN_Y + VIEW_OFFSET_Y, { recordHits: true, highlightSelected: true, dimInactive: true, activeObjectIds: _activeObjects }, anim.name);
  } else {
    lastObjectHits = [];
  }
  for (const obj of objects) {
    if (obj.folder === null || obj.folder === undefined) continue;
    const [ex, ey] = worldToCanvas(obj.world.x, obj.world.y);
    lastWorldById['objects:' + obj.id] = obj.world;
    lastPivotById['objects:' + obj.id] = [ex, ey];
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // Track label positions so we can draw them in a second pass at constant
  // pixel size (not affected by the world zoom).
  const _labelPositions = [];
  if (document.getElementById('showBones').checked) {
    ctx.lineWidth = 2;
    for (const br of boneRefs) {
      const w = boneWorld[br.id];
      const [x0, y0] = worldToCanvas(w.x, w.y);
      const isSel = selKey() === 'bones:' + br.id;
      const isActive = _activeBones.has(br.id);
      // Bookkeeping (world position, pivot for the edit panel/toolbar) is kept
      // regardless of visibility -- same as objects below -- so a hidden bone
      // can still be selected/edited via the timeline row or state inspector.
      lastWorldById['bones:' + br.id] = w;
      lastPivotById['bones:' + br.id] = [x0, y0];
      // Hidden via the timeline eye toggle: skip drawing the point/line/label
      // entirely, same treatment sprites already get (previously only sprites
      // respected trackVisible here, so a "hidden" bone still showed on canvas).
      const isVisible = trackVisible['bones:' + br.id] !== false;
      if (!isVisible) continue;
      // Dim bones (and their lines/labels) that aren't active at this frame
      ctx.save();
      ctx.globalAlpha = isActive ? 1 : 0.25;
      if (isSel) {
        // Glow under selected bone point
        ctx.save();
        ctx.shadowColor = 'rgba(255, 212, 121, 0.9)';
        ctx.shadowBlur = 12;
        ctx.fillStyle = '#ffd479';
        ctx.beginPath(); ctx.arc(x0, y0, 8, 0, 7); ctx.fill();
        ctx.restore();
      }
      ctx.fillStyle = isSel ? '#ffd479' : '#ff5577';
      ctx.beginPath(); ctx.arc(x0, y0, isSel ? 6 : 4, 0, 7); ctx.fill();
      // Only draw the line to the parent if the parent bone is visible too --
      // otherwise it points at a bone point that was never drawn.
      if (br.parent !== null && trackVisible['bones:' + br.parent] !== false) {
        const p = boneWorld[br.parent];
        const [x1, y1] = worldToCanvas(p.x, p.y);
        ctx.strokeStyle = '#54e0c0';
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      }
      lastBonePoints.push({ id: br.id, x: x0, y: y0 });
      if (document.getElementById('showLabels').checked) {
        _labelPositions.push({ name: entity.bones[br.id] || br.id, x: x0, y: y0, isActive });
      }
      ctx.restore();
    }
  }
  // Second pass: draw labels. The previous version drew in screen space
  // (computed via getBoundingClientRect) with a constant 11px font, which
  // had two bugs: (1) the position was calculated in wrap-relative pixel
  // coords but drawn in canvas-internal coords, so whenever the canvas
  // display size differed from its 900×900 internal size (which is always,
  // because CSS scales the canvas to fill the wrap) the labels drifted off
  // the bone point — that's the "misaligned when zoomed and panned" the
  // user reported; (2) the font was constant pixel size, so labels stayed
  // tiny even when the world was zoomed up large.
  //
  // Fix: draw the font and offsets in *screen pixels* by converting via
  // the canvas's display scale. The font size is also scaled with
  // VIEW_SCALE so labels grow with the world.
  if (_labelPositions.length && document.getElementById('showLabels').checked) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // Display scale: how many screen pixels per canvas-internal pixel.
    // The canvas is internally 900×900 but CSS-scaled to fill the wrap,
    // so this ratio is < 1 on the narrow axis (the wrap is usually
    // wider-than-tall) — that's why a "30px" font in canvas coords
    // shows up as ~11px on screen.
    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width / canvas.width;
    const scaleY = rect.height / canvas.height;
    // Target screen-pixel font size, grown with zoom.
    const screenFontPx = Math.max(11, Math.round(11 * Math.sqrt(VIEW_SCALE / 0.28)));
    // Convert to canvas-internal pixels (font is in internal units).
    const fontSize = screenFontPx / scaleY;
    ctx.font = fontSize + 'px var(--font-mono), monospace';
    ctx.textBaseline = 'bottom';
    // Offsets in screen pixels, converted to canvas-internal.
    const offXScreen = 6;
    const offYScreen = 2;
    const padXScreen = 4;
    const padYScreen = 2;
    const offX = offXScreen / scaleX;
    const offY = offYScreen / scaleY;
    const padX = padXScreen / scaleX;
    const padY = padYScreen / scaleY;
    for (const lb of _labelPositions) {
      const sx = lb.x + offX;
      const sy = lb.y - offY;
      ctx.globalAlpha = lb.isActive ? 0.95 : 0.35;
      const text = lb.name;
      const tw = ctx.measureText(text).width;
      const boxH = fontSize + padY * 2;
      const boxW = tw + padX * 2;
      ctx.fillStyle = 'rgba(10, 10, 10, 0.75)';
      ctx.fillRect(sx, sy - fontSize - padY, boxW, boxH);
      ctx.fillStyle = lb.isActive ? '#eee' : '#888';
      ctx.fillText(text, sx + padX, sy);
    }
    ctx.restore();
  }

  // ---- size box: shows the animation's overall extent (the "stage" the
  //      sprite is composed on) — filled with the user's backdrop color
  //      (incl. alpha) so the area inside reads as a separate workspace.
  //      Now extracted to paintSizeBoxBackground() so it can run BEFORE the
  //      sprites are drawn (otherwise the fill covers them).
  const sizeBoxEl = document.getElementById('showSizeBox');
  if (sizeBoxEl && sizeBoxEl.checked) {
    // Backwards compat: nothing to do here, paintSizeBoxBackground already ran
  }

  // draw rotate/scale handles for current selection
  if (editMode && selected && lastPivotById[selKey()]) {
    const [px, py] = lastPivotById[selKey()];
    const w = lastWorldById[selKey()];
    const rad = toRad(canvasAngleForWorldAngle(w.angle));
    const rx = px + ROTATE_HANDLE_R * Math.cos(rad), ry = py + ROTATE_HANDLE_R * Math.sin(rad);
    const sx = px + SCALE_HANDLE_R * Math.cos(rad + 0.6), sy = py + SCALE_HANDLE_R * Math.sin(rad + 0.6);
    ctx.strokeStyle = '#556'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(rx, ry); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(sx, sy); ctx.stroke();
    ctx.fillStyle = '#ffd479';
    ctx.beginPath(); ctx.arc(rx, ry, 8, 0, 7); ctx.fill();
    ctx.fillStyle = '#7ee8c2';
    ctx.fillRect(sx - 7, sy - 7, 14, 14);
    lastHandles = { rotate: [rx, ry], scale: [sx, sy] };
  } else {
    lastHandles = null;
  }

  const info = document.getElementById('boneInfo');
  let html = '';
  for (const br of boneRefs) {
    const w = boneWorld[br.id];
    const name = nameFor('bones', br.id, entity);
    html += `<div><span class="b">${name}</span>: x=${w.x.toFixed(1)} y=${w.y.toFixed(1)} °=${w.angle.toFixed(1)} sx=${w.scaleX.toFixed(2)} sy=${w.scaleY.toFixed(2)}</div>`;
  }
  for (const obj of objects) {
    const name = nameFor('objects', obj.id, entity);
    html += `<div><span class="b">${name}</span>: x=${obj.world.x.toFixed(1)} y=${obj.world.y.toFixed(1)} °=${obj.world.angle.toFixed(1)} sx=${obj.world.scaleX.toFixed(2)} sy=${obj.world.scaleY.toFixed(2)}</div>`;
  }
  info.innerHTML = html;

  renderStateInspector(entity, boneRefs, objects, boneWorld);
  renderTree(entity, boneRefs, objects);
  renderAssetManager(entity);
  renderTracker(entityIdx, entity, anim, timeMs);
  positionFloatToolbar();
}

// ---------- current state inspector (right panel) ----------
function renderStateInspector(entity, boneRefs, objects, boneWorld) {
  const el = document.getElementById('stateInspector');
  if (!el) return;
  let html = '';
  for (const br of boneRefs) {
    const w = boneWorld[br.id];
    const name = nameFor('bones', br.id, entity);
    const isSel = selKey() === 'bones:' + br.id;
    const vals = `x ${w.x.toFixed(0)} y ${w.y.toFixed(0)} ° ${w.angle.toFixed(0)}`;
    html += `<div class="row kind-bone${isSel ? ' sel' : ''}" data-kind="bones" data-id="${br.id}"><span class="dot"></span><span class="name">${name}</span><span class="vals">${vals}</span></div>`;
  }
  for (const obj of objects) {
    const name = nameFor('objects', obj.id, entity);
    const isSel = selKey() === 'objects:' + obj.id;
    const w = obj.world;
    const vals = `x ${w.x.toFixed(0)} y ${w.y.toFixed(0)} ° ${w.angle.toFixed(0)}`;
    html += `<div class="row kind-sprite${isSel ? ' sel' : ''}" data-kind="objects" data-id="${obj.id}"><span class="dot"></span><span class="name">${name}</span><span class="vals">${vals}</span></div>`;
  }
  el.innerHTML = html;
  el.querySelectorAll('.row').forEach(row => {
    row.addEventListener('click', () => {
      const kind = row.dataset.kind;
      const id = row.dataset.id;
      selected = { kind, id };
      updateEditPanel();
      render();
    });
  });
}

// ---------- tracker view (music-tracker-style timeline: rows = channels, columns = keyframe times) ----------

// ---------- Premiere-style timeline view ----------
let TIMELINE_HEADER_W = 160; // width of the left "objects" column; user-resizable
const TIMELINE_MIN_LANE_W = 600;
let trackVisible = {};
let playheadX = 0;

function getTimelinePixelsPerMs() {
  if (!currentAnim || currentAnim.length <= 0) return 1;
  return Math.max(0.4, Math.min(4, 1200 / currentAnim.length));
}

// Collects every bone_ref / object_ref that appears in ANY of the given
// mainline keys, deduped by id (first occurrence, in mainline-key order,
// wins as the representative ref used for parent/timeline/z_index lookup).
//
// Ref `id` numbers are only reliably stable for BONES: a given entity's
// bone_ref id maps to the same named bone in every mainline key of every
// animation (the skeleton's bone list doesn't change). For OBJECTS, Spriter
// assigns ref ids by enumeration order *within each mainline key*, so if an
// animation's object "cast" changes mid-animation (e.g. a weapon is drawn),
// the same id can be recycled to mean a different sprite later in that same
// animation. When that happens, this -- like the rest of the app's id-keyed
// names/corrections/visibility -- reflects the id's FIRST appearance. That's
// a quirk of the raw SCML format (confirmed against real exported data, not
// a bug introduced here).
function collectRefsAcrossKeys(mainlineKeys) {
  const bones = new Map();   // id -> bone_ref
  const objects = new Map(); // id -> object_ref
  for (const mk of mainlineKeys) {
    for (const br of mk.bone_refs) { if (!bones.has(br.id)) bones.set(br.id, br); }
    for (const orf of mk.object_refs) { if (!objects.has(orf.id)) objects.set(orf.id, orf); }
  }
  return { bones, objects };
}

function renderTracker(entityIdx, entity, anim, timeMs) {
  const el = document.getElementById('trackerView');
  if (!el) return;

  const mkey = getMainlineKeys(anim, timeMs);
  // Active id sets for the CURRENT mainline key -- used to dim rows/markers
  // that exist in the rig but aren't part of the pose at this instant.
  const activeBoneIds = new Set(mkey.bone_refs.map(b => b.id));
  const activeObjectIds = new Set(mkey.object_refs.map(o => o.id));

  // Channel list spans every mainline key of the WHOLE animation, not just
  // the current one -- so rows have a fixed identity for the duration of the
  // animation and don't pop in/out of existence while scrubbing or playing.
  // A bone/object that's only part of the cast for part of the animation
  // (e.g. a muzzle flash, a drawn weapon) still gets a persistent row here,
  // dimmed (via activeBoneIds/activeObjectIds above) for the time ranges
  // it's not part of the current pose.
  const refs = collectRefsAcrossKeys(anim.mainline);
  const channels = [];
  const objByParent = {};
  for (const orf of refs.objects.values()) {
    const p = orf.parent === null ? 'root' : orf.parent;
    (objByParent[p] = objByParent[p] || []).push(orf.id);
  }
  // Sort objects by z_index (draw order) within each parent
  for (const k of Object.keys(objByParent)) {
    objByParent[k].sort((a, b) => {
      const oa = refs.objects.get(a), ob = refs.objects.get(b);
      return (oa ? oa.z_index : 0) - (ob ? ob.z_index : 0);
    });
  }
  const boneChildren = {};
  for (const br of refs.bones.values()) {
    const p = br.parent === null ? 'root' : br.parent;
    (boneChildren[p] = boneChildren[p] || []).push(br);
  }
  function walkChannel(parentKey, depth, seen) {
    const children = boneChildren[parentKey] || [];
    for (const br of children) {
      // Cycle guard: each bone's parent is taken from its first appearance,
      // possibly a different mainline key than a sibling's -- a pathological
      // file could in theory disagree across keys and form a cycle when
      // unioned. Every mainline key on its own is always a valid tree.
      if (seen.has(br.id)) continue;
      seen.add(br.id);
      const sprites = objByParent[br.id] || [];
      const hasChildren = (boneChildren[br.id] || []).length > 0 || sprites.length > 0;
      channels.push({ kind: 'bones', id: br.id, name: nameFor('bones', br.id, entity), depth, hasChildren });
      // Sprites parented to this bone
      for (const oid of sprites) {
        channels.push({ kind: 'objects', id: oid, name: nameFor('objects', oid, entity), depth: depth + 1, hasChildren: false });
      }
      // Recurse into child bones
      walkChannel(br.id, depth + 1, seen);
    }
  }
  walkChannel('root', 0, new Set());
  // Root-level sprites (parented to 'root')
  const rootSprites = objByParent['root'] || [];
  for (const oid of rootSprites) {
    channels.push({ kind: 'objects', id: oid, name: nameFor('objects', oid, entity), depth: 0 });
  }

  const pxPerMs = getTimelinePixelsPerMs();
  const laneW = Math.max(TIMELINE_MIN_LANE_W, anim.length * pxPerMs);

  // Time ruler
  const targetTickPx = 80;
  const tickMsRaw = targetTickPx / pxPerMs;
  const niceSteps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
  let tickMs = niceSteps[niceSteps.length - 1];
  for (const s of niceSteps) { if (s >= tickMsRaw) { tickMs = s; break; } }
  const minorTickMs = tickMs / 5;

  // headerW is computed after the channels loop (depends on maxDepth).
  // Use a placeholder; we'll splice the real width in once we know it.
  let ruler = '<div class="time-ruler" data-ruler-width="' + (TIMELINE_HEADER_W + laneW) + '">';
  ruler += '<div class="time-ruler-header">objects<span class="resize-handle" id="tlResizeHandle"></span></div>';
  ruler += '<div class="time-ruler-track" id="timeRulerTrack" style="width:' + laneW + 'px;">';
  for (let tt = 0; tt <= anim.length; tt += tickMs) {
    const x = (tt / anim.length) * laneW;
    ruler += '<div class="ruler-tick major" style="left:' + x + 'px;">' + formatTimecode(tt) + '</div>';
  }
  if (minorTickMs >= tickMs / 6) {
    for (let tt = 0; tt <= anim.length; tt += minorTickMs) {
      if (Math.round(tt / tickMs) * tickMs === tt) continue;
      const x = (tt / anim.length) * laneW;
      ruler += '<div class="ruler-tick minor" style="left:' + x + 'px;"></div>';
    }
  }
  ruler += '</div></div>';

  let rows = '';
  for (const c of channels) {
    const isSel = selKey() === c.kind + ':' + c.id;
    const visibleKey = c.kind + ':' + c.id;
    const isActive = c.kind === 'bones' ? activeBoneIds.has(c.id) : activeObjectIds.has(c.id);
    const dimClass = isActive ? '' : ' dim';
    const isVisible = trackVisible[visibleKey] !== false;
    const ref = (c.kind === 'bones' ? refs.bones : refs.objects).get(c.id);
    const tl = ref ? anim.timelines[ref.timeline] : null;
    const keys = tl ? tl.keys : [];

    // Marker shape encodes how this key blends into the NEXT key on this
    // same row: diamond=linear, circle=eased (quadratic/cubic), flat=hold
    // (instant -- snaps, no blend). A corner flag marks sprite-swap keys,
    // where the image itself changes (not just position/rotation) -- see
    // the Timeline legend popover for the same language, spelled out.
    let markers = '';
    let prevFolderFile = null;
    for (const k of keys) {
      const x = (k.time / anim.length) * laneW;
      const curveType = String(k.curve_type === undefined ? '0' : k.curve_type);
      const isInstant = curveType === '1' || /instant/i.test(curveType);
      const isCubic = curveType === '3' || /cubic/i.test(curveType);
      const isEased = !isInstant && (isCubic || curveType === '2' || /quad/i.test(curveType));
      const curveLabel = isInstant ? 'hold (instant)' : isEased ? (isCubic ? 'cubic ease' : 'quadratic ease') : 'linear';
      // Sprite-swap detection: does this key point at a different image than
      // the previous key on this SAME timeline? (object timelines only --
      // bones have no folder/file.)
      const folderFile = (c.kind === 'objects' && k.folder !== null && k.folder !== undefined) ? (k.folder + '_' + k.file) : null;
      const isSwap = folderFile !== null && prevFolderFile !== null && folderFile !== prevFolderFile;
      if (folderFile !== null) prevFolderFile = folderFile;
      let swapLabel = '';
      if (isSwap) {
        const finfo = folders[k.folder] && folders[k.folder].files[k.file];
        swapLabel = ' · sprite → ' + (finfo ? finfo.name.split('/').pop() : (k.folder + '/' + k.file));
      }
      markers += '<div class="keyframe kind-' + (c.kind === 'bones' ? 'bone' : 'sprite') +
                 (isInstant ? ' instant' : isEased ? ' eased' : '') +
                 (isSwap ? ' swap' : '') +
                 '" data-kind="' + c.kind + '" data-id="' + c.id + '" data-time="' + k.time +
                 '" data-jump-time="' + k.time + '" style="left:' + x + 'px;" title="t=' + Math.round(k.time) + 'ms · ' + curveLabel + swapLabel + '"></div>';
    }

    const isBone = c.kind === 'bones';
    const hasChildren = isBone && c.hasChildren;
    const isLeafBone = isBone && !c.hasChildren;
    const treeGuide = isBone
      ? '<span class="tree-guide ' + (hasChildren ? 'has-child' : 'is-leaf') + '"></span>'
      : '<span class="tree-guide is-leaf" style="opacity:0.5;"></span>';
    const isLocked = false; // lock feature removed
    const hiddenClass = isVisible ? '' : ' hidden';
    const lockedClass = '';
    const allClasses = dimClass + hiddenClass;
    const eyeTitle = isVisible ? 'Hide track' : 'Show track';
    const eyeIcon = isVisible ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>' : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/></svg>';
    const lockIcon = '';
    const unlockIcon = '';
    const depthPx = (c.depth || 0) * 14;
    rows += '<div class="track-row kind-' + (isBone ? 'bone' : 'sprite') + (isSel ? ' sel' : '') + allClasses + '" data-kind="' + c.kind + '" data-id="' + c.id + '" data-depth="' + (c.depth || 0) + '">';
    rows += '<div class="track-header">';
    // Indent spacer pushes the name to a consistent zero-point across the whole tree.
    // The track-header column width itself accounts for the widest indent (see CSS var).
    if (depthPx > 0) rows += '<span class="indent-spacer" style="width:' + depthPx + 'px;"></span>';
    rows += treeGuide;
    rows += '<span class="name-color"></span>';
    rows += '<span class="track-name" data-kind="' + c.kind + '" data-id="' + c.id + '" title="' + c.name + '">' + c.name + '</span>';
    rows += '<button class="track-icon-btn eye ' + (isVisible ? 'on' : '') + '" data-toggle-visible="' + c.kind + ':' + c.id + '" title="' + eyeTitle + '">' + eyeIcon + '</button>';
    // (lock icon removed — not used)
    rows += '</div>';
    rows += '<div class="track-lane" style="width:' + laneW + 'px;">';
    rows += '<div class="track-lane-bg"></div>';
    rows += markers;
    rows += '</div>';
    rows += '</div>';
  }

  // Make the track-header column wide enough to fit the widest indent in the
  // current tree, so all track-lanes start at the same x regardless of depth.
  let maxDepth = 0;
  for (const c of channels) if ((c.depth || 0) > maxDepth) maxDepth = c.depth || 0;
  const headerW = TIMELINE_HEADER_W + maxDepth * 14;
  // Update the CSS custom property so the time-ruler header matches
  const tlScroll = document.getElementById('timelineScroll');
  if (tlScroll) tlScroll.style.setProperty('--tl-header-w', headerW + 'px');
  // Splice the actual width into the ruler HTML (the placeholder is set above
  // before maxDepth is known).
  ruler = ruler.replace('data-ruler-width="' + (TIMELINE_HEADER_W + laneW) + '"', 'style="width:' + (headerW + laneW) + 'px"');

  el.style.width = (headerW + laneW) + 'px';
  el.innerHTML = ruler + rows;

  updatePlayhead(laneW, anim);
  wireTimelineEvents();
}

function formatTimecode(ms) {
  if (ms < 1000) return Math.round(ms) + 'ms';
  const totalSec = ms / 1000;
  const m = Math.floor(totalSec / 60);
  const s = Math.floor(totalSec - m * 60);
  const rest = Math.round(ms - (m * 60 + s) * 1000);
  if (m > 0) return m + ':' + String(s).padStart(2, '0') + '.' + String(rest).padStart(3, '0');
  return s + '.' + String(rest).padStart(3, '0') + 's';
}

// ---------- timeline column resize (left "objects" column) ----------
const TL_HEADER_W_KEY = 'scml_timeline_header_w_v1';
function applyTimelineHeaderWidth() {
  const scroll = document.getElementById('timelineScroll');
  if (scroll) scroll.style.setProperty('--tl-header-w', TIMELINE_HEADER_W + 'px');
  // Re-render to pick up the new width. Guard against temporal-dead-zone on
  // currentAnim (it's declared later in the script).
  try {
    if (typeof render === 'function' && currentAnim) render();
  } catch (e) { /* not ready yet */ }
}
(function initTimelineResize() {
  try {
    const saved = parseInt(localStorage.getItem(TL_HEADER_W_KEY) || '160', 10);
    if (saved >= 80 && saved <= 480) TIMELINE_HEADER_W = saved;
  } catch (e) {}
  // Don't call applyTimelineHeaderWidth() here — currentAnim/render aren't
  // initialized yet. Wait until the page is fully booted.
  setTimeout(applyTimelineHeaderWidth, 200);
  // Wire the resize handle (delegated; survives renderTracker re-renders)
  document.body.addEventListener('mousedown', (e) => {
    const handle = e.target.closest('#tlResizeHandle');
    if (!handle) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = TIMELINE_HEADER_W;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    const onMove = (ev) => {
      const newW = Math.max(80, Math.min(480, startW + (ev.clientX - startX)));
      TIMELINE_HEADER_W = newW;
      applyTimelineHeaderWidth();
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      try { localStorage.setItem(TL_HEADER_W_KEY, String(TIMELINE_HEADER_W)); } catch (e) {}
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
})();

(function initTimelineDelegation() {
  // Event delegation on #trackerView (the stable container). Its innerHTML
  // is replaced on every render during play, but the element itself is
  // permanent, so a listener attached here survives re-renders. Without
  // this, the eye toggle silently fails during play: the play tick fires
  // between mousedown and click, the click event lands on a detached
  // button whose handler reference is now stale.
  const el = document.getElementById('trackerView');
  if (!el) return;
  el.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-toggle-visible]');
    if (!btn) return;
    e.stopPropagation();
    const key = btn.dataset.toggleVisible;
    const wasHidden = trackVisible[key] === false;
    trackVisible[key] = !wasHidden;
    // When hiding or showing a bone, cascade to all descendant bones + sprites.
    // Hide = turn them off; Show = turn them back on. This makes it possible
    // to switch a whole rig subtree with one click.
    if (key.startsWith('bones:')) {
      // Build the descendant set from every bone_ref in every mainline
      // key of the current animation. The entity's `bones` array doesn't
      // carry parent references here, so the only source of parent→child
      // information is the mainline keyframe data — and a child bone
      // that's idle at t=0 is still in the hierarchy at a later key.
      const rootBoneIdStr = key.slice('bones:'.length);
      const rootBoneIdNum = Number(rootBoneIdStr);
      const childBones = {};
      const mainlineKeys = currentAnim.mainline || [];
      for (let mk = 0; mk < mainlineKeys.length; mk++) {
        const mkey = mainlineKeys[mk];
        for (const br of (mkey.bone_refs || [])) {
          const parentKey = br.parent === null || br.parent === undefined ? 'root' : String(br.parent);
          (childBones[parentKey] = childBones[parentKey] || []).push(br);
        }
      }
      const allBoneIds = new Set([rootBoneIdStr, String(rootBoneIdNum)]);
      function collectBones(boneId) {
        for (const ch of (childBones[String(boneId)] || [])) {
          if (allBoneIds.has(String(ch.id))) continue; // cycle guard
          allBoneIds.add(String(ch.id));
          collectBones(ch.id);
        }
      }
      collectBones(rootBoneIdNum);
      // Cascade: every bone in the subtree (including the root) gets
      // set to the new visible state. We use `wasHidden` deliberately
      // — the cascade's job is to flip the WHOLE subtree as one unit,
      // not to re-toggle the root after we already toggled it. So if
      // the root was hidden, the cascade shows everything; if it was
      // visible, the cascade hides everything.
      const targetState = wasHidden;
      for (const boneId of allBoneIds) {
        trackVisible['bones:' + boneId] = targetState;
      }
      // Match sprites by their bone parent. Walk every mainline key
      // so we catch objects parented to bones that are dormant at t=0.
      const objIds = new Set();
      for (let mk = 0; mk < mainlineKeys.length; mk++) {
        const mkey = mainlineKeys[mk];
        for (const orf of (mkey.object_refs || [])) {
          if (allBoneIds.has(String(orf.parent))) {
            objIds.add(String(orf.id));
          }
        }
      }
      for (const oid of objIds) {
        trackVisible['objects:' + oid] = targetState;
      }
    }
    // The button's visual state (the 'on' class) is set by the tracker
    // re-render below, which reads trackVisible[] for every channel and
    // builds the button with the correct class. We don't toggle the class
    // here because (a) the old button is about to be replaced by the
    // re-render anyway, and (b) the trackVisible state after the cascade
    // is the source of truth — toggling a class on a soon-to-be-detached
    // element would just be misleading if anything inspected it.
    render();
  });
})();

// ---------- timeline legend popover (explains the keyframe marker shapes) ----------
(function initTimelineLegend() {
  const wrap = document.getElementById('tlLegend');
  const btn = document.getElementById('tlLegendBtn');
  if (!wrap || !btn) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    wrap.classList.toggle('show');
  });
  document.addEventListener('click', (e) => {
    if (wrap.classList.contains('show') && !wrap.contains(e.target)) wrap.classList.remove('show');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') wrap.classList.remove('show');
  });
})();

function updatePlayhead(laneW, anim) {
  const ph = document.getElementById('playhead');
  if (!ph) return;
  // Read the current header width from the CSS custom property so the playhead
  // aligns with the actual rendered track header (which may be wider than the
  // base TIMELINE_HEADER_W if the hierarchy has indented items).
  const tlScroll = document.getElementById('timelineScroll');
  const headerW = tlScroll ? parseFloat(getComputedStyle(tlScroll).getPropertyValue('--tl-header-w')) || TIMELINE_HEADER_W : TIMELINE_HEADER_W;
  const x = (t / anim.length) * laneW + headerW;
  ph.style.left = x + 'px';
  playheadX = x;
  const tc = document.getElementById('tlTimecode');
  const dur = document.getElementById('tlDuration');
  if (tc) tc.textContent = formatTimecode(t);
  if (dur) dur.textContent = formatTimecode(anim.length);
  if (frameLabel) frameLabel.textContent = formatTimecode(t) + ' / ' + formatTimecode(anim.length);
}

function wireTimelineEvents() {
  const ruler = document.querySelector('.time-ruler-track');
  if (ruler) {
    ruler.addEventListener('mousedown', onRulerMouseDown);
  }
  document.querySelectorAll('.track-lane').forEach(lane => {
    lane.addEventListener('mousedown', (e) => {
      // Don't re-render when the user is clicking the eye / lock / keyframe —
      // that re-render replaces the element before the click event fires,
      // which is why the eye toggle silently failed during play.
      if (e.target.classList.contains('keyframe')) return;
      if (e.target.classList.contains('track-icon-btn')) return;
      const row = e.target.closest('.track-row');
      if (!row) return;
      const kind = row.dataset.kind;
      const id = row.dataset.id;
      selected = { kind, id };
      updateEditPanel();
      render();
    });
  });
  document.querySelectorAll('.track-name').forEach(name => {
    name.addEventListener('click', (e) => {
      const kind = e.currentTarget.dataset.kind;
      const id = e.currentTarget.dataset.id;
      selected = { kind, id };
      updateEditPanel();
      render();
    });
    name.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const kind = e.currentTarget.dataset.kind;
      const id = e.currentTarget.dataset.id;
      const curName = nameFor(kind, id, currentEntity);
      const newName = prompt('Rename', curName);
      if (newName !== null && newName.trim() !== '' && newName.trim() !== curName) {
        pushUndo();
        setName(kind, id, newName);
        scheduleAutosave();
        render();
      }
    });
  });
  // Eye-toggle click handling is now done via event delegation on
  // #trackerView (see initTimelineDelegation below). Binding per-button
  // breaks during play because render() replaces the innerHTML of
  // #trackerView on every animation frame; if the play tick fires
  // between mousedown and click, the click event lands on a detached
  // button with a stale handler reference — and the toggle silently
  // does nothing. Delegation on the stable parent element survives.
  // (lock button removed — feature not used)
  document.querySelectorAll('.keyframe').forEach(kf => {
    // Click both jumps the playhead to this key AND selects the bone/sprite
    // that owns it -- previously only a double-click selected, so clicking a
    // key while a *different* item (or nothing) was selected moved the
    // playhead but left the edit panel/floating toolbar showing the old
    // selection, which read as "clicking a keyframe does nothing."
    kf.addEventListener('click', (e) => {
      e.stopPropagation();
      selected = { kind: kf.dataset.kind, id: kf.dataset.id };
      t = Number(kf.dataset.jumpTime);
      timeSlider.value = Math.round(t);
      playing = false; playBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>';
      updateEditPanel();
      render();
    });
  });
}

function onRulerMouseDown(e) {
  if (e.button !== 0) return;
  const ruler = e.currentTarget;
  const rect = ruler.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const frac = Math.max(0, Math.min(1, x / rect.width));
  t = frac * currentAnim.length;
  timeSlider.value = Math.round(t);
  playing = false;
  playBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>';
  render();
  const onMove = (ev) => {
    const xx = ev.clientX - rect.left;
    const f = Math.max(0, Math.min(1, xx / rect.width));
    t = f * currentAnim.length;
    timeSlider.value = Math.round(t);
    render();
  };
  const onUp = () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}



// ---------- asset manager (renameable list of every bone/sprite for this entity) ----------
// Builds a stable "every sprite this skin ever uses" roster, spanning every
// mainline key of every animation on the entity -- independent of the
// current animation/frame. Previously the Asset Manager rebuilt its grid
// from whatever was on screen at the current instant (computeFrame's output
// for the live playhead), so cards would appear, disappear, and re-thumbnail
// continuously while the animation played -- that's the "modifications
// during playback" behavior. A sprite's identity here is its object_ref id,
// which is stable for the whole entity as long as it never leaves an
// animation's cast (see collectRefsAcrossKeys for the one known exception:
// animations whose object cast changes mid-animation, e.g. drawing a
// weapon, can recycle ids -- rare in practice, and no worse than before).
function buildEntityObjectRoster(entity) {
  const byId = new Map(); // id -> { id, folder, file }
  for (const anim of entity.animations) {
    const { objects: objRefs } = collectRefsAcrossKeys(anim.mainline);
    for (const orf of objRefs.values()) {
      if (byId.has(orf.id)) continue;
      const tl = anim.timelines[orf.timeline];
      const key = tl && (tl.keys.find(k => k.id === orf.key) || tl.keys[0]);
      byId.set(orf.id, { id: orf.id, folder: key ? key.folder : null, file: key ? key.file : null });
    }
  }
  return [...byId.values()];
}

function renderAssetManager(entity) {
  // Populates the asset-manager POPUP grid (sprites only). Only touches the
  // DOM when the modal is actually open -- the roster itself no longer
  // depends on the current frame, so there's nothing to refresh per-frame.
  const modal = document.getElementById('assetManagerModal');
  if (!modal.classList.contains('show')) return;
  renderAssetGrid(entity, buildEntityObjectRoster(entity));
}

function renderAssetGrid(entity, objects) {
  const el = document.getElementById('assetGrid');
  const seen = new Set();
  let html = '';
  for (const obj of objects) {
    if (seen.has(obj.id)) continue;
    seen.add(obj.id);
    const cur = nameFor('objects', obj.id, entity);
    const imgSrc = (obj.folder !== null && obj.folder !== undefined) ? images[obj.folder + '_' + obj.file] : '';
    html += `<div class="asset-card">
      <div class="thumb-wrap">${imgSrc ? `<img src="${imgSrc}" alt="">` : '<span style="color:#556;font-size:10px;">no image</span>'}</div>
      <input type="text" value="${cur.replace(/"/g, '&quot;')}" data-id="${obj.id}">
      <div class="slot-id">sprite #${obj.id}${cur !== defaultNameFor('objects', obj.id, entity) ? '' : ' (unnamed)'}</div>
    </div>`;
  }
  el.innerHTML = html || '<div class="hint">No sprites found for this skin.</div>';
  el.querySelectorAll('input[type=text]').forEach(inp => {
    inp.addEventListener('change', () => {
      pushUndo();
      setName('objects', inp.dataset.id, inp.value);
      render();
      scheduleAutosave();
    });
  });
}

function updateReorderButtons() {
  const isSprite = selected && selected.kind === 'objects';
  const ids = ['reorderTop', 'reorderUp', 'reorderDown', 'reorderBottom'];
  ids.forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = !isSprite;
  });
  const hint = document.getElementById('drawOrderHint');
  if (hint) {
    hint.textContent = isSprite
      ? 'Reorder this sprite\'s draw layer (front to back).'
      : 'Select a sprite in the timeline to reorder draw layers.';
  }
}
document.getElementById('reorderTop').addEventListener('click', () => moveSelectedInDrawOrder('top'));
document.getElementById('reorderUp').addEventListener('click', () => moveSelectedInDrawOrder('up'));
document.getElementById('reorderDown').addEventListener('click', () => moveSelectedInDrawOrder('down'));
document.getElementById('reorderBottom').addEventListener('click', () => moveSelectedInDrawOrder('bottom'));

document.getElementById('tmFile').addEventListener('click', () => document.getElementById('fileModal').classList.add('show'));
document.getElementById('closeFileModal').addEventListener('click', () => document.getElementById('fileModal').classList.remove('show'));

document.getElementById('tmNewAnim').addEventListener('click', () => document.getElementById('newAnimModal').classList.add('show'));
document.getElementById('closeNewAnimModal').addEventListener('click', () => document.getElementById('newAnimModal').classList.remove('show'));

document.getElementById('tmSheet').addEventListener('click', () => document.getElementById('sheetConfigModal').classList.add('show'));
document.getElementById('closeSheetConfig').addEventListener('click', () => document.getElementById('sheetConfigModal').classList.remove('show'));

document.getElementById('tmProject').addEventListener('click', () => document.getElementById('loadProjectModal').classList.add('show'));
document.getElementById('closeLoadProjectModal').addEventListener('click', () => document.getElementById('loadProjectModal').classList.remove('show'));

document.getElementById('tmUndo').addEventListener('click', undo);
document.getElementById('tmRedo').addEventListener('click', redo);

document.getElementById('zoomSlider').addEventListener('input', (e) => {
  VIEW_SCALE = Number(e.target.value);
  document.getElementById('zoomLabel').textContent = Math.round(VIEW_SCALE * 100) + '%';
  floatToolbarMoved = false;
  render();
});
document.getElementById('speedSlider').addEventListener('input', (e) => {
  const sl = document.getElementById('speedLabel');
  if (sl) sl.textContent = Number(e.target.value).toFixed(2) + '\u00d7';
});
document.getElementById('filterTolerance').addEventListener('input', (e) => {
  const v = document.getElementById('filterToleranceVal');
  if (v) v.textContent = e.target.value + '\u00b0';
});
document.getElementById('showSizeBox').addEventListener('change', render);

// ---------- backdrop color (RGBA) ----------
const BACKDROP_COLOR_KEY = 'scml_canvas_backdrop_color_v1';
const BACKDROP_ALPHA_KEY = 'scml_canvas_backdrop_alpha_v1';
// State variables (read at draw-time by the size box fill)
let _backdropHex = '#141414';
let _backdropAlpha = 1;
// Public accessor for the canvas draw code to pick up the current color
function getCurrentBackdropColor() {
  // hex → rgb → rgba
  const h = _backdropHex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${_backdropAlpha})`;
}
function applyBackdrop() {
  const wrap = document.getElementById('canvasWrap');
  if (wrap) wrap.style.setProperty('--canvas-backdrop', getCurrentBackdropColor());
  // Also force a re-render so the size box fill updates.
  try {
    if (typeof render === 'function' && currentAnim) render();
  } catch (e) { /* not ready yet */ }
}
(function initBackdropColor() {
  const inp = document.getElementById('backdropColor');
  const alphaInp = document.getElementById('backdropAlpha');
  const transparentBtn = document.getElementById('backdropTransparent');
  if (!inp) return;
  try {
    const savedHex = localStorage.getItem(BACKDROP_COLOR_KEY);
    if (savedHex) { inp.value = savedHex; _backdropHex = savedHex; }
    const savedAlpha = parseFloat(localStorage.getItem(BACKDROP_ALPHA_KEY));
    if (!isNaN(savedAlpha)) { _backdropAlpha = savedAlpha; if (alphaInp) alphaInp.value = Math.round(savedAlpha * 100); }
  } catch (e) {}
  applyBackdrop();
  inp.addEventListener('input', () => {
    _backdropHex = inp.value;
    try { localStorage.setItem(BACKDROP_COLOR_KEY, _backdropHex); } catch (e) {}
    applyBackdrop();
  });
  if (alphaInp) {
    alphaInp.addEventListener('input', () => {
      _backdropAlpha = Number(alphaInp.value) / 100;
      try { localStorage.setItem(BACKDROP_ALPHA_KEY, String(_backdropAlpha)); } catch (e) {}
      applyBackdrop();
    });
  }
  if (transparentBtn) {
    transparentBtn.addEventListener('click', () => {
      _backdropAlpha = 0;
      if (alphaInp) alphaInp.value = 0;
      try { localStorage.setItem(BACKDROP_ALPHA_KEY, '0'); } catch (e) {}
      applyBackdrop();
    });
  }
})();

document.getElementById('tmAssets').addEventListener('click', () => {
  renderAssetGrid(currentEntity, buildEntityObjectRoster(currentEntity));
  document.getElementById('assetManagerModal').classList.add('show');
});
document.getElementById('closeAssetManager').addEventListener('click', () => {
  document.getElementById('assetManagerModal').classList.remove('show');
});

// Wire up the secondary Close/Cancel buttons in each modal footer
document.getElementById('closeFileModal2').addEventListener('click', () => document.getElementById('fileModal').classList.remove('show'));
document.getElementById('closeNewAnimModal2').addEventListener('click', () => document.getElementById('newAnimModal').classList.remove('show'));
document.getElementById('closeSheetConfig2').addEventListener('click', () => document.getElementById('sheetConfigModal').classList.remove('show'));
document.getElementById('closeLoadProjectModal2').addEventListener('click', () => document.getElementById('loadProjectModal').classList.remove('show'));
document.getElementById('closeAssetManager2').addEventListener('click', () => document.getElementById('assetManagerModal').classList.remove('show'));
document.getElementById('cancelExportBtn2').addEventListener('click', () => {
  document.getElementById('exportPreviewModal').classList.remove('show');
  pendingSheetExport = null;
});

// ---------- hierarchy tree ----------
function renderTree(entity, boneRefs, objects) {
  const treeEl = document.getElementById('tree');
  if (!treeEl) return; // hierarchy was removed — timeline now shows the same info as track rows
  const childrenOf = {};
  boneRefs.forEach(br => { childrenOf[br.parent === null ? 'root' : br.parent] = childrenOf[br.parent === null ? 'root' : br.parent] || []; childrenOf[br.parent === null ? 'root' : br.parent].push({ type: 'bone', id: br.id }); });
  objects.forEach(o => { const key = o.zIndex; }); // no-op placeholder to keep structure simple
  const objByParent = {};
  // recover object parents from mainline (objects array doesn't carry parent, so re-derive)
  const mkey = getMainlineKeys(currentAnim, normalizeAnimTime(currentAnim, t));
  mkey.object_refs.forEach(orf => {
    const key = orf.parent === null ? 'root' : orf.parent;
    objByParent[key] = objByParent[key] || [];
    objByParent[key].push(orf.id);
  });

  let html = '';
  function nodeLabel(kind, id) {
    return kind === 'bone' ? nameFor('bones', id, entity) : nameFor('objects', id, entity);
  }
  function walk(parentKey, depth) {
    let out = '';
    const bones = childrenOf[parentKey] || [];
    for (const b of bones) {
      const isSel = selKey() === 'bones:' + b.id;
      out += `<div class="tree-node${isSel ? ' sel' : ''}" style="padding-left:${depth * 14}px" data-kind="bones" data-id="${b.id}"><span class="dot bone-dot"></span>${nodeLabel('bone', b.id)}</div>`;
      const objs = objByParent[b.id] || [];
      for (const oid of objs) {
        const oSel = selKey() === 'objects:' + oid;
        out += `<div class="tree-node${oSel ? ' sel' : ''}" style="padding-left:${(depth + 1) * 14}px" data-kind="objects" data-id="${oid}"><span class="dot obj-dot"></span>${nodeLabel('object', oid)}</div>`;
      }
      out += walk(b.id, depth + 1);
    }
    return out;
  }
  const rootObjs = objByParent['root'] || [];
  html += walk('root', 0);
  for (const oid of rootObjs) {
    const oSel = selKey() === 'objects:' + oid;
    html += `<div class="tree-node${oSel ? ' sel' : ''}" style="padding-left:0px" data-kind="objects" data-id="${oid}"><span class="dot obj-dot"></span>${nodeLabel('object', oid)}</div>`;
  }
  treeEl.innerHTML = html;
  treeEl.querySelectorAll('.tree-node').forEach(el => {
    el.addEventListener('click', () => {
      selected = { kind: el.dataset.kind, id: el.dataset.id };
      updateEditPanel();
      render();
    });
    el.addEventListener('dblclick', (ev) => {
      ev.stopPropagation();
      const kind = el.dataset.kind;
      const curName = nameFor(kind, el.dataset.id, entity);
      const dot = el.querySelector('.dot');
      const input = document.createElement('input');
      input.type = 'text'; input.value = curName;
      input.style.cssText = 'width:100%;font-size:12px;background:#1b1d22;color:#eee;border:1px solid #3a5fd9;border-radius:3px;padding:1px 4px;';
      el.textContent = '';
      el.appendChild(dot);
      el.appendChild(input);
      input.focus(); input.select();
      let committed = false;
      const commit = () => {
        if (committed) return;
        committed = true;
        if (input.value.trim() !== curName) {
          pushUndo();
          setName(kind, el.dataset.id, input.value);
          scheduleAutosave();
        }
        render();
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (ke) => {
        if (ke.key === 'Enter') input.blur();
        if (ke.key === 'Escape') { input.value = curName; input.blur(); }
      });
    });
  });
}

// ---------- UI wiring ----------
const entitySelect = document.getElementById('entitySelect');
const animSelect = document.getElementById('animSelect');
const timeSlider = document.getElementById('timeSlider');
const speedSlider = document.getElementById('speedSlider');
const playBtn = document.getElementById('playBtn');
const frameLabel = document.getElementById('frameLabel');
const status = document.getElementById('status');
const editToggle = document.getElementById('editToggle');
const selInfo = document.getElementById('floatToolbarTitle');

entities.forEach((e, i) => {
  const opt = document.createElement('option');
  opt.value = i; opt.textContent = e.name;
  entitySelect.appendChild(opt);
});

let currentEntityIdx = 0;
let currentEntity = entities[0];
let currentAnim = currentEntity.animations[0];
let playing = false;
let t = 0;
let lastTs = null;
let editMode = false;
let selected = null;
let dragMode = null; // 'translate' | 'rotate' | 'scale'
let dragStart = null;
let lastHandles = null;

function populateAnims() {
  animSelect.innerHTML = '';
  const sheetAnimSelect = document.getElementById('sheetAnimSelect');
  const cloneSourceSelect = document.getElementById('cloneSourceSelect');
  sheetAnimSelect.innerHTML = '';
  cloneSourceSelect.innerHTML = '';
  currentEntity.animations.forEach((a, i) => {
    const opt = document.createElement('option');
    opt.value = i; opt.textContent = `${a.name} (${a.length|0}ms)`;
    animSelect.appendChild(opt);
    sheetAnimSelect.appendChild(opt.cloneNode(true));
    cloneSourceSelect.appendChild(opt.cloneNode(true));
  });
}
populateAnims();

function setAnim(idx) {
  currentAnim = currentEntity.animations[idx];
  t = 0;
  timeSlider.max = Math.round(currentAnim.length);
  timeSlider.value = 0;
  const startOffsetInput = document.getElementById('startOffsetInput');
  if (startOffsetInput) startOffsetInput.value = getStartOffset(currentAnim);
  render();
}

entitySelect.addEventListener('change', () => {
  currentEntityIdx = Number(entitySelect.value);
  currentEntity = entities[currentEntityIdx];
  selected = null; updateEditPanel();
  populateAnims();
  setAnim(0);
});
animSelect.addEventListener('change', () => setAnim(animSelect.value));
timeSlider.addEventListener('input', () => { t = Number(timeSlider.value); playing = false; playBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>'; render(); });

document.getElementById('stepFwdBtn').addEventListener('click', () => {
  t = Math.min(currentAnim.length, t + currentAnim.interval);
  timeSlider.value = t; playing = false; playBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>'; render();
});
document.getElementById('stepBackBtn').addEventListener('click', () => {
  t = Math.max(0, t - currentAnim.interval);
  timeSlider.value = t; playing = false; playBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>'; render();
});
playBtn.addEventListener('click', () => {
  playing = !playing;
  playBtn.innerHTML = playing ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>' : '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>';
  lastTs = null;
  if (playing) requestAnimationFrame(tick);
});
document.getElementById('showBones').addEventListener('change', render);
document.getElementById('showSprites').addEventListener('change', render);
document.getElementById('showLabels').addEventListener('change', render);





document.getElementById('startOffsetInput').addEventListener('input', (e) => {
  const v = Math.max(0, Number(e.target.value) || 0);
  animStartOffsets[currentAnim.name] = v;
  render();
  scheduleAutosave();
});
document.getElementById('useCurrentAsStart').addEventListener('click', () => {
  animStartOffsets[currentAnim.name] = Math.round(t);
  document.getElementById('startOffsetInput').value = Math.round(t);
  render();
  toast(`Start point for "${currentAnim.name}" set to ${Math.round(t)}ms.`);
  scheduleAutosave();
});
document.getElementById('resetStartOffset').addEventListener('click', () => {
  delete animStartOffsets[currentAnim.name];
  document.getElementById('startOffsetInput').value = 0;
  render();
  toast(`Start point for "${currentAnim.name}" reset to 0ms.`);
  scheduleAutosave();
});

function tick(ts) {
  if (!playing) return;
  if (lastTs === null) lastTs = ts;
  const dt = (ts - lastTs) * Number(speedSlider.value);
  lastTs = ts;
  t += dt;
  if (t > currentAnim.length) t -= currentAnim.length;
  timeSlider.value = Math.round(t);
  render();
  requestAnimationFrame(tick);
}

function render() {
  // Multiple module-scope `let`/`const` variables are referenced here
  // (currentEntityIdx, currentEntity, currentAnim, t, frameLabel).
  // During boot, the ResizeObserver in setupCanvasResize() may fire
  // before all of them are declared, hitting TDZ. The whole body is
  // wrapped in try/catch so a premature render() just no-ops instead
  // of crashing the page — the real first render happens at the end
  // of init() once everything is wired up.
  try {
    frameLabel.textContent = `t = ${Math.round(t)} ms / ${Math.round(currentAnim.length)} ms`;
    drawFrame(currentEntityIdx, currentEntity, currentAnim, t);
    updateCanvasBackdrop();
  } catch (e) { /* boot-phase render, no-op */ }
}

// ---------- edit mode ----------
editToggle.addEventListener('click', () => {
  editMode = !editMode;
  editToggle.textContent = editMode ? 'Disable edit mode' : 'Enable edit mode';
  canvas.classList.toggle('editing', editMode);
  if (!editMode) { selected = null; updateEditPanel(); }
  render();
});

// two-step "armed" confirm instead of native confirm() (which some browsers
// silently block after the first dialog, making the button look broken)
const clearBtn = document.getElementById('clearEntityEdits');
let clearArmed = false, clearArmedTimeout = null;
clearBtn.addEventListener('click', () => {
  if (!clearArmed) {
    clearArmed = true;
    clearBtn.classList.add('armed');
    clearBtn.textContent = 'Click again to confirm clear';
    clearArmedTimeout = setTimeout(() => {
      clearArmed = false;
      clearBtn.classList.remove('armed');
      clearBtn.textContent = 'Clear all edits (this skin)';
    }, 3000);
    return;
  }
  clearTimeout(clearArmedTimeout);
  clearArmed = false;
  clearBtn.classList.remove('armed');
  clearBtn.textContent = 'Clear all edits (this skin)';
  pushUndo();
  corrections[currentEntityIdx] = { bones: {}, objects: {} };
  selected = null; updateEditPanel(); render();
  toast('Cleared all edits for this skin.');
  scheduleAutosave();
});

function pickAt(mx, my) {
  if (lastHandles) {
    if (Math.hypot(lastHandles.rotate[0] - mx, lastHandles.rotate[1] - my) < 10) return { special: 'rotate' };
    if (Math.hypot(lastHandles.scale[0] - mx, lastHandles.scale[1] - my) < 10) return { special: 'scale' };
  }
  for (let i = lastObjectHits.length - 1; i >= 0; i--) {
    const o = lastObjectHits[i];
    const det = o.ax * o.by - o.ay * o.bx;
    if (Math.abs(det) < 1e-9) continue;
    const rx = mx - o.ex, ry = my - o.ey;
    const u = (o.by * rx - o.bx * ry) / det + o.pu * o.w;
    const v = (-o.ay * rx + o.ax * ry) / det + (1 - o.pv) * o.h;
    if (u >= 0 && u <= o.w && v >= 0 && v <= o.h) return { kind: 'objects', id: o.id };
  }
  let best = null, bestDist = 14;
  for (const b of lastBonePoints) {
    const d = Math.hypot(b.x - mx, b.y - my);
    if (d < bestDist) { bestDist = d; best = { kind: 'bones', id: b.id }; }
  }
  return best;
}

let isPanning = false;
let panStart = [0, 0];
let panOffsetStart = [0, 0];
// Set on a mousedown that hit nothing (no bone/sprite under the cursor).
// Deselecting doesn't happen immediately -- see the mouseup handler below --
// so that a drag which STARTS with a near-miss (trying to grab something
// small and just missing it) doesn't wipe out the current selection and
// close the floating toolbar out from under the user.
let pendingDeselectStart = null;
const CLICK_VS_DRAG_PX = 4;
canvas.addEventListener('mousedown', (e) => {
  const rect0 = canvas.getBoundingClientRect();
  // Pan: only allowed in view mode (left click) or with middle-mouse / Alt+left in any mode.
  // In edit mode, left-click on the canvas is reserved for selecting/dragging sprites & bones.
  const wantPan = e.button === 1 || (e.button === 0 && e.altKey) || (e.button === 0 && !editMode);
  if (wantPan && !eyedropperActive) {
    if (editMode && (e.button === 0 && !e.altKey)) {
      // In edit mode, normal left-click never pans — fall through to sprite/bone picking.
    } else {
      isPanning = true;
      panStart = [e.clientX, e.clientY];
      panOffsetStart = [VIEW_OFFSET_X, VIEW_OFFSET_Y];
      canvas.style.cursor = 'grabbing';
      e.preventDefault();
      return;
    }
  }
  if (eyedropperActive) {
    const mx0 = (e.clientX - rect0.left) * (canvas.width / rect0.width);
    const my0 = (e.clientY - rect0.top) * (canvas.height / rect0.height);
    const pixel = ctx.getImageData(Math.round(mx0), Math.round(my0), 1, 1).data;
    if (pixel[3] > 0) {
      document.getElementById('filterFrom').value = rgbToHex(pixel[0], pixel[1], pixel[2]);
      toast('Sampled color from canvas.');
    } else {
      toast('That spot is transparent — pick a spot on the character.');
    }
    eyedropperActive = false;
    return;
  }
  if (!editMode) return;
  const rect = canvas.getBoundingClientRect();
  const mx = (e.clientX - rect.left) * (canvas.width / rect.width);
  const my = (e.clientY - rect.top) * (canvas.height / rect.height);
  const hit = pickAt(mx, my);
  if (hit && hit.special && selected) {
    pushUndo();
    const c = ensureCorrection(currentEntityIdx, selected.kind, selected.id, currentAnim.name, editScope);
    const [px, py] = lastPivotById[selKey()];
    if (hit.special === 'rotate') {
      dragMode = 'rotate';
      dragStart = { px, py, initialDAngle: c.dAngle, initialPointerAngle: canvasAngleOf(mx, my, px, py) };
    } else {
      dragMode = 'scale';
      dragStart = { px, py, initialDsx: c.dsx, initialDsy: c.dsy, initialDist: Math.max(5, Math.hypot(mx - px, my - py)) };
    }
    return;
  }
  if (hit && hit.kind) {
    selected = hit;
    pushUndo();
    dragMode = 'translate';
    dragStart = { last: [mx, my] };
    updateEditPanel();
    render();
  } else {
    // Missed everything. Don't deselect yet -- see mouseup, which only
    // deselects if this turns out to have been a genuine click (little/no
    // movement), not an attempted drag that just missed its target.
    pendingDeselectStart = [e.clientX, e.clientY];
  }
});

canvas.addEventListener('mousemove', (e) => {
  if (isPanning) {
    VIEW_OFFSET_X = panOffsetStart[0] + (e.clientX - panStart[0]);
    VIEW_OFFSET_Y = panOffsetStart[1] + (e.clientY - panStart[1]);
    render();
    return;
  }
  if (!editMode || !dragMode || !selected) return;
  const rect = canvas.getBoundingClientRect();
  const mx = (e.clientX - rect.left) * (canvas.width / rect.width);
  const my = (e.clientY - rect.top) * (canvas.height / rect.height);
  const c = ensureCorrection(currentEntityIdx, selected.kind, selected.id, currentAnim.name, editScope);

  if (dragMode === 'translate') {
    const dcx = mx - dragStart.last[0], dcy = my - dragStart.last[1];
    dragStart.last = [mx, my];
    const [dwx, dwy] = canvasToWorldDelta(dcx, dcy);
    c.dx += dwx; c.dy += dwy;
  } else if (dragMode === 'rotate') {
    const now = canvasAngleOf(mx, my, dragStart.px, dragStart.py);
    const delta = now - dragStart.initialPointerAngle;
    // canvas-space angle delta maps to world-space angle delta with a sign flip (Y is flipped)
    c.dAngle = ((dragStart.initialDAngle - delta) % 360 + 360) % 360;
  } else if (dragMode === 'scale') {
    const dist = Math.max(5, Math.hypot(mx - dragStart.px, my - dragStart.py));
    const factor = dist / dragStart.initialDist;
    c.dsx = dragStart.initialDsx * factor;
    c.dsy = dragStart.initialDsy * factor;
  }
  updateEditPanel();
  render();
});
window.addEventListener('mouseup', (e) => {
  if (isPanning) {
    isPanning = false;
    canvas.style.cursor = editMode ? 'crosshair' : 'default';
  }
  if (dragMode) scheduleAutosave();
  dragMode = null; dragStart = null;
  if (pendingDeselectStart) {
    const moved = Math.hypot(e.clientX - pendingDeselectStart[0], e.clientY - pendingDeselectStart[1]);
    pendingDeselectStart = null;
    if (moved < CLICK_VS_DRAG_PX) { selected = null; updateEditPanel(); render(); }
  }
});

window.addEventListener('keydown', (e) => {
  if (!editMode || !selected) return;
  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  e.preventDefault();
  const step = e.shiftKey ? 10 : 1;
  const c = ensureCorrection(currentEntityIdx, selected.kind, selected.id, currentAnim.name, editScope);
  if (e.key === 'ArrowUp') c.dy += step;
  if (e.key === 'ArrowDown') c.dy -= step;
  if (e.key === 'ArrowLeft') c.dx -= step;
  if (e.key === 'ArrowRight') c.dx += step;
  updateEditPanel();
  render();
});

function updateEditPanel() {
  const scopeLabel = document.getElementById('ftScopeLabel');
  const colorSection = document.getElementById('ftColorSection');
  if (!selected) {
    selInfo.textContent = 'Nothing selected';
    scopeLabel.textContent = '';
    colorSection.style.display = 'none';
    if (typeof updateReorderButtons === 'function') updateReorderButtons();
    positionFloatToolbar();
    return;
  }
  const name = nameFor(selected.kind, selected.id, currentEntity);
  selInfo.textContent = name;
  scopeLabel.textContent = `${selected.kind === 'bones' ? 'Bone' : 'Sprite'} · scope: ${editScope === 'this' ? currentAnim.name + ' only' : 'all animations'}`;
  const c = ensureCorrection(currentEntityIdx, selected.kind, selected.id, currentAnim.name, editScope);
  // The float toolbar shows the REAL (post-correction) world position,
  // scale, shear — same as the right panel — plus the sprite's native
  // width/height/pivot for sprites. Bones don't have width/height/pivot,
  // so those fields are hidden for bones.
  const floatWorld = lastWorldById[(selected.kind === 'objects' ? 'objects:' : 'bones:') + selected.id];
  const bar = document.getElementById('floatToolbar');
  if (floatWorld) {
    document.getElementById('fX').value = floatWorld.x.toFixed(1);
    document.getElementById('fY').value = floatWorld.y.toFixed(1);
    document.getElementById('fAngleA').value = ((floatWorld.angle % 360 + 360) % 360).toFixed(1);
    document.getElementById('fSxA').value = floatWorld.scaleX.toFixed(3);
    document.getElementById('fSyA').value = floatWorld.scaleY.toFixed(3);
    document.getElementById('fShearA').value = (floatWorld.shear || 0).toFixed(1);
  } else {
    document.getElementById('fX').value = (0 + c.dx).toFixed(1);
    document.getElementById('fY').value = (0 + c.dy).toFixed(1);
    document.getElementById('fAngleA').value = ((c.dAngle % 360 + 360) % 360).toFixed(1);
    document.getElementById('fSxA').value = (1 * c.dsx).toFixed(3);
    document.getElementById('fSyA').value = (1 * c.dsy).toFixed(3);
    document.getElementById('fShearA').value = (c.dshear || 0).toFixed(1);
  }
  // Sprite-only: native width/height and pivot (read-only).
  if (selected.kind === 'objects') {
    bar.classList.add('show-obj-fields');
    const obj = currentEntity && currentEntity.objects ? currentEntity.objects.find(o => o.id === selected.id) : null;
    // objects array isn't on the entity; fall back to the lastObjectHits hit
    // entry captured in drawFrame, which has width/height and pivot.
    const hit = lastObjectHits && lastObjectHits.find(h => h.id === selected.id);
    if (hit) {
      document.getElementById('fW').value = Math.round(hit.w);
      document.getElementById('fH').value = Math.round(hit.h);
      document.getElementById('fPivotX').value = hit.pu.toFixed(3);
      document.getElementById('fPivotY').value = hit.pv.toFixed(3);
    } else if (obj) {
      // Fallback: look up the folder/file
      try {
        const finfo = folders[obj.folder].files[obj.file];
        document.getElementById('fW').value = Math.round(finfo.width);
        document.getElementById('fH').value = Math.round(finfo.height);
        document.getElementById('fPivotX').value = (finfo.pivot_x || 0).toFixed(3);
        document.getElementById('fPivotY').value = (finfo.pivot_y || 0).toFixed(3);
      } catch (e) {}
    }
  } else {
    bar.classList.remove('show-obj-fields');
  }
  
  // Sync right-panel mirror — show ACTUAL world position (post-correction),
  // not the delta. The actual value is the world position the user can see
  // in the canvas; editing these fields will move the sprite/bone to that
  // exact world coordinate.
  const dx2 = document.getElementById('fDx2');
  const dy2 = document.getElementById('fDy2');
  const ang2 = document.getElementById('fAngle2');
  const sx2 = document.getElementById('fSx2');
  const sy2 = document.getElementById('fSy2');
  const sh2 = document.getElementById('fShear2');
  const world = lastWorldById[(selected.kind === 'objects' ? 'objects:' : 'bones:') + selected.id];
  if (world) {
    if (dx2) dx2.value = world.x.toFixed(1);
    if (dy2) dy2.value = world.y.toFixed(1);
    if (ang2) ang2.value = ((world.angle % 360 + 360) % 360).toFixed(1);
    if (sx2) sx2.value = world.scaleX.toFixed(3);
    if (sy2) sy2.value = world.scaleY.toFixed(3);
    if (sh2) sh2.value = (world.shear || 0).toFixed(1);
  }
  const selName = document.getElementById('selName');
  const selIcon = document.getElementById('selIcon');
  const selScope = document.getElementById('selScope');
  if (selName) selName.textContent = name;
  if (selIcon) {
    selIcon.className = 'item-icon ' + (selected.kind === 'bones' ? 'bone' : 'sprite');
    selIcon.innerHTML = selected.kind === 'bones' ? '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5.5 3.5a2 2 0 1 1 3 3L8 7l2 2 4-4-2-2 .5-.5a2 2 0 1 1 3 3 2 2 0 1 1 0 4 2 2 0 1 1-3 3l-.5-.5-2 2 4 4 2-2 .5.5a2 2 0 1 1-3 3 2 2 0 1 1-4 0 2 2 0 1 1 3-3l.5.5 2-2-4-4-2 2-.5-.5a2 2 0 1 1 0-4 2 2 0 1 1 0-4Z"/></svg>' : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>';
  }
  if (selScope) selScope.textContent = (selected.kind === 'bones' ? 'Bone' : 'Sprite') + ' · ' + (editScope === 'this' ? currentAnim.name + ' only' : 'all animations');

  if (selected.kind === 'objects') {
    colorSection.style.display = 'block';
    renderFilterList();
  } else {
    colorSection.style.display = 'none';
  }
  positionFloatToolbar();
}

// ---------- float-toolbar transform fields: show & edit ACTUAL world position ----------
// Same model as the right-panel fields (see _detailFieldMap below): the
// inputs display the resolved world position the user sees in the canvas.
// On input, we compute the delta between the previous actual value and
// the newly-typed value, and fold that delta into the correction layer.
const _floatFieldMap = {
  fX:      { key: 'x',      type: 'add'  },
  fY:      { key: 'y',      type: 'add'  },
  fAngleA: { key: 'angle',  type: 'add'  },
  fShearA: { key: 'shear',  type: 'add'  },
  fSxA:    { key: 'scaleX', type: 'mult' },
  fSyA:    { key: 'scaleY', type: 'mult' },
};
Object.keys(_floatFieldMap).forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  let undoPushedThisFocus = false;
  el.addEventListener('focus', () => { undoPushedThisFocus = false; });
  el.addEventListener('input', () => {
    if (!selected) return;
    if (!undoPushedThisFocus) { pushUndo(); undoPushedThisFocus = true; }
    const meta = _floatFieldMap[id];
    const newVal = Number(el.value);
    if (!isFinite(newVal)) return;
    const world = lastWorldById[(selected.kind === 'objects' ? 'objects:' : 'bones:') + selected.id];
    const c = ensureCorrection(currentEntityIdx, selected.kind, selected.id, currentAnim.name, editScope);
    if (meta.type === 'add') {
      const oldVal = world ? world[meta.key] : 0;
      c['d' + meta.key.charAt(0).toUpperCase() + meta.key.slice(1)] = (c['d' + meta.key.charAt(0).toUpperCase() + meta.key.slice(1)] || 0) + (newVal - oldVal);
    } else { // 'mult' — scale fields
      const oldVal = world ? world[meta.key] : 1;
      const safeOld = oldVal || 1;
      const ratio = newVal / safeOld;
      const dKey = 'd' + meta.key.charAt(0).toUpperCase() + meta.key.slice(1);
      c[dKey] = (c[dKey] || 1) * ratio;
    }
    render();
    scheduleAutosave();
  });
});

// ---------- right-panel transform fields: show & edit ACTUAL world position ----------
// The fields display the resolved world position of the selected bone/sprite
// (i.e. the value the user sees in the canvas). Editing the field moves the
// item to that exact world coordinate by computing the delta and folding it
// into the correction layer.
const _detailFieldMap = {
  fDx2:   { key: 'x',      type: 'add'  },
  fDy2:   { key: 'y',      type: 'add'  },
  fAngle2:{ key: 'angle',  type: 'add'  },
  fSx2:   { key: 'scaleX', type: 'mul'  },
  fSy2:   { key: 'scaleY', type: 'mul'  },
  fShear2:{ key: 'shear',  type: 'add'  }
};
function applyDetailFieldEdit(id, raw) {
  if (!selected) return;
  const meta = _detailFieldMap[id];
  if (!meta) return;
  const c = ensureCorrection(currentEntityIdx, selected.kind, selected.id, currentAnim.name, editScope);
  const baseActual = lastWorldById[(selected.kind === 'objects' ? 'objects:' : 'bones:') + selected.id];
  if (!baseActual) return;
  const newVal = Number(raw);
  if (isNaN(newVal)) return;
  const oldActual = baseActual[meta.key];
  if (meta.type === 'add') {
    // Apply additive delta into the corresponding correction
    if (meta.key === 'x') c.dx += (newVal - oldActual);
    else if (meta.key === 'y') c.dy += (newVal - oldActual);
    else if (meta.key === 'angle') c.dAngle += (newVal - oldActual);
    else if (meta.key === 'shear') c.dshear = (c.dshear || 0) + (newVal - oldActual);
  } else if (meta.type === 'mul') {
    // Scale is multiplicative. dsx is a multiplier; new scale = old * dsx, so
    // dsx = new / old. Fold the ratio into the existing dsx.
    if (oldActual === 0) return;
    if (meta.key === 'scaleX') c.dsx = (c.dsx || 1) * (newVal / oldActual);
    else if (meta.key === 'scaleY') c.dsy = (c.dsy || 1) * (newVal / oldActual);
  }
  pushUndo();
  render();
  scheduleAutosave();
}
Object.keys(_detailFieldMap).forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('input', () => applyDetailFieldEdit(id, el.value));
});

// ---------- floating toolbar (follows the selected sprite/bone on canvas) ----------
let floatToolbarMoved = false;   // true once the user has manually dragged it
let floatToolbarLastSelKey = null;

function positionFloatToolbar() {
  const bar = document.getElementById('floatToolbar');
  if (!editMode || !selected || !lastPivotById[selKey()]) { bar.style.display = 'none'; floatToolbarLastSelKey = null; return; }
  bar.style.display = 'flex';
  if (selKey() !== floatToolbarLastSelKey) {
    // selection just changed to a different item -- snap to its new position and
    // forget any previous manual placement, so the window always starts out next
    // to whatever you just picked.
    floatToolbarLastSelKey = selKey();
    floatToolbarMoved = false;
  }
  if (floatToolbarMoved) return; // user has it where they want it; leave it alone
  const [px, py] = lastPivotById[selKey()]; // canvas-internal pixels
  // The toolbar is `position: absolute` inside #canvasWrap. CSS
  // `position: absolute` on a child of a scrollable container is
  // positioned relative to the SCROLL CONTENT, not the visible area —
  // so `left: 0, top: 0` is the top-left of the entire 2740×1317 canvas
  // content, not the wrap's visible 1370×429. We need to convert the
  // canvas-internal pivot to wrap-content coords, then clamp it so the
  // toolbar lands inside the currently-visible scroll window (so the
  // user can actually see it).
  const wrap = document.getElementById('canvasWrap');
  const wrapVisibleW = wrap.clientWidth;
  const wrapVisibleH = wrap.clientHeight;
  const wrapScrollLeft = wrap.scrollLeft || 0;
  const wrapScrollTop = wrap.scrollTop || 0;
  const barW = bar.offsetWidth || 250, barH = bar.offsetHeight || 180;
  // The canvas is top:0/left:0 inside the wrap and displays at its natural
  // internal-pixel size (1:1), so the canvas-internal pivot (px, py)
  // maps 1:1 to wrap-content coords.
  const contentX = px;
  const contentY = py;
  // Clamp to the visible scroll window, expressed in wrap-content coords.
  // (The visible window is [scrollLeft, scrollLeft+visibleW] x
  // [scrollTop, scrollTop+visibleH].)
  const minX = wrapScrollLeft + 4;
  const maxX = wrapScrollLeft + wrapVisibleW - barW - 4;
  const minY = wrapScrollTop + 4;
  const maxY = wrapScrollTop + wrapVisibleH - barH - 4;
  const bx = Math.max(minX, Math.min(maxX, contentX - barW / 2));
  const by = Math.max(minY, Math.min(maxY, contentY - 56));
  bar.style.left = bx + 'px';
  bar.style.top = by + 'px';
}

document.getElementById('ftMove').addEventListener('click', () => toast('Drag the sprite/bone itself to move it.'));
document.getElementById('ftRotate').addEventListener('click', () => toast('Drag the yellow handle to rotate.'));
document.getElementById('ftScale').addEventListener('click', () => toast('Drag the green handle to scale.'));

// ---------- dragging the floating window itself (separate from dragging a sprite/bone) ----------
(function setupFloatToolbarDrag() {
  const bar = document.getElementById('floatToolbar');
  const handle = document.getElementById('floatToolbarHandle');
  const STORAGE_KEY = 'scml_float_toolbar_v1';
  // Load saved state
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (typeof saved.left === 'number') bar.style.left = saved.left + 'px';
    if (typeof saved.top === 'number') bar.style.top = saved.top + 'px';
    if (typeof saved.width === 'number') bar.style.width = saved.width + 'px';
    if (typeof saved.height === 'number') bar.style.height = saved.height + 'px';
    if (saved.userMoved) floatToolbarMoved = true;
  } catch (e) {}
  function saveState() {
    try {
      const rect = bar.getBoundingClientRect();
      const parentRect = bar.offsetParent.getBoundingClientRect();
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        left: rect.left - parentRect.left,
        top: rect.top - parentRect.top,
        width: rect.width,
        height: rect.height,
        userMoved: floatToolbarMoved
      }));
    } catch (e) {}
  }
  let dragging = false, startMouse = [0, 0], startPos = [0, 0];
  handle.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    dragging = true;
    floatToolbarMoved = true;
    const rect = bar.getBoundingClientRect();
    const parentRect = bar.offsetParent.getBoundingClientRect();
    startMouse = [e.clientX, e.clientY];
    startPos = [rect.left - parentRect.left, rect.top - parentRect.top];
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startMouse[0], dy = e.clientY - startMouse[1];
    bar.style.left = Math.max(0, startPos[0] + dx) + 'px';
    bar.style.top = Math.max(0, startPos[1] + dy) + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (dragging) { dragging = false; saveState(); }
  });
  // Save on resize too (ResizeObserver)
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(saveState).observe(bar);
  }
})();

document.getElementById('ftFlipX').addEventListener('click', () => {
  if (!selected) return;
  pushUndo();
  const c = ensureCorrection(currentEntityIdx, selected.kind, selected.id, currentAnim.name, editScope);
  c.dsx *= -1;
  updateEditPanel(); render();
  scheduleAutosave();
});
document.getElementById('ftFlipY').addEventListener('click', () => {
  if (!selected) return;
  pushUndo();
  const c = ensureCorrection(currentEntityIdx, selected.kind, selected.id, currentAnim.name, editScope);
  c.dsy *= -1;
  updateEditPanel(); render();
  scheduleAutosave();
});

document.getElementById('editScopeSelect').addEventListener('change', (e) => {
  editScope = e.target.value;
  updateEditPanel();
});

document.getElementById('ftReset').addEventListener('click', () => {
  if (!selected) return;
  pushUndo();
  const e = corrections[currentEntityIdx];
  if (e && e[selected.kind] && e[selected.kind][selected.id]) {
    const entry = migrateCorrectionEntry(e[selected.kind][selected.id]);
    if (editScope === 'this') { delete entry.perAnim[currentAnim.name]; }
    else { entry.global = blankCorrection(); }
    e[selected.kind][selected.id] = entry;
  }
  updateEditPanel();
  render();
  scheduleAutosave();
  toast('Reset that correction.');
});

// ---------- color filter UI ----------
function renderFilterList() {
  const el = document.getElementById('filterList');
  if (colorFilters.length === 0) { el.innerHTML = 'No filters active.'; return; }
  // Only show filters that affect the CURRENTLY SELECTED sprite -- this panel lives
  // inside that sprite's own floating window, so anything else would be confusing.
  const ref = currentSpriteRef();
  const relevant = ref ? colorFilters.filter(f => f.spriteRef && f.spriteRef.folder === ref.folder && f.spriteRef.file === ref.file) : [];
  el.innerHTML = relevant.length ? relevant.map(f => `
    <div class="row" style="margin-top:4px; align-items:center;">
      <span style="display:inline-block;width:14px;height:14px;background:${f.sourceHex};border-radius:3px;border:1px solid #555;"></span>
      →
      <span style="display:inline-block;width:14px;height:14px;background:${f.targetHex};border-radius:3px;border:1px solid #555;"></span>
      <span style="font-size:10px;color:#9aa;">±${f.tolerance}° · ${f.animScope || 'project'}</span>
      <button class="secondary" data-remove-filter="${f.id}" style="padding:2px 6px; font-size:10px;">×</button>
    </div>`).join('') : '<span style="font-size:11px;color:#667;">No filters on this sprite.</span>';
  el.querySelectorAll('[data-remove-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      pushUndo();
      const id = Number(btn.dataset.removeFilter);
      colorFilters = colorFilters.filter(f => f.id !== id);
      renderFilterList();
      render();
      scheduleAutosave();
    });
  });
}
renderFilterList();

// Returns the (folder,file) of the currently selected sprite, or null if a bone (or
// nothing) is selected. Filters are always scoped to whatever sprite is selected when
// you add them -- no more separate "pick a sprite" step.
function currentSpriteRef() {
  if (!selected || selected.kind !== 'objects') return null;
  const frame = computeFrame(currentEntityIdx, currentAnim, t);
  const obj = frame.objects.find(o => o.id === selected.id);
  if (!obj || obj.folder === null || obj.folder === undefined) return null;
  const finfo = folders[obj.folder].files[obj.file];
  return { folder: obj.folder, file: obj.file, label: finfo.name.split('/').pop() };
}

document.getElementById('addFilter').addEventListener('click', () => {
  const ref = currentSpriteRef();
  if (!ref) { toast('Select a sprite first (not a bone).'); return; }
  const scopeMode = document.getElementById('filterScopeSelect').value; // 'animation' | 'project'
  pushUndo();
  colorFilters.push({
    id: filterIdCounter++,
    sourceHex: document.getElementById('filterFrom').value,
    targetHex: document.getElementById('filterTo').value,
    tolerance: Number(document.getElementById('filterTolerance').value),
    spriteRef: ref,
    animScope: scopeMode === 'animation' ? currentAnim.name : null
  });
  renderFilterList();
  render();
  toast(`Filter added to ${ref.label}${scopeMode === 'animation' ? ' (' + currentAnim.name + ' only)' : ' (whole project)'}.`);
  scheduleAutosave();
});

let eyedropperActive = false;
document.getElementById('pickFrom').addEventListener('click', () => {
  eyedropperActive = true;
  toast('Click anywhere on the character to sample that color.');
});

// ---------- spritesheet export ----------
function buildSpritesheet() {
  const animIdx = Number(document.getElementById('sheetAnimSelect').value);
  const anim = currentEntity.animations[animIdx];
  const fps = Math.max(1, Number(document.getElementById('sheetFps').value) || 12);
  const colsInput = document.getElementById('sheetCols').value;
  const TILE = Math.max(50, Number(document.getElementById('sheetTile').value) || 300);

  const frameCount = Math.max(1, Math.round((anim.length / 1000) * fps));
  const bbox = computeAnimationWorldBBox(currentEntityIdx, anim);
  const bboxW = Math.max(1, bbox.maxx - bbox.minx), bboxH = Math.max(1, bbox.maxy - bbox.miny);
  const margin = 0.88;
  const viewScale = Math.min(TILE / bboxW, TILE / bboxH) * margin;
  const cx = (bbox.minx + bbox.maxx) / 2, cy = (bbox.miny + bbox.maxy) / 2;
  const baseOriginX = TILE / 2 - cx * viewScale;
  const baseOriginY = TILE / 2 + cy * viewScale;

  const cols = colsInput ? Math.max(1, parseInt(colsInput)) : Math.ceil(Math.sqrt(frameCount));
  const rows = Math.ceil(frameCount / cols);

  const sheet = document.createElement('canvas');
  sheet.width = cols * TILE; sheet.height = rows * TILE;
  const sctx = sheet.getContext('2d');

  for (let f = 0; f < frameCount; f++) {
    const rawT = (f / fps) * 1000;
    const { objects } = computeFrame(currentEntityIdx, anim, rawT);
    const col = f % cols, row = Math.floor(f / cols);
    paintSprites(sctx, objects, viewScale, baseOriginX + col * TILE, baseOriginY + row * TILE, {}, anim.name);
  }

  const manifest = {
    entity: currentEntity.name, animation: anim.name, fps, frameCount, columns: cols, rows,
    tileWidth: TILE, tileHeight: TILE, sheetWidth: sheet.width, sheetHeight: sheet.height
  };
  return { sheet, manifest };
}

async function downloadSpritesheet(sheet, manifest) {
  const statusEl = document.getElementById('sheetStatus');
  const pngBlob = await new Promise(resolve => sheet.toBlob(resolve, 'image/png'));
  const a1 = document.createElement('a');
  a1.href = URL.createObjectURL(pngBlob);
  a1.download = `${manifest.entity}_${manifest.animation}_${manifest.fps}fps.png`;
  a1.click();

  const jsonBlob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
  const a2 = document.createElement('a');
  a2.href = URL.createObjectURL(jsonBlob);
  a2.download = `${manifest.entity}_${manifest.animation}_${manifest.fps}fps.json`;
  a2.click();

  statusEl.textContent = `Exported ${manifest.frameCount} frames, ${manifest.columns}×${manifest.rows} grid, ${manifest.tileWidth}px tiles.`;
  toast('Spritesheet exported.');
}

let pendingSheetExport = null;

document.getElementById('exportSheet').addEventListener('click', () => {
  try {
    const { sheet, manifest } = buildSpritesheet();
    pendingSheetExport = { sheet, manifest };
    document.getElementById('exportPreviewImg').src = sheet.toDataURL('image/png');
    document.getElementById('exportPreviewMeta').textContent =
      `${manifest.animation} · ${manifest.frameCount} frames · ${manifest.fps} fps · ${manifest.columns}×${manifest.rows} grid · ${manifest.tileWidth}px tiles`;
    document.getElementById('sheetConfigModal').classList.remove('show');
    document.getElementById('exportPreviewModal').classList.add('show');
  } catch (err) {
    document.getElementById('sheetStatus').textContent = 'Preview failed: ' + err.message;
  }
});

document.getElementById('confirmExportBtn').addEventListener('click', () => {
  if (!pendingSheetExport) return;
  downloadSpritesheet(pendingSheetExport.sheet, pendingSheetExport.manifest);
  document.getElementById('exportPreviewModal').classList.remove('show');
  pendingSheetExport = null;
});
document.getElementById('cancelExportBtn').addEventListener('click', () => {
  document.getElementById('exportPreviewModal').classList.remove('show');
  pendingSheetExport = null;
});




let addedAnimations = []; // { entityIdx, anim } pairs created via "New Animation"

function currentAppState() {
  return { corrections, animStartOffsets, colorFilters, boneNames, objectNames, addedAnimations };
}

function applyAddedAnimations(list) {
  (list || []).forEach(({ entityIdx, anim }) => {
    const ent = entities[entityIdx];
    if (!ent) return;
    if (!ent.animations.some(a => a.name === anim.name)) ent.animations.push(anim);
  });
  addedAnimations = list || [];
}

// ---------- undo / redo ----------
// Snapshot-based: captures everything in currentAppState() PLUS the entities array
// itself (bones/animations/z-order live there, e.g. draw-order reordering directly
// mutates entities, which appState alone doesn't cover). Entities contain no image
// data, so cloning them is cheap even though it's a full JSON round-trip.
let undoStack = [];
let redoStack = [];
const MAX_UNDO = 60;

function snapshotState() {
  return JSON.stringify({ appState: currentAppState(), entities });
}
function pushUndo() {
  undoStack.push(snapshotState());
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack = [];
  updateUndoRedoButtons();
}
function restoreSnapshot(snapJson) {
  const snap = JSON.parse(snapJson);
  const s = snap.appState;
  corrections = s.corrections || {};
  animStartOffsets = s.animStartOffsets || {};
  colorFilters = Array.isArray(s.colorFilters) ? s.colorFilters : [];
  boneNames = s.boneNames || {};
  objectNames = s.objectNames || {};
  addedAnimations = s.addedAnimations || [];
  entities = snap.entities;
  filterIdCounter = colorFilters.length ? Math.max(...colorFilters.map(f => f.id || 0)) + 1 : 1;
  Object.keys(filteredImgCache).forEach(k => delete filteredImgCache[k]);
  currentEntity = entities[currentEntityIdx] || entities[0];
  const wantName = currentAnim && currentAnim.name;
  currentAnim = currentEntity.animations.find(a => a.name === wantName) || currentEntity.animations[0];
  renderFilterList();
  populateAnims();
  const idx = currentEntity.animations.indexOf(currentAnim);
  animSelect.value = idx >= 0 ? idx : 0;
  document.getElementById('startOffsetInput').value = getStartOffset(currentAnim);
  selected = null; updateEditPanel();
  render();
  updateUndoRedoButtons();
}
function undo() {
  if (undoStack.length === 0) { toast('Nothing to undo.'); return; }
  redoStack.push(snapshotState());
  restoreSnapshot(undoStack.pop());
  toast('Undid last change.');
  scheduleAutosave();
}
function redo() {
  if (redoStack.length === 0) { toast('Nothing to redo.'); return; }
  undoStack.push(snapshotState());
  restoreSnapshot(redoStack.pop());
  toast('Redid change.');
  scheduleAutosave();
}
function updateUndoRedoButtons() {
  const u = document.getElementById('tmUndo'), r = document.getElementById('tmRedo');
  if (u) u.disabled = undoStack.length === 0;
  if (r) r.disabled = redoStack.length === 0;
}

// ---------- autosave (localStorage) ----------
// This is a real downloaded HTML file running in the person's own browser, not a
// sandboxed preview, so localStorage is available and is exactly the right tool for
// "don't lose an hour of re-posing work if the tab reloads." Only the built-in
// Explorer project is autosaved automatically (a freshly loaded custom project's
// images are session-only blob URLs that can't survive a reload anyway); if you're
// working on a custom project, use "Save edits" manually instead.
const AUTOSAVE_KEY = 'scml_viewer_autosave_v1';
let autosaveTimer = null;
let usingCustomProject = false;
let stateVersion = 0; // bumped on every meaningful edit; used to invalidate the anim-bbox cache below

function scheduleAutosave() {
  stateVersion++;
  if (usingCustomProject) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ savedAt: Date.now(), state: currentAppState() }));
    } catch (e) { /* storage full or unavailable -- silently skip, nothing else to do */ }
  }, 600);
}

function checkForAutosave() {
  let raw;
  try { raw = localStorage.getItem(AUTOSAVE_KEY); } catch (e) { return; }
  if (!raw) return;
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { return; }
  if (!parsed || !parsed.state) return;
  const banner = document.getElementById('autosaveBanner');
  const ageMin = Math.round((Date.now() - (parsed.savedAt || 0)) / 60000);
  banner.querySelector('span').textContent = `Found autosaved work from ${ageMin < 1 ? 'less than a minute ago' : ageMin + ' minute(s) ago'}.`;
  banner.classList.add('show');
  document.getElementById('restoreAutosave').onclick = () => {
    const s = parsed.state;
    corrections = s.corrections || {};
    animStartOffsets = s.animStartOffsets || {};
    colorFilters = Array.isArray(s.colorFilters) ? s.colorFilters : [];
    boneNames = s.boneNames || {};
    objectNames = s.objectNames || {};
    filterIdCounter = colorFilters.length ? Math.max(...colorFilters.map(f => f.id || 0)) + 1 : 1;
    applyAddedAnimations(s.addedAnimations);
    Object.keys(filteredImgCache).forEach(k => delete filteredImgCache[k]);
    renderFilterList();
    populateAnims();
    document.getElementById('startOffsetInput').value = getStartOffset(currentAnim);
    selected = null; updateEditPanel(); render();
    banner.classList.remove('show');
    toast('Autosaved work restored.');
  };
  document.getElementById('discardAutosave').onclick = () => {
    try { localStorage.removeItem(AUTOSAVE_KEY); } catch (e) {}
    banner.classList.remove('show');
  };
}
checkForAutosave();

// ---------- inject a resize handle into every modal so the user can drag
// the bottom-right corner to resize any popup ----------
(function injectModalResizeHandles() {
  const styleSheet = document.createElement('style');
  styleSheet.textContent = '.modal-box { position: relative; }';
  document.head.appendChild(styleSheet);
  document.querySelectorAll('.modal-box').forEach(box => {
    if (box.querySelector('.modal-resize-handle')) return;
    const handle = document.createElement('div');
    handle.className = 'modal-resize-handle';
    box.appendChild(handle);
  });
})();



document.getElementById('saveEdits').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(currentAppState(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'explorer_edits.json';
  a.click();
  toast('Saved edits.json');
});

document.getElementById('loadEditsFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const loaded = JSON.parse(reader.result);
      // backward compatible with old "just corrections" files
      corrections = ('corrections' in loaded) ? loaded.corrections : loaded;
      animStartOffsets = loaded.animStartOffsets && typeof loaded.animStartOffsets === 'object' ? loaded.animStartOffsets : {};
      colorFilters = Array.isArray(loaded.colorFilters) ? loaded.colorFilters : [];
      boneNames = loaded.boneNames && typeof loaded.boneNames === 'object' ? loaded.boneNames : {};
      objectNames = loaded.objectNames && typeof loaded.objectNames === 'object' ? loaded.objectNames : {};
      applyAddedAnimations(loaded.addedAnimations);
      filterIdCounter = colorFilters.length ? Math.max(...colorFilters.map(f => f.id || 0)) + 1 : 1;
      Object.keys(filteredImgCache).forEach(k => delete filteredImgCache[k]);
      renderFilterList();
      populateAnims();
      document.getElementById('startOffsetInput').value = getStartOffset(currentAnim);
      selected = null; updateEditPanel(); render();
      toast('Edits loaded.');
    } catch (err) {
      toast('Could not parse that file.');
    }
  };
  reader.readAsText(file);
});

async function blobUrlToDataUrl(url) {
  const resp = await fetch(url);
  const blob = await resp.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

document.getElementById('exportViewer').addEventListener('click', async () => {
  const btn = document.getElementById('exportViewer');
  const original = btn.textContent;
  btn.textContent = 'Building export…'; btn.disabled = true;
  try {
    // Collect every image, inlining blob URLs as data URLs so the
    // exported file is self-contained and can be opened from disk.
    const exportImages = {};
    for (const [key, url] of Object.entries(images)) {
      exportImages[key] = url.startsWith('data:') ? url : await blobUrlToDataUrl(url);
    }
    const dataJson = JSON.stringify({ folders, entities, images: exportImages });
    const appStateJson = JSON.stringify(currentAppState());

    // Build the exported HTML by taking the current page and:
    //   1) stripping the external data.js / corrections.js <script> tags
    //   2) inlining the data + corrections as <script id="data-holder">
    //      and <script id="corrections-holder"> tags (the app reads from
    //      window.SCML_DATA / window.SCML_CORRECTIONS OR from these inline
    //      tags — see init fallback below)
    //   3) inlining style.css and app.js so the exported file works
    //      standalone from file:// (no external deps to break)
    let html = document.documentElement.outerHTML;
    // Strip external script/link tags — we'll inline them.
    html = html.replace(/<script src=["']data\.js["']><\/script>/g, '');
    html = html.replace(/<script src=["']corrections\.js["']><\/script>/g, '');
    html = html.replace(/<link[^>]*href=["']style\.css["'][^>]*>/g, '');
    html = html.replace(/<script src=["']app\.js["']><\/script>/g, '');
    // Inline CSS at the end of <head>
    const cssText = await fetch('style.css').then(r => r.text()).catch(() => '');
    if (cssText) {
      html = html.replace('</head>', `<style>${cssText}</style></head>`);
    }
    // Inline JS, data, corrections, and a bootstrap that reads the
    // inline data/corrections tags into window.SCML_DATA / window.SCML_CORRECTIONS.
    // Order matters: data tag → corrections tag → bootstrap → app.js
    // (the bootstrap must run before app.js reads the globals).
    const jsText = await fetch('app.js').then(r => r.text()).catch(() => '');
    const dataTag = `<script id="data-holder" type="application/json">${dataJson}</script>`;
    const corrTag = `<script id="corrections-holder" type="application/json">${appStateJson}</script>`;
    const bootstrap = `<script>
  (function(){
    var d = document.getElementById('data-holder');
    if (d) { try { window.SCML_DATA = JSON.parse(d.textContent); } catch(e){} }
    var c = document.getElementById('corrections-holder');
    if (c) { try { window.SCML_CORRECTIONS = JSON.parse(c.textContent || '{}'); } catch(e){} }
  })();
</script>`;
    const scriptTag = jsText ? `<script>\n${jsText}\n</script>` : '';
    // The scriptTag placeholder marker gets replaced in order: data, corrections, bootstrap, then app.js
    const replaceBlock = dataTag + corrTag + bootstrap + scriptTag;
    html = html.replace('</body>', replaceBlock + '</body>');

    const blob = new Blob([html], { type: 'text/html' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'explorer_viewer_fixed.html';
    a.click();
    toast('Exported fixed viewer.');
  } catch (err) {
    toast('Export failed: ' + err.message);
  } finally {
    btn.textContent = original; btn.disabled = false;
  }
});

// ---------- load a different SCML project ----------
function directChildren(el, tag) {
  return Array.from(el.children).filter(c => c.tagName === tag);
}

function parseSCML(xmlText) {
  const dom = new DOMParser().parseFromString(xmlText, 'application/xml');
  const perr = dom.querySelector('parsererror');
  if (perr) throw new Error('XML did not parse: ' + perr.textContent.slice(0, 200));
  const root = dom.documentElement;

  const folders = {};
  for (const f of directChildren(root, 'folder')) {
    const fid = f.getAttribute('id');
    const files = {};
    for (const file of directChildren(f, 'file')) {
      files[file.getAttribute('id')] = {
        name: file.getAttribute('name'),
        width: parseFloat(file.getAttribute('width')),
        height: parseFloat(file.getAttribute('height')),
        // Spec default pivot is (0, 1) -- top-left -- when the attributes are omitted.
        pivot_x: file.getAttribute('pivot_x') !== null ? parseFloat(file.getAttribute('pivot_x')) : 0,
        pivot_y: file.getAttribute('pivot_y') !== null ? parseFloat(file.getAttribute('pivot_y')) : 1
      };
    }
    folders[fid] = { name: f.getAttribute('name'), files };
  }

  const entities = [];
  for (const e of directChildren(root, 'entity')) {
    const bones = [];
    for (const oi of directChildren(e, 'obj_info')) {
      if (oi.getAttribute('type') === 'bone') bones.push(oi.getAttribute('name'));
    }
    const animations = [];
    for (const anim of directChildren(e, 'animation')) {
      const loopingAttr = anim.getAttribute('looping');
      const a = {
        id: anim.getAttribute('id'), name: anim.getAttribute('name'),
        length: parseFloat(anim.getAttribute('length')),
        interval: parseFloat(anim.getAttribute('interval') || 100),
        looping: loopingAttr === null ? true : loopingAttr.toLowerCase() !== 'false',
        mainline: [], timelines: {}
      };
      const mainlineEl = directChildren(anim, 'mainline')[0];
      for (const key of directChildren(mainlineEl, 'key')) {
        const k = { id: key.getAttribute('id'), time: parseFloat(key.getAttribute('time') || 0), bone_refs: [], object_refs: [] };
        for (const br of directChildren(key, 'bone_ref')) {
          k.bone_refs.push({ id: br.getAttribute('id'), parent: br.getAttribute('parent'), timeline: br.getAttribute('timeline'), key: br.getAttribute('key') });
        }
        for (const orf of directChildren(key, 'object_ref')) {
          k.object_refs.push({ id: orf.getAttribute('id'), parent: orf.getAttribute('parent'), timeline: orf.getAttribute('timeline'), key: orf.getAttribute('key'), z_index: parseInt(orf.getAttribute('z_index') || 0) });
        }
        a.mainline.push(k);
      }
      for (const tl of directChildren(anim, 'timeline')) {
        const tlid = tl.getAttribute('id');
        const tobj = { id: tlid, obj: tl.getAttribute('obj'), name: tl.getAttribute('name'), object_type: tl.getAttribute('object_type') || 'sprite', keys: [] };
        for (const key of directChildren(tl, 'key')) {
          const kk = {
            id: key.getAttribute('id'), time: parseFloat(key.getAttribute('time') || 0),
            spin: parseInt(key.getAttribute('spin') === null ? 1 : key.getAttribute('spin')),
            curve_type: key.getAttribute('curve_type') || '0',
            c1: parseFloat(key.getAttribute('c1') || 0), c2: parseFloat(key.getAttribute('c2') || 0)
          };
          const boneEl = directChildren(key, 'bone')[0];
          const objEl = directChildren(key, 'object')[0];
          const el = boneEl || objEl;
          kk.transform = {
            x: parseFloat(el.getAttribute('x') || 0), y: parseFloat(el.getAttribute('y') || 0),
            angle: parseFloat(el.getAttribute('angle') || 0),
            scaleX: parseFloat(el.getAttribute('scale_x') || 1), scaleY: parseFloat(el.getAttribute('scale_y') || 1),
            // Spec: SpatialInfo.a (opacity), default 1 -- used for fade in/out keys.
            // Named `alpha` (not `a`) to avoid clashing with the `a`/`b` key-pair
            // locals used throughout the interpolation code below.
            alpha: el.getAttribute('a') !== null ? parseFloat(el.getAttribute('a')) : 1
          };
          kk.folder = objEl ? objEl.getAttribute('folder') : null;
          kk.file = objEl ? objEl.getAttribute('file') : null;
          tobj.keys.push(kk);
        }
        a.timelines[tlid] = tobj;
      }
      animations.push(a);
    }
    entities.push({ id: e.getAttribute('id'), name: e.getAttribute('name'), bones, animations });
  }
  return { folders, entities };
}

function buildImageMap(folders, fileList) {
  const byBase = {};
  const relEntries = [];
  for (const file of fileList) {
    if (!/\.png$/i.test(file.name)) continue;
    if (!byBase[file.name]) byBase[file.name] = file;
    const rel = (file.webkitRelativePath || file.name).replace(/\\/g, '/');
    relEntries.push({ rel, file });
  }
  const images = {};
  const missing = [];
  for (const [fid, finfo] of Object.entries(folders)) {
    for (const [fileId, attrs] of Object.entries(finfo.files)) {
      const declared = attrs.name.replace(/\\/g, '/');
      const base = declared.split('/').pop();
      let match = relEntries.find(({ rel }) => rel === declared || rel.endsWith('/' + declared));
      let file = match ? match.file : byBase[base];
      if (!file) { missing.push(declared); continue; }
      images[fid + '_' + fileId] = URL.createObjectURL(file);
    }
  }
  return { images, missing };
}

function loadProject(newFolders, newEntities, newImages, label, isCustom) {
  folders = newFolders; entities = newEntities; images = newImages;
  corrections = {};
  colorFilters = [];
  animStartOffsets = {};
  boneNames = {};
  objectNames = {};
  addedAnimations = [];
  usingCustomProject = !!isCustom;
  Object.keys(imgCache).forEach(k => delete imgCache[k]);
  Object.keys(filteredImgCache).forEach(k => delete filteredImgCache[k]);
  renderFilterList();
  entitySelect.innerHTML = '';
  entities.forEach((e, i) => {
    const opt = document.createElement('option');
    opt.value = i; opt.textContent = e.name;
    entitySelect.appendChild(opt);
  });
  currentEntityIdx = 0;
  currentEntity = entities[0];
  selected = null; updateEditPanel();
  populateAnims();
  setAnim(0);
  status.textContent = `${entities.length} entities · ${Object.keys(images).length} images loaded${label ? ' — ' + label : ''}`;
}

// ---------- new animation (clone an existing one as a starting point) ----------
document.getElementById('createAnimBtn').addEventListener('click', () => {
  const statusEl = document.getElementById('newAnimStatus');
  const srcIdx = Number(document.getElementById('cloneSourceSelect').value);
  const rawName = document.getElementById('newAnimName').value.trim();
  if (!rawName) { statusEl.textContent = 'Give the new animation a name first.'; return; }
  const name = rawName.replace(/\s+/g, '_');
  if (currentEntity.animations.some(a => a.name === name)) {
    statusEl.textContent = `"${name}" already exists — pick a different name.`;
    return;
  }
  pushUndo();
  const src = currentEntity.animations[srcIdx];
  // deep clone via JSON round-trip -- these are plain data objects, no functions/DOM refs
  const clone = JSON.parse(JSON.stringify(src));
  clone.id = 'custom_' + Date.now();
  clone.name = name;
  currentEntity.animations.push(clone);
  addedAnimations.push({ entityIdx: currentEntityIdx, anim: clone });
  populateAnims();
  animSelect.value = currentEntity.animations.length - 1;
  setAnim(currentEntity.animations.length - 1);
  document.getElementById('editScopeSelect').value = 'this';
  editScope = 'this';
  document.getElementById('newAnimName').value = '';
  statusEl.textContent = `Created "${name}" from "${src.name}". Edit scope is now set to "This animation only" so your re-posing stays isolated.`;
  toast(`Created animation "${name}".`);
  scheduleAutosave();
});


document.getElementById('loadProjectBtn').addEventListener('click', async () => {
  const scmlFile = document.getElementById('loadScmlFile').files[0];
  const imgFiles = document.getElementById('loadImagesFiles').files;
  const statusEl = document.getElementById('loadStatus');
  if (!scmlFile) { statusEl.textContent = 'Pick a .scml file first.'; return; }
  if (!imgFiles || imgFiles.length === 0) { statusEl.textContent = 'Pick the image parts too (folder or multi-select).'; return; }
  try {
    const xmlText = await scmlFile.text();
    const { folders: newFolders, entities: newEntities } = parseSCML(xmlText);
    const { images: newImages, missing } = buildImageMap(newFolders, imgFiles);
    loadProject(newFolders, newEntities, newImages, scmlFile.name, true);
    statusEl.textContent = missing.length
      ? `Loaded, but ${missing.length} image(s) not found: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}`
      : `Loaded ${scmlFile.name} — all images matched.`;
    toast('Project loaded.');
  } catch (err) {
    statusEl.textContent = 'Failed to load: ' + err.message;
  }
});

document.getElementById('resetProjectBtn').addEventListener('click', () => {
  loadProject(DEFAULT_DATA.folders, DEFAULT_DATA.entities, DEFAULT_DATA.images, 'built-in Explorer', false);
  document.getElementById('loadStatus').textContent = '';
  toast('Reset to built-in Explorer data.');
});

status.textContent = `${entities.length} entities · ${Object.keys(images).length} images loaded`;
setAnim(0);
// Force a re-render once the base64 image data has had time to decode.
let __imageLoadRenders = 0;
const __imgRenderInterval = setInterval(() => {
  render();
  if (++__imageLoadRenders >= 8) clearInterval(__imgRenderInterval);
}, 250);

