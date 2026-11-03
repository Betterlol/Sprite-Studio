"""Bounded image operations. The TypeScript host owns project writes."""
from pathlib import Path
from PIL import Image, ImageOps
import sys, json, math

ROOT = Path(sys.argv[1]).resolve()
Image.MAX_IMAGE_PIXELS = 16_777_216

def inside(value):
    p = Path(value)
    resolved = p.resolve()
    if not resolved.is_relative_to(ROOT) or resolved != p.absolute():
        raise ValueError('图像路径必须在工作台数据目录内，且不能是链接')
    return resolved

def image_at(value):
    path = inside(value)
    with Image.open(path) as original:
        if original.width * original.height > Image.MAX_IMAGE_PIXELS:
            raise ValueError('图片像素数超出当前上限')
        frame_count = getattr(original, 'n_frames', 1)
        image = ImageOps.exif_transpose(original).convert('RGBA')
        image.load()
    return image, frame_count

def run(method, params):
    image, count = image_at(params['path'])
    if method == 'inspect':
        return {'width': image.width, 'height': image.height, 'frameCount': count}
    folder = inside(params['outputDir'])
    folder.mkdir(parents=True, exist_ok=True)
    if method == 'slice':
        if count != 1: raise ValueError('目前仅支持切割静态图集')
        cols, rows = params['columns'], params['rows']
        if not isinstance(cols, int) or not isinstance(rows, int) or not 1 <= cols <= 32 or not 1 <= rows <= 32 or cols*rows > 128:
            raise ValueError('无效网格，最多 128 帧')
        if cols > image.width or rows > image.height: raise ValueError('切片不能小于一个像素')
        result = []
        for y in range(rows):
            for x in range(cols):
                box = (round(x*image.width/cols), round(y*image.height/rows), round((x+1)*image.width/cols), round((y+1)*image.height/rows))
                target = folder / f'{len(result):03}.png'
                frame = Image.new('RGBA', (math.ceil(image.width/cols), math.ceil(image.height/rows)))
                frame.alpha_composite(image.crop(box))
                frame.save(target)
                result.append(str(target))
        return {'files': result}
    if method == 'transform':
        if count != 1: raise ValueError('目前仅对静态帧生成调整候选')
        spec = params['transform']
        scale = float(spec.get('scale', 1))
        width, height = int(spec.get('width', image.width)), int(spec.get('height', image.height))
        if not 0.05 <= scale <= 4 or not 1 <= width <= 4096 or not 1 <= height <= 4096: raise ValueError('调整参数超出范围')
        size = (max(1, round(image.width*scale)), max(1, round(image.height*scale)))
        if size[0]*size[1] > Image.MAX_IMAGE_PIXELS: raise ValueError('缩放后的图片太大')
        resized = image.resize(size, Image.Resampling.LANCZOS)
        x, y = round((width-size[0])/2+spec.get('offsetX', 0)), round((height-size[1])/2+spec.get('offsetY', 0))
        bounds = resized.getbbox()
        if bounds and not spec.get('clip', False) and (x+bounds[0] < 0 or y+bounds[1] < 0 or x+bounds[2] > width or y+bounds[3] > height):
            raise ValueError('可见内容超出画布，请减小偏移、缩放，或勾选允许裁切')
        canvas = Image.new('RGBA', (width, height))
        canvas.alpha_composite(resized, (x, y))
        target = folder / 'adjusted.png'
        canvas.save(target)
        return {'files': [str(target)]}
    if method == 'export':
        frames = params['frames']
        images = []
        pixels = 0
        for frame in frames:
            current, count = image_at(frame['path'])
            if count != 1: raise ValueError('动画帧必须是静态图片')
            pixels += current.width * current.height
            if pixels > 67_108_864: raise ValueError('动画解码像素总量超出当前导出预算，请减少帧数或尺寸')
            images.append(current)
        if len({im.size for im in images}) != 1: raise ValueError('导出动画的帧画布必须一致')
        durations = [max(1, round(frame['durationUs']/1000)) for frame in frames]
        target = folder / 'animation.webp'
        images[0].save(target, format='WEBP', save_all=True, append_images=images[1:], duration=durations, loop=0 if params.get('loop') else 1, lossless=True)
        return {'files': [str(target)], 'durationMs': sum(durations)}
    raise ValueError('未知图像操作')

for line in sys.stdin:
    request = None
    try:
        request = json.loads(line)
        result = run(request['method'], request['params'])
        print(json.dumps({'id': request['id'], 'result': result}), flush=True)
    except Exception as error:
        print(json.dumps({'id': request.get('id') if request else None, 'error': str(error)}, ensure_ascii=False), flush=True)
