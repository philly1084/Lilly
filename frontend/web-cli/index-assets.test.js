const fs = require('fs');
const path = require('path');

describe('Web CLI browser assets', () => {
  const indexPath = path.join(__dirname, 'index.html');
  const fileHandlerPath = path.join(__dirname, 'js', 'file-handler.js');

  test('loads initial runtime libraries from KimiBuilt same-origin routes', () => {
    const html = fs.readFileSync(indexPath, 'utf8');

    expect(html).toContain('/api/sandbox-libraries/highlightjs/highlight.min.js');
    expect(html).toContain('/api/sandbox-libraries/mermaid/mermaid.min.js');
    expect(html).toContain('/api/sandbox-libraries/pdf-lib/pdf-lib.min.js');
    expect(html).not.toMatch(/(?:cdn\.tailwindcss\.com|cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com)/);
  });

  test('loads optional document import libraries from same-origin routes', () => {
    const source = fs.readFileSync(fileHandlerPath, 'utf8');

    expect(source).toContain('/api/sandbox-libraries/mammoth/mammoth.browser.min.js');
    expect(source).toContain('/api/sandbox-libraries/pdfjs/pdf.min.mjs');
    expect(source).toContain('/api/sandbox-libraries/pdfjs/pdf.worker.min.mjs');
    expect(source).not.toMatch(/(?:cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com)/);
  });
});
