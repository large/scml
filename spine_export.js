// ---------- Spine 4.2 / 4.3 export ----------
// Converts the current entity into the files a Spine runtime (e.g.
// spine-flutter) loads: a skeleton .json, a texture .atlas, and packed
// .png page(s). The mapping is documented in docs/SPINE_EXPORT.md; the
// short version of the model:
//
//   SCML bone            -> Spine bone (named after its timeline)
//   SCML object timeline -> one Spine SLOT + one Spine BONE per timeline
//                           NAME. SCML animates sprite transforms per-key,
//                           which only bones can do in Spine, so every
//                           sprite rides its own bone. The timeline NAME
//                           (not the object id!) is the stable sprite
//                           identity: SCML object ids are z-slots that get
//                           freely recycled between mainline keys.
//   image (folder/file)  -> region attachment named by the file path (sans
//                           extension), offset so the Spine region CENTER
//                           lands where SCML's pivot math puts the image.
//   mainline cast changes-> slot attachment keys (name/null) at the
//                           mainline key times where a sprite (dis)appears.
//   z_index changes      -> a drawOrder timeline keyed per mainline key.
//
// WHY THE EXPORTED SKELETON IS FLAT (every bone a child of root):
// Spriter and Spine propagate transforms down a bone chain differently.
// Spriter composes angle and scale COMPONENT-WISE at every level -- a
// node's world transform is always a pure translate-rotate-scale, never
// skewed. Spine composes full affine matrices, so a rotated child under a
// non-uniformly scaled parent SHEARS. This project's rig leans hard on
// non-uniform scale (e.g. scaleY 6.3 on a leg with rotated children), so
// preserving the hierarchy would visibly distort deep chains. Instead,
// every exported bone hangs off root and its animation keys are its SCML
// WORLD transform, baked at the union of the animation's authored key
// times -- bit-exact at every authored instant, linear in between (which
// is also exactly what this project's data uses: every key is linear).
//
// Spine timeline value semantics (verified against the official
// spine-core runtime source):
//   rotate    key value: setup rotation + value        (ADDITIVE)
//   translate key value: setup x/y + value             (ADDITIVE)
//   scale     key value: setup scale * value           (MULTIPLIER)
// so every baked key is converted relative to the setup pose, which is
// the pose of the FIRST animation at t=0.

const SPINE_VERSIONS = { '4.2': '4.2.119', '4.3': '4.3.10' };

function spineSanitizeBaseName(s) {
  return String(s || 'skeleton').replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '') || 'skeleton';
}

function spineSignedAngle(a) {
  a = ((a % 360) + 360) % 360;
  return a > 180 ? a - 360 : a;
}

function spineRound(v) { return Math.round(v * 10000) / 10000; }

function spineRegionName(folderId, fileId) {
  const finfo = folders[folderId] && folders[folderId].files[fileId];
  if (!finfo) return null;
  return finfo.name.replace(/\.[a-zA-Z0-9]+$/, '');
}

// ---------- rig model: stable identities across all animations ----------
// bones: SCML bone id -> { name }                       [ids verified stable]
// sprites: timeline NAME -> { variants:Set('folder|file'),
//                             perAnim: Map(animName -> timelineId) }
function spineBuildRig(entity) {
  const warnings = [];
  const bones = new Map();
  const sprites = new Map();
  for (const anim of entity.animations) {
    for (const mk of anim.mainline) {
      for (const br of mk.bone_refs) {
        if (!bones.has(br.id)) bones.set(br.id, { name: nameFor('bones', br.id, entity) });
      }
      for (const orf of mk.object_refs) {
        const tl = anim.timelines[orf.timeline];
        if (!tl) continue;
        const nm = tl.name || ('object_' + orf.timeline);
        let s = sprites.get(nm);
        if (!s) { s = { name: nm, variants: new Set(), perAnim: new Map() }; sprites.set(nm, s); }
        if (!s.perAnim.has(anim.name)) s.perAnim.set(anim.name, orf.timeline);
        for (const k of tl.keys) {
          if (k.folder !== null && k.folder !== undefined) s.variants.add(k.folder + '|' + k.file);
        }
      }
    }
  }
  return { bones, sprites, warnings };
}

