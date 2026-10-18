#!/usr/bin/env python3
"""
fire-detector-v1 — real active-fire / burn detection on a VIIRS false-color scene
(NASA GIBS layer VIIRS_SNPP_CorrectedReflectance_BandsM11-I2-I1: R=M11 SWIR 2.25um,
G=I2 NIR 0.87um, B=I1 red 0.64um). Active fire fronts and fresh burn scars radiate
strongly in SWIR -> high R with suppressed B; smoke is bluish and is rejected.

Usage: fire_detect.py --image scene.jpg --bbox S,W,N,E [--truth viirs.csv] [--thumb out.png] [--thumb-b64]
Prints one JSON object to stdout.
"""
import argparse, json, sys, time, base64, io, math
import numpy as np
from PIL import Image, ImageDraw

def components(mask: np.ndarray):
    """8-connected components via iterative flood fill with a stack (numpy, no scipy)."""
    h, w = mask.shape
    labels = np.zeros((h, w), dtype=np.int32)
    cur = 0
    ys, xs = np.nonzero(mask)
    for y0, x0 in zip(ys, xs):
        if labels[y0, x0]:
            continue
        cur += 1
        stack = [(y0, x0)]
        labels[y0, x0] = cur
        while stack:
            y, x = stack.pop()
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not labels[ny, nx]:
                        labels[ny, nx] = cur
                        stack.append((ny, nx))
    return labels, cur

def boxstats(a: np.ndarray, r: int):
    """Local mean and std over a (2r+1)^2 window via integral images."""
    p = np.pad(a, r, mode="reflect")
    ii = np.pad(p.cumsum(0).cumsum(1), ((1, 0), (1, 0)))
    ii2 = np.pad((p * p).cumsum(0).cumsum(1), ((1, 0), (1, 0)))
    k = 2 * r + 1
    n = k * k
    s = ii[k:, k:] - ii[:-k, k:] - ii[k:, :-k] + ii[:-k, :-k]
    s2 = ii2[k:, k:] - ii2[:-k, k:] - ii2[k:, :-k] + ii2[:-k, :-k]
    m = s / n
    v = np.maximum(s2 / n - m * m, 0)
    return m, np.sqrt(v)

