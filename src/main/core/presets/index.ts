/**
 * The presets surface, over whichever model a profile mounts.
 *
 * Everything above this module — IPC, preload, the page — sees one roster, one
 * set of writes and one location to open. The two models differ in exactly three
 * places, and each is handled here:
 *
 * - WHERE a roster comes from: two scanned roots (directory), or a profile's
 *   composed patch layers (declaration).
 * - WHAT a preset's definition is: a directory edited by writing `preset.yml`
 *   beside the composition (directory), or one row of a patch layer, editable
 *   only when that layer is the launcher's own (declaration).
 * - WHY a preset cannot be used here: the host's health check cannot answer that,
 *   so each preset is graded against the profile's own resolution chain — the
 *   same way for both models.
 *
 * The profile is an argument rather than a page-level notion because the
 * declaration model makes the roster a per-profile fact: two profiles of one dsh
 * may select different bundle versions, and a declaration in one profile's patch
 * layer does not exist in another's.
 */

import { existsSync, readFileSync } from 'node:fs'
import { collectInsertIds } from '../patch/patch.ts'
import { homePatchPath, profilePatchPath, writePatchFile } from '../profile/home.ts'
import { discoverPresets, presetById, presetRoots } from './roots.ts'
import { directoryGradeTargets, gradeTargets, type GradeTarget } from './rating.ts'
import { detectModel, profileLayers } from './layers.ts'
import {
  configBodyOf, declarationLoaderId, insertDeclaration, pluginsBlockOf, readDeclarations,
  removeDeclaration, saveDeclarationMeta,
  type ComposedLayer, type DeclarationInput, type DeclaredPreset,
} from './declaration.ts'
import { legacyPresets, migrationInput } from './legacy.ts'
import { copyPreset, deletePreset, savePresetMeta } from './authoring.ts'
import { E, throwE } from '../shared/errors.ts'
import { PRESET_ID_RE } from '../../../shared/preset.ts'
import type { DshContext } from '../profile/appState.ts'
import type {
  PresetLegacyItem, PresetListItem, PresetListing, PresetMetaInput, PresetPlace, PresetRow,
} from '../../../shared/types.ts'

/** One patch file's current text, or the empty document the host expects. */
function patchTextAt(path: string): string {
  if (!existsSync(path)) return '[]\n'
  return asPatchDocument(readFileSync(path, 'utf8'))
}

/**
 * A patch document with no entries becomes the `[]` marker.
 *
 * Removing the last row leaves comments-only text (the template header the host
 * writes), and neither an empty file nor a comments-only one parses as a YAML
 * document — the host fails the whole profile at boot. The marker is what makes
 * "nothing overridden here" a loadable state, and the next append replaces it.
 */
function asPatchDocument(text: string): string {
  const hasEntry = text.split('\n').some(line => line.trim() !== '' && !line.trim().startsWith('#'))
  if (hasEntry) return text
  const kept = text.replace(/\s+$/, '')
  return kept === '' ? '[]\n' : `${kept}\n[]\n`
}

/** The patch document a declarative write lands in: this profile's own layer. */
function profilePatchText(ctx: DshContext, profile: string): string {
  return patchTextAt(profilePatchPath(ctx, profile))
}

/** Write one declaration layer's new text, normalized and verified. */
function writeLayer(path: string, text: string): void {
  writePatchFile(path, asPatchDocument(text))
}

// ── the page's read ─────────────────────────────────────────────────────────

/** Publish one directory-model row for the page. */
function directoryItem(row: PresetRow): PresetListItem {
  return {
    id: row.id,
    trust: row.trust,
    source: row.trust === 'system' ? 'package' : 'user-dir',
    ...(row.name === undefined ? {} : { name: row.name }),
    ...(row.description === undefined ? {} : { description: row.description }),
    ...(row.order === undefined ? {} : { order: row.order }),
    ...(row.broken === undefined ? {} : { broken: row.broken }),
    editable: row.editable,
    location: row.dir,
    locationKind: 'dir',
  }
}

/** The places a directory-model roster comes from. */
function directoryPlaces(ctx: DshContext): PresetPlace[] {
  return presetRoots(ctx).map((root): PresetPlace => ({
    source: root.trust === 'system' ? 'package' : 'user-dir',
    path: root.path,
    exists: root.exists,
    writable: root.writable,
  }))
}

