/**
 * Inbound image extension follows the content, not the URL.
 *
 * QQ image URLs (multimedia.nt.qq.com.cn/download?…) have no extension in
 * the path, so extForUrl falls back to '.jpg' and GIF/PNG/WebP stickers were
 * saved as media_….jpg. DSH's read_image compares content with extension
 * and refuses those files, so the model could not look at the sticker.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'

import { MediaStore, matchImageExt, sniffImageExt } from '../src/media/store.js'

const GIF = Buffer.from('474946383961010001000000002c00000000010001000002024401003b', 'hex')
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const JPEG = Buffer.from('ffd8ffe000104a464946000101', 'hex')
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x1a, 0, 0, 0]), Buffer.from('WEBPVP8 ')])

const noHash = async () => undefined

describe('sniffImageExt', () => {
  it('recognises JPEG, PNG, GIF and WebP headers', () => {
    expect(sniffImageExt(JPEG)).toBe('.jpg')
    expect(sniffImageExt(PNG)).toBe('.png')
    expect(sniffImageExt(GIF)).toBe('.gif')
    expect(sniffImageExt(WEBP)).toBe('.webp')
  })

  it('returns undefined for anything else, including short buffers', () => {
    expect(sniffImageExt(Buffer.from('not an image'))).toBeUndefined()
    expect(sniffImageExt(Buffer.alloc(0))).toBeUndefined()
    expect(sniffImageExt(Buffer.from('GIF'))).toBeUndefined()
  })
})

describe('MediaStore.resolve names inbound images after their content', () => {
  const store = () => new MediaStore(mkdtempSync(join(tmpdir(), 'onebot-ext-')), 6)

  it('a GIF sticker that would default to .jpg is saved as .gif', async () => {
    const r = await store().resolve({ kind: 'image', file: 'base64://' + GIF.toString('base64') }, noHash)
    expect(r?.path.endsWith('.gif')).toBe(true)
    expect(existsSync(r!.path)).toBe(true)
    expect(existsSync(r!.path.replace(/\.gif$/, '.jpg'))).toBe(false)
  })

  it('PNG and WebP are renamed too; a real JPEG keeps its name', async () => {
    const s = store()
    expect((await s.resolve({ kind: 'image', file: 'base64://' + PNG.toString('base64') }, noHash))?.path.endsWith('.png')).toBe(true)
    expect((await s.resolve({ kind: 'image', file: 'base64://' + WEBP.toString('base64') }, noHash))?.path.endsWith('.webp')).toBe(true)
    expect((await s.resolve({ kind: 'image', file: 'base64://' + JPEG.toString('base64') }, noHash))?.path.endsWith('.jpg')).toBe(true)
  })

  it('unknown content keeps the original name', async () => {
    const r = await store().resolve({ kind: 'image', file: 'base64://' + Buffer.from('????').toString('base64') }, noHash)
    expect(r?.path.endsWith('.jpg')).toBe(true)
  })

  it('non-image media is left alone', async () => {
    const r = await store().resolve({ kind: 'file', file: 'base64://' + GIF.toString('base64') }, noHash)
    expect(r?.path.endsWith('.bin')).toBe(true)
  })
})

describe('matchImageExt', () => {
  it('keeps .jpeg for JPEG content and keeps the path when the file is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'onebot-ext-'))
    const jpeg = join(dir, 'a.jpeg')
    writeFileSync(jpeg, JPEG)
    expect(await matchImageExt(jpeg)).toBe(jpeg)
    const missing = join(dir, 'gone.jpg')
    expect(await matchImageExt(missing)).toBe(missing)
  })
})

describe('renaming runs before shrinking', () => {
  // shrinkImage picks PNG or JPEG output from the source extension, so a PNG
  // still named .jpg would be re-encoded as JPEG.
  it('a large PNG that would default to .jpg is shrunk to a .png', async () => {
    const canvas = createCanvas(3000, 2000)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = 'rgba(74, 144, 217, 0.5)'
    ctx.fillRect(0, 0, 1500, 2000)
    const png = canvas.toBuffer('image/png')
    const s = new MediaStore(mkdtempSync(join(tmpdir(), 'onebot-ext-')), 6, 1024)
    const r = await s.resolve({ kind: 'image', file: 'base64://' + png.toString('base64') }, noHash)
    expect(r?.path.endsWith('-c1024.png')).toBe(true)
    expect(sniffImageExt(readFileSync(r!.path))).toBe('.png')
  })
})
