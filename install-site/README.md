# PrivateDivi Wallet - Installation Site

Modern, responsive landing page for the PrivateDivi browser extension with automatic browser detection and installation instructions.

## Features

- **Browser Detection**: Automatically detects user's browser and shows appropriate install button
- **Responsive Design**: Works seamlessly on desktop, tablet, and mobile devices
- **Dark Mode**: Modern dark theme with light mode support via CSS media queries
- **Tab Navigation**: Easy switching between Chrome/Edge and Firefox installation instructions
- **Mobile Detection**: Shows helpful message for mobile users
- **Animated UI**: Smooth transitions, hover effects, and micro-interactions
- **Accessibility**: Semantic HTML, keyboard navigation, and ARIA labels

## Design Aesthetic

**Theme**: Dark, modern, tech-forward with gradient accents

**Typography**:
- System font stack for optimal performance
- Large, bold headings with gradient text effects
- Clear hierarchy and readability

**Color Palette**:
- Primary: Indigo gradient (#6366f1 → #8b5cf6)
- Background: Deep dark (#0a0a0f → #1e1e2e)
- Text: Light grays (#f8f9fa, #b4b8c5)
- Accents: Vibrant gradient with glow effects

**Motion**:
- Floating logo animation
- Smooth hover transitions
- Tab fade-in animations
- Card lift effects

## File Structure

```
install-site/
├── index.html          # Main page structure
├── styles.css          # Complete styling with dark theme
├── install.js          # Browser detection and tab logic
├── README.md           # This file
└── assets/
    ├── logo.svg        # PrivateDivi shield logo
    ├── favicon.svg     # Browser tab icon
    ├── favicon.ico     # Legacy favicon format
    ├── chrome.svg      # Chrome browser icon
    ├── firefox.svg     # Firefox browser icon
    ├── edge.svg        # Edge browser icon
    ├── brave.svg       # Brave browser icon
    ├── opera.svg       # Opera browser icon
    └── screenshots/
        ├── dashboard.png  # Dashboard screenshot
        ├── send.png       # Send transaction screenshot
        └── receive.png    # Receive screen screenshot

```

## Browser Support

The extension supports:
- Chrome
- Firefox
- Edge
- Brave
- Opera

Safari support coming soon.

## Customization

### Update Download URLs

Edit `install.js` and update the `RELEASE_BASE_URL`:

```javascript
const RELEASE_BASE_URL = 'https://github.com/your-org/divi-testnet/releases/latest/download';
```

### Add Real Screenshots

Replace the placeholder SVG screenshots in `assets/screenshots/` with actual PNG screenshots of the extension:

```bash
# Take screenshots at 800x500px or 1600x1000px (2x for retina)
# Replace these files:
assets/screenshots/dashboard.png
assets/screenshots/send.png
assets/screenshots/receive.png
```

### Update Links

Edit `index.html` footer section to update:
- GitHub repository URL
- PrivateDivi website URL
- Support email

### Theme Colors

Edit CSS variables in `styles.css`:

```css
:root {
  --accent-primary: #6366f1;     /* Change primary color */
  --accent-secondary: #8b5cf6;   /* Change secondary color */
  /* ... other variables ... */
}
```

## Deployment

### Static Hosting

This site is pure HTML/CSS/JS with no build step required. Deploy to:

- **GitHub Pages**: Push to gh-pages branch
- **Netlify**: Drag and drop the folder
- **Vercel**: Connect repository and deploy
- **Cloudflare Pages**: Connect and deploy

### Local Development

Simply open `index.html` in a browser:

```bash
open index.html
# or
python3 -m http.server 8000
# then visit http://localhost:8000
```

## SEO & Performance

- Semantic HTML5 structure
- Meta viewport for mobile
- Fast load time (no external dependencies)
- Accessible color contrast ratios
- Keyboard navigation support

## Future Enhancements

- [ ] Add browser store links once published
- [ ] Replace placeholder screenshots with real screenshots
- [ ] Add video demo
- [ ] Analytics integration
- [ ] Multi-language support
- [ ] Blog/changelog section
- [ ] Browser extension metrics display

## License

Same as parent project.
