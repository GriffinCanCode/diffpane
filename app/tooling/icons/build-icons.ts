import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const desktop = path.join(root, 'branding/desktop')
const master = path.join(desktop, 'diffpane.png')
const images = path.join(root, 'branding/public/img')
const favicons = path.join(images, 'favicons')
const faviconSizes = [16, 32, 48]
const temporary = await mkdtemp(path.join(os.tmpdir(), 'diffpane-icons-'))
function resize(size: number, output: string) {
  execFileSync('sips', ['-z', String(size), String(size), master, '--out', output], {
    stdio: 'ignore',
  })
}

try {
  await mkdir(favicons, { recursive: true })
  for (const size of faviconSizes) resize(size, path.join(favicons, `favicon-${size}.png`))
  resize(180, path.join(images, 'apple-touch-icon.png'))
  resize(512, path.join(images, 'diffpane.png'))

  // ICO directory entries point to PNG images, preserving their alpha channel.
  const pngs = await Promise.all(faviconSizes.map(size => readFile(path.join(favicons, `favicon-${size}.png`))))
  const header = Buffer.alloc(6 + faviconSizes.length * 16)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(faviconSizes.length, 4)
  let offset = header.length
  for (const [index, size] of faviconSizes.entries()) {
    const png = pngs[index]
    if (!png) throw new Error(`Missing ${size}px favicon data`)
    const entry = 6 + index * 16
    header[entry] = header[entry + 1] = size
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(png.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += png.length
  }
  await writeFile(path.join(favicons, 'favicon.ico'), Buffer.concat([header, ...pngs]))

  const iconset = path.join(temporary, 'Diffpane.iconset')
  await mkdir(iconset)
  for (const size of [16, 32, 128, 256, 512]) {
    resize(size, path.join(iconset, `icon_${size}x${size}.png`))
    resize(size * 2, path.join(iconset, `icon_${size}x${size}@2x.png`))
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(desktop, 'diffpane.icns')])
  console.info('Built browser favicons and macOS app icon from branding/desktop/diffpane.png.')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
