import sys,json,fitz
# Filter text-only pages before agent vision work. Preserve any nontrivial drawing or raster image.
result=[]
with fitz.open(sys.argv[1]) as doc:
    for i,page in enumerate(doc):
        images=page.get_images(full=True)
        drawings=page.get_drawings()
        segments=sum(len(d.get('items',[])) for d in drawings if not (len(d.get('items',[]))==1 and d['items'][0][0]=='re' and d.get('rect',fitz.Rect()).get_area()>page.rect.get_area()*.8))
        visual=bool(images) or segments>=3 or len(page.get_text().strip())<30
        if visual: result.append(i+1)
print(json.dumps(result))