/** Publish one declared preset for the page. */
function declarationItem(preset: DeclaredPreset): PresetListItem {
  return {
    id: preset.id,
    // A declaration in a bundle layer belongs to the deployment; one in the
    // profile or home patch is the person's own — which is also what decides
    // whether it is editable, there being no `trust` field in this model to
    // consult.
    trust: preset.layer === 'bundle' ? 'system' : 'user',
    source: preset.layer,
    ...(preset.bundle === undefined ? {} : { bundle: preset.bundle }),
    ...(preset.name === undefined ? {} : { name: preset.name }),
    ...(preset.description === undefined ? {} : { description: preset.description }),
    ...(preset.order === undefined ? {} : { order: preset.order }),
    ...(preset.broken === undefined ? {} : { broken: preset.broken }),
    // ONLY the profile's own layer. The home layer is writable on disk but not
    // here: this page is one profile's roster, and a declaration there is shared
    // by every profile of the machine, so editing it from a profile-scoped page
    // would change rosters the person is not looking at. The same condition is
    // what {@link assertEditable} enforces — a page that offers an action the
    // core then refuses is the failure `store/refstate.ts` names as this repo's
    // rule, in the other direction.
    editable: preset.layer === 'profile',
    // The declaration, not the preset: this model has no directory, and the file
    // that carries the definition is the thing worth opening.
    location: preset.sourcePath,
    locationKind: 'file',
  }
}

/**
 * The places a declaration-model roster comes from: every layer that can carry a
 * declaration, in the order dsh applies them. The profile's own patch is listed
 * whether or not it exists — it is where a preset the launcher creates goes.
 */
function declarationPlaces(ctx: DshContext, profile: string, layers: readonly ComposedLayer[]): PresetPlace[] {
  const places: PresetPlace[] = []
  const seen = new Set<string>()
  const add = (place: PresetPlace): void => {
    if (seen.has(place.path)) return
    seen.add(place.path)
    places.push(place)
  }
  for (const layer of layers) {
    if (layer.kind !== 'bundle') continue
    add({
      source: 'bundle',
      path: layer.path,
      ...(layer.bundle === undefined ? {} : { bundle: layer.bundle }),
      exists: true,
      writable: false,
    })
  }
  const profilePatch = profilePatchPath(ctx, profile)
  add({ source: 'profile', path: profilePatch, exists: existsSync(profilePatch), writable: true })
  const homePatch = homePatchPath(ctx)
  add({ source: 'home', path: homePatch, exists: existsSync(homePatch), writable: true })
  return places
}

/** The retired root's directories, marked when their id is already declared. */
function legacyItems(ctx: DshContext, declared: ReadonlySet<string>): PresetLegacyItem[] {
  return legacyPresets(ctx).map(preset => ({
    id: preset.id,
    dir: preset.dir,
    ...(preset.name === undefined ? {} : { name: preset.name }),
    ...(preset.description === undefined ? {} : { description: preset.description }),
    ...(preset.read.ok ? {} : { problem: preset.read.problem }),
    taken: declared.has(preset.id),
  }))
}

/**
 * Everything the presets page renders for one profile.
 * @param ctx - the dsh to read.
 * @param profile - the profile whose roster, places and grades are read.
 * @returns the roster, one grade per preset, the definition sources, and what
 * could not be listed as a row.
 */
export function presetListing(ctx: DshContext, profile: string): PresetListing {
  const layers = profileLayers(ctx, profile)
  const model = detectModel(layers)

  if (model === 'declaration') {
    const { presets, warnings } = readDeclarations(layers)
    const targets: GradeTarget[] = presets.map(p => ({ id: p.id, baseDir: p.baseDir, read: p.read }))
    return {
      profile,
      model,
      presets: presets.map(declarationItem),
      grades: gradeTargets(ctx, targets, [profile]),
      places: declarationPlaces(ctx, profile, layers),
      legacy: legacyItems(ctx, new Set(presets.map(p => p.id))),
      warnings,
    }
  }

  if (model === 'directory') {
    const rows = discoverPresets(presetRoots(ctx))
    return {
      profile,
      model,
      presets: rows.map(directoryItem),
      grades: gradeTargets(ctx, directoryGradeTargets(rows), [profile]),
      places: directoryPlaces(ctx),
      // These directories ARE the roster here; nothing is left over.
      legacy: [],
      warnings: [],
    }
  }

  // Nothing mounts a preset roster here, so there is nowhere a preset could come
  // from: the retired root and the unmounted package's `presets/` are not
  // sources, they are directories dsh never reads. Listing them would contradict
  // the page's own "this dsh enables no agent presets" state.
  return { profile, model, presets: [], grades: [], places: [], legacy: [], warnings: [] }
}

