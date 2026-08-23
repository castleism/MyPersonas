// sitemap — per-persona sitemap.xml generated from the personas table.
// Roadmap v0.5 ("Auto-generated per-persona sitemap"). Serves every public persona
// as its own URL so search engines can discover them.
//
// Deploy:  supabase functions deploy sitemap --no-verify-jwt
// Then point https://aliaspaces.com/sitemap.xml at it (see DEPLOY.md) or submit
// the function URL directly in Search Console.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SITE = "https://aliaspaces.com";

serve(async () => {
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data, error } = await admin.rpc("public_reviewed_persona_sitemap");
  if (error || !Array.isArray(data)) {
    return new Response("Sitemap is temporarily unavailable", {
      status: 503,
      headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
    });
  }

  const esc = (s: string) => s.replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c] as string));

  const urls = [`<url><loc>${SITE}/</loc><changefreq>daily</changefreq></url>`];
  for (const p of data || []) {
    const lastmod = String(p.last_modified_at || "").slice(0, 10);
    urls.push(
      `<url><loc>${SITE}/#/p/${esc(p.handle)}</loc>` +
      (lastmod ? `<lastmod>${lastmod}</lastmod>` : "") +
      `<changefreq>weekly</changefreq></url>`,
    );
  }
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>`;

  return new Response(xml, {
    headers: { "Content-Type": "application/xml", "Cache-Control": "public, max-age=3600" },
  });
});
