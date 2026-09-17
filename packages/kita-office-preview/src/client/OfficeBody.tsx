/**
 * kita-office-preview body.
 *
 * The preview owner has already read the file for us (`loading:
 * 'bytes-complete'` → `remote.workspaceFiles.readAll`), so this component owns
 * exactly one job: turn a byte array plus a filename suffix into DOM inside the
 * element it is handed. It never reads a file and never talks to the Host.
 *
 * Three library families are involved, each with its own container contract:
 *   .docx → docx-preview      (renderAsync, injects its own stylesheet)
 *   .xlsx → @js-preview/excel (init(host).preview(bytes), needs its CSS file)
 *   .pptx → pptx-preview      (init(host, opts).preview(ArrayBuffer))
 *
 * The legacy binary containers (.doc/.xls/.ppt) and the OpenDocument family
 * (.odt/.ods/.odp) are claimed by the registry but deliberately have no
 * renderer: no browser-side library opens them. Claiming them replaces the
 * product's generic "unsupported" placeholder with the actual reason and the
 * remedy, which is the useful answer for a user staring at the file.
 */
import * as React from 'react'

import { renderAsync as renderDocxAsync } from 'docx-preview'
import excelCss from '@js-preview/excel/lib/index.css'
import jsPreviewExcel from '@js-preview/excel'
import { init as initPptxPreview } from 'pptx-preview'

/** Document slot content as the preview owner delivers it. */
type SlotContent =
  | { readonly kind: 'bytes'; readonly data: Uint8Array }
  | { readonly kind: 'text'; readonly text: string; readonly eof: boolean }

/** Props the keyed `sidebar.right.tab.document` seat hands to a body. */
export interface OfficeBodyProps {
  /** Original resource address; its basename carries the suffix. */
  readonly resourceAddress?: string
  /** Prepared content. Only the `bytes` arm can be rendered here. */
  readonly content?: SlotContent
  /** The toolbar's wrap preference; unused by these renderers. */
  readonly wrap?: boolean
  /** Report a renderer-owned scrollport back to the owner. */
  readonly scrollportRef?: (element: HTMLElement | null) => void
}

type RenderableFamily = 'docx' | 'xlsx' | 'pptx'

const STYLE_ID = 'kita-office-preview-style'

/** The libraries' own stylesheets plus this component's layout shell. */
const SHELL_CSS = `
.kita-office-preview { position: relative; display: flex; flex-direction: column; width: 100%; height: 100%; min-height: 0; }
.kita-office-preview-host { flex: 1 1 auto; min-height: 0; overflow: auto; }
.kita-office-preview-host:empty { display: none; }
.kita-office-preview-status { flex: 0 0 auto; padding: 12px 16px; font-size: 13px; line-height: 1.6; color: var(--dsh-text-secondary, #8a8f99); }
.kita-office-preview-status[data-phase="error"] { color: var(--dsh-text-danger, #e5484d); }
.kita-office-preview-status[data-phase="error"] code { font-family: var(--dsh-font-mono, ui-monospace, monospace); }
`

const VENDOR_CSS = [excelCss]
  .filter((sheet): sheet is string => typeof sheet === 'string' && sheet.length > 0)
  .join('\n')

/**
 * Install the plugin stylesheet once per page.
 *
 * A client bundle is loaded as a classic script, so the libraries' CSS files
 * are inlined at build time and injected here rather than being linked: nothing
 * would ever fetch a sibling `.css` file.
 */
function ensureStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.setAttribute('data-plugin', 'kita-office-preview')
  style.textContent = `${VENDOR_CSS}\n${SHELL_CSS}`
  document.head.appendChild(style)
}

/**
 * Decode the suffix a resource address ends in.
 * @param address - resource address, possibly percent-encoded and with a query.
 * @returns the lowercased suffix without its dot, or an empty string.
 */
function suffixOf(address: string): string {
  let raw = address
  try {
    raw = decodeURIComponent(address)
  } catch {
    // A malformed escape sequence is not worth failing over; match on the raw text.
  }
  const withoutQuery = raw.split('?')[0] ?? raw
  const name = withoutQuery.replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/**
 * Map a suffix to a renderer family.
 * @param suffix - lowercased suffix without its dot.
 * @returns the family, or null when no browser-side library opens this format.
 */
function familyOf(suffix: string): RenderableFamily | null {
  if (suffix === 'docx' || suffix === 'docm') return 'docx'
  if (suffix === 'xlsx' || suffix === 'xlsm') return 'xlsx'
  if (suffix === 'pptx' || suffix === 'pptm') return 'pptx'
  return null
}

/**
 * Reason and remedy for a suffix this plugin claims but cannot render.
 * @param suffix - lowercased suffix without its dot.
 * @returns a user-facing explanation, or null when the suffix is renderable.
 */
function unsupportedReason(suffix: string): string | null {
  if (suffix === 'doc' || suffix === 'xls' || suffix === 'ppt') {
    return `旧版二进制格式 .${suffix} 无法在浏览器内解析（它不是 OOXML 包）。请用 Office / WPS 另存为 .${suffix}x 后再预览。`
  }
  if (suffix === 'odt' || suffix === 'ods' || suffix === 'odp') {
    return `OpenDocument 格式 .${suffix} 暂无浏览器端渲染器。请另存为 Office 格式（.docx / .xlsx / .pptx）后再预览。`
  }
  return null
}

/**
 * Copy a byte view into a standalone ArrayBuffer.
 *
 * `pptx-preview` accepts an ArrayBuffer only, and the slot's `Uint8Array` may be
 * a window over a larger buffer, so the range is copied rather than aliased.
 * @param data - bytes handed over by the preview owner.
 * @returns an ArrayBuffer holding exactly those bytes.
 */
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const { buffer, byteOffset, byteLength } = data
  if (byteOffset === 0 && byteLength === buffer.byteLength) {
    return buffer as ArrayBuffer
  }
  return buffer.slice(byteOffset, byteOffset + byteLength) as ArrayBuffer
}

