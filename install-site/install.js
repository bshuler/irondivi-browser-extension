// Browser detection and install link generation

const RELEASE_BASE_URL = 'https://vps1.divi.domains/irondivi-wallet/downloads';

// Detect browser
function detectBrowser() {
  const ua = navigator.userAgent;

  if (ua.includes('Firefox')) return 'firefox';
  if (ua.includes('Edg/')) return 'edge';
  if (ua.includes('OPR/') || ua.includes('Opera')) return 'opera';
  if (ua.includes('Brave')) return 'brave';
  if (ua.includes('Chrome')) return 'chrome';
  if (ua.includes('Safari')) return 'safari';

  return 'unknown';
}

// Get browser info
function getBrowserInfo(browser) {
  const info = {
    chrome: {
      name: 'Chrome',
      icon: '🌐',
      storeUrl: 'https://chrome.google.com/webstore/detail/irondivi-wallet/...',
      downloadUrl: `${RELEASE_BASE_URL}/irondivi-wallet-chrome-v0.0.2.zip`,
      supported: true,
    },
    firefox: {
      name: 'Firefox',
      icon: '🦊',
      storeUrl: 'https://addons.mozilla.org/firefox/addon/irondivi-wallet/',
      downloadUrl: `${RELEASE_BASE_URL}/irondivi-wallet-firefox-v0.0.2.xpi`,
      supported: true,
    },
    edge: {
      name: 'Edge',
      icon: '🌐',
      storeUrl: 'https://microsoftedge.microsoft.com/addons/detail/irondivi-wallet/...',
      downloadUrl: `${RELEASE_BASE_URL}/irondivi-wallet-edge-v0.0.2.zip`,
      supported: true,
    },
    brave: {
      name: 'Brave',
      icon: '🦁',
      storeUrl: 'https://chrome.google.com/webstore/detail/irondivi-wallet/...',
      downloadUrl: `${RELEASE_BASE_URL}/irondivi-wallet-chrome-v0.0.2.zip`,
      supported: true,
    },
    opera: {
      name: 'Opera',
      icon: '🔴',
      storeUrl: 'https://chrome.google.com/webstore/detail/irondivi-wallet/...',
      downloadUrl: `${RELEASE_BASE_URL}/irondivi-wallet-chrome-v0.0.2.zip`,
      supported: true,
    },
    safari: {
      name: 'Safari',
      icon: '🧭',
      supported: false,
      note: 'Safari is not yet supported. Please use Chrome, Firefox, or Edge.',
    },
    unknown: {
      name: 'your browser',
      icon: '🌐',
      supported: false,
      note: 'Please use Chrome, Firefox, Edge, Brave, or Opera.',
    },
  };

  return info[browser] || info.unknown;
}

// Initialize
function init() {
  const browser = detectBrowser();
  const info = getBrowserInfo(browser);

  const installBtn = document.getElementById('primary-install-btn');
  const installText = document.getElementById('install-text');
  const browserIcon = document.getElementById('browser-icon');
  const installNote = document.getElementById('install-note');

  browserIcon.textContent = info.icon;

  if (info.supported) {
    installText.textContent = `Install for ${info.name}`;
    installBtn.onclick = () => window.open(info.downloadUrl, '_blank');
    installNote.textContent = 'Or get it from the browser store (coming soon)';
  } else {
    installText.textContent = 'Not Supported';
    installBtn.disabled = true;
    installBtn.classList.add('disabled');
    installNote.textContent = info.note;
  }

  // Update download links
  document.getElementById('chrome-download').href = getBrowserInfo('chrome').downloadUrl;
  document.getElementById('firefox-download').href = getBrowserInfo('firefox').downloadUrl;

  // Highlight current browser in grid
  document.querySelectorAll('.browser-card').forEach(card => {
    if (card.dataset.browser === browser) {
      card.classList.add('current');
    }
  });
}

// Tab switching
document.querySelectorAll('.tabs .tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const tabName = tab.dataset.tab;

    // Update active tab
    document.querySelectorAll('.tabs .tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');

    // Update content
    document.querySelectorAll('.tab-content').forEach(content => {
      content.classList.remove('active');
    });
    document.getElementById(`tab-${tabName}`).classList.add('active');
  });
});

// Check for mobile
if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
  const installSection = document.getElementById('install-section');
  installSection.innerHTML = `
    <div class="mobile-notice">
      <p>📱 Browser extensions require a desktop browser.</p>
      <p>Please visit this page on your computer.</p>
    </div>
  `;
}

// Initialize on load
document.addEventListener('DOMContentLoaded', init);
