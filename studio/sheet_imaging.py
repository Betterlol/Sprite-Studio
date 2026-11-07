"""Deterministic bounded sheet analysis. No models, background removal or implicit fit."""
from array import array
from hashlib import sha256
import json
import math
import struct
from PIL import Image, ImageDraw, ImageOps

ALGORITHM = 'alpha-runs-8-v1'
MAX_SOURCE = 16_777_216
MAX_RUNS = 262_144
MAX_COMPONENTS = 4096
MAX_OUTPUT = 67_108_864


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'))


def detect(image, source_hash, params):
    threshold, minimum = params['alphaThreshold'], params['minComponentPixels']
    if not 0 <= threshold <= 255 or not 1 <= minimum <= MAX_SOURCE:
        raise ValueError('无效连通域参数')
    if image.width * image.height > MAX_SOURCE:
        raise ValueError('源图像素预算超限')
    # Compact run arrays, not Python pixel objects or source-sized masks per component.
    xs, ends, ys, parents = (array('i') for _ in range(4))
    def root(i):
        while parents[i] != i:
            parents[i] = parents[parents[i]]
            i = parents[i]
        return i
    alpha = image.getchannel('A').tobytes()
    previous = []
    for y in range(image.height):
        current = []
        x = 0
        while x < image.width:
            if alpha[y * image.width + x] <= threshold:
                x += 1
                continue
            left = x
            while x < image.width and alpha[y * image.width + x] > threshold:
                x += 1
            if len(xs) >= MAX_RUNS:
                raise ValueError('连通扫描复杂度超限：最多262144个像素游程，请调整阈值或使用矩形')
            i = len(xs)
            xs.append(left); ends.append(x); ys.append(y); parents.append(i)
            current.append(i)
        # Sorted disjoint row intervals: 8-connectivity includes one-pixel diagonals.
        p = 0
        for i in current:
            while p < len(previous) and ends[previous[p]] < xs[i]:
                p += 1
            q = p
            while q < len(previous) and xs[previous[q]] <= ends[i]:
                a, b = root(i), root(previous[q])
                if a != b:
                    parents[max(a, b)] = min(a, b)
                q += 1
        previous = current
    groups = {}
    for i in range(len(xs)):
        r = root(i)
        groups.setdefault(r, []).append(i)
    components, discarded_count, discarded_pixels = [], 0, 0
    parameter_hash = sha256(canonical(params).encode()).hexdigest()
    for runs in groups.values():
        pixels = sum(ends[i] - xs[i] for i in runs)
        if pixels < minimum:
            discarded_count += 1; discarded_pixels += pixels
            continue
        if len(components) >= MAX_COMPONENTS:
            raise ValueError('连通候选超过4096，请调整过滤参数或使用矩形')
        mask = sha256()
        for i in runs:
            mask.update(struct.pack('>III', ys[i], xs[i], ends[i]))
        key = sha256(canonical([source_hash, ALGORITHM, params, mask.hexdigest()]).encode()).hexdigest()
        components.append({'key': key, 'box': [min(xs[i] for i in runs), min(ys[i] for i in runs), max(ends[i] for i in runs), max(ys[i] for i in runs)+1], 'pixelCount': pixels, '_runs': runs})
    diagnostics = []
    if not components:
        diagnostics.append({'code': 'empty', 'message': '没有保留的可见组件'})
    if discarded_count:
        diagnostics.append({'code': 'filtered', 'message': f'已丢弃{discarded_count}个组件 / {discarded_pixels}像素'})
    foreground = sum(c['pixelCount'] for c in components) + discarded_pixels
    if foreground >= image.width * image.height * 0.95:
        diagnostics.append({'code': 'suspected-background', 'message': '图片不透明或疑似全图背景；不会自动去底'})
    return components, (xs, ends, ys), {'algorithmVersion': ALGORITHM, 'parameterHash': parameter_hash, 'detection': params, 'discardedCount': discarded_count, 'discardedPixels': discarded_pixels, 'diagnostics': diagnostics}


def grid_boxes(image, grid):
    cols, rows = grid['columns'], grid['rows']
    top, right, bottom, left = grid['margin']; gx, gy = grid['spacing']
    uw = image.width-left-right-gx*(cols-1); uh = image.height-top-bottom-gy*(rows-1)
    if cols*rows > 128 or uw < cols or uh < rows:
        raise ValueError('边距、间距或网格数量使切片小于一个像素')
    return [[left+round(x*uw/cols)+x*gx, top+round(y*uh/rows)+y*gy,
             left+round((x+1)*uw/cols)+x*gx, top+round((y+1)*uh/rows)+y*gy]
            for y in range(rows) for x in range(cols)], (math.ceil(uw/cols), math.ceil(uh/rows))


