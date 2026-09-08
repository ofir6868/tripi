# Fonts

The two typefaces the site is set in, served from this origin instead of from
Google's CDN. `public/css/style.css` carries the `@font-face` rules; the pages
preload the two Hebrew faces, the only ones above the fold on a Hebrew page.

Why they live here: as a Google Fonts `<link>` they cost first paint two cold
origins in a row — `fonts.googleapis.com` for a render-blocking stylesheet, then
`fonts.gstatic.com` for the files — a DNS lookup, a TCP handshake and a TLS
negotiation each, before a single pixel. From here they arrive on the connection
the page is already using.

Both families are licensed under the **SIL Open Font License 1.1**, which permits
hosting them like this.

| file | family | subset | source |
| --- | --- | --- | --- |
| `assistant-hebrew.woff2` | Assistant v24 (variable, wght 200–800) | hebrew | [Assistant on Google Fonts](https://fonts.google.com/specimen/Assistant) |
| `assistant-latin.woff2` | Assistant v24 (variable, wght 200–800) | latin | ” |
| `assistant-latin-ext.woff2` | Assistant v24 (variable, wght 200–800) | latin-ext | ” |
| `suez-one-hebrew.woff2` | Suez One v15 (static, 400) | hebrew | [Suez One on Google Fonts](https://fonts.google.com/specimen/Suez+One) |
| `suez-one-latin.woff2` | Suez One v15 (static, 400) | latin | ” |
| `suez-one-latin-ext.woff2` | Suez One v15 (static, 400) | latin-ext | ” |

## Replacing or adding a face

The files are served `immutable` for a year (see `server.js`), so **a changed font
needs a changed filename** — new bytes under an old name reach nobody who has
already visited. Give the new file a name that says what it is and update both the
`@font-face` rules in `style.css` and the `<link rel="preload">` tags.

To refresh from Google, ask its API with a browser User-Agent (it serves woff2
only to browsers that can read it), then take the URLs out of the CSS it returns:

    curl -A "Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36" \
      'https://fonts.googleapis.com/css2?family=Suez+One&family=Assistant:wght@300;400;600;700;800&display=swap'

Keep the `unicode-range` values in `style.css` in step with that CSS: they are what
stops a Hebrew page from ever fetching the 22kB Latin subset it has no glyph for.
