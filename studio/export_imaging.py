"""Deterministic export packaging: PNG frames, TexturePacker atlases and WebP/GIF previews.

Staged files use short relative paths so a deeply nested data root stays inside
the Windows path limit; the TypeScript host maps them to readable ZIP entries and
writes the archive itself. Only Pillow file handles need the extended prefix.
"""
import io
import json
import math
import struct

from PIL import Image

MAX_CANVAS = 16_384
MAX_PIXELS = 67_108_864
FORMATS = ('frames', 'atlas', 'webp', 'gif')


def _stem(value):
    cleaned = ''.join('_' if c in '\\/:*?"<>|%' or ord(c) < 32 else c for c in str(value))
    cleaned = cleaned.strip(' .')[:60]
    return cleaned or '动画'


def _load(value, inside, native):
    path = inside(value)
    with Image.open(native(path)) as original:
        if getattr(original, 'n_frames', 1) != 1:
            raise ValueError('导出帧必须是静态图片')
        if original.width * original.height > MAX_PIXELS:
            raise ValueError('单帧像素数超出当前上限')
        image = original.convert('RGBA')
        image.load()
    return image


def _images(params, inside, native):
    frames = params.get('frames')
    if not isinstance(frames, list) or not frames:
        raise ValueError('没有可导出的帧')
    images, decoded = [], 0
    for frame in frames:
        image = _load(frame['path'], inside, native)
        decoded += image.width * image.height
        if decoded > MAX_PIXELS:
            raise ValueError('导出解码像素总量超出当前预算，请减少帧数或尺寸')
        images.append(image)
    if len({image.size for image in images}) != 1:
        raise ValueError('导出动画的帧画布必须一致')
    durations = []
    for frame in frames:
        duration = int(frame.get('durationUs', 100_000))
        if duration < 1:
            raise ValueError('帧时长必须为正整数微秒')
        durations.append(max(1, round(duration / 1000)))
    return images, durations


def _indexed(image):
    rgba = image.convert('RGBA')
    alpha = rgba.getchannel('A')
    transparent = alpha.point(lambda value: 255 if value < 128 else 0)
    rgb = rgba.convert('RGB')
    rgb.paste((0, 0, 0), (0, 0), transparent)
    quantized = rgb.quantize(colors=255, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    indexed = quantized.point(lambda value: value + 1)
    indexed.paste(0, (0, 0), transparent)
    palette = (quantized.getpalette() or [])[:765]
    indexed.putpalette([0, 0, 0] + palette + [0] * (765 - len(palette)))
    indexed.info['transparency'] = 0
    return indexed


def _gif(images, durations, loop):
    frames = [_indexed(image) for image in images]
    ticks = [max(20, round(duration / 10) * 10) for duration in durations]
    options = {
        'format': 'GIF',
        'save_all': True,
        'append_images': frames[1:],
        'duration': ticks,
        'disposal': 2,
        'transparency': 0,
        'optimize': False,
        'interlace': False,
    }
    # GIF's finite loop value counts repeats after the first pass; an absent
    # extension means a single pass, which WebP expresses as loop=1.
    if loop == 0:
        options['loop'] = 0
    elif loop > 1:
        options['loop'] = loop - 1
    output = io.BytesIO()
    try:
        frames[0].save(output, **options)
    except struct.error as error:
        raise ValueError('GIF 帧时长超出可编码范围，请缩短单帧停留') from error
    return output.getvalue()


def _animation(path, native, name, params, step_names, durations):
    payload = {
        'schema': 'sprite-preview-v1',
        'name': name,
        'fps': params.get('fps', 12),
        'loop': bool(params.get('loop', True)),
        'steps': [
            {'frame': step, 'duration_ms': duration}
            for step, duration in zip(step_names, durations)
        ],
    }
    native(path).write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def export_clip(params, inside, native):
    """Write one animation's staged files and return their relative paths."""
    root = inside(params['outputDir'])
    native(root).mkdir(parents=True, exist_ok=True)
    name = _stem(params['name'])
    formats = [value for value in params.get('formats') or [] if value in FORMATS]
    if not formats:
        raise ValueError('请选择导出内容')
    images, durations = _images(params, inside, native)
    width, height = images[0].size

    def target(relative):
        path = root / relative
        native(path.parent).mkdir(parents=True, exist_ok=True)
        return path

    def relative(path):
        return path.relative_to(root).as_posix()

    files = {}
    if 'frames' in formats:
        files['frames'] = []
        for index, image in enumerate(images):
            path = target(f'f/{index:03d}.png')
            image.save(native(path))
            files['frames'].append(relative(path))
    if 'atlas' in formats:
        columns = max(1, min(int(params.get('columns') or 4), len(images)))
        rows = math.ceil(len(images) / columns)
        if columns * width > MAX_CANVAS or rows * height > MAX_CANVAS:
            raise ValueError('图集在单轴超过 16384 像素，请调整列数或拆分动画')
        sheet = Image.new('RGBA', (columns * width, rows * height))
        hash_frames = {}
        for index, image in enumerate(images):
            x, y = (index % columns) * width, (index // columns) * height
            sheet.alpha_composite(image, (x, y))
            hash_frames[f'{name}_{index:02d}.png'] = {
                'frame': {'x': x, 'y': y, 'w': width, 'h': height},
                'rotated': False,
                'trimmed': False,
                'spriteSourceSize': {'x': 0, 'y': 0, 'w': width, 'h': height},
                'sourceSize': {'w': width, 'h': height},
                'duration': durations[index],
            }
        png = target('a.png')
        sheet.save(native(png))
        data = target('a.json')
        native(data).write_text(
            json.dumps(
                {
                    'frames': hash_frames,
                    'meta': {
                        'app': 'sprite-studio',
                        'version': '1.0',
                        'image': f'{name}.png',
                        'format': 'RGBA8888',
                        'size': {'w': sheet.width, 'h': sheet.height},
                        'scale': '1',
                        'columns': columns,
                        'rows': rows,
                    },
                },
                ensure_ascii=False,
                indent=2,
            )
            + '\n',
            encoding='utf-8',
        )
        files['atlas'] = {'png': relative(png), 'json': relative(data)}

    steps = [f'{name}_{index:02d}.png' for index in range(len(images))]
    loop = 0 if params.get('loop', True) else 1
    if 'webp' in formats:
        path = target('w.webp')
        images[0].save(
            native(path),
            format='WEBP',
            save_all=True,
            append_images=images[1:],
            duration=durations,
            loop=loop,
            lossless=True,
            method=4,
        )
        meta = target('w.animation.json')
        _animation(meta, native, name, params, steps, durations)
        files['webp'] = {'file': relative(path), 'json': relative(meta)}
    if 'gif' in formats:
        path = target('g.gif')
        native(path).write_bytes(_gif(images, durations, loop))
        meta = target('g.animation.json')
        _animation(meta, native, name, params, steps, durations)
        files['gif'] = {'file': relative(path), 'json': relative(meta)}

    return {
        'name': name,
        'width': width,
        'height': height,
        'count': len(images),
        'durationMs': sum(durations),
        'files': files,
    }


def process(method, params, inside, native):
    if method == 'export_clip':
        return export_clip(params, inside, native)
    raise ValueError('未知导出操作')
