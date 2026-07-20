// Versioned, content-only erasure endpoint. The immutable handler option makes
// it impossible for URL rewriting or a request body to select account deletion.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createErasureHandler } from "../delete-account/index.ts";

serve(createErasureHandler({ contentOnly: true }));
