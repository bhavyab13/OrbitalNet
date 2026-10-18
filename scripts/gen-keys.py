#!/usr/bin/env python3
"""Generate Ed25519 keypairs for every OCGP signer into keys/<kid>.json (skips existing)."""
import json, os, sys, base64
from pathlib import Path
try:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives import serialization
except ImportError:
    sys.exit("pip install cryptography")
root = Path(__file__).resolve().parent.parent
keys = root / "keys"; keys.mkdir(exist_ok=True)
b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()
for kid in ["world", "broker", "orbital-foundry", "lumen-relay", "northstar-relay"]:
    p = keys / f"{kid}.json"
    if p.exists(): print("exists", p); continue
    sk = Ed25519PrivateKey.generate()
    raw_sk = sk.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption())
    raw_pk = sk.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    p.write_text(json.dumps({"kid": kid, "public_key": b64(raw_pk), "private_key": b64(raw_sk)}, indent=2))
    print("wrote", p)
