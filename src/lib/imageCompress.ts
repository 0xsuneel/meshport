// Shared by profile photos and store logos.
// Resize + compress an image client-side before upload. Keeps the longest
// edge at maxDim px and re-encodes as JPEG at the given quality - this keeps
// avatar uploads small and fast regardless of how large the original photo is.
export async function compressImage(file: File, maxDim = 512, quality = 0.85): Promise<File> {
  const objectUrl = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = reject
      el.src = objectUrl
    })

    const scale = Math.min(1, maxDim / Math.max(img.width, img.height))
    const width = Math.round(img.width * scale)
    const height = Math.round(img.height * scale)

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return file // fall back to original if canvas isn't available
    ctx.drawImage(img, 0, 0, width, height)

    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality))
    if (!blob) return file // fall back to original if encoding failed

    const baseName = file.name.replace(/\.[^.]+$/, '')
    return new File([blob], `${baseName}.jpg`, { type: 'image/jpeg' })
  } catch {
    return file // any decode error - just upload the original
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}
