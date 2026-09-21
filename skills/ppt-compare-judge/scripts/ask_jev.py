#!/usr/bin/env python3
"""Read a JSON request from stdin; emit sanitized Jev results, never credentials."""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

URL = 'https://api.typesafe.ai/v1/systemone'

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def validate(p):
    if not isinstance(p, dict) or set(p) - {'state', 'questions', 'model'}:
        raise ValueError('Expected an object with state, questions and optional model')
    if not isinstance(p.get('state'), (str, dict, list)):
        raise ValueError('state must be text, object or array')
    qs = p.get('questions')
    if not isinstance(qs, dict) or not qs:
        raise ValueError('questions must be a nonempty object')
    for q in qs.values():
        if not isinstance(q, dict) or not isinstance(q.get('instructions'), (str, dict, list)) or not q['instructions']:
            raise ValueError('Each question requires instructions')
        kind, criteria = q.get('type'), q.get('criteria')
        if kind == 'noul':
            if criteria is not None and (not isinstance(criteria, dict) or set(criteria) - {'true', 'false'}):
                raise ValueError('noul criteria must contain true/false keys')
        elif kind == 'choice':
            if not isinstance(criteria, dict) or not 1 <= len(criteria) <= 255:
                raise ValueError('choice requires 1-255 named options')
        elif kind == 'score':
            if not isinstance(criteria, list) or not 2 <= len(criteria) <= 10:
                raise ValueError('score requires 2-10 ordered levels')
        else:
            raise ValueError('Question type must be noul, choice or score')
    p.setdefault('model', 'jev-latest')
    if not isinstance(p['model'], str) or not p['model'].startswith('jev-'):
        raise ValueError('Expected a TypeSafe jev-* model ID')
    return p

def credential(env_name='TYPESAFE_API_KEY'):
    key = os.environ.get(env_name, '')
    if not key or any(c.isspace() for c in key):
        raise ValueError('TYPESAFE_API_KEY environment variable required')
    return key

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--validate-only', action='store_true')
    ap.add_argument('--config', help='Independent text/vision config; never contains literal keys')
    args = ap.parse_args()
    key = ''
    def emit(obj):
        text = json.dumps(obj, ensure_ascii=False)
        print(text.replace(key, '[REDACTED]') if key else text)
    try:
        payload = json.load(sys.stdin)
        env_name = 'TYPESAFE_API_KEY'
        if args.config:
            from check_config import validate as validate_config
            with open(args.config) as f:
                config = validate_config(json.load(f))
            text_config = config['text']
            if text_config['protocol'] != 'typesafe':
                raise ValueError('Use the selected provider adapter for non-JEV protocols')
            payload['model'] = text_config['model']
            env_name = text_config['api_key_env']
        payload = validate(payload)
        if args.validate_only:
            emit({'ok': True, 'validation_only': True, 'question_count': len(payload['questions'])})
            return 0
        key = credential(env_name)
        req = urllib.request.Request(URL, data=json.dumps(payload, ensure_ascii=False).encode(), headers={'Authorization':'Bearer '+key, 'Content-Type':'application/json'}, method='POST')
        with urllib.request.build_opener(NoRedirect).open(req, timeout=30) as r:
            result = json.loads(r.read())
        answers = result.get('answers', {})
        for qid, q in payload['questions'].items():
            answer = answers.get(qid)
            if not isinstance(answer, dict) or answer.get('type') != q['type'] or q['type'] not in answer:
                raise ValueError('API response missing a matching typed answer')
        emit({'ok':True, 'model':result.get('model'), 'answers':answers, 'usage':result.get('usage')})
        return 0
    except urllib.error.HTTPError as e:
        # Avoid echoing arbitrary response bodies which may contain request material.
        emit({'ok':False, 'http_status':e.code, 'retry_after':e.headers.get('Retry-After'), 'error':'TypeSafe rejected the request; check account access, request schema, quota or rate limits.'})
    except (ValueError, KeyError, TypeError):
        emit({'ok':False, 'error':'Invalid request, credential entry, or response schema. Use --validate-only to check the request.'})
    except (OSError, urllib.error.URLError):
        emit({'ok':False, 'error':'Credential or network unavailable; no successful answer verified.'})
    return 1

if __name__ == '__main__':
    sys.exit(main())
