#!/usr/bin/env python3
"""One-time enrichment: extract zone polygons and chokepoint metadata from KML into CSV/GeoJSON."""

from __future__ import annotations

import csv
import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

KML_NS = "http://www.opengis.net/kml/2.2"
DATA_DIR = Path(__file__).resolve().parent.parent / "data"

DESC_PATTERN = re.compile(
    r"Category:\s*(?P<category>[^|]+)\|\s*Status:\s*(?P<status>[^|]+)\|\s*"
    r"Risk:\s*(?P<risk>[^|]+)\|\s*Source:\s*(?P<source>[^|]+)\|\s*Note:\s*(?P<note>.+)",
    re.DOTALL,
)


def polygon_centroid(coords: list[list[float]]) -> tuple[float, float]:
    lons = [c[0] for c in coords]
    lats = [c[1] for c in coords]
    return sum(lats) / len(lats), sum(lons) / len(lons)


def close_ring(coords: list[list[float]]) -> list[list[float]]:
    if coords and coords[0] != coords[-1]:
        return coords + [coords[0]]
    return coords


def classify_subtype(name: str) -> str:
    lower = name.lower()
    if "ghat" in lower or "kund" in lower:
        return "ghat"
    if any(token in lower for token in ("station", "cbs", "transit", "chowk", "bazar")):
        return "transit_hub"
    return "landmark"


def extract_polygons(kml_path: Path) -> tuple[list[dict], dict[str, dict], list[dict]]:
    tree = ET.parse(kml_path)
    features: list[dict] = []
    zone_updates: dict[str, dict] = {}
    special_rows: list[dict] = []

    for placemark in tree.iter(f"{{{KML_NS}}}Placemark"):
        name_el = placemark.find(f"{{{KML_NS}}}name")
        name = (name_el.text or "").strip() if name_el is not None else ""
        polygon = placemark.find(f".//{{{KML_NS}}}Polygon")
        if polygon is None:
            continue

        coords_el = polygon.find(f".//{{{KML_NS}}}coordinates")
        if coords_el is None or not coords_el.text:
            continue

        coords = [
            [float(parts[0]), float(parts[1])]
            for token in coords_el.text.strip().split()
            if (parts := token.split(",")) and len(parts) >= 2
        ]
        coords = close_ring(coords)
        lat, lon = polygon_centroid(coords)
        area_type = "cctv_zone" if name.startswith("Zone Area ") else "special_area"
        boundary_point_count = len(coords) - 1 if coords[0] == coords[-1] else len(coords)
        props = {
            "name": name,
            "area_type": area_type,
            "subtype": "cctv_zone" if area_type == "cctv_zone" else classify_subtype(name),
            "centroid_lat": round(lat, 6),
            "centroid_lng": round(lon, 6),
            "boundary_point_count": boundary_point_count,
        }
        features.append(
            {
                "type": "Feature",
                "properties": props,
                "geometry": {"type": "Polygon", "coordinates": [coords]},
            }
        )
        if area_type == "special_area":
            special_rows.append(
                {
                    "area_name": name,
                    "subtype": props["subtype"],
                    "centroid_lat": props["centroid_lat"],
                    "centroid_lng": props["centroid_lng"],
                    "boundary_point_count": boundary_point_count,
                }
            )
        else:
            zone_updates[name] = props

    return features, zone_updates, special_rows


def enrich_chokepoints(kml_path: Path, csv_path: Path) -> list[dict]:
    tree = ET.parse(kml_path)
    kml_meta: dict[str, dict[str, str]] = {}
    for placemark in tree.iter(f"{{{KML_NS}}}Placemark"):
        name_el = placemark.find(f"{{{KML_NS}}}name")
        desc_el = placemark.find(f"{{{KML_NS}}}description")
        name = (name_el.text or "").strip() if name_el is not None else ""
        desc = (desc_el.text or "").strip() if desc_el is not None else ""
        match = DESC_PATTERN.match(desc)
        if not match:
            raise RuntimeError(f"Could not parse chokepoint description for {name!r}")
        kml_meta[name] = {key: match.group(key).strip() for key in ("category", "status", "risk", "source", "note")}

    rows = []
    with csv_path.open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            name = row["location_name"]
            if name not in kml_meta:
                raise RuntimeError(f"Chokepoint missing in KML: {name}")
            meta = kml_meta[name]
            rows.append(
                {
                    "location_name": name,
                    "category": row["category"],
                    "risk_level": meta["risk"],
                    "status": meta["status"],
                    "longitude": row["longitude"],
                    "latitude": row["latitude"],
                    "source_url": meta["source"],
                    "note": meta["note"],
                }
            )
    return rows


def main() -> int:
    cctv_kml = DATA_DIR / "CCTV Dataset.kml"
    choke_kml = DATA_DIR / "nashik_kumbh_chokepoints_parking_map.kml"
    if not cctv_kml.exists() or not choke_kml.exists():
        print("KML source files not found; enrichment already applied or sources missing.", file=sys.stderr)
        return 1

    features, zone_updates, special_rows = extract_polygons(cctv_kml)
    geojson_path = DATA_DIR / "Area_Boundaries.geojson"
    with geojson_path.open("w", encoding="utf-8") as handle:
        json.dump({"type": "FeatureCollection", "features": features}, handle, indent=2)
        handle.write("\n")

    with (DATA_DIR / "Special_Areas.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=["area_name", "subtype", "centroid_lat", "centroid_lng", "boundary_point_count"],
        )
        writer.writeheader()
        writer.writerows(sorted(special_rows, key=lambda row: row["area_name"]))

    zone_rows = []
    with (DATA_DIR / "Zone_Boundaries.csv").open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            update = zone_updates.get(row["zone_name"])
            zone_rows.append(
                {
                    "zone_name": row["zone_name"],
                    "area_type": "cctv_zone",
                    "centroid_lat": update["centroid_lat"] if update else row["centroid_lat"],
                    "centroid_lng": update["centroid_lng"] if update else row["centroid_lng"],
                    "boundary_point_count": update["boundary_point_count"]
                    if update
                    else row.get("boundary_point_count", row.get("approx_boundary_points")),
                }
            )

    with (DATA_DIR / "Zone_Boundaries.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=["zone_name", "area_type", "centroid_lat", "centroid_lng", "boundary_point_count"],
        )
        writer.writeheader()
        writer.writerows(zone_rows)

    choke_rows = enrich_chokepoints(choke_kml, DATA_DIR / "Chokepoints_Parking.csv")
    with (DATA_DIR / "Chokepoints_Parking.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=[
                "location_name",
                "category",
                "risk_level",
                "status",
                "longitude",
                "latitude",
                "source_url",
                "note",
            ],
        )
        writer.writeheader()
        writer.writerows(choke_rows)

    print(f"Wrote {geojson_path.name}: {len(features)} polygons")
    print(f"Wrote Special_Areas.csv: {len(special_rows)} rows")
    print(f"Updated Zone_Boundaries.csv: {len(zone_rows)} rows")
    print(f"Updated Chokepoints_Parking.csv: {len(choke_rows)} rows")
    return 0


if __name__ == "__main__":
    sys.exit(main())