/** The declaration that supplies one id in these layers, or a refusal. */
function declarationIn(layers: readonly ComposedLayer[], id: string): DeclaredPreset {
  const found = readDeclarations(layers).presets.find(p => p.id === id)
  if (found === undefined) throwE(E.presetNotFound, { preset: id })
  return found
}

/**
 * Refuse a write this page does not own.
 *
 * Two refusals, not one, because the reasons differ and only one of them is
 * about ownership: a bundle declaration is the deployment's, while a home-layer
 * one is the person's own but shared by every profile of the machine. They are
 * separate codes because the renderer turns a code into a sentence
 * (`lib/ipc.ts`) — one code could only ever say one of the two.
 */
function assertEditable(preset: DeclaredPreset): void {
  if (preset.layer === 'bundle') throwE(E.presetReadOnly, { preset: preset.id })
  if (preset.layer !== 'profile') throwE(E.presetHomeReadOnly, { preset: preset.id })
}

/**
 * Refuse an id a LAYER already supplies.
 *
 * Two different failures, one check: a repeated PRESET id makes dsh fail that one
 * declaration, while a repeated LOADER ROW id makes it refuse to boot the whole
 * profile. Both are the caller's to avoid before anything is written.
 * @param layers - the profile's layers, composed once by the caller.
 * @param id - the preset id being claimed.
 */
function assertDeclaredIdFree(layers: readonly ComposedLayer[], id: string): void {
  if (!PRESET_ID_RE.test(id)) throwE(E.presetBadId, { preset: id })
  if (readDeclarations(layers).presets.some(p => p.id === id)) throwE(E.presetExists, { preset: id })
  const rowId = declarationLoaderId(id)
  // Ask the SAME structural walk the boot pre-flight uses ({@link findInsertConflicts})
  // which ids this layer INSERTS. A raw text search for `- id: <rowId>` misses
  // three shapes that all carry a real row — a CRLF file, one whose last line has
  // no newline, and `- id:  x` with extra spaces — and in the other direction it
  // matches a plugin row inside a declaration's own `config.plugins` roster,
  // which is not an entry and cannot collide with anything.
  if (layers.some(layer => collectInsertIds(layer.text).includes(rowId))) {
    throwE(E.presetExists, { preset: id })
  }
}

/** {@link assertDeclaredIdFree} plus the directories the retired root still
 * holds — which dsh no longer reads, but which would collide with the id the
 * moment someone migrated them. */
function assertIdFree(ctx: DshContext, layers: readonly ComposedLayer[], id: string): void {
  assertDeclaredIdFree(layers, id)
  if (legacyPresets(ctx).some(p => p.id === id)) throwE(E.presetExists, { preset: id })
}

/** The declaration-model half of "create a preset from an existing one". */
function copyIntoProfile(
  ctx: DshContext, profile: string, layers: readonly ComposedLayer[], fromId: string, toId: string,
  name?: string,
): void {
  const source = declarationIn(layers, fromId)
  assertIdFree(ctx, layers, toId)
  const body = configBodyOf(patchTextAt(source.sourcePath), source.rowId)
  const plugins = body === undefined ? undefined : pluginsBlockOf(body)
  if (plugins === undefined) throwE(E.presetNoPlugins, { preset: fromId })
  // The copy keeps the source's DESCRIPTION and drops its name and roster order,
  // exactly as the directory model's copy does: the display text describes what
  // the preset does, while the name and the position are the new one's own.
  const input: DeclarationInput = {
    id: toId,
    ...(name === undefined || name.trim() === '' ? {} : { name }),
    ...(source.description === undefined ? {} : { description: source.description }),
    pluginsBlock: plugins,
  }
  writeLayer(profilePatchPath(ctx, profile), insertDeclaration(profilePatchText(ctx, profile), input))
}

// ── the writes ──────────────────────────────────────────────────────────────

/**
 * Store one preset's display text.
 *
 * On a directory-model dsh this writes `preset.yml` beside the composition. On a
 * declaration-model dsh it edits the scalar lines inside the declaring row's
 * `config`, leaving that row's `plugins` block byte for byte as it was.
 * @param ctx - the dsh to write.
 * @param profile - the profile whose roster the preset belongs to.
 * @param id - the preset id.
 * @param meta - the display half; `''`/`null` clears a key.
 * @throws `preset.notFound`, `preset.readOnly` for a preset the deployment owns,
 * or `preset.homeReadOnly` for one the machine-level home layer holds.
 */