def resolve(image, params, source_hash):
    version = params['recipeVersion']
    if version not in (1, 2):
        raise ValueError('需要显式recipeVersion 1或2')
    method = params['method']
    items = params['items']
    if len(items) > 128:
        raise ValueError('输出超过128帧')
    components, runs, diagnostics = [], None, []
    if method == 'grid':
        boxes, legacy_size = grid_boxes(image, params['grid'])
    elif method == 'components' and version == 2:
        if params['sourceContentHash'] != source_hash or params['algorithmVersion'] != ALGORITHM:
            raise ValueError('STALE_ANALYSIS：源内容或算法已变化，请重新检测')
        components, runs, analysis = detect(image, source_hash, params['detection'])
        diagnostics.extend(analysis['diagnostics'])
    elif method != 'boxes' or version != 2:
        raise ValueError('无效切割方法')
    by_key = {c['key']: c for c in components}
    used, resolved, active = set(), [], []
    for index, item in enumerate(items):
        selected = []
        if method == 'grid':
            x, y = item['cell']
            if not 0 <= x < params['grid']['columns'] or not 0 <= y < params['grid']['rows']:
                raise ValueError('切片单元超出网格')
            box = boxes[y*params['grid']['columns']+x]
        elif method == 'boxes':
            box = item['box']
        else:
            for key in item['componentKeys']:
                if key not in by_key:
                    raise ValueError('STALE_ANALYSIS：组件key不存在，请重新检测并显式分组')
                selected.append(by_key[key])
                if item['enabled']:
                    used.add(key)
            box = [min(c['box'][0] for c in selected), min(c['box'][1] for c in selected), max(c['box'][2] for c in selected), max(c['box'][3] for c in selected)]
        l, t, r, b = box
        if not (0 <= l < r <= image.width and 0 <= t < b <= image.height):
            raise ValueError('矩形超出原图或为空')
        resolved.append({'index': index, 'box': box, 'name': item['name'], 'enabled': item['enabled']})
        if item['enabled']:
            active.append((index, item, box, selected))
    if method == 'components' and len(used) < len(components):
        diagnostics.append({'code': 'unassigned', 'message': f'{len(components)-len(used)}个组件未分配到启用条目'})
    if not active:
        diagnostics.append({'code': 'empty-selection', 'message': '没有启用的切片'})
    if params.get('expectedFrames') and params['expectedFrames'] != len(active):
        diagnostics.append({'code': 'frame-count', 'message': f'期望{params["expectedFrames"]}帧，实际{len(active)}帧；不会补帧或硬拆'})
    if version == 1:
        width, height = legacy_size; scale, alignment = 1, 'top-left'
    else:
        output = params['output']; width, height = output['width'], output['height']
        scale, alignment = output['scale'], output['alignment']
    if (version == 2 and (not 1 <= width <= 4096 or not 1 <= height <= 4096)) or not .05 <= scale <= 4 or width*height*len(active) > MAX_OUTPUT:
        raise ValueError('输出画布或总解码像素预算超限')
    frames = []
    for index, item, box, selected in active:
        w, h = box[2]-box[0], box[3]-box[1]
        sw, sh = max(1, math.floor(w*scale+.5)), max(1, math.floor(h*scale+.5))
        if sw*sh > MAX_SOURCE:
            raise ValueError('缩放中间画布像素预算超限')
        x = 0 if version == 1 else (width-sw)//2
        y = 0 if version == 1 else height-sh if alignment == 'bottom-center' else (height-sh)//2
        overflow = {'left': max(0, -x), 'top': max(0, -y), 'right': max(0, x+sw-width), 'bottom': max(0, y+sh-height)}
        frames.append({'index': index, 'name': item['name'], 'box': box, 'scaledSize': [sw, sh], 'offset': [x, y], 'overflow': overflow, 'blocking': any(overflow.values()), '_selected': selected})
    suggestion = {'width': max((f['scaledSize'][0] for f in frames), default=1), 'height': max((f['scaledSize'][1] for f in frames), default=1)}
    return frames, runs, {'width': width, 'height': height, 'rectangles': resolved, 'diagnostics': diagnostics, 'suggestedOutput': suggestion, 'total': len(active)}


