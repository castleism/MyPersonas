# Akiko / Being Tea Co. — Version 2 Asset QA

QA date: **2026-08-09**  
Asset state: **READY_FOR_OWNER_REVIEW**  
External state: **Not posted, staged, scheduled, or uploaded**

## Scope

This check covers the 30 final JPEG files under `images-v2/instagram`, `images-v2/facebook`, and `images-v2/x`, the new non-destructive `ASSET-MANIFEST-V2.csv`, and the four version-2 review contact sheets. The original version-1 files and manifest were not changed.

## Result

**PASS — 30 of 30 version-2 publication assets meet every requested technical check.**

- Exactly ten numbered JPEGs are present for each platform (`01.jpg` through `10.jpg`).
- All 30 hashes are unique.
- All files decode as JPEG in RGB mode.
- Every file has an embedded profile identified as `sRGB built-in`.
- Every file has zero EXIF entries.
- Every file is under 5,000,000 bytes; the largest is 395,449 bytes.
- The manifest was independently reconciled against the files for byte size, dimensions, and SHA-256 hash with zero mismatches.
- Every manifest row is gated as `READY_FOR_OWNER_REVIEW`, `disclosure_required=true`, and `owner_approval_required=true`.

## Platform checks

| Platform | Count | Required dimensions | Dimension result | Byte range | Total bytes | RGB | Embedded sRGB | EXIF-free | Under 5 MB |
|---|---:|---:|---|---:|---:|---|---|---|---|
| Instagram | 10 | 1080 × 1440 | 10/10 pass | 239,346–307,042 | 2,750,707 | 10/10 | 10/10 | 10/10 | 10/10 |
| Facebook | 10 | 1080 × 1350 | 10/10 pass | 333,034–395,449 | 3,608,564 | 10/10 | 10/10 | 10/10 | 10/10 |
| X | 10 | 1600 × 900 | 10/10 pass | 234,701–354,935 | 2,877,897 | 10/10 | 10/10 | 10/10 | 10/10 |
| **All final assets** | **30** | Platform-specific | **30/30 pass** | **234,701–395,449** | **9,237,168** | **30/30** | **30/30** | **30/30** | **30/30** |

## Manifest

- File: `ASSET-MANIFEST-V2.csv`
- Rows: 30
- SHA-256: `9b0c3dae7d8cb5ebe58eb9938c04008831e7a30cc91513eeb6ca3d23448a32a0`
- Reconciliation result: 30/30 rows match the current asset dimensions, byte counts, and SHA-256 hashes.

## Review contact sheets

These sheets are review artifacts only; the 30 final platform JPEGs were not resized, recompressed, or otherwise altered while the sheets were produced.

| Review sheet | Dimensions | Bytes | SHA-256 | QA |
|---|---:|---:|---|---|
| `images-v2/instagram-contact-sheet-v2.jpg` | 944 × 3171 | 790,705 | `48b50b4a9d208027f2b8e52b399f2dc6ad1c25a1c167bd7278356b0cced73ac9` | RGB, embedded sRGB, zero EXIF; all ten labels visible |
| `images-v2/facebook-contact-sheet-v2.jpg` | 944 × 3002 | 699,358 | `0daa712729769375c98ada6348ae01ffe502ce1e5b965e59d572aef82075a8e4` | Existing correct sheet preserved byte-for-byte |
| `images-v2/x-contact-sheet-v2.jpg` | 944 × 1476 | 363,744 | `9fc09f3cd6d4913b9d09741ddb512399043d8120d4c9cd447ef39e16a9bf6e3e` | RGB, embedded sRGB, zero EXIF; all ten labels visible |
| `CONTACT-SHEET-ALL-V2.jpg` | 1540 × 5024 | 1,422,376 | `0ad9ee2f8af5f45958c2059fe133e5c48f825c2e56f33b0602124bb2d38ac8d0` | All 30 assets shown in concept rows and labelled by platform/concept |

## Visual review

- All 30 assets appear in the combined sheet once, organized as ten concepts across Instagram, Facebook, and X.
- Akiko’s version-2 identity is visually consistent across the set: early-30s adult presentation, black sculptural updo, restrained blossom ornament, warm natural interiors, and the red ceremonial introduction followed by simpler forest/charcoal/ivory wardrobe.
- Platform crops are meaningfully different: intimate vertical Instagram framing, contextual vertical Facebook framing, and wide X framing.
- No review-sheet cropping or label omission was detected.

## Anomalies and limits

- **Requested technical anomalies: none.**
- This local QA does not simulate each platform’s uploaded preview, compression, accessibility UI, or account-side recommendation check. Those remain post-authorization checks.
- `READY_FOR_OWNER_REVIEW` is not owner approval and does not authorize scheduling or publication.
