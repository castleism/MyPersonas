# Platform production and compliance notes

Verified August 8, 2026 from official platform sources. Recheck immediately before publishing because platform capabilities and policies change.

## Instagram

- Native photo uploads preserve quality up to 1080 pixels wide and currently support aspect ratios from 1.91:1 through 3:4: https://www.facebook.com/help/1631821640426723/
- The official publishing API remains narrower for still images: JPEG, sRGB, 320–1440 pixels wide, maximum 8 MB, and aspect ratios from 4:5 through 1.91:1: https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media
- API caption ceiling: 2,200 characters, 30 hashtags, and 20 mentions. Alt-text ceiling: 1,000 characters.
- Recommendation eligibility should be checked through Account Status; eligibility does not guarantee recommendation: https://www.facebook.com/help/instagram/653964212890722
- Current campaign export: 1080 x 1350 sRGB JPEG, 4:5, under 5 MB. This preserves portrait presence and future official-API compatibility.
- When the API supports it, set `is_ai_generated=true`. Preserve visible caption disclosure and any C2PA/IPTC provenance metadata.

## Facebook

- Facebook supports ordinary photo uploads in common formats and recommends files under 15 MB; PNG files above 1 MB may appear pixelated: https://www.facebook.com/help/121317464722113
- Facebook publishes no single universal organic Feed-photo aspect or pixel recommendation. The campaign's 1200 x 1500, 4:5 JPEG is a mobile-feed production decision, not a claimed official optimum.
- Account Status should be checked for recommendation, standards, feature, and monetization restrictions: https://www.facebook.com/help/1392616391875085/
- Meta states that it is prioritizing original material and reducing distribution for unoriginal or minimally altered work: https://about.fb.com/news/2026/03/rewarding-original-creators-on-facebook/
- Add the platform-native alt text manually if the eventual publishing route does not preserve it.

## X

- Standard posts support 280 characters and up to four media items: https://help.x.com/en/using-x/how-to-post
- Ordinary images may be JPEG, PNG, or GIF up to 5 MB. Single images with standard aspect ratios between 2:1 and 3:4 display in full: https://help.x.com/en/using-x/posting-gifs-and-pictures
- Image descriptions support up to 1,000 characters: https://help.x.com/en/using-x/picture-descriptions
- X prohibits bulk duplication, repeated near-identical posts, artificial engagement, deceptive identities, and harmful deceptive synthetic media: https://help.x.com/en/rules-and-policies/authenticity
- Current campaign export: 1600 x 900 sRGB JPEG, 16:9, under 5 MB.

## AI and fictional-character disclosure

- Meta may display `AI info` when supported metadata is detected or the uploader discloses AI generation: https://about.fb.com/news/2024/04/metas-approach-to-labeling-ai-generated-content-and-manipulated-media/
- X permits non-deceptive synthetic media but may label synthetic or manipulated media; harmful deceptive presentation is prohibited.
- WAIS uses a higher voluntary standard: every launch caption says that the character is fictional and the visual is AI-assisted. Real-science posts identify themselves as evergreen explanations and link to primary sources in the approval pack.

## Originality safeguards

- Twenty-five final platform assets use independently generated source scenes. Five exports use distinct crops or zooms from a sibling generated source after the built-in image generator lost authorization during the final batch or visual QA found the original composition ambiguous: Facebook 06, X 06, X 07, Instagram 09, and X 09.
- All thirty final exports differ in framing or composition, pixel dimensions, caption depth, and accessibility description. The five derivative variants are identified in `ASSET-MANIFEST.csv`; they can be independently regenerated after image-generation authorization is restored if the owner requires that stricter standard.
- No watermarks, copied characters, licensed music, scraped imagery, engagement pods, fake followers, follow churn, or unsolicited automated replies are included.
- All platform states remain `awaiting_owner_approval`; no platform scheduler or external API has been called.