export function savePresetMetaIn(ctx: DshContext, profile: string, id: string, meta: PresetMetaInput): void {
  const layers = profileLayers(ctx, profile)
  if (detectModel(layers) !== 'declaration') {
    savePresetMeta(ctx, id, meta)
    return
  }
  const preset = declarationIn(layers, id)
  assertEditable(preset)
  writeLayer(preset.sourcePath, saveDeclarationMeta(patchTextAt(preset.sourcePath), preset.rowId, meta))
}

/**
 * Create a preset by copying an existing one.
 * @param ctx - the dsh to write.
 * @param profile - the target profile (the declaration model writes there).
 * @param fromId - the preset to copy.
 * @param toId - the new preset's id.
 * @param name - its display name; omitted keeps the source's description only.
 * @throws `preset.notFound`, `preset.badId`, `preset.exists`, or `preset.noPlugins`.
 */
export function copyPresetIn(
  ctx: DshContext, profile: string, fromId: string, toId: string, name?: string,
): void {
  const layers = profileLayers(ctx, profile)
  if (detectModel(layers) !== 'declaration') {
    copyPreset(ctx, fromId, toId, name)
    return
  }
  copyIntoProfile(ctx, profile, layers, fromId, toId, name)
}

/**
 * Remove a preset the launcher owns. A built-in one is refused: on the directory
 * model it ships with the install, and on the declaration model its row belongs
 * to a bundle layer.
 * @param ctx - the dsh to write.
 * @param profile - the profile whose roster the preset belongs to.
 * @param id - the preset id.
 * @throws `preset.notFound`, `preset.readOnly` for a preset the deployment owns,
 * or `preset.homeReadOnly` for one the machine-level home layer holds.
 */
export async function deletePresetIn(ctx: DshContext, profile: string, id: string): Promise<void> {
  const layers = profileLayers(ctx, profile)
  if (detectModel(layers) !== 'declaration') {
    await deletePreset(ctx, id)
    return
  }
  const preset = declarationIn(layers, id)
  assertEditable(preset)
  writeLayer(preset.sourcePath, removeDeclaration(patchTextAt(preset.sourcePath), preset.rowId))
}

/**
 * Migrate one directory the retired root still holds into a declaration in this
 * profile's own patch layer.
 *
 * The directory is NOT touched: it stops mattering the moment the declaration
 * exists, and deleting a person's files is a separate decision they make.
 * @param ctx - the dsh to write.
 * @param profile - the profile that receives the declaration.
 * @param id - the legacy directory's name, which becomes the preset id.
 * @throws `preset.notFound`, `preset.badId`, `preset.exists`, or `preset.badComposition`.
 */
export function migrateLegacyPreset(ctx: DshContext, profile: string, id: string): void {
  const legacy = legacyPresets(ctx).find(p => p.id === id)
  if (legacy === undefined) throwE(E.presetNotFound, { preset: id })
  assertDeclaredIdFree(profileLayers(ctx, profile), id)
  const migrated = migrationInput(legacy)
  if (!migrated.ok) throwE(E.presetBadComposition, { preset: id, detail: migrated.problem })
  writeLayer(profilePatchPath(ctx, profile), insertDeclaration(profilePatchText(ctx, profile), migrated.input))
}

/**
 * What "open" targets for one preset.
 *
 * Location only: this asks which model the profile mounts and where that model
 * keeps the one id's definition. Reading the whole roster here would grade every
 * preset of the profile — a full module resolution walk per row — to answer a
 * question about a single path, and "open" is a click on a file, not a verdict.
 * @param ctx - the dsh to read.
 * @param profile - the profile whose roster the preset belongs to.
 * @param id - the preset id.
 * @returns the path and whether it is a directory.
 * @throws `preset.notFound` when no layer supplies that id, or when the profile
 * mounts no preset model at all.
 */
export function presetLocationOf(
  ctx: DshContext, profile: string, id: string,
): { path: string; kind: 'dir' | 'file' } {
  const layers = profileLayers(ctx, profile)
  const model = detectModel(layers)
  if (model === 'declaration') {
    return { path: declarationIn(layers, id).sourcePath, kind: 'file' }
  }
  if (model === 'directory') {
    const row = presetById(discoverPresets(presetRoots(ctx)), id)
    if (row === undefined) throwE(E.presetNotFound, { preset: id })
    return { path: row.dir, kind: 'dir' }
  }
  // No model, no roster: the directory the retired root holds is not where this
  // dsh's presets come from, so "open" has nothing to open.
  throwE(E.presetNotFound, { preset: id })
}
