import zipfile, sys, os, json, re, xml.etree.ElementTree as ET, posixpath
filename, dest=sys.argv[1:]
assets=[]; warnings=[]
with zipfile.ZipFile(filename) as z:
    names=z.namelist()
    media=[n for n in names if re.match(r'(word|ppt)/media/',n)]
    for i,n in enumerate(media):
        ext=os.path.splitext(n)[1].lower()
        if ext not in ['.png','.jpg','.jpeg','.gif','.bmp','.tiff','.tif','.svg','.webp']:
            warnings.append(f'Unsupported embedded graphic: {os.path.basename(n)}. A PDF export preserves its appearance.')
            continue
        out=os.path.join(dest, f'embedded-{i}{ext}')
        with open(out,'wb') as f: f.write(z.read(n))
        locators=[]
        for rel in names:
            if re.fullmatch(r'ppt/slides/_rels/slide\d+\.xml.rels',rel):
                for r in ET.fromstring(z.read(rel)):
                    if posixpath.normpath(posixpath.join('ppt/slides', r.get('Target',''))) == n:
                        locators.append('Slide '+re.search(r'slide(\d+)',rel).group(1))
        assets.append({'path':out,'locator':', '.join(locators) or 'Document','name':os.path.basename(n)})
    if any(re.match(r'ppt/(charts|diagrams)/',n) for n in names):
        warnings.append('PowerPoint charts or SmartArt are present. Embedded pictures are preserved; export the slides as PDF to preserve vector diagrams exactly.')
print(json.dumps({'assets':assets,'warnings':warnings}))
