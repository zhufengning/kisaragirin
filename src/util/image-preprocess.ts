import {readFileSync} from 'fs';
import sharp from 'sharp';

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

export interface ImagePreprocessOptions {
    /** 压缩后的最大字节数，超过则降低压缩质量并缩小尺寸 */
    maxSizeBytes: number;
    /** 动图最多抽取的帧数 */
    maxFrames: number;
    /** 动图抽帧与长边缩放时使用的 jpeg 质量 */
    initialQuality: number;
    /** 长边像素上限，超过则按比例缩小，0 表示不限制 */
    maxLongEdge: number;
    /** 总像素（宽乘高）上限，超过则按比例缩小，0 表示不限制 */
    maxTotalPixels: number;
}

const MIME_BY_FORMAT: Record<string, string> = {
    avif: 'image/avif',
    bmp: 'image/bmp',
    gif: 'image/gif',
    heif: 'image/heif',
    jpeg: 'image/jpeg',
    png: 'image/png',
    svg: 'image/svg+xml',
    tiff: 'image/tiff',
    webp: 'image/webp'
};

/**
 * 预处理图片：长边或总像素超过上限时按比例缩小，字节数超过上限时压缩（缩放与压缩后均为 jpg）。
 * 未超过任何上限的图片保持原有格式。
 * 动图均匀切最多 maxFrames 帧，每帧单独处理。
 */
export async function preprocessImage (inputPath: string, options: ImagePreprocessOptions): Promise<PreprocessResult> {
    const buf = readFileSync(inputPath);
    const meta = await sharp(buf).metadata();
    const totalFrames = meta.pages ?? 1;
    const isAnimation = totalFrames > 1;

    if (!isAnimation) {
        const limited = await limitSize(buf, options);
        const compressed = await compressToLimit(limited, options);
        return {
            frames: [await toFrame(compressed)],
            isAnimation: false,
            totalFrames: 1,
            extractedFrames: 1
        };
    }

    // 动图：均匀取最多 maxFrames 帧
    const indices = pickFrameIndices(totalFrames, options.maxFrames);
    const frames: ImageFrame[] = [];

    for (const idx of indices) {
        const frameBuf = await sharp(buf, {page: idx, animated: false})
            .jpeg({quality: options.initialQuality, progressive: false})
            .toBuffer();
        const limited = await limitSize(frameBuf, options);
        const compressed = await compressToLimit(limited, options);
        frames.push(await toFrame(compressed));
    }

    return {
        frames,
        isAnimation: true,
        totalFrames,
        extractedFrames: frames.length
    };
}

/** 按字节的实际格式生成发送给 vision 模型的帧 */
async function toFrame (buffer: Buffer): Promise<ImageFrame> {
    const format = (await sharp(buffer).metadata()).format;
    const mimeType = format ? MIME_BY_FORMAT[format] : undefined;
    if (!mimeType) {
        throw new Error(`Unsupported image format: ${format ?? 'unknown'}`);
    }
    return {base64: buffer.toString('base64'), mimeType};
}

/** 长边或总像素超过上限时按比例缩小；上限为 0 表示不限制 */
async function limitSize (buffer: Buffer, options: ImagePreprocessOptions): Promise<Buffer> {
    const meta = await sharp(buffer).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    const target = targetSize(width, height, options);
    if (target.width === width && target.height === height) {
        return buffer;
    }

    return sharp(buffer)
        .resize({width: target.width, height: target.height, fit: 'inside', withoutEnlargement: true})
        .jpeg({quality: options.initialQuality, progressive: false})
        .toBuffer();
}

/** 按长边上限与总像素上限计算缩放后的尺寸 */
function targetSize (width: number, height: number, options: ImagePreprocessOptions): {width: number; height: number} {
    const longEdge = Math.max(width, height);
    const totalPixels = width * height;
    let scale = 1;
    if (options.maxLongEdge > 0 && longEdge > options.maxLongEdge) {
        scale = options.maxLongEdge / longEdge;
    }
    if (options.maxTotalPixels > 0 && totalPixels * scale * scale > options.maxTotalPixels) {
        scale = Math.sqrt(options.maxTotalPixels / totalPixels);
    }
    if (scale >= 1) {
        return {width, height};
    }
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale))
    };
}

/** 均匀选取 frame 索引 */
function pickFrameIndices (total: number, max: number): number[] {
    if (total <= 1 || max <= 1) {
        return [0];
    }
    if (total <= max) {
        return Array.from({length: total}, (_, i) => i);
    }
    return Array.from({length: max}, (_, i) =>
        Math.round(i * (total - 1) / (max - 1)),
    );
}

/** 把图片压缩到大小上限以下 */
async function compressToLimit (buffer: Buffer, options: ImagePreprocessOptions): Promise<Buffer> {
    const maxSizeBytes = options.maxSizeBytes;
    if (buffer.length <= maxSizeBytes) {
        return buffer;
    }

    // 先尝试降低压缩质量
    for (let q = 70; q >= 40; q -= 10) {
        const candidate = await sharp(buffer)
            .jpeg({quality: q, progressive: false})
            .toBuffer();
        if (candidate.length <= maxSizeBytes) {
            return candidate;
        }
    }

    // 质量降到 40 还超，开始等比例缩小尺寸
    const meta = await sharp(buffer).metadata();
    let w = meta.width ?? 2048;
    let h = meta.height ?? 2048;
    let current = buffer;

    while (current.length > maxSizeBytes && (w > 400 || h > 400)) {
        w = Math.round(w * 0.75);
        h = Math.round(h * 0.75);
        current = await sharp(buffer)
            .resize(w, h, {fit: 'inside', withoutEnlargement: true})
            .jpeg({quality: 40, progressive: false})
            .toBuffer();
    }

    return current;
}
