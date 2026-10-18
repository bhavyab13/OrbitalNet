"""Canonical JSON + Ed25519 signing (OCGP §2)."""
import base64
import json
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def b64u_dec(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _jsnum(obj):
    """Match JavaScript JSON.stringify number formatting: integral floats become ints,
    other floats use shortest round-trip repr (same as JS)."""
    if isinstance(obj, bool):
        return obj
    if isinstance(obj, float):
        return int(obj) if obj.is_integer() else obj
    if isinstance(obj, dict):
        return {k: _jsnum(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_jsnum(v) for v in obj]
    return obj


def canonical(obj) -> bytes:
    return json.dumps(_jsnum(obj), sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


class Signer:
    def __init__(self, kid: str, private_key_b64u: str, public_key_b64u: str):
        self.kid = kid
        self.public_key = public_key_b64u
        self._sk = Ed25519PrivateKey.from_private_bytes(b64u_dec(private_key_b64u))

    @classmethod
    def load(cls, path: Path) -> "Signer":
        d = json.loads(path.read_text())
        return cls(d["kid"], d["private_key"], d["public_key"])

    @classmethod
    def generate(cls, kid: str) -> "Signer":
        sk = Ed25519PrivateKey.generate()
        raw_sk = sk.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption())
        raw_pk = sk.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        return cls(kid, b64u(raw_sk), b64u(raw_pk))

    def sign(self, msg: dict) -> dict:
        body = {k: v for k, v in msg.items() if k != "sig"}
        body["kid"] = self.kid
        sig = self._sk.sign(canonical(body))
        return {**body, "sig": b64u(sig)}


def verify(msg: dict, public_key_b64u: str) -> bool:
    try:
        body = {k: v for k, v in msg.items() if k != "sig"}
        pk = Ed25519PublicKey.from_public_bytes(b64u_dec(public_key_b64u))
        pk.verify(b64u_dec(msg["sig"]), canonical(body))
        return True
    except Exception:
        return False
