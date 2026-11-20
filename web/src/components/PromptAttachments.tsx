import { useEffect, useState } from 'react'

function FilePreview({ file }: { file: File }) {
  const [preview, setPreview] = useState<{ file: File; url: string }>()
  useEffect(() => {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return
    const url = URL.createObjectURL(file)
    setPreview({ file, url })
    return () => URL.revokeObjectURL(url)
  }, [file])
  return preview?.file === file ? <img src={preview.url} alt={`Preview of ${file.name}`} className="h-12 w-12 object-contain rounded" /> : null
}

export function PromptAttachments({ files, disabled, onAdd, onRemove }: {
  files: File[]
  disabled: boolean
  onAdd: (files: File[]) => void
  onRemove: (index: number) => void
}) {
  return <div className="mt-2 space-y-2">
    <label className={`inline-flex items-center rounded-lg border border-gray-600 px-3 py-1.5 text-xs ${disabled ? 'opacity-50' : 'cursor-pointer hover:bg-gray-700'}`}>
      Attach files
      <input type="file" multiple disabled={disabled} className="sr-only" aria-label="Attach files to first prompt" onChange={event => {
        onAdd(Array.from(event.target.files || []))
        event.target.value = ''
      }} />
    </label>
    <span className="ml-2 text-[11px] text-gray-500">Drop files or paste images · 4 files, 10 MiB each</span>
    {files.length > 0 && <ul aria-label="Prompt attachments" className="space-y-1">
      {files.map((file, index) => <li key={`${file.name}:${file.lastModified}:${index}`} className="flex items-center gap-2 rounded bg-gray-900 px-2 py-1.5 text-xs">
        <FilePreview file={file} />
        <span className="min-w-0 flex-1 break-all">{file.name}<span className="block text-gray-500">{file.type || 'file'} · {(file.size / 1024).toFixed(1)} KiB</span></span>
        <button type="button" disabled={disabled} aria-label={`Remove attachment ${file.name}`} className="text-gray-400 hover:text-red-300 disabled:opacity-50" onClick={() => onRemove(index)}>Remove</button>
      </li>)}
    </ul>}
    <p className="text-[11px] text-gray-500">Original files go to the chosen agent, not to Jev classification. Reading documents depends on the agent’s tools; files are not executed.</p>
  </div>
}
