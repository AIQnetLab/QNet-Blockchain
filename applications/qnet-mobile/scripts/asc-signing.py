#!/usr/bin/env python3
"""App Store signing for the TestFlight lane through the App Store Connect API, with no Apple device.

Automatic signing archives with a development profile, which needs a device registered to the team. This
script instead makes a distribution certificate and an App Store profile for the run (the API key needs the
Admin role), with the Python standard library and /usr/bin/openssl only.

  prepare <dir>                     removes what earlier runs left (profiles named QNet-CI-* and their
                                    certificates), creates a certificate from a new key and a profile with it,
                                    writes key.pem, cert.cer and profile.mobileprovision to <dir> and prints
                                    CERT_ID, PROFILE_ID, PROFILE_NAME and PROFILE_UUID as NAME=value lines.
  discard <cert_id> <profile_id>    deletes a run's profile and revokes its certificate.

A run that uploaded keeps its certificate until the next run removes it, so a build Apple is still processing
is never checked against a revoked certificate; a run that uploaded nothing discards its own at the end.
Reads ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH, BUNDLE_ID and RUN_TAG from the environment.
"""
import base64
import json
import os
import plistlib
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = 'https://api.appstoreconnect.apple.com/v1'
PREFIX = 'QNet-CI-'
OPENSSL = '/usr/bin/openssl'
CAPABILITIES = ('PUSH_NOTIFICATIONS', 'ASSOCIATED_DOMAINS')


class ApiError(Exception):
    def __init__(self, method, path, status, detail):
        hint = ' (the API key needs the Admin role: App Store Connect > Users and Access > Integrations)' if status in (401, 403) else ''
        super().__init__(f'App Store Connect {method} {path.split("?")[0]}: HTTP {status}{hint} {detail}')
        self.status = status


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()


def der_to_raw(sig):
    """ECDSA-Sig-Value (SEQUENCE of two INTEGERs) to the 64-byte r || s a JWT carries."""
    i = 2 if sig[1] < 0x80 else 2 + (sig[1] & 0x7F)
    raw = b''
    for _ in range(2):
        if sig[i] != 0x02:
            raise ValueError('not an ECDSA signature')
        n = sig[i + 1]
        raw += sig[i + 2:i + 2 + n].lstrip(b'\0').rjust(32, b'\0')
        i += 2 + n
    return raw


def token():
    now = int(time.time())
    head = b64url(json.dumps({'alg': 'ES256', 'kid': os.environ['ASC_KEY_ID'], 'typ': 'JWT'}).encode())
    body = b64url(json.dumps({'iss': os.environ['ASC_ISSUER_ID'], 'iat': now, 'exp': now + 900,
                              'aud': 'appstoreconnect-v1'}).encode())
    sig = subprocess.run([OPENSSL, 'dgst', '-sha256', '-sign', os.environ['ASC_KEY_PATH']],
                         input=f'{head}.{body}'.encode(), capture_output=True, check=True).stdout
    return f'{head}.{body}.{b64url(der_to_raw(sig))}'


_token = None


def call(method, path, body=None):
    global _token
    _token = _token or token()
    req = urllib.request.Request(API + path, method=method,
                                 data=None if body is None else json.dumps(body).encode(),
                                 headers={'Authorization': f'Bearer {_token}', 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as e:
        raise ApiError(method, path, e.code, e.read().decode(errors='replace')[:800]) from None
    return json.loads(raw) if raw else {}


def remove(cert_ids, profile_id):
    """Deletes a profile, then revokes its certificates; what is already gone is not an error."""
    paths = ([f'/profiles/{profile_id}'] if profile_id else []) + [f'/certificates/{c}' for c in cert_ids]
    for path in paths:
        try:
            call('DELETE', path)
        except ApiError as e:
            if e.status not in (404, 409):
                raise


def prepare(out):
    bundle_id = os.environ['BUNDLE_ID']
    name = PREFIX + os.environ['RUN_TAG']

    left = call('GET', '/profiles?' + urllib.parse.urlencode({'limit': 200, 'include': 'certificates'}))['data']
    for profile in left:
        if profile['attributes']['name'].startswith(PREFIX):
            certs = [c['id'] for c in profile.get('relationships', {}).get('certificates', {}).get('data') or []]
            remove(certs, profile['id'])
            print(f'removed {profile["attributes"]["name"]} and {len(certs)} certificate(s)', file=sys.stderr)

    found = call('GET', '/bundleIds?' + urllib.parse.urlencode({'filter[identifier]': bundle_id, 'limit': 200}))['data']
    found = [b for b in found if b['attributes']['identifier'] == bundle_id]
    if not found:
        sys.exit(f'::error::the bundle id {bundle_id} is not registered to the team')
    bundle = found[0]['id']
    have = {c['attributes']['capabilityType'] for c in call('GET', f'/bundleIds/{bundle}/bundleIdCapabilities')['data']}
    for cap in CAPABILITIES:
        if cap not in have:
            call('POST', '/bundleIdCapabilities', {'data': {
                'type': 'bundleIdCapabilities', 'attributes': {'capabilityType': cap},
                'relationships': {'bundleId': {'data': {'type': 'bundleIds', 'id': bundle}}}}})
            print(f'enabled {cap} on {bundle_id}', file=sys.stderr)

    key, csr = os.path.join(out, 'key.pem'), os.path.join(out, 'csr.pem')
    subprocess.run([OPENSSL, 'req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', csr,
                    '-subj', '/CN=QNet CI/O=Orrery Group LLC'], capture_output=True, check=True)
    with open(csr) as f:
        cert = call('POST', '/certificates', {'data': {
            'type': 'certificates', 'attributes': {'certificateType': 'DISTRIBUTION', 'csrContent': f.read()}}})['data']
    try:
        profile = call('POST', '/profiles', {'data': {
            'type': 'profiles', 'attributes': {'name': name, 'profileType': 'IOS_APP_STORE'},
            'relationships': {'bundleId': {'data': {'type': 'bundleIds', 'id': bundle}},
                              'certificates': {'data': [{'type': 'certificates', 'id': cert['id']}]}}}})['data']
    except ApiError:
        remove([cert['id']], None)
        raise

    blob = base64.b64decode(profile['attributes']['profileContent'])
    with open(os.path.join(out, 'cert.cer'), 'wb') as f:
        f.write(base64.b64decode(cert['attributes']['certificateContent']))
    with open(os.path.join(out, 'profile.mobileprovision'), 'wb') as f:
        f.write(blob)
    plist = plistlib.loads(blob[blob.index(b'<?xml'):blob.index(b'</plist>') + len(b'</plist>')])
    print(f'CERT_ID={cert["id"]}\nPROFILE_ID={profile["id"]}\nPROFILE_NAME={name}\nPROFILE_UUID={plist["UUID"]}')


def main(argv):
    try:
        if len(argv) == 3 and argv[1] == 'prepare':
            prepare(argv[2])
        elif len(argv) == 4 and argv[1] == 'discard':
            remove([argv[2]], argv[3])
        else:
            sys.exit(__doc__)
    except ApiError as e:
        sys.exit(f'::error::{e}')


if __name__ == '__main__':
    main(sys.argv)
