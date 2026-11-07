"""Final-region rendering and region generators. Generator settings never enter v3 recipes."""
from pathlib import Path
from io import BytesIO
from hashlib import sha256
import math
from PIL import Image, ImageDraw, ImageOps
from sheet_imaging import detect, grid_boxes, ALGORITHM, MAX_SOURCE, MAX_OUTPUT


def overlay(image, items, folder, native):
    im = ImageOps.contain(image, (1024, 1024), Image.Resampling.NEAREST).copy()
    draw = ImageDraw.Draw(im)
    sx, sy = im.width / image.width, im.height / image.height
    for i, item in enumerate(items):
        l, t, r, b = item['box']
        draw.rectangle((l*sx, t*sy, max(l*sx, (r-1)*sx), max(t*sy, (b-1)*sy)), outline='#37bcb0', width=1)
        draw.text((l*sx+2, t*sy+2), str(i+1), fill='#37bcb0')
    file = folder/'regions.png'
    im.save(native(file))
    return [str(file)]


def generate(method, image, params, folder, native, source_hash):
    resolving = method == 'region_resolve'
    version = params.get('recipeVersion', 3)
    operation = params.get('method', 'boxes')
    diagnostics, selection_files = [], []
    components, runs = [], None
    if operation == 'components':
        if resolving and (params['sourceContentHash'] != source_hash or params['algorithmVersion'] != ALGORITHM):
            raise ValueError('STALE_ANALYSIS：旧识别来源已变化，请重新生成区域或改用矩形')
        components, runs, info = detect(image, source_hash, params['detection'])
        diagnostics = info['diagnostics']
    if resolving:
        inputs = params['items']
    elif operation == 'grid':
        grid = params['grid']
        inputs = [{'name': f'{y*grid["columns"]+x+1:02}', 'enabled': True, 'cell': [x,y]}
                  for y in range(grid['rows']) for x in range(grid['columns'])]
    else:
        if len(components) > 128:
            raise ValueError(f'识别到{len(components)}个区域，超过128帧；请调整过滤参数后重新生成')
        inputs = [{'name': f'{i+1:02}', 'enabled': True, 'componentKeys': [c['key']]} for i,c in enumerate(components)]
    if len(inputs) > 128:
        raise ValueError('区域最多128帧')
    boxes, legacy_size = grid_boxes(image, params['grid']) if operation == 'grid' else ([], None)
    by_key = {c['key']:c for c in components}
    items, masks_area = [], 0
    for index, item in enumerate(inputs):
        selected = []
        if operation == 'grid':
            x, y = item['cell']
            if not 0 <= x < params['grid']['columns'] or not 0 <= y < params['grid']['rows']:
                raise ValueError('切片单元超出网格')
            box = boxes[y*params['grid']['columns']+x]
        elif operation == 'components':
            for key in item['componentKeys']:
                if key not in by_key:
                    raise ValueError('STALE_ANALYSIS：旧组件不存在，请重新生成区域')
                selected.append(by_key[key])
            box = [min(c['box'][0] for c in selected), min(c['box'][1] for c in selected), max(c['box'][2] for c in selected), max(c['box'][3] for c in selected)]
        else:
            box = item['box']
        l,t,r,b = box
        if not 0 <= l < r <= image.width or not 0 <= t < b <= image.height:
            raise ValueError('矩形超出原图或为空')
        result = {k:item[k] for k in ('id','name','enabled') if k in item}
        result['box'] = box
        if selected:
            masks_area += (r-l)*(b-t)
            if masks_area > MAX_OUTPUT:
                raise ValueError('固化选区总像素预算超限')
            mask = Image.new('L', (r-l,b-t))
            draw = ImageDraw.Draw(mask)
            xs, ends, ys = runs
            for component in selected:
                for i in component['_runs']:
                    draw.line((xs[i]-l,ys[i]-t,ends[i]-l-1,ys[i]-t), fill=255)
            path = folder/f'selection-{index:03}.png'
            mask.save(native(path))
            selection_files.append({'index':index,'box':box,'path':str(path)})
        items.append(result)
    if resolving and version == 1:
        width,height = legacy_size
        output = {'width':width,'height':height,'scale':1,'alignment':'top-left'}
    elif resolving:
        output = params['output']
    else:
        output = params.get('output') or {'width':max((i['box'][2]-i['box'][0] for i in items),default=1), 'height':max((i['box'][3]-i['box'][1] for i in items),default=1), 'scale':1,'alignment':'center'}
    if output['width'] > 4096 or output['height'] > 4096:
        raise ValueError('建议画布超过4096像素，请明确设置输出画布和统一缩放')
    if output['width']*output['height']*sum(bool(i['enabled']) for i in items) > MAX_OUTPUT:
        raise ValueError('输出总解码像素预算超限')
    return {'items':items,'output':output,'selectionFiles':selection_files,'total':len(items),'diagnostics':diagnostics,'files':overlay(image,items,folder,native)}