// World pose of everything at one instant, from the raw authored data
// (no override corrections, no start-offset shift).
function spineFrameAt(entityIdx, anim, timeMs) {
  return computeFrame(entityIdx, anim, timeMs, { skipCorrections: true, rawTime: true });
}

// The setup pose: first animation, t=0 (world space -- the exported
// skeleton is flat, so world IS local). Items absent there take their
// pose from the first animation where they DO appear.
function spineBuildSetup(entity, entityIdx, rig) {
  const setup = { bones: new Map(), sprites: new Map(), slotOrder: [], initialAttachment: new Map() };

  for (const anim of entity.animations) {
    const frame = spineFrameAt(entityIdx, anim, 0);
    for (const [id] of rig.bones) {
      if (!setup.bones.has(id) && frame.boneWorld[id]) setup.bones.set(id, frame.boneWorld[id]);
    }
    for (const [name, s] of rig.sprites) {
      if (setup.sprites.has(name)) continue;
      const tlId = s.perAnim.get(anim.name);
      if (tlId === undefined) continue;
      const obj = frame.objects.find(o => String(o.timeline) === String(tlId));
      if (obj) {
        setup.sprites.set(name, obj.world);
        setup.initialAttachment.set(name, (obj.folder !== null && obj.folder !== undefined) ? spineRegionName(obj.folder, obj.file) : null);
      }
    }
  }
  for (const [id] of rig.bones) if (!setup.bones.has(id)) setup.bones.set(id, { x: 0, y: 0, angle: 0, scaleX: 1, scaleY: 1 });
  for (const [name] of rig.sprites) {
    if (!setup.sprites.has(name)) { setup.sprites.set(name, { x: 0, y: 0, angle: 0, scaleX: 1, scaleY: 1 }); setup.initialAttachment.set(name, null); }
  }

  // Base slot order: first animation's t=0 cast sorted by z_index, then
  // every sprite not in that cast appended in name order (invisible there
  // anyway; per-animation drawOrder keys handle their real stacking).
  const anim0 = entity.animations[0];
  const frame0 = spineFrameAt(entityIdx, anim0, 0);
  const tlIdToName = new Map();
  for (const [name, s] of rig.sprites) {
    const tlId = s.perAnim.get(anim0.name);
    if (tlId !== undefined) tlIdToName.set(String(tlId), name);
  }
  const present = frame0.objects.map(o => tlIdToName.get(String(o.timeline))).filter(n => n !== undefined);
  const absent = [...rig.sprites.keys()].filter(n => !present.includes(n)).sort();
  setup.slotOrder = [...present, ...absent];
  return setup;
}

// ---------- baked world-space key series -> Spine timelines ----------
// series: [{time, world:{x,y,angle,scaleX,scaleY}}] sampled at the union
// of the animation's authored key times (exact at each), plus a wrap/hold
// key at anim.length. Angles arrive normalized to [0,360) -- unwrap them
// into a continuous rotation value via shortest-path steps (samples are
// dense: every authored key of the whole cast is included).
function spineSeriesToTimelines(series, setupWorld) {
  if (!series.length) return null;
  const setupRot = spineSignedAngle(setupWorld.angle || 0);
  const sSx = Math.abs(setupWorld.scaleX) < 1e-6 ? 1e-6 : setupWorld.scaleX;
  const sSy = Math.abs(setupWorld.scaleY) < 1e-6 ? 1e-6 : setupWorld.scaleY;

  let rot = setupRot + spineShortestDelta(setupRot, series[0].world.angle);
  const rotVals = [rot];
  for (let i = 1; i < series.length; i++) {
    rot += spineShortestDelta(series[i - 1].world.angle, series[i].world.angle);
    rotVals.push(rot);
  }

  const rotate = [], translate = [], scale = [];
  for (let i = 0; i < series.length; i++) {
    const p = series[i], tS = spineRound(p.time / 1000);
    const rk = { time: tS, value: spineRound(rotVals[i] - setupRot) };
    const tk = { time: tS, x: spineRound(p.world.x - setupWorld.x), y: spineRound(p.world.y - setupWorld.y) };
    const sk = { time: tS, x: spineRound(p.world.scaleX / sSx), y: spineRound(p.world.scaleY / sSy) };
    if (p.stepped) { rk.curve = 'stepped'; tk.curve = 'stepped'; sk.curve = 'stepped'; }
    rotate.push(rk); translate.push(tk); scale.push(sk);
  }

  // Constant series collapse to a single key; series that never leave the
  // setup pose are dropped entirely.
  function compact(keys, isDefault, sameAs) {
    if (keys.every(k => sameAs(k, keys[0]))) {
      return isDefault(keys[0]) ? null : [keys[0]];
    }
    return keys;
  }
  const out = {};
  const r = compact(rotate, k => Math.abs(k.value) < 1e-3, (a, b) => Math.abs(a.value - b.value) < 1e-3);
  const t = compact(translate, k => Math.abs(k.x) < 1e-3 && Math.abs(k.y) < 1e-3, (a, b) => Math.abs(a.x - b.x) < 1e-3 && Math.abs(a.y - b.y) < 1e-3);
  const s = compact(scale, k => Math.abs(k.x - 1) < 1e-4 && Math.abs(k.y - 1) < 1e-4, (a, b) => Math.abs(a.x - b.x) < 1e-4 && Math.abs(a.y - b.y) < 1e-4);
  if (r) out.rotate = r;
  if (t) out.translate = t;
  if (s) out.scale = s;
  return Object.keys(out).length ? out : null;
}

