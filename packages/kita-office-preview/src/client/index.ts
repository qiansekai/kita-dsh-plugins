/**
 * kita-office-preview, browser half.
 *
 * Registers one extensible document renderer into the official right-Sidebar
 * preview registry (`ctx.documentPreviews`), covering the Office container
 * suffixes the product deliberately leaves unclaimed.
 *
 * Why this is an extension and not a patch: the product's own candidate
 * resolution is
 *
 *   const matched = matchingDocumentPreviews(definitions, path)
 *   if (matched.length > 0 && binaryDocumentPath(definitions, path)) return matched
 *   if (matched.length === 0 && unviewable) return matched          // unsupported empty state
 *   ...plain-text fallback
 *
 * `doc/docx/xls/xlsx/ppt/pptx/odt/ods/odp` sit in the product's
 * UNVIEWABLE_BINARY_EXTENSIONS list, so with no matching implementation they
 * render an "unsupported" placeholder and the file is never even read.
 * Declaring the same suffixes here *and* listing them in `binaryExtensions`
 * makes both guards true, so these files resolve to this renderer with no
 * change to the shipped package.
 *
 * Content delivery is the owner's business: `loading: 'bytes-complete'` makes
 * the preview read the whole file through `remote.workspaceFiles.readAll`
 * (Host `maxFileBytes` applies) and hand the body a `{ kind: 'bytes' }`
 * content. This plugin never reads files itself.
 */
import * as React from 'react'

import { OfficeBody } from './OfficeBody.tsx'

/** Services this plugin needs before it can apply. */
export const inject = ['slots', 'documentPreviews']

/** Implementation id; also the keyed body slot key. */
const PREVIEW_ID = 'kita-office-preview'

/**
 * Every container suffix this renderer claims.
 *
 * The macro-enabled OOXML variants render through the same readers. The legacy
 * binary formats (.doc/.xls/.ppt) and the OpenDocument family (.odt/.ods/.odp)
 * are claimed on purpose even though nothing can render them: without a claim
 * they would show the product's generic "unsupported" placeholder, while the
 * body can state the actual reason and remedy.
 */
const EXTENSIONS = [
  'docx',
  'docm',
  'xlsx',
  'xlsm',
  'pptx',
  'pptm',
  'doc',
  'xls',
  'ppt',
  'odt',
  'ods',
  'odp',
] as const

/**
 * Register the renderer metadata and its body.
 * @param ctx - client root context carrying the slot and preview registries.
 */
function apply(ctx) {
  ctx.effect(() =>
    ctx.documentPreviews.register({
      id: PREVIEW_ID,
      extensions: [...EXTENSIONS],
      // Every declared suffix is a binary container: the file must never fall
      // back to the plain-text reader, which would show zip bytes.
      binaryExtensions: [...EXTENSIONS],
      // External implementations outrank the product's `builtin` band.
      priority: 'extension',
      title: () => 'Office 预览',
      loading: 'bytes-complete',
      wrap: false,
    }),
  )

  ctx.effect(() =>
    ctx.slots.inject('sidebar.right.tab.document', () =>
      ctx.slots.register(
        {
          name: 'sidebar.right.tab.document',
          key: PREVIEW_ID,
        },
        OfficeBody,
      ),
    ),
  )
}

export { apply }
export { OfficeBody }
export { React }
