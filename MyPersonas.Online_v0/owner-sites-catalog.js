(() => {
  "use strict";

  // Public owner check-list only. Every URL is already documented in-repo.
  // Do not add shop, affiliate, or unpublished destinations here.
  window.OWNER_SITES_CATALOG = Object.freeze({
    updated: "2026-09-24",
    websites: Object.freeze([
      {
        id: "aliaspaces",
        name: "AliaSpaces / MyPersonas",
        url: "./",
        openLabel: "Open website",
        note: "Public persona network. Install from the home page as the AliaSpaces browser app."
      },
      {
        id: "nooyouniverse",
        name: "Noo Youniverse",
        url: "https://nooyouniverse.com/",
        openLabel: "Open website",
        note: "Cillian's live evidence-labeled site. Add to Home screen from Chrome on that origin if you want a separate icon."
      },
      {
        id: "beingteaco",
        name: "Being Tea Co.",
        url: "https://beingteaco.com/",
        openLabel: "Open website",
        note: "Akiko Sasaki is the public host. Brother Kāruṇya is retired. No shop links are added here."
      },
      {
        id: "castleborn",
        name: "Castleborn",
        url: "https://castleborn.online",
        openLabel: "Open website",
        note: "External Castleborn home. Family details stay private-by-default."
      }
    ]),
    apps: Object.freeze([
      {
        id: "aliaspaces-pwa",
        name: "AliaSpaces app",
        url: "./",
        openLabel: "Open / install",
        note: "The website packaged as a standalone browser app. Android Chrome: menu → Install app or Add to Home screen."
      },
      {
        id: "owner-home",
        name: "Owner command center",
        url: "./#/owner",
        openLabel: "Open owner home",
        note: "Signed-in owner app for personas, briefings, and post review. Part of the AliaSpaces PWA."
      },
      {
        id: "owner-check",
        name: "Owner check list",
        url: "./owner-phone.html",
        openLabel: "Open check list",
        note: "This launch pad. Install it as its own Android home-screen app so every site and in-dev app is one tap away."
      },
      {
        id: "owner-sites",
        name: "Signed-in sites view",
        url: "./#/sites",
        openLabel: "Open in owner app",
        note: "Same inventory inside the signed-in owner shell."
      },
      {
        id: "workroom-bridge",
        name: "Workroom Bridge",
        url: "",
        openLabel: "",
        note: "Desktop Electron scaffold only (apps/workroom-bridge). Not an Android app and not packaged for the phone."
      },
      {
        id: "gemini-console",
        name: "Gemini research console",
        url: "",
        openLabel: "",
        note: "Local repo file gemini-research-console.html. It is not in the Pages artifact, so it cannot be installed from the live site."
      }
    ])
  });
})();
