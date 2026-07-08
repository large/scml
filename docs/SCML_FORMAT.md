# How SCML actually works

SCML (Spriter Character Markup Language) is BrashMonkey Spriter's animation
format. This doc explains the data model this editor is built on, using the
built-in "8-bit character" project as running examples. Official spec:
https://www.brashmonkey.com/ScmlDocs/ScmlReference.html — this doc is the
practical, example-driven version of that reference, cross-checked against
it and against this project's actual data.

## The short answer

Yes — it's a bone system, and yes, you move bones (and sprites) between
poses using curves, but with two refinements worth having straight before
anything else:

1. **There's no single global timeline.** Every bone and every sprite has
   its **own** private sequence of keyframes, on its own schedule. A hand
   might key at 0ms and 150ms while a foot keys at 0ms, 300ms, and 600ms in
   the very same animation. "The timeline" (the row-based view in this
   editor) is really dozens of independent mini-timelines shown together.
2. **Bones are invisible.** A bone is nothing but a position + rotation +
   scale in space — Spriter never draws it. Sprites (images) get **attached**
   to bones (or to nothing, i.e. directly to the stage) and inherit the
   bone's position the way a hand inherits a forearm's position: move the
   forearm, the hand comes with it, on top of whatever the hand is doing on
   its own.

That's the whole trick: a rig is a tree of bones, each with its own
keyframed local motion, and sprites are leaves hanging off that tree.

## The data hierarchy

```
spriter_data
├── folder[]                    -- image libraries: <file> = one PNG + its pivot point
└── entity[]                    -- one character/rig ("Skin" in this editor)
    ├── obj_info (type="bone")  -- the bone list, just names -- this is the skeleton
    └── animation[]
        ├── mainline             -- the "cast + sync points" for THIS animation
        │   └── key[]            -- at time T: which bones/sprites participate, and how they're parented/ordered
        │       ├── bone_ref[]   -- "bone A, parented to bone B, sample timeline N at its key K"
        │       └── object_ref[] -- same, for sprites, plus a draw-order z_index
        └── timeline[]            -- one per bone/sprite, ITS OWN keyframes
            └── key[]              -- x, y, angle, scale_x, scale_y (+ folder/file if it's a sprite)
```

Two things live side by side per animation: **timelines** (the actual
keyframed motion, one track per part) and the **mainline** (a short list of
sync points that says which parts are "in the shot" and how they're
plugged together at that moment). This split is the single most confusing
thing about the format until it clicks, so here's both halves in detail.

## Timelines: where the motion actually lives

A timeline belongs to one bone or one sprite, for one animation. Its keys
store the part's **local** transform — x, y, angle, scale_x, scale_y —
*relative to its parent*, not relative to the stage. Each key also carries:

- **`curve_type`** — how this key blends into the *next* key on the same
  timeline: linear (steady), quadratic/cubic (eased), or instant (hold —
  snap with no blend). This is exactly what the diamond/circle/flat-bar
  shapes on the Timeline panel mean; see the Legend button there.
- **`spin`** — which rotational direction to interpolate angle in (+1
  clockwise, -1 counter-clockwise, 0 don't rotate at all), so a hand
  spinning through 350° doesn't accidentally interpolate the "short way"
  backwards through 0°.
- **`folder` / `file`** (sprite timelines only) — which image to show at
  this key.

That last one is the answer to "why are some sprites multiple and others
not" — see below.

## Mainline: the cast list and sync points

The mainline doesn't hold motion at all. Each mainline `key` is a moment in
time that says three things:

- **Which bones and sprites are "on stage"** at that moment (a
  `bone_ref`/`object_ref` per active part — parts can appear and disappear
  between mainline keys, e.g. a muzzle flash that only exists for two
  frames).
- **How they're plugged together right now** — each ref's `parent`
  attribute and which `timeline` + which key index (`key="N"`) on that
  timeline to sample.
- **Draw order** — each `object_ref` has a `z_index`; sprites paint back to
  front in ascending z_index.

Mainline keys are usually sparse (an idle animation might have just one, at
t=0) compared to the dozens of timeline keys underneath — mainline keys
only need to fire when the *cast or plumbing* changes, not every time
something merely moves.

## Computing a pose at time T (what the editor's `computeFrame` does)

1. Find the mainline key whose time is the latest one `<= T` — that's the
   cast list and plumbing for this instant.
2. For every active bone, in parent-before-child order: look up its
   timeline, find the key at the index the mainline `bone_ref` points to,
   interpolate toward the *next* key on that same timeline using the
   current key's `curve_type`/`spin`, giving a **local** transform.
3. Compose that local transform with the parent bone's **world** transform
   (already computed in step 2, since parents are processed first) — the
   bone's own effect (rotation, scale, translation) is layered *inside* the
   parent's rotation/scale, the same way a wristwatch keeps facing the same
   way relative to your wrist no matter how your arm rotates.
4. Do the same for every active sprite (interpolate its own timeline, then
   compose with whichever bone it's parented to, or leave it as-is if it's
   parented directly to the stage).
5. Sort sprites by z_index and paint each one at its pivot point, in its
   final world position/rotation/scale.

Every part in a chain has its own keyframes *and* rides on its parent's
motion — a foot's own keys might only nudge it up and down, but it also
swings through space because the leg above it is rotating.

## Why do some sprites appear as "multiple"?

Two different things look similar but are different concepts, and both
happen in this project:

**A. Sprite-swap keys — one slot, several images, same identity.** A
timeline's keys don't have to keep pointing at the same picture. In this
project, the `foot_02` timeline's keys cycle through `foot_01.png` through
`foot_05.png` as the walk cycle progresses — same sprite *slot*, five
different pictures of a foot mid-step, because a 2D character's foot
usually reads better as a handful of discrete drawn poses than as one image
being stretched. Likewise `hat_top` swaps to a different picture partway
through the shotgun recoil (the hat visibly kicks up), and the hand slots
(`light_tone_08` and its variants) cycle through **8 to 11 different
pictures each** across the rig's gun-handling animations — different
finger poses for gripping, resting, trigger-pulling. The Timeline panel
flags exactly these keys with a small orange corner flag and a tooltip
("sprite → hat_up.png"); the Asset Manager's Sprites tab groups every image
a slot ever uses under its one card, for the same reason. **This is normal,
intentional animation technique — not a bug, and not actually "multiple
sprites."** It's one slot with a flipbook of images.

**B. Cast changes — different animations, different roster.** `idle` and
`walk` use the same fixed cast of ~16 sprites the whole time. `shoot_shotgun`
introduces the shotgun itself partway through, growing the cast from 18 to
20 active sprites mid-animation. This is just "a new bone/sprite entered
the scene," unrelated to swapping.

There is a data quirk worth knowing if you're renaming things or writing a
new implementation: `bone_ref`/`object_ref` `id` numbers are only
assigned *within one mainline key*, by enumeration order — they are not a
stable cross-file identity. For **bones** this never matters in practice (a
rig's skeleton doesn't change shape, so a given bone id maps to the same
named bone in every key, of every animation, in this project — verified).
For **objects**, an animation whose cast changes (like `shoot_shotgun`,
above) can and does recycle ids to mean a different sprite partway through
— confirmed directly against this project's data (in `shoot_shotgun`, 18 of
20 object ids point at a different sprite in at least one other mainline
key of that same animation). The one durable cross-animation identity a
sprite has is its **timeline name**, which Spriter keeps consistent — this
editor's default naming (Asset Manager → Sprites tab) now uses exactly
that, which is why it's more trustworthy than the raw id shown in "sprite
#N".

