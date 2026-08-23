# Persona profile image cropping

## Released scope

Selecting a profile image, banner, page background, or feed header opens a local placement dialog before upload. Owners can drag, use the slider or plus/minus keys to zoom, reset, use arrow-key positioning, and inspect the crop in the actual square, card, desktop, and phone shapes that reuse the asset.

The first release supports static PNG, JPEG, and WebP files. GIF is intentionally excluded from Page Looks because browser canvas cropping would flatten the animation without warning. Generated Gemini assets keep their existing registered path and are not downloaded, re-cropped, or double-watermarked.

## Privacy, provenance, and security

- The selected file is decoded locally with its phone-photo orientation applied.
- Decoded images are limited to 48 megapixels; output dimensions are fixed by slot and remain below 2 megapixels.
- Canvas creates a new cropped copy and strips EXIF/GPS and most embedded metadata. The original local file is not uploaded or retained by MyPersonas.
- The exact encoded crop is hashed and sent to the authenticated `media-ingest` function.
- The owner's original AI-use answer follows the crop. When visible marking is required, the server applies the canonical watermark after cropping.
- A user/persona/route/field generation guard is checked before and after upload so an older request cannot overwrite a newer selection.
- Cancel, navigation, decode failure, and successful completion release the decoded bitmap or object URL and leave the prior persona field unchanged.

## Responsive behavior

One raster cannot exactly match every responsive `cover` ratio. The placement dialog therefore shows concrete downstream masks and a conservative safe region:

- profile image: circle, card, and rail previews;
- banner: desktop, persona-card, and phone previews;
- background: desktop and portrait-phone previews;
- feed header: header, wide-post, and square-box previews.

This is the production-compatible phase-one implementation. A later version may add bounded focal-point metadata and server-generated responsive renditions so owners can reposition an already-saved asset without selecting the local source again. That expansion requires a forward database migration, restore/export support, public projection rules, and server-side derivative tests; it must not be encoded into ad hoc URL fragments or unvalidated layout JSON.
