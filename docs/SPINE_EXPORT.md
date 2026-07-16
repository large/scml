# Exporting to Spine (4.2 / 4.3)

**File → Export to Spine** converts the current entity into the three things a
[Spine](https://esotericsoftware.com/) runtime loads:

| file | what it is |
|---|---|
| `<name>.json` | the skeleton: bones, slots, a default skin, and every animation |
| `<name>.atlas` | the texture atlas description (region name → pixel rectangle) |
| `<name>.png`, `<name>_2.png`, … | the packed image page(s), max 4096×4096 each |

Every animation of the entity is included. The export was built for — and
validated against — **Spine 4.2 and 4.3**; pick the version matching your
runtime, because Spine runtimes only accept files whose `major.minor` version
matches their own (spine-flutter's latest is 4.3; 4.2 runtimes are still
common and 4.2 files also work with the json↔skel converter below).

## Using it with spine-flutter

```dart
final drawable = await SkeletonDrawableFlutter.fromAsset(
  'assets/character.atlas',
  'assets/character.json',
);
// or the widget shortcut:
SpineWidget.fromAsset('assets/character.atlas', 'assets/character.json', controller)
```

Notes for Flutter specifically:

- The atlas is written with `pma: false` and the PNGs use straight
  (non-premultiplied) alpha — which is exactly what spine-flutter requires
  (it does not support premultiplied-alpha atlases).
- spine-flutter accepts `.json` skeletons directly. If you want the smaller
  binary `.skel` instead, run the exported JSON through
  [SpineSkeletonDataConverter](https://github.com/wang606/SpineSkeletonDataConverter)
  (supports 3.5–4.2): `SpineSkeletonDataConverter input.json output.skel`.
- The Spine editor itself can also import the JSON (File → Import Data), so
  you can continue working on the exported skeleton there.

## How SCML concepts map to Spine

| SCML | Spine |
|---|---|
| bone | bone (named after its timeline, e.g. `bone_000`) |
| object **timeline** (by name) | one **slot** + one **bone** carrying it |
| image (`folder/file`) | region attachment in the default skin, named by file path (`body/leg_upper`) |
| pivot | attachment center offset: `((0.5−pivot_x)·w, (0.5−pivot_y)·h)` |
| mainline cast changes | slot **attachment keys** (`name` / `null`) at the mainline key times |
| `z_index` per mainline key | a **drawOrder** timeline (offsets vs. the setup order) |
| timeline keys + curves + spin | baked **rotate / translate / scale** keys (see below) |
| per-key alpha (`a`) | slot **alpha** timeline (only written when it actually varies) |

Two SCML quirks make the naive 1:1 mapping wrong, and the exporter handles
both:

1. **SCML object ids are z-slots, not identities.** Between mainline keys the
   same `object_ref id` freely points at different timelines (verified: 18 of
   20 ids in this project's `shoot_shotgun` re-point mid-animation). The
   stable identity of a sprite is its **timeline name**, so that's what
   becomes the Spine slot/bone. Bones don't have this problem (verified
   stable across every animation).
2. **Sprites animate their transforms; Spine attachments can't.** Only bones
   animate in Spine, so every sprite rides its own little bone, and its slot
   + region attachment hang off that.

## Why the exported skeleton is flat (and baked)

Spriter and Spine propagate transforms down a bone chain **differently**:

- **Spriter** composes angle and scale *component-wise* at every level. A
  node's world transform is always a clean translate–rotate–scale; nothing
  ever shears.
- **Spine** composes full affine *matrices*. A rotated child under a
  non-uniformly scaled parent **shears** — that's correct affine math, and
  Spine's editor embraces it.

This project's rig leans hard on non-uniform scale (a leg bone with
`scaleY 6.3` and rotated children, mirrored arms via negative scale), so a
hierarchy-preserving export would visibly skew and displace deep chains — in
testing, hands ended up 1000+ px from where Spriter draws them.

The exporter therefore emits a **flat skeleton**: every bone is a child of
`root`, and each animation's keys are the item's **SCML world transform**,
baked at the union of the animation's authored key times. That is bit-exact
at every authored instant. Between those instants the export adds keys only
where needed, adaptively:

- it samples each gap's midpoint and subdivides (down to a 1-ms grid,
  capped per item) wherever a straight world-space blend would drift more
  than **1 px / 0.35° / 1% scale** from the true SCML pose — so a fast arm
  arc gets a handful of extra keys, while static or slow motion gets none;
- mainline keys that **hard-cut** an item's pose (cast re-anchors, parent
  switches — detected with a 0.01 ms epsilon so fast authored ramps stay
  ramps) get a *stepped* key 0.1 ms before the cut, reproducing the jump
  exactly instead of smearing it;
- looping animations get an explicit final key at `t = length` holding the
  wrapped-around pose, since SCML interpolates the last key back to the
  first while Spine timelines hold their last key;
- constant timelines collapse to a single key, and timelines that never
  leave the setup pose are dropped.

The setup pose is the first animation's `t = 0` frame.

Trade-off to be aware of: because the exported skeleton is flat, it plays
back faithfully in any Spine runtime, but it is **not a rig you'd want to
re-animate by hand in the Spine editor** — grabbing an "arm" bone won't drag
the hand along. For runtime playback (spine-flutter, spine-unity, …), which
is what this export is for, none of that matters.

## Validation

The exporter is tested end-to-end against the **official spine-core runtime**
(`@esotericsoftware/spine-core` 4.2.119 and 4.3.10 from npm): the exported
files are parsed by the real `SkeletonJson` + `TextureAtlas`, a real
`Skeleton` is posed by each animation, and at 430 sampled instants across
all 20 animations every sprite's **world matrix** (a,b,c,d,x,y), its current
**image**, its **visibility**, and the full visible **draw order** are
compared against the app's own SCML pipeline. Results, identical on both
runtime versions:

- world matrices: **7315 / 7322** samples within 1.6 px / 2% — the 7
  remaining deviate by at most ~6 px and sit strictly inside
  sub-*millisecond* windows of authored impact whips (die's collapse,
  stab's hit), i.e. 1/17th of one 60 fps frame;
- images (attachments): **7322 / 7322**;
- visibility (cast presence): no mismatches;
- draw order: **430 / 430**.

## What is NOT exported

- **Override corrections** (the dx/dy "Override" panel) — the export writes
  the *authored* keyframe data. Bake overrides into real keyframes ("This
  keyframe" edits) if you want them in the export.
- **The tool's per-animation loop-start offset** — a viewer feature, not
  part of the data.
- **Bone-alpha inheritance** — Spine has no bone alpha; per-sprite alpha
  keys are exported (this project doesn't use alpha animation at all).
- **Character maps, sounds, events, variables** — not represented in this
  editor's data model.
- Spine-side features SCML has no data for (IK, meshes, physics, multiple
  skins) are simply absent — the file is still a complete, valid Spine
  project with a single default skin.
