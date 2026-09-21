"""Validate structure only, never certify visual evidence or factual correctness."""
import argparse,json,pathlib
WEIGHTS={'readability':.30,'layout':.25,'explanation':.30,'consistency':.15}
def validate(m,j):
 ids={s['id'] for s in m['samples']};pages={s['id']:{x['page_id'] for x in s['images']} for s in m['samples']}
 rank=j['ranking']
 if not rank or not all(isinstance(g,list) and g for g in rank):raise ValueError('Nonempty ranking groups required')
 ranked=[i for g in rank for i in g]
 if len(ranked)!=len(ids) or set(ranked)!=ids:raise ValueError('Ranking omits/duplicates candidates')
 decks=j['decks']
 if len(decks)!=len(ids) or {d['id'] for d in decks}!=ids:raise ValueError('Decks omit/duplicate candidates')
 weights=m.get('visual_weights',WEIGHTS)
 if set(weights)!=set(WEIGHTS) or abs(sum(weights.values())-1)>1e-8 or any(v<0 for v in weights.values()):raise ValueError('Invalid frozen weights')
 scores={}
 for d in decks:
  sc=d['scores']
  if set(sc)!=set(weights):raise ValueError('Missing/extra dimension')
  if any(v is not None and (type(v)!=int or not 1<=v<=5) for v in sc.values()):raise ValueError('Scores must be integers 1-5 or null')
  covered=set()
  for ev in d['evidence']:
   if ev['dimension'] not in weights or ev['page_id'] not in pages[d['id']] or not isinstance(ev.get('observation'),str) or not ev['observation'].strip():raise ValueError('Invalid evidence reference')
   covered.add(ev['dimension'])
  if covered!=set(weights):raise ValueError('Each dimension needs evidence')
  scores[d['id']]=None if None in sc.values() else round(sum(sc[k]*weights[k] for k in weights)*20,2)
 conflicts=[]
 for i,g in enumerate(rank):
  for later in rank[i+1:]:
   for a in g:
    for b in later:
     if scores[a] is not None and scores[b] is not None and scores[a]<scores[b]:conflicts.append([a,b])
 return {'structure':'PASS','weighted_scores':scores,'rank_score_conflicts':conflicts,'visual_evidence':'NOT_VERIFIED','human_calibration':'NOT_VERIFIED'}
if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('manifest');p.add_argument('judgment');a=p.parse_args();print(json.dumps(validate(json.loads(pathlib.Path(a.manifest).read_text()),json.loads(pathlib.Path(a.judgment).read_text())),ensure_ascii=False,indent=2))
