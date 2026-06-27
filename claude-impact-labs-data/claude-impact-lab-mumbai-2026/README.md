# Claude Impact Lab — Mumbai 2026
## Missing Persons at Kumbh Mela 2027: Dataset Package

### Problem Statement
Over 80 million pilgrims attend the Nashik-Trimbakeshwar Simhastha Kumbh Mela. At this scale, thousands of people go missing every day, mostly elderly pilgrims separated from their families. The current system relies on manual lost-and-found centers with **no cross-search between centers**: a found person registered at Center A is invisible to a family searching at Center B. Your task is to build a solution that closes this gap.

---

### Datasets Included

#### 1. `Synthetic_Missing_Persons_2500.csv`
2,500 **synthetic (fake) records** modeled on real Kumbh Mela missing-person patterns. No real personal data.

| Field | Description |
|---|---|
| case_id | Unique case identifier (KMP-2027-XXXXX) |
| reported_at | Date and time case was reported (YYYY-MM-DD HH:MM) |
| missing_person_name | Name of missing person, often blank (15% missing) |
| gender | Male / Female / Unknown |
| age_band | Age range: 0-12, 13-17, 18-40, 41-60, 61-70, 71-80, 80+ |
| state | State of origin |
| district | District of origin |
| language | Primary language spoken |
| last_seen_location | Where they were last seen |
| reporting_center | Which lost-and-found center filed the report |
| reporter_mobile | Mobile of family member, often blank (20% missing) |
| physical_description | Free-text, often vague or blank |
| status | Reunited / Pending / Transferred to hospital / Unresolved |
| resolution_hours | Time to reunification (blank if unresolved) |
| is_duplicate_report | True if same person reported at multiple centers (8%) |
| remarks | Volunteer/operator notes |

**Key patterns:** cases spike 4-5x on Amrit Snan days; 61-70 age band is the largest group; 8% are duplicate reports across centers (the core matching problem); 15% have no name, 20% no mobile; ~85% resolved, ~3% unresolved.

---

#### 2. `CCTV_Locations.csv`
**1,280 CCTV cameras** across 32 zones. GPS coordinates only, no footage.

| Field | Description |
|---|---|
| camera_id | Camera identifier (Z{zone}-C{number}) |
| longitude | GPS longitude |
| latitude | GPS latitude |

Use to find which zones have camera coverage near any reported location.

---

#### 3. `Zone_Boundaries.csv`
The **32 CCTV administrative zones** across the grounds. Use centroids for fast zone lookup and scoring; use `Area_Boundaries.geojson` when you need the actual polygon.

| Field | Description |
|---|---|
| zone_name | Zone label (e.g. `Zone Area 1`) |
| area_type | Always `cctv_zone` |
| centroid_lat | Center latitude (derived from polygon) |
| centroid_lng | Center longitude (derived from polygon) |
| boundary_point_count | Polygon vertex count |

---

#### 4. `Area_Boundaries.geojson`
**53 boundary polygons** extracted from the CCTV map: the 32 CCTV zones plus **21 sacred/transit sub-areas** (ghats, Ram Kund, railway station, CBS hub, etc.). Load in Leaflet/Mapbox for zone overlays, point-in-polygon checks, and resolving vague landmarks ("near Ramkund") to a zone.

Each feature has: `name`, `area_type` (`cctv_zone` or `special_area`), `subtype` (`cctv_zone` / `ghat` / `transit_hub` / `landmark`), `centroid_lat`, `centroid_lng`, `boundary_point_count`.

---

#### 5. `Special_Areas.csv`
Quick lookup table for the **21 non-zone polygons** (ghats, kunds, transit hubs) also present in `Area_Boundaries.geojson`.

| Field | Description |
|---|---|
| area_name | Named area (e.g. `Ram Kund`, `Nashik Road Railway Station`) |
| subtype | `ghat`, `transit_hub`, or `landmark` |
| centroid_lat | Center latitude |
| centroid_lng | Center longitude |
| boundary_point_count | Polygon vertex count |

---

#### 6. `Police_Stations.csv`
**14 police stations** across Nashik serving the mela area. Real locations.

| Field | Description |
|---|---|
| station_name | Police station name |
| longitude | GPS longitude |
| latitude | GPS latitude |

Use to route a found person or family to the nearest help point, or to model response coverage.

---

#### 7. `Chokepoints_Parking.csv`
**85 mapped points** across the mela: traffic chokepoints, transfer nodes and parking zones. Real locations with crowd-risk metadata.

| Field | Description |
|---|---|
| location_name | Name of the point |
| category | Traffic choke point / No-vehicle pressure zone / Transfer node / Parking / Outer parking / Parking belt |
| risk_level | Crowd/separation risk: `very high`, `high`, or `medium` |
| status | Planning status (e.g. `confirmed 2027 project`, `confirmed Kumbh pressure zone`) |
| longitude | GPS longitude |
| latitude | GPS latitude |
| source_url | Reference URL for the location/risk assessment |
| note | Plain-language context for operators and ICCC |

Breakdown: 26 traffic chokepoints, 11 transfer nodes, 3 no-vehicle pressure zones, 30 parking, 10 outer parking, 5 parking belts. **6 very-high-risk** points (Dwarka corridor, Ramkund zone, railway station, etc.). Use `risk_level` to prioritize Mode C hotspot alerts and chokepoint-aware match confidence.

---

### Key Insights for Building

1. **The cross-center search gap is the real problem.** A unified, searchable registry across all centers is the highest-impact build.
2. **Offline-first matters.** Networks collapse at peak density near ghats and on snan days.
3. **Don't assume a smartphone.** The at-risk group (elderly, rural, multilingual) often has none, so design a human-operated fallback.
4. **For ML, use pre-trained models, not train-from-scratch.** The data is for testing your pipeline, not training.
5. **Use the geography.** Chokepoints and transfer nodes predict where separations cluster; police stations and CCTV zones tell you where help and coverage already exist.

---

### Judging Criteria
- Deployability (could this run at scale?)
- Real-world fit (does it solve a real failure?)
- UX (works for phoneless, non-literate users?)
- System design (offline, duplicate, incomplete data?)
- Responsible data handling (privacy by design?)

---

### Data Credits
CCTV, police station, chokepoint and parking location data provided by Kumbhathon Innovation Foundation.
Zone polygons and chokepoint risk metadata were extracted from source KML maps into `Area_Boundaries.geojson` and enriched CSV columns.
Synthetic missing-person dataset generated for Claude Impact Lab, Mumbai 2026.
All missing-person records are fake. No real personal data is present in any file.

---

*India's First Claude Impact Lab | 27 June 2026 | RIIDL, Somaiya Vidyavihar University, Mumbai*
*Organized and hosted by Sumeet Doshi, Claude Community Ambassador India*
*In partnership with Kumbhathon Innovation Foundation and the Government of Maharashtra*
