// 裁切右下角水印区域，并缩放到 128x128
import sharp from 'sharp'
import path from 'node:path'
import process from 'node:process'

const SRC = process.argv[2]
const DST = process.argv[3]
const SIZE = Number(process.argv[4] || 128)

if (!SRC || !DST) {
  console.error('Usage: process_icon.mjs <src.png> <dst.png> [size=128]')
  process.exit(1)
}

const meta = await sharp(SRC).metadata()
console.log('Original:', meta.width, 'x', meta.height)

// 裁切策略：
// 水印 "AI生成 WORKBUDDY" 在右下角，约占右侧 18%、底部 14%
// 保留 1024x1024 中左侧 82%、上方 86% → 约 838 x 880
// 居中正方形裁切：用 min(裁切宽, 裁切高) 作为最终尺寸，水平居中、垂直靠上
const W = meta.width, H = meta.height
const cropW = Math.floor(W * 0.82)  // 824
const cropH = Math.floor(H * 0.86)  // 880
const square = Math.min(cropW, cropH) // 824
const left = Math.floor((W - square) / 2)
const top = Math.floor((H - square) * 0.20)  // 偏上一点，水印在下

console.log('Crop:', left, top, square, 'x', square)

await sharp(SRC)
  .extract({ left, top, width: square, height: square })
  .resize(SIZE, SIZE, { kernel: sharp.kernel.lanczos3 })
  .png()
  .toFile(DST)

const dstMeta = await sharp(DST).metadata()
console.log('Saved:', DST, '→', dstMeta.width, 'x', dstMeta.height, 'format=' + dstMeta.format)