def render_frame(image, frame, runs, size):
    l, t, r, b = frame['box']
    if runs is None:
        crop = image.crop((l, t, r, b))
    else:
        crop = Image.new('RGBA', (r-l, b-t))
        xs, ends, ys = runs
        for component in frame['_selected']:
            for i in component['_runs']:
                crop.paste(image.crop((xs[i], ys[i], ends[i], ys[i]+1)), (xs[i]-l, ys[i]-t))
    if tuple(frame['scaledSize']) != crop.size:
        crop = crop.resize(tuple(frame['scaledSize']), Image.Resampling.NEAREST)
    canvas = Image.new('RGBA', size)
    # paste (no mask) preserves RGBA bytes including partially transparent selected pixels.
    canvas.paste(crop, tuple(frame['offset']))
    return canvas


def process(method, image, params, folder, native, source_hash):
    if method == 'sheet_detect':
        components, _, info = detect(image, source_hash, params['detection'])
        offset, limit = params['offset'], params['limit']
        page = components[offset:offset+limit]
        info.update({'total': len(components), 'offset': offset, 'limit': limit, 'candidates': [{k:v for k,v in c.items() if k != '_runs'} for c in page], 'allKeys': [c['key'] for c in components]})
        overlay = ImageOps.contain(image, (1024, 1024), Image.Resampling.NEAREST).copy()
        draw = ImageDraw.Draw(overlay)
        for c in page:
            l,t,r,b = c['box']; sx,sy = overlay.width/image.width, overlay.height/image.height
            draw.rectangle((l*sx,t*sy,max(l*sx,(r-1)*sx),max(t*sy,(b-1)*sy)), outline='#37bcb0', width=1)
        target = folder/'overlay.png'; overlay.save(native(target)); info['files'] = [str(target)]
        return info
    frames, runs, info = resolve(image, params, source_hash)
    if method == 'recipe_slice':
        if any(f['blocking'] for f in frames):
            raise ValueError('画布溢出：请显式修改统一画布或scale；不会自动缩小或裁切')
        if not frames:
            raise ValueError('请先选择要切割的条目')
        if any(d['code'] == 'frame-count' for d in info['diagnostics']):
            raise ValueError('期望帧数不符，请修正配方；不会补帧或硬拆')
        files = []
        for i, frame in enumerate(frames):
            target = folder/f'{i:03}.png'
            render_frame(image, frame, runs, (info['width'], info['height'])).save(native(target))
            files.append(str(target))
        return {**info, 'files': files, 'itemIndexes': [f['index'] for f in frames]}
    start, limit = params['start'], params['limit']
    batch = frames[start:start+limit]
    contact = Image.new('RGB', (min(max(1,len(batch)),4)*180, max(1,math.ceil(len(batch)/4))*210), '#182127')
    draw = ImageDraw.Draw(contact)
    for i, f in enumerate(batch):
        # Draw in a small evidence viewport of the UNION, so overflow pixels stay
        # visible beyond the outlined output canvas. Never allocate that large union.
        xoff, yoff = f['offset']; sw, sh = f['scaledSize']
        l, t = min(0,xoff), min(0,yoff)
        r, b = max(info['width'],xoff+sw), max(info['height'],yoff+sh)
        factor = min(160/(r-l),160/(b-t))
        tile = Image.new('RGBA', (160,160), '#35454c')
        tw, th = max(1,math.floor((r-l)*factor)), max(1,math.floor((b-t)*factor))
        ox, oy = (160-tw)//2, (160-th)//2
        # Render the selected crop on its own bounded scaled-size canvas, not a
        # clipped output canvas, then fit ONLY the static evidence thumbnail.
        isolated = {**f, 'offset': [0,0]}
        crop = render_frame(image, isolated, runs, (sw,sh))
        small = crop.resize((max(1,math.floor(sw*factor)),max(1,math.floor(sh*factor))),Image.Resampling.NEAREST)
        tile.alpha_composite(small,(ox+math.floor((xoff-l)*factor),oy+math.floor((yoff-t)*factor)))
        ImageDraw.Draw(tile).rectangle((ox+math.floor(-l*factor),oy+math.floor(-t*factor),ox+min(159,math.floor((info['width']-l)*factor)),oy+min(159,math.floor((info['height']-t)*factor))),outline='#ff786b' if f['blocking'] else '#37bcb0',width=1)
        x,y = (i%4)*180+10,(i//4)*210+25
        contact.paste(tile.convert('RGB'),(x,y))
        draw.text((x,y-18), f'#{start+i+1} item {f["index"]+1}', fill='white')
        draw.text((x,y+164), 'OVERFLOW' if f['blocking'] else f'{info["width"]} x {info["height"]}', fill='#ff786b' if f['blocking'] else 'white')
    target = folder/'contact.png'; contact.save(native(target))
    return {**info, 'frames': [{k:v for k,v in f.items() if k != '_selected'} for f in batch], 'start': start, 'end': start+len(batch), 'limit': limit, 'files': [str(target)], 'blocking': any(f['blocking'] for f in frames)}
