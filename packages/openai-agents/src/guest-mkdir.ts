/** Creates parent directories for a guest file path (best-effort). */
export async function mkdirpGuest(
  fs: { mkdir(path: string): Promise<void> },
  filePath: string,
) {
  const parts = filePath.split('/').filter(Boolean)
  if (parts.length <= 1) return
  let cur = ''
  for (let i = 0; i < parts.length - 1; i++) {
    cur += `/${parts[i]}`
    await fs.mkdir(cur).catch(() => {})
  }
}