def erode_dilate(mask: np.ndarray, r: int = 1) -> np.ndarray:
    """Morphological opening with a (2r+1)^2 box using shifted sums."""
    def box(m):
        p = np.pad(m.astype(np.int32), r)
        out = np.zeros_like(m, dtype=np.int32)
        h, w = m.shape
        for dy in range(-r, r + 1):
            for dx in range(-r, r + 1):
                out += p[r + dy:r + dy + h, r + dx:r + dx + w]
        return out
    k = (2 * r + 1) ** 2
    er = box(mask) == k
    return box(er) > 0

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True)
    ap.add_argument("--bbox", required=True, help="S,W,N,E")
    ap.add_argument("--truth")
    ap.add_argument("--thumb")
    ap.add_argument("--thumb-b64", action="store_true")
    ap.add_argument("--min-pixels", type=int, default=4)
    a = ap.parse_args()
    t0 = time.time()
    S, W, N, E = [float(v) for v in a.bbox.split(",")]

    img = Image.open(a.image).convert("RGB")
    arr = np.asarray(img).astype(np.int16)
    H, Wd = arr.shape[:2]
    R, G, B = arr[..., 0], arr[..., 1], arr[..., 2]

    # --- Active-fire detection: contextual SWIR anomaly (Giglio-style). A pixel is a fire
    # candidate when its SWIR (R channel = M11) exceeds the local background mean by k·sigma
    # over a 51x51 window, is not smoke/cloud (B < R), and is bright in absolute terms.
    Rf = R.astype(np.float64)
    bg_mean, bg_std = boxstats(Rf, 25)
    idx = Rf - bg_mean
    fire = (Rf > bg_mean + 2.0 * bg_std) & (idx > 15) & (Rf > 100) & (B < R)
    hot = (Rf > bg_mean + 3.0 * bg_std) & (idx > 25) & (B < R) & (Rf > 100)  # strongest cores (cloud-excluded)
    fire = fire | hot
    # --- Burn-scar class: fresh burns appear pink/salmon in this band combination
    scar = (R > 150) & (G > 100) & (B > 100) & (R > B - 10) & (np.abs(G - B) < 45) & ~((R > 215) & (G > 215) & (B > 215))
    scar = erode_dilate(scar, 1)

    labels, n = components(fire)
    px_deg_lat = (N - S) / H
    px_deg_lon = (E - W) / Wd
    km_per_px = 111.0 * px_deg_lat * 111.0 * px_deg_lon * math.cos(math.radians((N + S) / 2))

    feats = []
    for cid in range(1, n + 1):
        ys, xs = np.nonzero(labels == cid)
        if len(ys) < a.min_pixels:
            continue
        score = float(np.clip(idx[ys, xs].mean() / 60.0, 0, 1))
        cy, cx = ys.mean(), xs.mean()
        lat = N - (cy + 0.5) * px_deg_lat
        lon = W + (cx + 0.5) * px_deg_lon
        y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
        poly = [
            [W + x0 * px_deg_lon, N - y0 * px_deg_lat],
            [W + x1 * px_deg_lon, N - y0 * px_deg_lat],
            [W + x1 * px_deg_lon, N - y1 * px_deg_lat],
            [W + x0 * px_deg_lon, N - y1 * px_deg_lat],
            [W + x0 * px_deg_lon, N - y0 * px_deg_lat],
        ]
        feats.append({
            "type": "Feature",
            "geometry": {"type": "Polygon", "coordinates": [[[round(x, 5), round(y, 5)] for x, y in poly]]},
            "properties": {
                "cluster_id": cid, "pixels": int(len(ys)), "area_km2": round(len(ys) * km_per_px, 2),
                "score": round(score, 3), "centroid": [round(lon, 5), round(lat, 5)],
                "core_pixels": int(hot[ys, xs].sum()),
                "bbox_px": [int(x0), int(y0), int(x1), int(y1)],
            },
        })
    feats.sort(key=lambda f: -f["properties"]["pixels"])
    fire_pixels = int(fire.sum())
    scar_pixels = int(scar.sum())
    strongest = None
    if feats:
        s = max(feats, key=lambda f: f["properties"]["score"] * math.log1p(f["properties"]["pixels"]))
        strongest = {"lon": s["properties"]["centroid"][0], "lat": s["properties"]["centroid"][1], "score": s["properties"]["score"], "cluster_id": s["properties"]["cluster_id"]}

    validation = None
    if a.truth:
        import csv
        pts = []
        with open(a.truth) as f:
            for r in csv.DictReader(f):
                la, lo = float(r["latitude"]), float(r["longitude"])
                if S <= la <= N and W <= lo <= E:
                    pts.append((la, lo, r.get("confidence", ""), float(r.get("frp") or 0)))
        inside = 0
        hi = [(la, lo) for la, lo, c, f in pts if f > 15]
        inside_hi = 0
        # count VIIRS detections falling within any detected cluster bbox (+1px tolerance)
        boxes = [f["properties"]["bbox_px"] for f in feats]
        def near(la, lo, tol=3):
            x = (lo - W) / px_deg_lon
            y = (N - la) / px_deg_lat
            return any(x0 - tol <= x <= x1 + tol and y0 - tol <= y <= y1 + tol for x0, y0, x1, y1 in boxes)
        for la, lo, _, _ in pts:
            if near(la, lo):
                inside += 1
        for la, lo in hi:
            if near(la, lo):
                inside_hi += 1
        validation = {"viirs_hotspots_in_scene": len(pts), "hotspots_inside_detected_clusters": inside,
                      "recall_proxy": round(inside / len(pts), 3) if pts else None,
                      "high_frp_hotspots": len(hi), "high_frp_inside_detected_clusters": inside_hi,
                      "high_frp_recall_proxy": round(inside_hi / len(hi), 3) if hi else None,
                      "note": "VIIRS detections are 24h incl. night passes; the scene is the daytime composite, so recall is a lower bound."}

    thumb_b64 = None
    if a.thumb or a.thumb_b64:
        tw = 384
        th = int(H * tw / Wd)
        t = img.resize((tw, th)).convert("RGB")
        d = ImageDraw.Draw(t)
        sx, sy = tw / Wd, th / H
        for f in feats[:60]:
            x0, y0, x1, y1 = f["properties"]["bbox_px"]
            d.rectangle([x0 * sx - 2, y0 * sy - 2, x1 * sx + 2, y1 * sy + 2], outline=(255, 60, 60), width=2)
        if strongest:
            f = next(ff for ff in feats if ff["properties"]["cluster_id"] == strongest["cluster_id"])
            x0, y0, x1, y1 = f["properties"]["bbox_px"]
            d.rectangle([x0 * sx - 5, y0 * sy - 5, x1 * sx + 5, y1 * sy + 5], outline=(255, 230, 0), width=3)
        buf = io.BytesIO(); t.convert("RGB").save(buf, "JPEG", quality=72, optimize=True)
        if a.thumb:
            open(a.thumb, "wb").write(buf.getvalue())
        if a.thumb_b64:
            thumb_b64 = base64.b64encode(buf.getvalue()).decode()

    out = {
        "model": "fire-detector-v1",
        "geojson": {"type": "FeatureCollection", "features": feats},
        "summary": {
            "fire_pixels": fire_pixels,
            "clusters": len(feats),
            "affected_km2_est": round(fire_pixels * km_per_px, 1),
            "burn_scar_pixels": scar_pixels,
            "burn_scar_km2_est": round(scar_pixels * km_per_px, 1),
            "method": "contextual SWIR anomaly (M11) + burn-scar spectral class",
            "strongest": strongest,
            "bbox": [S, W, N, E],
            "image_px": [Wd, H],
            "compute_s": round(time.time() - t0, 3),
        },
        "validation": validation,
        "thumbnail_b64": thumb_b64,
    }
    json.dump(out, sys.stdout)

if __name__ == "__main__":
    main()
