/**
 * A plugin README rendered from its own install directory.
 *
 * Images are the reason this is a component rather than a bare `<ReactMarkdown>`:
 * a README's relative `src` has to resolve against the plugin's dir on disk, which
 * the renderer reaches through a `file://` URL.
 */
import { useMemo } from 'react'
import { theme } from 'antd'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'

interface Props {
  text: string
  /** The plugin's install dir; `''` when unknown, which leaves image srcs alone. */
  dir: string
}

export default function PluginReadme({ text, dir }: Props): JSX.Element {
  const { token } = theme.useToken()
  const mdComponents = useMemo<Components>(() => ({
    a: props => <a {...props} target="_blank" rel="noreferrer" style={{ color: token.colorPrimary }} />,
    code: props => <code {...props} style={{ background: token.colorFillTertiary, padding: '1px 5px', borderRadius: 4, fontSize: '0.9em' }} />,
    pre: props => <pre {...props} style={{ background: token.colorFillTertiary, padding: token.paddingSM, borderRadius: 6, overflowX: 'auto' }} />,
    img: props => {
      const raw = props.src ?? ''
      // Only a relative src is resolved: an absolute URL or a data: URI is the
      // README's own business, and rewriting one would break it.
      const src = dir !== '' && !/^[a-z]+:/i.test(raw)
        ? `file:///${dir.replace(/\\/g, '/')}${raw.startsWith('/') ? '' : '/'}${raw}`
        : raw
      return <img {...props} src={src} style={{ maxWidth: '100%', ...(props.style as object | undefined) }} />
    },
  }), [dir, token])
  return (
    <div style={{ maxHeight: 420, overflowY: 'auto', lineHeight: 1.7 }}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, rehypeSanitize]} components={mdComponents}>{text}</ReactMarkdown>
    </div>
  )
}