function spineShortestDelta(a, b) {
  let diff = (b - a) % 360;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return diff;
}

function spineBuildAnimation(entity, entityIdx, rig, setup, anim) {
  const looping = anim.looping !== false;

  // Union of every authored key time in this animation: every timeline key
  // + every mainline key (cast/z/parent changes) + t=0 and t=length. Each
  // baked bone gets keys at all of these -- exact at every authored
  // instant of the whole cast, whichever chain the motion came from.
  const timeSet = new Set([0]);
  for (const mk of anim.mainline) timeSet.add(Math.min(mk.time, anim.length));
  for (const tlId of Object.keys(anim.timelines)) {
    for (const k of anim.timelines[tlId].keys) timeSet.add(Math.min(k.time, anim.length));
  }
  timeSet.add(anim.length);
  const times = [...timeSet].sort((a, b) => a - b);

  const tlIdToSprite = new Map();
  for (const [name, s] of rig.sprites) {
    const tlId = s.perAnim.get(anim.name);
    if (tlId !== undefined) tlIdToSprite.set(String(tlId), name);
  }

  // Bake: one computeFrame per union time serves every bone and sprite.
  // Sampling AT t=length (rawTime clamps there) evaluates every timeline
  // with its interpolation factor at 1 -- i.e. the exact wrapped pose for
  // looping animations, using the LAST mainline key's cast (so items that
  // are present at the end but absent at t=0 still get their final key).
  const frameCache = new Map();
  function frameAt(tms) {
    let f = frameCache.get(tms);
    if (!f) { f = spineFrameAt(entityIdx, anim, tms); frameCache.set(tms, f); }
    return f;
  }
  function worldOf(frame, item) {
    if (item.kind === 'bone') return frame.boneWorld[item.id] || null;
    const o = frame.objects.find(o => String(o.timeline) === String(item.tlId));
    return o ? o.world : null;
  }

  const items = [];
  for (const [id] of rig.bones) items.push({ kind: 'bone', id, series: [] });
  for (const [name, s] of rig.sprites) {
    const tlId = s.perAnim.get(anim.name);
    if (tlId !== undefined) items.push({ kind: 'sprite', name, tlId, series: [] });
  }

  // A mainline key can HARD-CUT an item's pose (the cast re-anchors, an
  // object jumps to a new timeline segment, parenting switches). A baked
  // key at the mainline time captures the post-cut pose; without a key
  // just before it, the linear segment leading in would smear the cut
  // over the whole previous gap. Detect items that jump at a mainline
  // time and give them a stepped pre-cut key just before it.
  //
  // The detection epsilon must be ~zero (0.01ms), NOT a whole millisecond:
  // this project authors legitimate 1ms-apart keys (a stab snapping 60px
  // between t=292 and t=293) -- those are fast RAMPS that must stay
  // interpolated, while a true cut shows its full jump across even an
  // infinitesimal step.
  const preCutTimes = new Map(); // item index -> Set of times
  for (const mk of anim.mainline) {
    if (mk.time <= 0 || mk.time >= anim.length) continue;
    const before = frameAt(Math.max(0, mk.time - 0.01));
    const at = frameAt(mk.time);
    items.forEach((it, idx) => {
      const wb = worldOf(before, it), wa = worldOf(at, it);
      // An item that VANISHES at this mainline key needs a final key just
      // before it -- otherwise its baked series simply ends at its last
      // union time and Spine freezes it there, while SCML keeps it moving
      // right up until the cast drops it.
      const jump = (wb && !wa) || (wb && wa && (
        Math.abs(wa.x - wb.x) > 3 || Math.abs(wa.y - wb.y) > 3
        || Math.abs(spineShortestDelta(wb.angle, wa.angle)) > 2
        || Math.abs(wa.scaleX - wb.scaleX) > 0.05 || Math.abs(wa.scaleY - wb.scaleY) > 0.05));
      if (jump) {
        if (!preCutTimes.has(idx)) preCutTimes.set(idx, new Set());
        // 0.1ms before the cut -- exactly representable in the exported
        // seconds (4 decimal places), and far below one frame at any rate.
        preCutTimes.get(idx).add(mk.time - 0.1);
      }
    });
  }

  for (const tms of times) {
    const frame = frameAt(tms);
    items.forEach((it, idx) => {
      const cuts = preCutTimes.get(idx);
      if (cuts) {
        for (const ct of [...cuts]) {
          if (ct < tms && (!it.series.length || it.series[it.series.length - 1].time < ct)) {
            const w = worldOf(frameAt(ct), it);
            // `stepped` holds this pose flat until the next key -- the cut
            // then happens exactly AT the mainline key, like SCML's, instead
            // of ramping across the final millisecond.
            if (w) it.series.push({ time: ct, world: w, stepped: true });
            cuts.delete(ct);
          }
        }
      }
      const w = worldOf(frame, it);
      if (w) it.series.push({ time: tms, world: w });
    });
  }

  // Adaptive refinement: SCML interpolates LOCAL values down a bone chain,
  // so a child under a rotating parent travels an ARC between keys; the
  // flat baked export interpolates world values, a straight CHORD. Where
  // the chord deviates, subdivide until the true midpoint pose is within
  // tolerance of the linear blend of its neighbors -- down to a 1ms grid
  // if the motion demands it (this project authors 4ms punch-impact
  // segments that whip a hand 270px along an arc), with a per-item cap so
  // pathological data can't blow the file up. Static/slow motion adds no
  // keys at all.
  const TOL_POS = 1.0, TOL_ANGLE = 0.35, TOL_SCALE = 0.01, MAX_ADDED_KEYS = 250;
  function lerpN(a, b, f) { return a + (b - a) * f; }
  function refineSeries(item, series) {
    let added = 0;
    const queue = [];
    for (let i = 0; i + 1 < series.length; i++) queue.push([series[i], series[i + 1]]);
    const inserts = [];
    while (queue.length && added < MAX_ADDED_KEYS) {
      const [a, b] = queue.shift();
      const gap = b.time - a.time;
      // Spine key times resolve to 0.1ms (4 decimals of seconds); 0.3ms is
      // the practical floor before rounding makes neighbors collide.
      if (gap < 0.3) continue;
      // Whole-millisecond grid for normal motion; sub-ms keys only get
      // considered inside already-tiny segments (see the bigOff gate below).
      // Sub-ms midpoints are snapped to the 0.1ms grid BEFORE sampling --
      // exported key times only carry 4 decimals of seconds, and sampling
      // at 94.45ms but emitting at 94.5ms would skew time vs value by
      // 0.05ms, which is ~30px during this data's 600px/ms whips.
      const midT = gap >= 2 ? Math.round((a.time + b.time) / 2) : Math.round((a.time + b.time) * 5) / 10;
      if (midT <= a.time || midT >= b.time) continue;
      const w = worldOf(frameAt(midT), item);
      if (!w) continue;
      const f = (midT - a.time) / (b.time - a.time);
      const lin = {
        x: lerpN(a.world.x, b.world.x, f), y: lerpN(a.world.y, b.world.y, f),
        angle: a.world.angle + spineShortestDelta(a.world.angle, b.world.angle) * f,
        scaleX: lerpN(a.world.scaleX, b.world.scaleX, f), scaleY: lerpN(a.world.scaleY, b.world.scaleY, f),
      };
      const dx = Math.abs(w.x - lin.x), dy = Math.abs(w.y - lin.y);
      const da = Math.abs(spineShortestDelta(lin.angle, w.angle));
      const dsx = Math.abs(w.scaleX - lin.scaleX), dsy = Math.abs(w.scaleY - lin.scaleY);
      const off = dx > TOL_POS || dy > TOL_POS || da > TOL_ANGLE || dsx > TOL_SCALE || dsy > TOL_SCALE;
      if (!off) continue;
      // Below 1ms, only keep subdividing while the segment is genuinely
      // violent (5x tolerance) -- this project authors 1ms mainline pairs
      // (die's collapse, stab's impact) whose trajectories curve tens of
      // px INSIDE the millisecond.
      const bigOff = dx > 5 * TOL_POS || dy > 5 * TOL_POS || da > 5 * TOL_ANGLE || dsx > 5 * TOL_SCALE || dsy > 5 * TOL_SCALE;
      if (gap < 1.05 && !bigOff) continue;
      const mid = { time: midT, world: w };
      inserts.push(mid);
      added++;
      queue.push([a, mid], [mid, b]);
    }
    if (!inserts.length) return series;
    return [...series, ...inserts].sort((x, y) => x.time - y.time);
  }
  for (const it of items) it.series = refineSeries(it, it.series);

  const bones = {};
  for (const it of items) {
    const setupWorld = it.kind === 'bone' ? setup.bones.get(it.id) : setup.sprites.get(it.name);
    const conv = spineSeriesToTimelines(it.series, setupWorld);
    if (conv) bones[it.kind === 'bone' ? rig.bones.get(it.id).name : it.name] = conv;
  }

  // --- slots: attachment (image/cast) keys, plus alpha when authored
  const slots = {};
  for (const [name, s] of rig.sprites) {
    const slotTimelines = {};
    const tlId = s.perAnim.get(anim.name);
    if (tlId === undefined) {
      slotTimelines.attachment = [{ time: 0, name: null }];
      slots[name] = slotTimelines;
      continue;
    }
    const tl = anim.timelines[tlId];

    // presence spans from the mainline cast + sprite-swap keys within them
    const events = [];
    let prevPresent = null;
    for (let i = 0; i < anim.mainline.length; i++) {
      const mk = anim.mainline[i];
      const ref = mk.object_refs.find(o => String(o.timeline) === String(tlId));
      const present = !!ref;
      if (present && prevPresent !== true) {
        const v = getTimelineValueAt(tl, ref.key, mk.time, anim.length, looping);
        events.push({ time: mk.time, name: (v.folder !== null && v.folder !== undefined) ? spineRegionName(v.folder, v.file) : null });
      } else if (!present && prevPresent !== false) {
        events.push({ time: mk.time, name: null });
      }
      prevPresent = present;
      const spanEnd = i + 1 < anim.mainline.length ? anim.mainline[i + 1].time : anim.length + 1;
      if (present) {
        for (const k of tl.keys) {
          if (k.time >= mk.time && k.time < spanEnd && k.folder !== null && k.folder !== undefined) {
            events.push({ time: k.time, name: spineRegionName(k.folder, k.file) });
          }
        }
      }
    }
    events.sort((a, b) => a.time - b.time);
    const attachment = [];
    for (const e of events) {
      const prev = attachment[attachment.length - 1];
      if (prev && Math.abs(prev.time * 1000 - e.time) < 0.5) { prev.name = e.name; continue; }
      if (prev && prev.name === e.name) continue;
      attachment.push({ time: spineRound(e.time / 1000), name: e.name });
    }
    const setupAtt = setup.initialAttachment.get(name) || null;
    if (attachment.length && (attachment.length > 1 || attachment[0].name !== setupAtt || attachment[0].time > 0)) {
      slotTimelines.attachment = attachment;
    }

    if (tl.keys.some(k => k.transform && k.transform.alpha !== undefined && k.transform.alpha !== 1)) {
      slotTimelines.alpha = tl.keys.map(k => ({ time: spineRound(k.time / 1000), value: spineRound(k.transform.alpha === undefined ? 1 : k.transform.alpha) }));
    }
    if (Object.keys(slotTimelines).length) slots[name] = slotTimelines;
  }

  // --- draw order: one key per mainline key whose visible stacking
  // differs from the setup slot order. Slots absent from the cast keep
  // their setup positions; present ones fill the remaining positions in
  // z order.
  const slotIndex = new Map(setup.slotOrder.map((n, i) => [n, i]));
  const drawOrder = [];
  let prevSig = setup.slotOrder.join(' ');
  for (const mk of anim.mainline) {
    const present = mk.object_refs
      .slice().sort((a, b) => a.z_index - b.z_index)
      .map(o => tlIdToSprite.get(String(o.timeline)))
      .filter(n => n !== undefined);
    const presentSet = new Set(present);
    const desired = new Array(setup.slotOrder.length).fill(null);
    for (const n of setup.slotOrder) if (!presentSet.has(n)) desired[slotIndex.get(n)] = n;
    let pi = 0;
    for (let i = 0; i < desired.length && pi < present.length; i++) {
      if (desired[i] === null) desired[i] = present[pi++];
    }
    const sig = desired.join(' ');
    if (sig !== prevSig) {
      const offsets = [];
      desired.forEach((n, newIdx) => {
        const oldIdx = slotIndex.get(n);
        if (newIdx !== oldIdx) offsets.push({ slot: n, offset: newIdx - oldIdx });
      });
      // Spine's reader walks offsets assuming they're ordered by the
      // slot's SETUP index (it interleaves "unchanged" slots as it goes)
      // -- an unsorted list makes it crash with a negative array length.
      offsets.sort((a, b) => slotIndex.get(a.slot) - slotIndex.get(b.slot));
      const key = { time: spineRound(mk.time / 1000) };
      if (offsets.length) key.offsets = offsets;
      drawOrder.push(key);
      prevSig = sig;
    }
  }

  const out = {};
  if (Object.keys(slots).length) out.slots = slots;
  if (Object.keys(bones).length) out.bones = bones;
  if (drawOrder.length) out.drawOrder = drawOrder;
  return out;
}

