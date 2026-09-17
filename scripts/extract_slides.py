import sys, zipfile, re, xml.etree.ElementTree as ET
with zipfile.ZipFile(sys.argv[1]) as z:
    slides=sorted([n for n in z.namelist() if re.fullmatch(r'ppt/slides/slide\d+\.xml', n)],key=lambda n:int(re.search(r'slide(\d+)',n).group(1)))
    for i,n in enumerate(slides,1):
        root=ET.fromstring(z.read(n))
        print(f'\n[Slide {i}]')
        for p in root.iter('{http://schemas.openxmlformats.org/drawingml/2006/main}p'):
            print(' '.join(t.text or '' for t in p.iter('{http://schemas.openxmlformats.org/drawingml/2006/main}t')))
        notes=f'ppt/notesSlides/notesSlide{i}.xml'
        if notes in z.namelist():
            print('[Speaker notes]')
            print(' '.join(t.text or '' for t in ET.fromstring(z.read(notes)).iter('{http://schemas.openxmlformats.org/drawingml/2006/main}t')))
