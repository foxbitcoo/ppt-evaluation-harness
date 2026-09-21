"""Validate independent judge lanes without reading or printing secret values."""
import argparse,json,os,re
from urllib.parse import urlsplit

def validate(c):
 for lane in ('text','vision'):
  x=c[lane]
  if set(x)-{'protocol','model','base_url','api_key_env','endpoint_id'}:raise ValueError('Unsupported configuration field; never store literal keys')
  allowed={'typesafe','openai-chat'} if lane=='text' else {'ark-responses','openai-chat'}
  if x['protocol'] not in allowed:raise ValueError('Unsupported lane protocol')
  if not isinstance(x['model'],str) or not x['model'].strip():raise ValueError('Model required')
  if not re.fullmatch('[A-Z][A-Z0-9_]*',x['api_key_env']):raise ValueError('Environment variable name required')
  u=urlsplit(x['base_url'])
  if u.scheme!='https' or not u.hostname or u.username or u.password or u.query or u.fragment:raise ValueError('HTTPS base URL without credentials/query required')
  if x['protocol']=='typesafe' and (x['base_url'].rstrip('/')!='https://api.typesafe.ai/v1' or not x['model'].startswith('jev-')):raise ValueError('TypeSafe adapter requires official URL and jev model')
  ep=x.get('endpoint_id','')
  if ep and not re.fullmatch('ep-[a-zA-Z0-9-]+',ep):raise ValueError('Invalid endpoint ID')
 return c

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('config');a=p.parse_args()
 try:
  with open(a.config) as f:c=validate(json.load(f))
  missing=[x['api_key_env'] for x in (c['text'],c['vision']) if not os.environ.get(x['api_key_env'])]
  unresolved=['vision.endpoint_id'] if c['vision']['protocol']=='ark-responses' and not c['vision'].get('endpoint_id') else []
  print(json.dumps({'structure':'PASS','missing_environment_variables':missing,'unresolved':unresolved,'network_calls':0}))
 except (ValueError,KeyError,TypeError,OSError):
  print(json.dumps({'structure':'FAILED','error':'Invalid model configuration; check the example without exposing keys'}));return 1
 return 0
if __name__=='__main__':raise SystemExit(main())