// ---------- texture packing: every project PNG onto 4096-max pages ----------
// Async because the app loads images lazily -- any not yet decoded must be
// awaited or they'd silently drop out of the sheet.
async function spinePackAtlas(baseName) {
  const items = [];
  for (const folderId of Object.keys(folders)) {
    for (const fileId of Object.keys(folders[folderId].files)) {
      const finfo = folders[folderId].files[fileId];
      const img = getImage(folderId, fileId);
      if (!img) continue;
      if (!img.complete || !img.naturalWidth) {
        await new Promise(res => {
          img.addEventListener('load', res, { once: true });
          img.addEventListener('error', res, { once: true });
          if (img.complete) res(); // raced: finished between the check and here
        });
      }
      if (!img.naturalWidth) continue; // genuinely failed to load
      items.push({ folderId, fileId, name: spineRegionName(folderId, fileId), w: Math.round(finfo.width), h: Math.round(finfo.height), img });
    }
  }
  items.sort((a, b) => b.h - a.h || b.w - a.w);

  // Shelf-pack onto as many pages as needed, each capped at 4096x4096 --
  // the safe max texture size on virtually all GPUs Spine runtimes target.
  // (This project's raw art is ~33 megapixels, so one page can't hold it.)
  const PAD = 2, PAGE_MAX = 4096;
  const pages = [];
  let cur = null, x = PAD, y = PAD, shelfH = 0;
  for (const it of items) {
    if (cur && x + it.w + PAD > PAGE_MAX) { x = PAD; y += shelfH + PAD; shelfH = 0; }
    if (!cur || y + it.h + PAD > PAGE_MAX) {
      cur = { items: [], usedW: 0, usedH: 0 };
      pages.push(cur);
      x = PAD; y = PAD; shelfH = 0;
    }
    it.x = x; it.y = y;
    cur.items.push(it);
    x += it.w + PAD;
    shelfH = Math.max(shelfH, it.h);
    cur.usedW = Math.max(cur.usedW, it.x + it.w + PAD);
    cur.usedH = Math.max(cur.usedH, it.y + it.h + PAD);
  }

  const pageOut = [];
  let atlas = '';
  pages.forEach((p, i) => {
    let w = 1; while (w < p.usedW) w *= 2;
    let h = 1; while (h < p.usedH) h *= 2;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const cx = canvas.getContext('2d');
    for (const it of p.items) cx.drawImage(it.img, it.x, it.y, it.w, it.h);
    const pageName = baseName + (i === 0 ? '' : '_' + (i + 1)) + '.png';
    pageOut.push({ canvas, name: pageName });
    if (i > 0) atlas += '\n';
    atlas += pageName + '\n';
    atlas += 'size: ' + w + ', ' + h + '\n';
    atlas += 'filter: Linear, Linear\n';
    atlas += 'pma: false\n';
    for (const it of p.items) {
      atlas += it.name + '\n';
      atlas += '  bounds: ' + it.x + ', ' + it.y + ', ' + it.w + ', ' + it.h + '\n';
    }
  });
  return { pages: pageOut, atlasText: atlas, regionCount: items.length };
}

