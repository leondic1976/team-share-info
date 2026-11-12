import sanitizeHtml from 'sanitize-html'

/** Allow-list sanitizer for rich text from the editor (13.6). */
export function cleanHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'code', 'pre', 'blockquote', 'hr',
      'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'label', 'input', 'div', 'span', 'mark',
      'table', 'thead', 'tbody', 'tr', 'th', 'td', 'colgroup', 'col', 'a', 'img'
    ],
    allowedAttributes: {
      a: ['href', 'target', 'rel'],
      img: ['src', 'alt', 'width', 'height'],
      input: ['type', 'checked', 'disabled'],
      li: ['data-type', 'data-checked'],
      ul: ['data-type'],
      td: ['colspan', 'rowspan', 'colwidth'],
      th: ['colspan', 'rowspan', 'colwidth'],
      col: ['style'],
      span: ['data-type', 'data-id', 'data-label'],
      '*': []
    },
    allowedSchemes: ['http', 'https', 'mailto', 'data'],
    allowedSchemesByTag: { img: ['data', 'http', 'https'] },
    allowedStyles: { col: { 'min-width': [/^\d+px$/], width: [/^\d+px$/] } },
    transformTags: { a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }) }
  })
}

export function htmlToText(html: string): string {
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} }).replace(/\s+/g, ' ').trim()
}