def frames_for(image, params):
    output, items = params['output'], params['items']
    width,height,scale = output['width'],output['height'],output['scale']
    if len(items)>128 or not 1<=width<=4096 or not 1<=height<=4096 or not .05<=scale<=4:
        raise ValueError('无效区域或输出画布')
    if width*height*sum(bool(i['enabled']) for i in items)>MAX_OUTPUT:
        raise ValueError('输出总解码像素预算超限')
    frames, rectangles = [], []
    for index,item in enumerate(items):
        l,t,r,b = item['box']
        if not (0<=l<r<=image.width and 0<=t<b<=image.height):
            raise ValueError('矩形超出原图或为空')
        rectangles.append({'index':index,'box':item['box'],'name':item['name'],'enabled':item['enabled']})
        if not item['enabled']:
            continue
        sw,sh = max(1,math.floor((r-l)*scale+.5)), max(1,math.floor((b-t)*scale+.5))
        if sw*sh>MAX_SOURCE:
            raise ValueError('缩放中间画布像素预算超限')
        x = 0 if output['alignment']=='top-left' else (width-sw)//2
        y = 0 if output['alignment']=='top-left' else height-sh if output['alignment']=='bottom-center' else (height-sh)//2
        overflow={'left':max(0,-x),'top':max(0,-y),'right':max(0,x+sw-width),'bottom':max(0,y+sh-height)}
        frames.append({'index':index,'name':item['name'],'box':item['box'],'scaledSize':[sw,sh],'offset':[x,y],'overflow':overflow,'blocking':any(overflow.values())})
    diagnostics=[]
    if not frames: diagnostics.append({'code':'empty-selection','message':'没有启用的区域'})
    if params.get('expectedFrames') and params['expectedFrames']!=len(frames):
        diagnostics.append({'code':'frame-count','message':f'期望{params["expectedFrames"]}帧，实际{len(frames)}帧'})
    return frames, {'width':width,'height':height,'total':len(frames),'rectangles':rectangles,'diagnostics':diagnostics,'suggestedOutput':{'width':max((f['scaledSize'][0] for f in frames),default=1),'height':max((f['scaledSize'][1] for f in frames),default=1)}}


def extract(image, item, native, inside):
    l,t,r,b=item['box']
    raw=image.crop((l,t,r,b))
    if item.get('_selectionPath'):
        path=inside(item['_selectionPath'])
        data=native(path).read_bytes()
        if sha256(data).hexdigest()!=item['_selectionImageHash']:
            raise ValueError('不可变选区图片已改变')
        with Image.open(BytesIO(data)) as original:
            mask=original.convert('L');mask.load()
        if mask.size!=raw.size:
            raise ValueError('选区尺寸不符')
        selected=Image.new('RGBA',raw.size)
        selected.paste(raw,(0,0),mask)
        raw=selected
    return raw


def render(raw, frame, size):
    scaled=raw if raw.size==tuple(frame['scaledSize']) else raw.resize(tuple(frame['scaledSize']),Image.Resampling.NEAREST)
    result=Image.new('RGBA',size)
    result.paste(scaled,tuple(frame['offset']))
    return result


def process(method,image,params,folder,native,inside,source_hash):
    if image.width*image.height>MAX_SOURCE:
        raise ValueError('源图像素预算超限')
    if method in ('region_generate','region_resolve'):
        return generate(method,image,params,folder,native,source_hash)
    frames,info=frames_for(image,params)
    if method=='recipe_slice':
        if not frames: raise ValueError('请先添加区域')
        if any(f['blocking'] for f in frames): raise ValueError('画布溢出：请调整统一输出设置')
        if any(d['code']=='frame-count' for d in info['diagnostics']): raise ValueError('期望帧数不符')
        files=[]
        for i,f in enumerate(frames):
            raw=extract(image,params['items'][f['index']],native,inside)
            path=folder/f'{i:03}.png'
            render(raw,f,(info['width'],info['height'])).save(native(path));files.append(str(path))
        return {**info,'files':files,'itemIndexes':[f['index'] for f in frames]}
    start,limit=params['start'],params['limit'];batch=frames[start:start+limit]
    contact=Image.new('RGB',(min(max(1,len(batch)),4)*180,max(1,math.ceil(len(batch)/4))*210),'#182127')
    draw=ImageDraw.Draw(contact);frame_files=[]
    for i,f in enumerate(batch):
        raw=extract(image,params['items'][f['index']],native,inside)
        out=render(raw,f,(info['width'],info['height']))
        raw_path,out_path=folder/f'raw-{i:03}.png',folder/f'output-{i:03}.png'
        (raw if max(raw.size)<=1024 else ImageOps.contain(raw,(1024,1024),Image.Resampling.NEAREST)).save(native(raw_path))
        (out if max(out.size)<=1024 else ImageOps.contain(out,(1024,1024),Image.Resampling.NEAREST)).save(native(out_path))
        frame_files.append({'index':f['index'],'raw':str(raw_path),'output':str(out_path)})
        tile=Image.new('RGBA',(160,160),'#35454c')
        # Static evidence shows the whole source region even when the output would clip.
        shown=raw if f['blocking'] else out
        small=ImageOps.contain(shown,(160,160),Image.Resampling.NEAREST)
        tile.alpha_composite(small,((160-small.width)//2,(160-small.height)//2))
        x,y=(i%4)*180+10,(i//4)*210+25
        contact.paste(tile.convert('RGB'),(x,y));draw.text((x,y-18),f'#{f["index"]+1}',fill='white')
        draw.text((x,y+165),'OVERFLOW' if f['blocking'] else f'{info["width"]} x {info["height"]}',fill='#ff786b' if f['blocking'] else 'white')
    path=folder/'contact.png';contact.save(native(path))
    return {**info,'frames':batch,'start':start,'end':start+len(batch),'limit':limit,'files':[str(path)],'frameFiles':frame_files,'blocking':any(f['blocking'] for f in frames)}
