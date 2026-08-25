export async function resolve(specifier, context, nextResolve) {
  if (specifier === "npm:@imagemagick/magick-wasm@0.0.42") {
    return nextResolve("@imagemagick/magick-wasm", context);
  }
  return nextResolve(specifier, context);
}
