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
//
// `scale` shrinks the PACKED pixels only (bounds in the atlas match the
// shrunken size); attachment width/height stay at the source dimensions,
// so sprites render at exactly the same world size, just from fewer
// texels. This project's source art is ~33 megapixels of almost entirely
// opaque pixels (trimming transparent margins would reclaim just 2%), so
// resolution is the one lever that meaningfully shrinks the pages:
// 100% -> three 4096 pages, 50% -> one, 25% -> a single 2048 page.
async function spinePackAtlas(baseName, scale = 1) {
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
      items.push({
        folderId, fileId, name: spineRegionName(folderId, fileId),
        w: Math.max(1, Math.round(finfo.width * scale)),
        h: Math.max(1, Math.round(finfo.height * scale)),
        img,
      });
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

  const atlasScale = [1, 0.5, 0.25].includes(opts.atlasScale) ? opts.atlasScale : 1;
  const pack = await spinePackAtlas(baseName, atlasScale);
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
        atlasScale: parseFloat(document.getElementById('spineAtlasScale').value) || 1,
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

// ============================================================
// ---------- Spine 4.x IMPORT: skeleton .json + .atlas + page PNGs ----------
// Converts a Spine project into the editor's internal SCML-shaped model so
// "the editor should not care" where a project came from. Coverage: bones,
// slots with region attachments (default skin), rotate/translate/scale
// timelines (linear, stepped, and bezier curves -- evaluated exactly),
// attachment (image/cast) keys, slot alpha, and drawOrder keys. Meshes,
// IK/physics constraints, and extra skins have no SCML counterpart and are
// ignored (a warning lists what was skipped).
//
// The transform-inheritance caveat from the export applies in reverse:
// Spine composes full affine matrices down a chain, Spriter composes
// angle/scale component-wise. For rigs that don't combine non-uniform
// scale with rotated children (which includes everything this editor
// exports -- flat rigs are immune), the two agree.

function spineAtlasParse(atlasText) {
  const pages = [];
  let page = null, region = null;
  for (const rawLine of atlasText.split(/\r\n|\r|\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) { page = null; region = null; continue; }
    const m = line.trim().match(/^([\w]+):\s*(.*)$/);
    if (!page) {
      page = { name: line.trim(), regions: [], width: 0, height: 0 };
      pages.push(page);
      region = null;
      continue;
    }
    if (m && (region === null || ['bounds', 'offsets', 'rotate', 'index', 'xy', 'size', 'orig', 'offset'].includes(m[1])) ) {
      const key = m[1], vals = m[2].split(',').map(s => s.trim());
      if (region === null) {
        // page-level field
        if (key === 'size') { page.width = parseInt(vals[0]); page.height = parseInt(vals[1]); }
        // other page fields ignored
        continue;
      }
      if (key === 'bounds') { region.x = +vals[0]; region.y = +vals[1]; region.w = +vals[2]; region.h = +vals[3]; }
      else if (key === 'xy') { region.x = +vals[0]; region.y = +vals[1]; }
      else if (key === 'size') { region.w = +vals[0]; region.h = +vals[1]; }
      else if (key === 'rotate') { region.rotate = vals[0] === 'true' ? 90 : (vals[0] === 'false' ? 0 : parseInt(vals[0])); }
      else if (key === 'offsets') { region.offX = +vals[0]; region.offY = +vals[1]; region.origW = +vals[2]; region.origH = +vals[3]; }
      else if (key === 'offset') { region.offX = +vals[0]; region.offY = +vals[1]; }
      else if (key === 'orig') { region.origW = +vals[0]; region.origH = +vals[1]; }
      continue;
    }
    // a non-field line while a page is open = a new region name
    region = { name: line.trim(), x: 0, y: 0, w: 0, h: 0, rotate: 0, offX: 0, offY: 0, origW: 0, origH: 0, page };
    page.regions.push(region);
  }
  const regions = [];
  for (const p of pages) for (const r of p.regions) { if (!r.origW) { r.origW = r.w; r.origH = r.h; } regions.push(r); }
  return { pages, regions };
}

// Evaluate a spine timeline channel (array of keys with value fields) at
// time t. `fields` names the value properties (e.g. ['value'] for rotate,
// ['x','y'] for translate). Bezier curves are stored on the EARLIER key as
// 4 numbers per field in absolute time/value space; solve time->s by
// bisection (the time polynomial is monotonic).
function spineEvalChannel(keys, fields, defaults, t) {
  if (!keys || !keys.length) return defaults.slice();
  let i = keys.length - 1;
  for (let k = 0; k < keys.length; k++) { if ((keys[k].time || 0) <= t + 1e-9) i = k; else break; }
  if ((keys[0].time || 0) > t + 1e-9) i = -1;
  if (i < 0) return fields.map((f, fi) => keys[0][f] !== undefined ? keys[0][f] : defaults[fi]);
  const a = keys[i], b = keys[i + 1];
  const av = fields.map((f, fi) => a[f] !== undefined ? a[f] : defaults[fi]);
  if (!b) return av;
  const bv = fields.map((f, fi) => b[f] !== undefined ? b[f] : defaults[fi]);
  const t0 = a.time || 0, t1 = b.time || 0;
  if (t1 <= t0) return bv;
  if (a.curve === 'stepped') return av;
  const f = (t - t0) / (t1 - t0);
  if (Array.isArray(a.curve)) {
    return fields.map((_, fi) => {
      const c = a.curve.slice(fi * 4, fi * 4 + 4);
      if (c.length < 4) return av[fi] + (bv[fi] - av[fi]) * f;
      // cubic bezier through (t0,av) (c0,c1) (c2,c3) (t1,bv); find s with time(s)=t
      const bez = (p0, p1, p2, p3, s) => {
        const u = 1 - s;
        return u * u * u * p0 + 3 * u * u * s * p1 + 3 * u * s * s * p2 + s * s * s * p3;
      };
      let lo = 0, hi = 1, s = f;
      for (let it = 0; it < 40; it++) {
        s = (lo + hi) / 2;
        const tv = bez(t0, c[0], c[2], t1, s);
        if (tv < t) lo = s; else hi = s;
      }
      return bez(av[fi], c[1], c[3], bv[fi], s);
    });
  }
  return fields.map((_, fi) => av[fi] + (bv[fi] - av[fi]) * f);
}

async function importSpineProject(json, atlasText, extraFiles, label) {
  const missing = [];
  const warnings = [];

  // ---- atlas pages -> per-region data-URL images
  const atlas = spineAtlasParse(atlasText);
  const pageImages = {};
  for (const p of atlas.pages) {
    const f = extraFiles.find(f => f.name === p.name || f.name.endsWith('/' + p.name));
    if (!f) { missing.push('page ' + p.name); continue; }
    const url = await readFileAsDataURL(f);
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('bad page image ' + p.name)); img.src = url; });
    pageImages[p.name] = img;
  }

  // region name -> {folderName, fileBase}: "body/leg_upper" -> folder "body"
  function splitRegionName(name) {
    const idx = name.lastIndexOf('/');
    return idx === -1 ? { folderName: 'images', base: name } : { folderName: name.slice(0, idx), base: name.slice(idx + 1) };
  }

  const newFolders = {};
  const newImages = {};
  const folderIdByName = new Map();
  const fileRefByRegion = new Map(); // region name -> {folderId, fileId}
  function folderIdFor(name) {
    if (folderIdByName.has(name)) return folderIdByName.get(name);
    const fid = String(folderIdByName.size);
    folderIdByName.set(name, fid);
    newFolders[fid] = { name, files: {} };
    return fid;
  }

  // pivots come from the skin attachments below; regions are cut here
  for (const r of atlas.regions) {
    const img = pageImages[r.page.name];
    if (!img) { continue; }
    const cw = r.rotate === 90 ? r.h : r.w, ch = r.rotate === 90 ? r.w : r.h;
    const canvas = document.createElement('canvas');
    canvas.width = r.origW || r.w; canvas.height = r.origH || r.h;
    const cx = canvas.getContext('2d');
    if (r.rotate === 90) {
      // libgdx-style 90° packing: stored rotated CW; un-rotate
      cx.save();
      cx.translate(r.offX + r.w / 2, (canvas.height - r.origH) + r.offY + r.h / 2);
      cx.rotate(-Math.PI / 2);
      cx.drawImage(img, r.x, r.y, cw, ch, -r.h / 2, -r.w / 2, cw, ch);
      cx.restore();
      warnings.push(`region ${r.name} is 90°-rotated in the atlas -- un-rotated on import, verify it visually`);
    } else {
      // offY is measured from the BOTTOM of the original image in libgdx
      const destY = (canvas.height - r.h) - r.offY;
      cx.drawImage(img, r.x, r.y, r.w, r.h, r.offX, destY, r.w, r.h);
    }
    const { folderName, base } = splitRegionName(r.name);
    const fid = folderIdFor(folderName);
    const fileId = String(Object.keys(newFolders[fid].files).length);
    newFolders[fid].files[fileId] = {
      name: (folderName ? folderName + '/' : '') + base + '.png',
      width: canvas.width, height: canvas.height,
      pivot_x: 0, pivot_y: 1, // corrected from attachments below
    };
    newImages[fid + '_' + fileId] = canvas.toDataURL('image/png');
    fileRefByRegion.set(r.name, { folderId: fid, fileId });
  }

  // ---- skeleton structure
  const bonesArr = json.bones || [];
  const boneIndexByName = new Map(bonesArr.map((b, i) => [b.name, i]));
  const slots = json.slots || [];
  const skins = json.skins || [];
  const skinObj = Array.isArray(skins) ? (skins.find(s => s.name === 'default') || skins[0]) : { attachments: skins };
  const attachments = (skinObj && skinObj.attachments) || {};
  if ((Array.isArray(skins) ? skins.length : Object.keys(skins).length) > 1) warnings.push('multiple skins found -- only the default/first skin is imported');

  // attachment -> region + pivot; also fix the file pivot from the
  // attachment's center offset (inverse of the export mapping)
  const attachmentInfo = new Map(); // slotName|attName -> {folderId, fileId}
  for (const slotName of Object.keys(attachments)) {
    for (const attName of Object.keys(attachments[slotName])) {
      const att = attachments[slotName][attName];
      const type = att.type || 'region';
      if (type !== 'region') { warnings.push(`slot ${slotName}: ${type} attachment "${attName}" skipped (only region attachments import)`); continue; }
      const regionName = att.path || att.name || attName;
      const ref = fileRefByRegion.get(regionName);
      if (!ref) { missing.push('region ' + regionName); continue; }
      const finfo = newFolders[ref.folderId].files[ref.fileId];
      const w = att.width || finfo.width, h = att.height || finfo.height;
      finfo.pivot_x = 0.5 - (att.x || 0) / w;
      finfo.pivot_y = 0.5 - (att.y || 0) / h;
      if (att.rotation) warnings.push(`slot ${slotName}: attachment "${attName}" has rotation ${att.rotation} -- not representable per-image in SCML, ignored`);
      if ((att.scaleX && att.scaleX !== 1) || (att.scaleY && att.scaleY !== 1)) warnings.push(`slot ${slotName}: attachment "${attName}" has scale -- ignored`);
      attachmentInfo.set(slotName + '|' + attName, ref);
    }
  }
  for (const key of ['ik', 'transform', 'path', 'physics']) {
    if (json[key] && json[key].length) warnings.push(`${json[key].length} ${key} constraint(s) skipped (no SCML counterpart)`);
  }

  // SCML ids: bones 0..n-1 in spine order (parents always precede children
  // in spine files); objects = slots in draw-order (slot array order).
  const boneSetup = bonesArr.map(b => ({
    x: b.x || 0, y: b.y || 0, angle: b.rotation || 0,
    scaleX: b.scaleX === undefined ? 1 : b.scaleX, scaleY: b.scaleY === undefined ? 1 : b.scaleY,
  }));

  function norm360(a) { return ((a % 360) + 360) % 360; }

  // ---- animations
  const animations = [];
  const animsSrc = json.animations || {};
  for (const [animName, anim] of Object.entries(animsSrc)) {
    let maxT = 0;
    JSON.stringify(anim, (k, v) => { if (k === 'time' && typeof v === 'number') maxT = Math.max(maxT, v); return v; });
    const lengthMs = Math.max(1, Math.round(maxT * 1000)) || 1000;

    const timelines = {};
    let tlId = 0;
    const boneTimelineId = new Map();   // bone index -> timeline id
    const slotTimelineId = new Map();   // slot name -> timeline id

    // --- bone timelines: keys at the union of the bone's channel key times
    for (let bi = 0; bi < bonesArr.length; bi++) {
      const bname = bonesArr[bi].name;
      const bt = (anim.bones && anim.bones[bname]) || {};
      const times = new Set([0]);
      for (const ch of ['rotate', 'translate', 'scale', 'translatex', 'translatey', 'scalex', 'scaley']) {
        for (const k of bt[ch] || []) times.add(Math.round((k.time || 0) * 100000) / 100000);
      }
      const sorted = [...times].sort((a, b) => a - b);
      const setup = boneSetup[bi];
      const keys = sorted.map((tS, idx) => {
        const [rot] = spineEvalChannel(bt.rotate, ['value'], [0], tS);
        const [tx, ty] = spineEvalChannel(bt.translate, ['x', 'y'], [0, 0], tS);
        const [sx, sy] = spineEvalChannel(bt.scale, ['x', 'y'], [1, 1], tS);
        return {
          id: String(idx), time: Math.round(tS * 1000),
          spin: 1, curve_type: '0', c1: 0, c2: 0,
          transform: {
            x: setup.x + tx, y: setup.y + ty,
            angle: norm360(setup.angle + rot),
            scaleX: setup.scaleX * sx, scaleY: setup.scaleY * sy,
            alpha: 1,
          },
          folder: null, file: null,
          _rawAngle: setup.angle + rot, // continuous value for spin derivation
        };
      });
      // spin from the continuous rotation values, then stepped segments
      for (let i = 0; i < keys.length - 1; i++) {
        const d = keys[i + 1]._rawAngle - keys[i]._rawAngle;
        keys[i].spin = d >= 0 ? 1 : -1;
        if (Math.abs(d) < 1e-6) keys[i].spin = 0;
        // a rotate key that is stepped in spine holds -- SCML equivalent is
        // instant curve (holds EVERYTHING; spine stepped is per-channel, the
        // difference only matters when one channel steps and another
        // doesn't, which our own exports never produce)
        const rk = (bt.rotate || []).find(k => Math.abs((k.time || 0) - keys[i].time / 1000) < 1e-6);
        if (rk && rk.curve === 'stepped') keys[i].curve_type = '1';
      }
      keys.forEach(k => delete k._rawAngle);
      const id = String(tlId++);
      timelines[id] = { id, obj: null, name: bname, object_type: 'bone', keys };
      boneTimelineId.set(bi, id);
    }

    // --- slot timelines: transform rides the slot's bone; keys carry the
    // image (attachment) and alpha
    const slotState = new Map(); // slot name -> {attachment events, alphaKeys}
    for (const slot of slots) {
      const st = (anim.slots && anim.slots[slot.name]) || {};
      const attKeys = st.attachment || [];
      const alphaKeys = st.alpha || [];
      if (st.rgba) warnings.push(`slot ${slot.name}: rgba color timeline imported as alpha only`);
      const rgbaKeys = st.rgba || [];
      const times = new Set([0]);
      for (const k of attKeys) times.add(k.time || 0);
      for (const k of alphaKeys) times.add(k.time || 0);
      for (const k of rgbaKeys) times.add(k.time || 0);
      const sorted = [...times].sort((a, b) => a - b);
      const setupAtt = slot.attachment || null;
      function attachmentAt(tS) {
        let cur = setupAtt;
        for (const k of attKeys) { if ((k.time || 0) <= tS + 1e-9) cur = k.name; else break; }
        return cur;
      }
      function alphaAt(tS) {
        if (alphaKeys.length) return spineEvalChannel(alphaKeys, ['value'], [1], tS)[0];
        if (rgbaKeys.length) {
          let cur = 'ffffffff';
          for (const k of rgbaKeys) { if ((k.time || 0) <= tS + 1e-9) cur = k.color || cur; else break; }
          return cur.length >= 8 ? parseInt(cur.slice(6, 8), 16) / 255 : 1;
        }
        const c = slot.color;
        return c && c.length >= 8 ? parseInt(c.slice(6, 8), 16) / 255 : 1;
      }
      const keys = sorted.map((tS, idx) => {
        const attName = attachmentAt(tS);
        const ref = attName ? attachmentInfo.get(slot.name + '|' + attName) : null;
        return {
          id: String(idx), time: Math.round(tS * 1000),
          spin: 1, curve_type: '0', c1: 0, c2: 0,
          transform: { x: 0, y: 0, angle: 0, scaleX: 1, scaleY: 1, alpha: alphaAt(tS) },
          folder: ref ? ref.folderId : null, file: ref ? ref.fileId : null,
          _present: !!ref,
        };
      });
      const id = String(tlId++);
      timelines[id] = { id, obj: null, name: slot.name, object_type: 'sprite', keys };
      slotTimelineId.set(slot.name, id);
      slotState.set(slot.name, { keys });
    }

    // --- mainline: one key at EVERY timeline key time (plus drawOrder key
    // times). This is how genuine Spriter exports are built, and it's not
    // optional: SCML playback anchors interpolation at the mainline ref's
    // `key` index and can only blend to the NEXT key -- a sparse mainline
    // would freeze every track at its anchor's next key.
    const mainTimes = new Set([0]);
    for (const tl of Object.values(timelines)) for (const k of tl.keys) mainTimes.add(k.time);
    for (const k of anim.drawOrder || []) mainTimes.add(Math.round((k.time || 0) * 1000));
    const mainSorted = [...mainTimes].sort((a, b) => a - b);

    // full slot order at time t from the drawOrder timeline (spine offsets
    // algorithm, reconstructed)
    function slotOrderAt(tMs) {
      let key = null;
      for (const k of anim.drawOrder || []) { if (Math.round((k.time || 0) * 1000) <= tMs) key = k; else break; }
      const n = slots.length;
      if (!key || !key.offsets) return slots.map((s, i) => i);
      const order = new Array(n).fill(-1);
      const unchanged = [];
      let orig = 0;
      for (const off of key.offsets) {
        const idx = slots.findIndex(s => s.name === off.slot);
        while (orig !== idx) unchanged.push(orig++);
        order[orig + off.offset] = orig; orig++;
      }
      while (orig < n) unchanged.push(orig++);
      let ui = unchanged.length;
      for (let i = n - 1; i >= 0; i--) if (order[i] === -1) order[i] = unchanged[--ui];
      return order;
    }

    const mainline = mainSorted.map((tMs, mkIdx) => {
      const mk = { id: String(mkIdx), time: tMs, bone_refs: [], object_refs: [] };
      for (let bi = 0; bi < bonesArr.length; bi++) {
        const tl = timelines[boneTimelineId.get(bi)];
        let anchor = 0;
        for (let i = 0; i < tl.keys.length; i++) if (tl.keys[i].time <= tMs) anchor = i;
        const parentName = bonesArr[bi].parent;
        mk.bone_refs.push({
          id: String(bi),
          parent: parentName === undefined || parentName === null ? null : String(boneIndexByName.get(parentName)),
          timeline: tl.id, key: String(anchor),
        });
      }
      const order = slotOrderAt(tMs);
      let z = 0, objId = 0;
      for (const slotIdx of order) {
        const slot = slots[slotIdx];
        const tl = timelines[slotTimelineId.get(slot.name)];
        let anchor = 0;
        for (let i = 0; i < tl.keys.length; i++) if (tl.keys[i].time <= tMs) anchor = i;
        if (!tl.keys[anchor]._present) { continue; } // hidden at this moment -> not in the cast
        mk.object_refs.push({
          id: String(objId++),
          parent: slot.bone !== undefined ? String(boneIndexByName.get(slot.bone)) : null,
          timeline: tl.id, key: String(anchor), z_index: z++,
        });
      }
      return mk;
    });

    for (const tl of Object.values(timelines)) for (const k of tl.keys) delete k._present;
    animations.push({ id: String(animations.length), name: animName, length: lengthMs, interval: 100, looping: true, mainline, timelines });
  }

  const entityName = (label || 'spine').replace(/\.[^.]*$/, '');
  const newEntities = [{ id: '0', name: entityName, bones: bonesArr.map(b => b.name), animations }];
  loadProject(newFolders, newEntities, newImages, label, true);
  if (warnings.length) console.warn('[spine import]', warnings);
  return { missing, warnings };
}
