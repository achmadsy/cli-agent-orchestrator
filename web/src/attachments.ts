import type { AutoSessionRequest } from './api'

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
export const MAX_ATTACHMENTS = 4

export function validateAttachments(files: File[]): string | null {
  if (files.length > MAX_ATTACHMENTS) return 'Attach up to four files.'
  for (const file of files) {
    if (!file.size || file.size > MAX_ATTACHMENT_BYTES) return 'Each file must be nonempty and up to 10 MiB.'
    if (!file.name || new TextEncoder().encode(file.name).length > 255 || /[/\\\x00-\x1f\x7f-\x9f]/.test(file.name) || ['.', '..'].includes(file.name)) return 'Use plain filenames without paths or control characters.'
    if (file.type.startsWith('image/') && !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return 'Images must be PNG, JPEG or WebP.'
  }
  return null
}

export async function encodeAttachments(files: File[]): Promise<NonNullable<AutoSessionRequest['attachments']>> {
  const error = validateAttachments(files)
  if (error) throw new Error(error)
  const result: NonNullable<AutoSessionRequest['attachments']> = []
  for (const file of files) {
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => reject(new Error('Could not read an attachment. Try selecting it again.'))
      reader.onload = () => resolve(String(reader.result).split(',')[1])
      reader.readAsDataURL(file)
    })
    result.push({ filename: file.name, content_type: file.type || 'application/octet-stream', data_base64: data })
  }
  return result
}
