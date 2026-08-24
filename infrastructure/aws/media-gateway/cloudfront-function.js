function mediaGatewayReject(statusCode, statusDescription) {
  return {
    statusCode: statusCode,
    statusDescription: statusDescription,
    headers: {
      "cache-control": { value: "no-store, max-age=0" },
      "content-security-policy": { value: "default-src 'none'" },
      "referrer-policy": { value: "no-referrer" },
      "x-content-type-options": { value: "nosniff" }
    }
  };
}

function handler(event) {
  var request = event.request;
  var headers = request.headers || {};
  var host = headers.host && headers.host.value || "";
  var query = request.querystring || {};
  var uri = request.uri || "";
  var persona = /^\/persona\/v1\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
  var approved = /^\/approved\/v1\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

  // The distribution hostname is not an alternate public URL. Only the exact
  // reviewed first-party host is canonical.
  if (host !== "${MediaGatewayHostname}") return mediaGatewayReject(404, "Not Found");
  if (request.method !== "GET" && request.method !== "OPTIONS") {
    return mediaGatewayReject(405, "Method Not Allowed");
  }
  if (Object.keys(query).length !== 0 || uri.length > 128 ||
      uri.indexOf("%") !== -1 || uri.indexOf("\\") !== -1) {
    return mediaGatewayReject(404, "Not Found");
  }

  // A viewer-supplied copy is removed. CloudFront adds/overwrites the real
  // origin header after this viewer-request function has returned.
  delete request.headers["x-mypersonas-media-gateway"];

  var match = uri.match(persona);
  if (match) {
    request.uri = "/functions/v1/public-media/" + match[1];
    request.querystring = {};
    return request;
  }

  match = uri.match(approved);
  if (match) {
    if (request.method !== "GET") return mediaGatewayReject(405, "Method Not Allowed");
    request.uri = "/functions/v1/approved-media/" + match[1];
    request.querystring = {};
    return request;
  }
  return mediaGatewayReject(404, "Not Found");
}