// ---------- top-level assembly ----------
async function buildSpineExport(opts = {}) {
  const version = SPINE_VERSIONS[opts.version] ? opts.version : '4.2';
  const entity = currentEntity;
  const entityIdx = currentEntityIdx;
  const baseName = spineSanitizeBaseName(opts.baseName || entity.name);

  const rig = spineBuildRig(entity);
  const setup = spineBuildSetup(entity, entityIdx, rig);
  const warnings = [...rig.warnings];

  const usedNames = new Set(['root']);
  function uniqueName(n) {
    let name = n, i = 2;
    while (usedNames.has(name)) name = n + '_' + (i++);
    usedNames.add(name);
    return name;
  }

  function setupEntry(name, world) {
    const entry = { name, parent: 'root' };
    if (Math.abs(world.x) > 1e-4) entry.x = spineRound(world.x);
    if (Math.abs(world.y) > 1e-4) entry.y = spineRound(world.y);
    const rot = spineSignedAngle(world.angle || 0);
    if (Math.abs(rot) > 1e-4) entry.rotation = spineRound(rot);
    if (Math.abs((world.scaleX ?? 1) - 1) > 1e-4) entry.scaleX = spineRound(world.scaleX);
    if (Math.abs((world.scaleY ?? 1) - 1) > 1e-4) entry.scaleY = spineRound(world.scaleY);
    return entry;
  }

  const bonesJson = [{ name: 'root' }];
  const boneName = new Map();
  for (const [id, b] of rig.bones) {
    const name = uniqueName(b.name);
    boneName.set(id, name);
    bonesJson.push(setupEntry(name, setup.bones.get(id)));
  }
  const spriteBoneName = new Map();
  for (const name of setup.slotOrder) {
    const exported = uniqueName(name);
    spriteBoneName.set(name, exported);
    bonesJson.push(setupEntry(exported, setup.sprites.get(name)));
  }

  // --- slots (order = setup draw order) + default skin attachments
  const slotsJson = [];
  const skinAttachments = {};
  for (const name of setup.slotOrder) {
    const s = rig.sprites.get(name);
    const exported = spriteBoneName.get(name);
    const slot = { name: exported, bone: exported };
    const initial = setup.initialAttachment.get(name);
    if (initial) slot.attachment = initial;
    slotsJson.push(slot);

    const attMap = {};
    for (const v of s.variants) {
      const [folderId, fileId] = v.split('|');
      const finfo = folders[folderId] && folders[folderId].files[fileId];
      if (!finfo) continue;
      const regionName = spineRegionName(folderId, fileId);
      // Region attachments are placed by their CENTER in bone-local space;
      // SCML places the image by its pivot at the bone origin. The app's
      // own pivot math (computeObjectWorldCorners) puts the image center
      // at ((0.5-px)*w, (0.5-py)*h) in sprite-local y-up space.
      attMap[regionName] = {
        x: spineRound((0.5 - finfo.pivot_x) * finfo.width),
        y: spineRound((0.5 - finfo.pivot_y) * finfo.height),
        width: Math.round(finfo.width),
        height: Math.round(finfo.height),
      };
    }
    skinAttachments[exported] = attMap;
  }

  // --- animations
  const animationsJson = {};
  for (const anim of entity.animations) {
    animationsJson[anim.name] = spineBuildAnimation(entity, entityIdx, rig, setup, anim);
  }

  // Rename bone/slot keys in animations to their exported names, which may
  // have been uniquified (both sprite names and skeleton-bone names pass
  // through uniqueName above).
  const renameMap = new Map(spriteBoneName);
  for (const [id, b] of rig.bones) {
    const exported = boneName.get(id);
    if (exported && exported !== b.name && !renameMap.has(b.name)) renameMap.set(b.name, exported);
  }
  for (const animName of Object.keys(animationsJson)) {
    const a = animationsJson[animName];
    for (const section of ['bones', 'slots']) {
      if (!a[section]) continue;
      const renamed = {};
      for (const key of Object.keys(a[section])) {
        renamed[renameMap.get(key) || key] = a[section][key];
      }
      a[section] = renamed;
    }
    if (a.drawOrder) {
      for (const k of a.drawOrder) {
        if (k.offsets) for (const o of k.offsets) o.slot = renameMap.get(o.slot) || o.slot;
      }
    }
  }

  // --- skeleton header: overall bounds across all animations
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const anim of entity.animations) {
    const bb = computeAnimationWorldBBox(entityIdx, anim, 8);
    minx = Math.min(minx, bb.minx); maxx = Math.max(maxx, bb.maxx);
    miny = Math.min(miny, bb.miny); maxy = Math.max(maxy, bb.maxy);
  }
  if (!isFinite(minx)) { minx = miny = -100; maxx = maxy = 100; }

  const json = {
    skeleton: {
      hash: (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)),
      spine: SPINE_VERSIONS[version],
      x: spineRound(minx), y: spineRound(miny),
      width: spineRound(maxx - minx), height: spineRound(maxy - miny),
      images: '', audio: '',
    },
    bones: bonesJson,
    slots: slotsJson,
    skins: [{ name: 'default', attachments: skinAttachments }],
    animations: animationsJson,
  };

  const pack = await spinePackAtlas(baseName);
  return { json, atlasText: pack.atlasText, pages: pack.pages, baseName, version, warnings, regionCount: pack.regionCount };
}