## How this maps to the editor

- **Timeline panel** rows = one row per bone/sprite **timeline**, for the
  current animation. Diamond/circle/flat markers = `curve_type`. Orange
  flag = a sprite-swap key. A dimmed row = that part exists in this
  animation's rig but isn't part of the mainline cast at the playhead's
  current position (e.g. before the shotgun is drawn).
- **Selected item → "This keyframe"** edits the raw local x/y/angle/scale
  stored in that timeline key directly — but only when the playhead sits
  exactly on one of that item's own keyframes (steps 2–3 above, run in
  reverse). Between keyframes there's no single key to edit — the pose
  is interpolated, so those fields are read-only.
- **Selected item → "Override"** is *not* part of the SCML data model at
  all — it's this editor's own correction layer (a flat delta folded in at
  the very end of step 3/4, on top of whatever the keyframe(s) produce),
  useful for a global nudge without hand-editing every keyframe.
- **Asset Manager → Sprites tab** groups by logical slot (one card per
  `object_ref` id you've ever seen, every image variant grouped under it).
  **Raw assets tab** is the flip side: literally every `<file>` this
  project declares, whether or not anything currently uses it. In this
  project, 56 PNGs are declared and 53 are wired into some sprite slot — 3
  (`body_arms_back.png`, `light_tone_09.png`, `dark_tone_09.png`) exist in
  the file but aren't referenced by any animation.

## Can I build an animation from scratch here?

**Mostly, today.** What works, tested end-to-end:

- **"+ Animation"** clones an existing animation (its full timeline set,
  every bone and sprite it uses) as a starting point. From there you can
  freely drag/rotate/rescale any bone or sprite at any time, with edit
  scope set to "this animation only" so it doesn't bleed into the source —
  this is genuinely a from-scratch *re-pose*, just starting from an
  existing skeleton + cast rather than a blank canvas.
- Within that clone, **"This keyframe"** edits let you adjust any *existing*
  keyframe's authored pose directly, per the section above.
- **"Insert keyframe here"** adds a brand-new key to the selected item's
  timeline at the current playhead time, seeded with its live interpolated
  pose (so inserting is a no-op visually — the point is to give you a real
  key to then re-pose via "This keyframe"). It correctly re-indexes every
  mainline ref across the whole animation that points at the same timeline,
  since SCML's `ref.key` is a raw array index into `timeline.keys[]`, not an
  id lookup — verified by fingerprinting every bone/object's pose at every
  sampled time across the whole animation before and after an insert, on an
  animation with real cast changes and id-recycling, with zero unexpected
  changes outside the edited item's own local time window.
- **"Change image…"** on an on-keyframe sprite opens a picker over every raw
  PNG in the project — including ones no Spriter-authored sprite currently
  uses — and reassigns that keyframe to point at it directly.
- You can retime the loop start, recolor sprites, reorder draw layers, and
  rename everything as you go.

What's **still not** possible through the UI, confirmed by testing:

- **No way to add a new bone.** The skeleton is fixed to whatever
  `obj_info` declared for the entity.
- **No way to add a new sprite slot** — there's no "attach this PNG to
  this bone" control that introduces a timeline the mainline doesn't
  already reference; you can retarget an *existing* keyframe's image (above),
  but not add a wholly new object/bone to the cast.

Put together: this editor is now a **re-posing and re-timing tool for an
existing Spriter rig's cast**, not a rig-authoring tool — you can insert,
re-pose, and re-image any beat of a cloned animation, but you can't grow
the skeleton or the sprite roster itself. To add genuinely new bones or
sprite slots, the underlying `.scml` still needs to be edited in Spriter
Pro (or by hand/script) first, then loaded here (File → Project → "Load a
different SCML project") for fine-tuning.
