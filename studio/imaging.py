"""Bounded image operations. The TypeScript host owns project writes."""
from pathlib import Path
from PIL import Image, ImageOps, ImageDraw, ImageFont
import sys, json, math

ROOT = Path(sys.argv[1]).resolve()
Image.MAX_IMAGE_PIXELS = 16_777_216
VISIBLE_ALPHA_THRESHOLD = 16

def native(path):
    # Pillow needs an extended Windows path when the data root is deeply nested.
    # Keep protocol paths ordinary so the TypeScript host can resolve them normally.
    return Path('//?/' + str(path).replace(chr(92), '/')) if sys.platform == 'win32' else path

def inside(value):
    p = Path(value)
    resolved = p.resolve()
    if not resolved.is_relative_to(ROOT) or resolved != p.absolute():
        raise ValueError('图像路径必须在工作台数据目录内，且不能是链接')
    return resolved

def image_at(value):
    path = inside(value)
    with Image.open(native(path)) as original:
        if original.width * original.height > Image.MAX_IMAGE_PIXELS:
            raise ValueError('图片像素数超出当前上限')
        frame_count = getattr(original, 'n_frames', 1)
        image = ImageOps.exif_transpose(original).convert('RGBA')
        image.load()
    return image, frame_count

def review_images(params, folder):
    frames, start, end = params['frames'], params['start'], params['end']
    if not 0 <= start <= end < len(frames) or end-start+1 > 16: raise ValueError('检查区间最多 16 帧')
    try: font = ImageFont.truetype('C:/Windows/Fonts/arial.ttf', 13)
    except OSError: font = ImageFont.load_default()
    def board():
        result = Image.new('RGBA', (160,160), '#20292e')
        draw = ImageDraw.Draw(result)
        for y in range(0,160,10):
            for x in range(0,160,10):
                if (x//10+y//10)%2: draw.rectangle((x,y,x+9,y+9),fill='#2e3a40')
        return result
    def thumb(image): return ImageOps.contain(image,(160,160),Image.Resampling.NEAREST)
    def place(canvas, image, index, text, detail):
        x,y=(index%4)*180+10,(index//4)*206+30
        tile=board(); small=thumb(image); tile.alpha_composite(small,((160-small.width)//2,(160-small.height)//2)); canvas.paste(tile.convert('RGB'),(x,y))
        draw=ImageDraw.Draw(canvas);draw.text((x,y-22),text,font=font,fill='#d2e6df');draw.text((x,y+165),detail,font=font,fill='#9eb3b7')
    count=end-start+1
    contact=Image.new('RGB',(min(count,4)*180,math.ceil(count/4)*206),'#141c21')
    observations=[]
    for index in range(start,end+1):
        frame=frames[index];image,n=image_at(frame['path'])
        if n!=1: raise ValueError('检查动画帧需要静态图片')
        bbox=image.getchannel('A').point(lambda value:255 if value>VISIBLE_ALPHA_THRESHOLD else 0).getbbox()
        observations.append({'frameId':frame['id'],'index':index,'durationUs':frame['durationUs'],'bbox':bbox,'center':[(bbox[0]+bbox[2])/2,(bbox[1]+bbox[3])/2] if bbox else None,'width':bbox[2]-bbox[0] if bbox else 0,'height':bbox[3]-bbox[1] if bbox else 0})
        place(contact,image,index-start,f'#{index+1}  {frame["durationUs"]/1000:g} ms',f'bounds {observations[-1]["width"]} x {observations[-1]["height"]}')
    pairs=[]
    if start>0: pairs.append((start-1,start,False))
    pairs.extend((index,index+1,False) for index in range(start,end))
    if end<len(frames)-1:pairs.append((end,end+1,False))
    if params['loop']:pairs.append((len(frames)-1,0,True))
    onion=Image.new('RGB',(min(max(len(pairs),1),4)*180,math.ceil(max(len(pairs),1)/4)*206),'#141c21')
    for i,(left,right,loop) in enumerate(pairs):
        previous,_=image_at(frames[left]['path']); current,_=image_at(frames[right]['path'])
        if previous.size!=current.size:raise ValueError('动画画布不一致')
        overlay=Image.new('RGBA',previous.size)
        for source,color,alpha in [(previous,(239,107,96),0.55),(current,(92,211,199),0.7)]:
            tint=Image.new('RGBA',source.size,(*color,0));tint.putalpha(source.getchannel('A').point(lambda value:round(value*alpha)));overlay.alpha_composite(tint)
        place(onion,overlay,i,f'#{left+1} > #{right+1}'+(' LOOP' if loop else ''),'red: previous / cyan: next')
    contact_path=folder/'contact.png';onion_path=folder/'onion.png';contact.save(native(contact_path));onion.save(native(onion_path))
    return {'contact':str(contact_path),'onion':str(onion_path),'frames':observations,'pairs':[{'from':left,'to':right,'loopBoundary':loop} for left,right,loop in pairs]}

def run(method, params):
    image, count = image_at(params['path'])
    if method == 'inspect':
        return {'width': image.width, 'height': image.height, 'frameCount': count}
    folder = inside(params['outputDir'])
    native(folder).mkdir(parents=True, exist_ok=True)
    if method == 'review': return review_images(params, folder)
    if method in ('region_generate', 'region_resolve', 'region_preview') or (method == 'recipe_slice' and params.get('recipeVersion') == 3):
        if count != 1: raise ValueError('切割来源必须是静态图片')
        from region_imaging import process
        from hashlib import sha256
        source_hash = sha256(native(inside(params['path'])).read_bytes()).hexdigest()
        return process(method, image, params, folder, native, inside, source_hash)
    if method in ('sheet_detect', 'sheet_preview') or (method == 'recipe_slice' and params.get('recipeVersion') == 2):
        if count != 1: raise ValueError('切割来源必须是静态图片')
        from sheet_imaging import process
        from hashlib import sha256
        source_hash = sha256(native(inside(params['path'])).read_bytes()).hexdigest()
        return process(method, image, params, folder, native, source_hash)
    if method == 'recipe_slice':
        if params.get('recipeVersion') != 1: raise ValueError('需要显式recipeVersion')
        if count != 1: raise ValueError('切割来源必须是静态图片')
        grid=params['grid']; cols,rows=grid['columns'],grid['rows']
        top,right,bottom,left=grid['margin']; gap_x,gap_y=grid['spacing']
        usable_w=image.width-left-right-gap_x*(cols-1)
        usable_h=image.height-top-bottom-gap_y*(rows-1)
        if usable_w<cols or usable_h<rows: raise ValueError('切片不能小于一个像素')
        width,height=math.ceil(usable_w/cols),math.ceil(usable_h/rows)
        files=[]
        for item in params['items']:
            if not item['enabled']: continue
            x,y=item['cell']
            box=(left+round(x*usable_w/cols)+x*gap_x, top+round(y*usable_h/rows)+y*gap_y,
                 left+round((x+1)*usable_w/cols)+x*gap_x, top+round((y+1)*usable_h/rows)+y*gap_y)
            frame=Image.new('RGBA',(width,height)); frame.alpha_composite(image.crop(box))
            target=folder/f'{len(files):03}.png';frame.save(native(target));files.append(str(target))
        return {'files':files,'width':width,'height':height}
    if method in ('slice', 'inbetween'):
        if count != 1: raise ValueError('目前仅支持切割静态图集')
        cols, rows = params['columns'], params['rows']
        if not isinstance(cols, int) or not isinstance(rows, int) or not 1 <= cols <= 32 or not 1 <= rows <= 32 or cols*rows > 128:
            raise ValueError('无效网格，最多 128 帧')
        if cols > image.width or rows > image.height: raise ValueError('切片不能小于一个像素')
        result = []
        for y in range(rows):
            for x in range(cols):
                index = y*cols+x
                if method == 'inbetween' and params['includesEndpoints'] and index in (0, cols*rows-1): continue
                box = (round(x*image.width/cols), round(y*image.height/rows), round((x+1)*image.width/cols), round((y+1)*image.height/rows))
                target = folder / f'{len(result):03}.png'
                frame = Image.new('RGBA', (math.ceil(image.width/cols), math.ceil(image.height/rows)))
                frame.alpha_composite(image.crop(box))
                if method == 'inbetween':
                    width, height = params['width'], params['height']
                    if not 1 <= width <= 4096 or not 1 <= height <= 4096: raise ValueError('无效动画画布')
                    fitted = ImageOps.contain(frame, (width, height), Image.Resampling.LANCZOS)
                    frame = Image.new('RGBA', (width, height))
                    frame.alpha_composite(fitted, ((width-fitted.width)//2, (height-fitted.height)//2))
                frame.save(native(target))
                result.append(str(target))
        return {'files': result}
    if method == 'transform':
        if count != 1: raise ValueError('目前仅支持调整静态图片')
        spec = params['transform']
        scale = float(spec.get('scale', 1))
        width, height = int(spec.get('width', image.width)), int(spec.get('height', image.height))
        if not 0.05 <= scale <= 4 or not 1 <= width <= 4096 or not 1 <= height <= 4096: raise ValueError('调整参数超出范围')
        size = (max(1, round(image.width*scale)), max(1, round(image.height*scale)))
        if size[0]*size[1] > Image.MAX_IMAGE_PIXELS: raise ValueError('缩放后的图片太大')
        resized = image.resize(size, Image.Resampling.LANCZOS)
        x, y = round((width-size[0])/2+spec.get('offsetX', 0)), round((height-size[1])/2+spec.get('offsetY', 0))
        # Match review_images: near-transparent interpolation fringes are not visible content.
        local_bounds = resized.getchannel('A').point(lambda value:255 if value>VISIBLE_ALPHA_THRESHOLD else 0).getbbox()
        bounds = [x+local_bounds[0], y+local_bounds[1], x+local_bounds[2], y+local_bounds[3]] if local_bounds else None
        overflow = {'left':max(0,-bounds[0]), 'top':max(0,-bounds[1]), 'right':max(0,bounds[2]-width), 'bottom':max(0,bounds[3]-height)} if bounds else dict.fromkeys(['left','top','right','bottom'],0)
        blocking = any(overflow.values()) and not spec.get('clip', False)
        if blocking and not params.get('preview', False):
            detail = ', '.join(f'{key}={value}px' for key,value in overflow.items() if value)
            raise ValueError(f'可见内容超出画布（{detail}），请减小偏移、缩放，或勾选允许裁切')
        canvas = Image.new('RGBA', (width, height))
        canvas.alpha_composite(resized, (x, y))
        target = folder / 'adjusted.png'
        canvas.save(native(target))
        return {'files': [str(target)], 'bounds':bounds, 'overflow':overflow, 'blocking':blocking}
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
        images[0].save(native(target), format='WEBP', save_all=True, append_images=images[1:], duration=durations, loop=0 if params.get('loop') else 1, lossless=True)
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