// ---------- UI ----------
(function initSpineExportUI() {
  const openBtn = document.getElementById('spineExportOpen');
  const modal = document.getElementById('spineExportModal');
  if (!openBtn || !modal) return;
  openBtn.addEventListener('click', () => {
    document.getElementById('fileModal').classList.remove('show');
    document.getElementById('spineBaseName').value = spineSanitizeBaseName(currentEntity.name);
    document.getElementById('spineExportStatus').textContent = '';
    modal.classList.add('show');
  });
  document.getElementById('closeSpineExport').addEventListener('click', () => modal.classList.remove('show'));
  document.getElementById('closeSpineExport2').addEventListener('click', () => modal.classList.remove('show'));
  document.getElementById('spineExportBtn').addEventListener('click', async () => {
    const status = document.getElementById('spineExportStatus');
    try {
      status.textContent = 'Building…';
      const result = await buildSpineExport({
        version: document.getElementById('spineVersion').value,
        baseName: document.getElementById('spineBaseName').value,
      });
      const files = [
        { name: result.baseName + '.json', blob: new Blob([JSON.stringify(result.json, null, 1)], { type: 'application/json' }) },
        { name: result.baseName + '.atlas', blob: new Blob([result.atlasText], { type: 'text/plain' }) },
      ];
      for (const p of result.pages) {
        const blob = await new Promise(res => p.canvas.toBlob(res, 'image/png'));
        files.push({ name: p.name, blob });
      }
      for (const f of files) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(f.blob);
        a.download = f.name;
        a.click();
      }
      const w = result.warnings.length ? ` · ${result.warnings.length} warning(s), see console` : '';
      result.warnings.forEach(x => console.warn('[spine export]', x));
      status.textContent = `Exported ${result.baseName}.json / .atlas / ${result.pages.length} png page(s) (Spine ${SPINE_VERSIONS[result.version]}, ${result.regionCount} packed images)${w}`;
      toast(`Spine export downloaded (${2 + result.pages.length} files).`);
    } catch (err) {
      console.error(err);
      status.textContent = 'Export failed: ' + err.message;
    }
  });
})();
