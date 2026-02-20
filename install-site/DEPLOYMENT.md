# Deployment Guide

This site can be deployed to any static hosting service. No build step required.

## Quick Start

### Local Testing

```bash
./serve.sh
# Visit http://localhost:8000
```

## Deployment Options

### Option 1: GitHub Pages

1. Push the `install-site` folder to your repository
2. Go to repository Settings > Pages
3. Select branch and `/install-site` folder
4. Save and wait for deployment

**URL**: `https://yourusername.github.io/repo-name/`

### Option 2: Netlify

**Via Drag & Drop**:
1. Visit https://app.netlify.com/drop
2. Drag the `install-site` folder
3. Done!

**Via CLI**:
```bash
npm install -g netlify-cli
cd install-site
netlify deploy --prod
```

### Option 3: Vercel

```bash
npm install -g vercel
cd install-site
vercel --prod
```

### Option 4: Cloudflare Pages

1. Go to https://pages.cloudflare.com
2. Connect your Git repository
3. Build settings:
   - Build command: (leave empty)
   - Build output directory: `/install-site`
4. Deploy

### Option 5: AWS S3 + CloudFront

```bash
aws s3 sync . s3://your-bucket-name --delete
aws cloudfront create-invalidation --distribution-id YOUR_DIST_ID --paths "/*"
```

### Option 6: Any Web Server

Upload files to your web server's public directory:

```bash
# Via SCP
scp -r install-site/* user@server:/var/www/html/

# Via rsync
rsync -avz install-site/ user@server:/var/www/html/
```

## Pre-Deployment Checklist

- [ ] Update `RELEASE_BASE_URL` in `install.js` with actual GitHub release URL
- [ ] Replace placeholder screenshots with real extension screenshots
- [ ] Update footer links in `index.html` (GitHub, website, support email)
- [ ] Test on multiple browsers (Chrome, Firefox, Edge, Safari)
- [ ] Test on mobile devices
- [ ] Verify all download links work
- [ ] Check browser detection logic
- [ ] Add actual favicon.ico file (use online converter for SVG → ICO)
- [ ] Update meta tags for SEO if needed
- [ ] Add analytics (Google Analytics, Plausible, etc.) if desired

## Custom Domain

### Netlify
```bash
netlify domains:add yourdomain.com
```

### Vercel
```bash
vercel domains add yourdomain.com
```

### Cloudflare Pages
Add custom domain in dashboard under Custom domains

## SSL/HTTPS

All recommended hosting providers (GitHub Pages, Netlify, Vercel, Cloudflare) provide free SSL certificates automatically.

## Performance Optimization

The site is already optimized:
- No external dependencies
- Inline CSS and JS
- SVG icons (scalable, small file size)
- Lazy-loaded images (native browser support)
- Minified on deployment (automatic with most hosts)

### Optional: Manual Minification

```bash
# Install tools
npm install -g html-minifier clean-css-cli terser

# Minify
html-minifier --collapse-whitespace --remove-comments index.html -o index.min.html
cleancss -o styles.min.css styles.css
terser install.js -o install.min.js

# Update script/link tags in index.html to use .min versions
```

## Monitoring

Add uptime monitoring:
- UptimeRobot (free)
- Pingdom
- StatusCake
- Better Uptime

## Analytics (Optional)

Add analytics by inserting tracking code before `</head>` in `index.html`:

**Google Analytics**:
```html
<script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXXXXXXXX"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-XXXXXXXXXX');
</script>
```

**Plausible** (privacy-friendly):
```html
<script defer data-domain="yourdomain.com" src="https://plausible.io/js/script.js"></script>
```

## Security Headers

Add security headers via `_headers` file (Netlify/Cloudflare Pages):

```
/*
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  X-XSS-Protection: 1; mode=block
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: geolocation=(), microphone=(), camera=()
```

Or via `vercel.json` (Vercel):

```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "X-Frame-Options", "value": "DENY" },
        { "key": "X-Content-Type-Options", "value": "nosniff" }
      ]
    }
  ]
}
```

## Troubleshooting

**Issue**: Browser detection not working
- Check that JavaScript is enabled
- Verify `install.js` is loaded correctly
- Check browser console for errors

**Issue**: Images not loading
- Verify all asset paths are correct
- Check file permissions on server
- Ensure files were uploaded correctly

**Issue**: Styles not applying
- Check `styles.css` path in `index.html`
- Verify CSS file uploaded correctly
- Clear browser cache

## Support

For issues or questions, refer to the main repository README or contact support.
