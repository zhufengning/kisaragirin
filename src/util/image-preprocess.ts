import {readFileSync} from 'fs';
import sharp from 'sharp';

const MAX_SIZE_BYTES = 6 * 1024 * 1024; // 6 MB
const MAX_FRAMES = 5;
const INITIAL_QUALITY = 80;

export interface ImageFrame {
    base64: string;
    mimeType: string;
}

export interface PreprocessResult {
    frames: ImageFrame[];
    isAnimation: boolean;
    totalFrames: number;
    extractedFrames: number;
}

/**
 * 预处理图片，统一转成 jpg，大于 6MB 则压缩。
 * 动图均匀切最多 5 帧，每帧单独处理。
 */
export async function preprocessImage (inputPath: string): Promise<PreprocessResult> {
    const buf = readFileSync(inputPath);
    const meta = await sharp(buf).metadata();
    const totalFrames = meta.pages ?? 1;
    const isAnimation = totalFrames > 1;

    if (!isAnimation) {
        const compressed = await compressToLimit(buf);
        return {
            frames: [{base64: compressed.toString('base64'), mimeType: 'image/jpeg'}],
            isAnimation: false,
            totalFrames: 1,
            extractedFrames: 1
        };
    }

    // 动图：均匀取最多 5 帧
    const indices = pickFrameIndices(totalFrames, MAX_FRAMES);
    const frames: ImageFrame[] = [];

    for (const idx of indices) {
        const frameBuf = await sharp(buf, {page: idx, animated: false})
            .jpeg({quality: INITIAL_QUALITY, progressive: false})
            .toBuffer();
        const compressed = await compressToLimit(frameBuf);
        frames.push({
            base64: compressed.toString('base64'),
            mimeType: 'image/jpeg'
        });
    }

    return {
        frames,
        isAnimation: true,
        totalFrames,
        extractedFrames: frames.length
    };
}

/** 均匀选取 frame 索引 */
function pickFrameIndices (total: number, max: number): number[] {
    if (total <= max) {
        return Array.from({length: total}, (_, i) => i);
    }
    return Array.from({length: max}, (_, i) =>
        Math.round(i * (total - 1) / (max - 1)),
    );
}

/** 把图片压缩到 6MB 以下 */
async function compressToLimit (buffer: Buffer): Promise<Buffer> {
    if (buffer.length <= MAX_SIZE_BYTES) {
        return buffer;
    }

    // 先尝试降低 jpeg quality
    for (let q = 70; q >= 40; q -= 10) {
        const candidate = await sharp(buffer)
            .jpeg({quality: q, progressive: false})
            .toBuffer();
        if (candidate.length <= MAX_SIZE_BYTES) {
            return candidate;
        }
    }

    // quality 降到 40 还超，开始等比例缩小尺寸
    const meta = await sharp(buffer).metadata();
    let w = meta.width ?? 2048;
    let h = meta.height ?? 2048;
    let current = buffer;

    while (current.length > MAX_SIZE_BYTES && (w > 400 || h > 400)) {
        w = Math.round(w * 0.75);
        h = Math.round(h * 0.75);
        current = await sharp(buffer)
            .resize(w, h, {fit: 'inside', withoutEnlargement: true})
            .jpeg({quality: 40, progressive: false})
            .toBuffer();
    }

    return current;
}
