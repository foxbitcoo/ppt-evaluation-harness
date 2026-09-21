"""Prepare anonymous PPT judge inputs locally; no credentials or network."""
import argparse, hashlib, json, pathlib, posixpath, re, struct
from zipfile import ZipFile
from xml.etree import ElementTree as ET
NS={'a':'http://schemas.openxmlformats.org/drawingml/2006/main','p':'http://schemas.openxmlformats.org/presentationml/2006/main','r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
def sha(b):return hashlib.sha256(b).hexdigest()
def encode(v):return (json.dumps(v,ensure_ascii=False,indent=2)+'\n').encode()
def prepare(config,out):
 c=json.loads(pathlib.Path(config).read_text());out=pathlib.Path(out)
 if out.exists():raise ValueError('Output directory must not exist')
 if not isinstance(c.get('task'),str) or not c['task'].strip():raise ValueError('Task required')
 rubric_path=pathlib.Path(c['rubric']);rb=rubric_path.read_bytes();r=json.loads(rb)
 if not r.get('version') or not r.get('questions'):raise ValueError('Versioned rubric required')
 ids=[s['id'] for s in c['samples']]
 if len(ids)<2 or len(set(ids))!=len(ids) or not all(re.fullmatch('[A-Z][A-Z0-9]{0,7}',i) for i in ids):raise ValueError('At least two unique anonymous IDs required')
 files={};manifest={'task':c['task'],'rubric_sha256':sha(rb),'jev_model':c['jev_model'],'samples':[],'status':'PREPARED_NOT_RUN'};vision=[]
 if 'visual_weights' in c:manifest['visual_weights']=c['visual_weights']
 for s in c['samples']:
  sid=s['id'];src=pathlib.Path(s['pptx']).resolve();pages=[]
  with ZipFile(src) as z:
   if z.testzip():raise ValueError('PPTX ZIP invalid')
   rel=ET.fromstring(z.read('ppt/_rels/presentation.xml.rels'))
   targets={el.attrib['Id']:posixpath.normpath(posixpath.join('ppt',el.attrib['Target'])) if not el.attrib['Target'].startswith('/') else el.attrib['Target'][1:] for el in rel if el.attrib.get('TargetMode')!='External'}
   for n,slide in enumerate(ET.fromstring(z.read('ppt/presentation.xml')).findall('p:sldIdLst/p:sldId',NS),1):
    root=ET.fromstring(z.read(targets[slide.attrib['{'+NS['r']+'}id']]))
    paras=[];pid=f'{sid}-p{n:03}'
    for par in root.findall('.//a:p',NS):
     txt=''.join((el.text or '') if el.tag=='{'+NS['a']+'}t' else '\n' for el in par.iter() if el.tag in ['{'+NS['a']+'}t','{'+NS['a']+'}br']).strip()
     if txt:paras.append({'id':f'{pid}-t{len(paras)+1:03}','text':txt})
    pages.append({'page_id':pid,'page_number':n,'paragraphs':paras})
  if not pages or len(s['images'])!=len(pages):raise ValueError(f'{sid}: incomplete render images')
  images=[]
  for page,img in zip(pages,s['images']):
   ip=pathlib.Path(img).resolve();data=ip.read_bytes()
   if data[:8]!=b'\x89PNG\r\n\x1a\n' or len(data)<24:raise ValueError('PNG required')
   width,height=struct.unpack('>II',data[16:24])
   if not width or not height:raise ValueError('Invalid PNG dimensions')
   images.append({'page_id':page['page_id'],'path':str(ip),'sha256':sha(data),'bytes':len(data),'width':width,'height':height})
   vision.extend([{'type':'input_text','text':f"candidate={sid} page_id={page['page_id']} page_number={page['page_number']}"},{'type':'input_image','image_url':ip.as_uri()}])
  deck={'sample_id':sid,'extraction':'OOXML paragraphs in actual slide order; no OCR, notes, charts, inherited master text or visibility guarantees','pages':pages}
  request={'model':c['jev_model'],'state':{'task':c['task'],'deck':deck,'reference_pack':r.get('reference_pack',[])},'questions':r['questions']}
  files[f'text-{sid}.json']=encode(deck);files[f'jev-request-{sid}.json']=encode(request)
  manifest['samples'].append({'id':sid,'label':s.get('label',sid),'pptx':str(src),'sha256':sha(src.read_bytes()),'page_count':len(pages),'images':images,'text_sha256':sha(files[f'text-{sid}.json']),'jev_request_sha256':sha(files[f'jev-request-{sid}.json'])})
 files['manifest.json']=encode(manifest);files['vision-input.json']=encode(vision);files['rubric.json']=rb
 out.mkdir(parents=True)
 for name,data in files.items():(out/name).write_bytes(data)
 return {'status':'PREPARED_NOT_RUN','decks':len(ids),'images':len(vision)//2,'directory':str(out.resolve())}
if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('config');p.add_argument('out');a=p.parse_args();print(json.dumps(prepare(a.config,a.out),ensure_ascii=False))