/** Release whatever a renderer mounted, mirroring the library's own dispose hook. */
type Disposer = () => void

/**
 * Mount one renderer into the host element.
 * @param family - resolved renderer family.
 * @param host - element the library may fill.
 * @param bytes - complete file bytes.
 * @returns a disposer that tears the renderer down.
 */
async function mount(family: RenderableFamily, host: HTMLElement, bytes: ArrayBuffer): Promise<Disposer> {
  if (family === 'docx') {
    // docx-preview builds its own page wrappers and injects its stylesheet once;
    // it exposes no dispose hook, so teardown is clearing the mount element.
    await renderDocxAsync(bytes, host, undefined, {
      inWrapper: true,
      breakPages: true,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true,
    })
    return () => {
      host.innerHTML = ''
    }
  }

  if (family === 'xlsx') {
    const previewer = jsPreviewExcel.init(host, { showContextmenu: false })
    await previewer.preview(bytes)
    return () => previewer.destroy()
  }

  // pptx-preview lays slides out at a fixed logical width, so the element's own
  // width is measured after mount; a zero width would collapse every slide.
  const width = host.clientWidth > 0 ? host.clientWidth : 960
  const previewer = initPptxPreview(host, { width, height: 0, mode: 'list' })
  await previewer.preview(bytes)
  return () => previewer.destroy()
}

/** Extract a readable message from an unknown rejection. */
function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  if (typeof error === 'string' && error.length > 0) return error
  return '未知错误'
}

/**
 * Office preview body for the right Sidebar's document seat.
 * @param props - slot props carrying the prepared content and address.
 * @returns the status line plus the renderer mount point.
 */
export function OfficeBody(props: OfficeBodyProps) {
  const hostRef = React.useRef<HTMLDivElement | null>(null)
  const [status, setStatus] = React.useState<{ phase: 'loading' | 'ready' | 'error'; message: string }>({
    phase: 'loading',
    message: '正在解析文档…',
  })

  const address = typeof props.resourceAddress === 'string' ? props.resourceAddress : ''
  const suffix = React.useMemo(() => suffixOf(address), [address])
  const content = props.content
  const scrollportRef = props.scrollportRef

  React.useEffect(() => {
    const host = hostRef.current
    if (host === null) return undefined

    const unsupported = unsupportedReason(suffix)
    if (unsupported !== null) {
      host.innerHTML = ''
      setStatus({ phase: 'error', message: unsupported })
      return undefined
    }

    const family = familyOf(suffix)
    if (family === null) {
      host.innerHTML = ''
      setStatus({ phase: 'error', message: `没有可用于 .${suffix} 的渲染器。` })
      return undefined
    }

    if (content === undefined || content.kind !== 'bytes') {
      host.innerHTML = ''
      setStatus({ phase: 'error', message: '未能取到文件字节，预览需要完整内容。' })
      return undefined
    }

    ensureStyles()
    host.innerHTML = ''
    setStatus({ phase: 'loading', message: '正在解析文档…' })

    let disposed = false
    let dispose: Disposer | null = null

    void mount(family, host, toArrayBuffer(content.data))
      .then((teardown) => {
        if (disposed) {
          teardown()
          return
        }
        dispose = teardown
        setStatus({ phase: 'ready', message: '' })
      })
      .catch((error: unknown) => {
        if (disposed) return
        host.innerHTML = ''
        setStatus({ phase: 'error', message: `解析失败：${messageOf(error)}` })
      })

    return () => {
      disposed = true
      if (dispose !== null) {
        try {
          dispose()
        } catch {
          // A renderer that already tore itself down must not break unmount.
        }
      }
      host.innerHTML = ''
    }
  }, [content, suffix])

  React.useEffect(() => {
    if (typeof scrollportRef !== 'function') return undefined
    scrollportRef(hostRef.current)
    return () => scrollportRef(null)
  }, [scrollportRef])

  return React.createElement(
    'div',
    { className: 'kita-office-preview' },
    status.phase === 'ready'
      ? null
      : React.createElement(
          'div',
          { className: 'kita-office-preview-status', 'data-phase': status.phase },
          status.message,
        ),
    React.createElement('div', { className: 'kita-office-preview-host', ref: hostRef }),
  )
}
