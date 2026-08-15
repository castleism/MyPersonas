export const GEMINI_NATIVE_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta";
export const GEMINI_IMAGE_MODEL = "gemini-3.1-flash-image";
export const MAX_GEMINI_IMAGE_REQUEST_BYTES = 12 * 1024 * 1024;
export const MAX_BASE_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_BASE_IMAGE_BASE64_CHARS = Math.ceil(MAX_BASE_IMAGE_BYTES / 3) *
  4;

const GOOGLE_IMAGE_PROVIDERS = new Set(["google", "google_legacy"]);
const INPUT_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export type GeminiBaseImage = {
  mimeType: string;
  data: string;
  decodedBytes: number;
};

export function isGoogleImageProvider(value: unknown): boolean {
  return typeof value === "string" &&
    GOOGLE_IMAGE_PROVIDERS.has(value.trim().toLowerCase());
}

export function pinnedGeminiImageModel(override: unknown): string {
  if (override === undefined || override === null || override === "") {
    return GEMINI_IMAGE_MODEL;
  }
  if (
    typeof override !== "string" ||
    override.trim() !== GEMINI_IMAGE_MODEL
  ) {
    throw new Error(`Only ${GEMINI_IMAGE_MODEL} is supported`);
  }
  return GEMINI_IMAGE_MODEL;
}

export function geminiGenerateContentUrl(override?: unknown): string {
  const model = pinnedGeminiImageModel(override);
  return `${GEMINI_NATIVE_BASE_URL}/models/${model}:generateContent`;
}

export function decodedBase64ByteLength(
  value: string,
  maxBytes = Number.MAX_SAFE_INTEGER,
): number {
  if (
    !value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    throw new Error("Base image data must be canonical base64");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const decodedBytes = value.length / 4 * 3 - padding;
  if (!Number.isSafeInteger(decodedBytes) || decodedBytes <= 0) {
    throw new Error("Base image data is invalid");
  }
  if (decodedBytes > maxBytes) {
    throw new Error("Base image exceeds the decoded-byte limit");
  }
  return decodedBytes;
}

export function parseGeminiBaseImage(value: unknown): GeminiBaseImage | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new Error("Base image must be a data URL");
  }

  const comma = value.indexOf(",");
  if (comma < 0 || comma > 64) {
    throw new Error("Base image must be a supported data URL");
  }
  const metadata = value.slice(0, comma).toLowerCase();
  const match = /^data:(image\/(?:jpeg|png|webp));base64$/.exec(metadata);
  if (!match || !INPUT_IMAGE_MIME_TYPES.has(match[1])) {
    throw new Error("Base image must be JPEG, PNG, or WebP");
  }

  // Check the encoded and decoded limits before slicing or decoding the payload.
  const dataStart = comma + 1;
  const encodedLength = value.length - dataStart;
  if (encodedLength <= 0 || encodedLength > MAX_BASE_IMAGE_BASE64_CHARS) {
    throw new Error("Base image exceeds the encoded-byte limit");
  }
  const data = value.slice(dataStart);
  const decodedBytes = decodedBase64ByteLength(data, MAX_BASE_IMAGE_BYTES);
  return { mimeType: match[1], data, decodedBytes };
}
