/**
 * The one js-yaml setup every patch-config reader and validator shares — the
 * only module in the repo that imports js-yaml directly.
 *
 * dsh configs routinely use cordis' non-standard `!!js` tag, which js-yaml
 * rejects as an unknown explicit tag. This module registers it ONCE, under its
 * RESOLVED name: js-yaml looks up `!!js` as `tag:yaml.org,2002:js`, and a short
 * name here never matches. The tag is load-only — the launcher never dumps
 * `!!js` back through js-yaml — so `identify` always returns false.
 */
import { CORE_SCHEMA, FAILSAFE_SCHEMA, defineScalarTag, dump, load } from 'js-yaml'

/** Sentinel prefix carrying a cordis `!!js` expression through js-yaml. */
const JS_PREFIX = '\u0000dsh-js:'

const jsExprTag = defineScalarTag<string>('tag:yaml.org,2002:js', {
  identify: () => false,
  resolve: (source: string): string => `${JS_PREFIX}${source}`,
})

/** `CORE_SCHEMA` + `!!js`: booleans/numbers stay typed, expressions survive. */
export const CONFIG_SCHEMA = CORE_SCHEMA.withTags(jsExprTag)

/** Parse one patch `config` body with the shared tolerant schema. */
export function loadYaml(raw: string): unknown {
  return load(raw, { schema: CONFIG_SCHEMA })
}

/**
 * Render a small document the launcher itself owns.
 *
 * The write-side counterpart of {@link loadYaml}, and the reason it lives here
 * rather than in the one module that needs it: the repo keeps a single js-yaml
 * importer, so the tolerant loader and the renderer can never drift apart. It
 * only ever sees plain scalars a person typed — the `!!js` sentinel never
 * reaches a dump, which is why the loader-only tag is no obstacle.
 * @param value - the document to render.
 * @returns the YAML text, newline-terminated.
 */
export function dumpYaml(value: unknown): string {
  return dump(value, { lineWidth: -1, noRefs: true })
}

/** Whether a parsed scalar came from a `!!js` expression. */
export function isJsExpr(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(JS_PREFIX)
}

/** The raw expression text behind a `!!js`-tagged scalar. */
export function jsExprText(value: string): string {
  return value.slice(JS_PREFIX.length)
}

/**
 * The result of a structure-only parse: `checked: false` means the document
 * carries a cordis `!!js` tag, so its shape was NOT verified.
 */
export type StructureParse = { checked: true; value: unknown } | { checked: false }

/**
 * Parse a document for STRUCTURE ONLY. `FAILSAFE_SCHEMA` resolves every scalar
 * to a string, so a validation pass never interprets a value — that is exactly
 * why the validator must not reuse {@link CONFIG_SCHEMA}.
 *
 * `!!js` is resolvable by neither schema: the tag is registered on
 * `CONFIG_SCHEMA` alone, and without it js-yaml throws `unknown scalar tag`.
 * Such a document therefore reports `checked: false` rather than being misread
 * as malformed YAML — the escape a patch file full of secret references needs.
 * Throws on malformed YAML, like `load`.
 */
export function loadStructureOnly(text: string): StructureParse {
  if (text.includes('!!js')) return { checked: false }
  return { checked: true, value: load(text, { schema: FAILSAFE_SCHEMA }) }
}
