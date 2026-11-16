"use strict";
// Google tag for the STS2 Tracker, exactly what Google's "Install manually" page gives:
//
//   <script async src="https://www.googletagmanager.com/gtm.js?id=GTM-PTM5ZFBX"></script>
//   <script> window.dataLayer = window.dataLayer || [];
//            function gtag(){dataLayer.push(arguments);}  gtag('js', new Date()); </script>
//
// It lives in this file because the site's Content-Security-Policy (vercel.json and server.js)
// forbids inline scripts, and that policy also lists the Google domains the tag needs.
// Google says to add only ONE Google tag per page, so don't add a second tag (for example a
// direct G-... gtag.js snippet) elsewhere: visits would be counted twice. What gets measured
// (which analytics property and events it reports to) is configured inside the container on Google's side.
(function () {
  const CONTAINER_ID = "GTM-PTM5ZFBX";

  // Don't count local development, so test clicks never show up in the real reports.
  const host = window.location.hostname;
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host.endsWith(".local")
  )
    return;

  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtm.js?id=${CONTAINER_ID}`;
  document.head.append(script);

  window.dataLayer = window.dataLayer || [];
  function gtag() {
    window.dataLayer.push(arguments);
  }
  window.gtag = gtag;
  gtag("js", new Date());
})();
