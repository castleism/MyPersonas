# Akiko profile-asset QA

Status: **AWAITING_OWNER**  
Prepared: 2026-08-09  
Scope: local proposals only; no profile, Page, account, or composer was changed.

## Outcome

The package now includes a square Akiko profile portrait, platform-sized Facebook and X exports, a responsive Facebook Page cover, an official fast-load-size Facebook alternative, an X header, and a review contact sheet. All upload candidates are RGB JPEGs with embedded sRGB profiles, zero EXIF entries, unique SHA-256 hashes, and small file sizes.

The private owner-supplied visual reference was not used, copied into this folder, or exposed to the image generator. The sole identity reference was `../identity/akiko-canonical-portrait-v2.png` (SHA-256 `09F118DA30AC2B6C6D4920193FED5DD46FA1484A0DF5198663D0F5DC59C254AF`).

## Current official dimensional guidance

- Facebook says a Page profile picture should be 320 x 320 for best quality and will display as a circle. Its current Page-cover guidance says the cover is full bleed at 16:9, can be responsively cropped or resized, and may be partly covered on the left by the profile picture. It also lists an 851 x 315 sRGB JPEG under 100 KB as the faster-loading option. See [Facebook Page profile picture and cover photo dimensions](https://www.facebook.com/help/125379114252045).
- X recommends 400 x 400 for profile images and 1500 x 500 for headers. X also warns that approximately 60 pixels at the top and bottom of a header may crop on some displays. See [How to customize your X profile](https://help.x.com/articles/166743) and [Help with uploading a profile photo](https://help.x.com/en/managing-your-account/common-issues-when-uploading-profile-photo).

These are current source checks, not a substitute for a native composer preview. Platform rendering can vary by device and interface revision.

Source-availability note: both X Help pages opened normally during verification. A direct live open of the Facebook Help URL redirected to login and returned a temporary-block page in the research tool, although the current official-page crawl remained available. Facebook's wording is also ambiguous because it describes a responsive 16:9 full-bleed cover while separately naming 851 x 315 as the faster-loading file. That is why this package provides both a 1600 x 900 responsive proposal and an 851 x 315 under-100-KB alternative, with the native Page composer designated as the final arbiter.

## Technical verification

| File | Intended use | Dimensions | Bytes | RGB | sRGB embedded | EXIF | Visual result |
|---|---|---:|---:|---|---|---:|---|
| `akiko-profile-master-1024.jpg` | editable square master | 1024 x 1024 | 162,279 | yes | yes | 0 | face and hair have safe circular-crop margin |
| `akiko-profile-facebook-320.jpg` | Facebook profile | 320 x 320 | 23,368 | yes | yes | sharp at target size; circular preview still required |
| `akiko-profile-x-400.jpg` | X profile | 400 x 400 | 32,786 | yes | yes | sharp at target size; circular preview still required |
| `akiko-facebook-cover-1600x900.jpg` | responsive Facebook Page cover | 1600 x 900 | 159,405 | yes | yes | subject stays right; lower-left overlap area is quiet |
| `akiko-facebook-cover-fastload-851x315.jpg` | Facebook fast-load alternative | 851 x 315 | 31,189 | yes | yes | face remains clear; shallow crop trims some outer styling |
| `akiko-x-header-1500x500.jpg` | X header | 1500 x 500 | 92,496 | yes | yes | selected safe-zone revision keeps hair, face, hands, and vessels away from edges |
| `PROFILE-ASSET-CONTACT-SHEET.jpg` | owner review only | 1800 x 1500 | 255,659 | yes | yes | all primary proposals readable together |

Every row is recorded in `PROFILE-ASSET-MANIFEST.csv` with its SHA-256 hash.

## Visual and identity review

- Profile: recognizable continuity with the v2 fictional likeness; apparent early 30s; calm, attentive expression; modern charcoal and ivory tea-host layers; no logo, text, or claim of cultural authority.
- Facebook cover: coherent with the profile but deliberately wider and more environmental. The left side remains visually quiet for responsive cropping and profile-picture overlap.
- X header: a distinct side-on comparison scene, not an identical repost. The selected v2 source removed ornaments and pulled the camera back. The first X generation remains archived as `source-generations/x-header-source-v1-rejected-crop-risk.png` and is not an upload candidate because its hair silhouette was too close to the top edge.
- Cross-platform distinctness: the three primary assets share identity, light, materials, and tea-comparison language while changing framing, action, wardrobe detail, and visual hierarchy.
- No visible brands, text overlays, watermarks, third-party media, or product-performance claims appear.

## Owner decisions still required

1. Approve, deny, or revise the square likeness and modern-neutral wardrobe.
2. Decide whether the Facebook header should retain the subtle floral hair ornaments and earrings shown in the cover, or match the fully ornament-free X header.
3. Choose the 1600 x 900 responsive Facebook cover or the 851 x 315 fast-load alternative after native preview.
4. Preview the profile crop, Facebook cover on desktop and mobile, and X header in the official composers before any change is saved.
5. Reapprove any asset that is cropped, retouched, color-adjusted, or otherwise modified after this review.

Until those decisions are made, every asset remains **AWAITING_OWNER** and nothing is approved, staged to a provider, scheduled, or published.
