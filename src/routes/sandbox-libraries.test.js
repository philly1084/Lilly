const express = require('express');
const request = require('supertest');
const sandboxLibrariesRouter = require('./sandbox-libraries');

function buildApp() {
  const app = express();
  app.use('/api/sandbox-libraries', sandboxLibrariesRouter);
  return app;
}

describe('sandbox libraries route', () => {
  test('returns the browser library catalog for sandboxed HTML builds', async () => {
    const response = await request(buildApp()).get('/api/sandbox-libraries/catalog.json');

    expect(response.status).toBe(200);
    expect(response.body.guidance).toContain('/api/sandbox-libraries/');
    expect(response.body.libraries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'three', packageName: 'three' }),
      expect.objectContaining({ id: 'chartjs', packageName: 'chart.js' }),
      expect.objectContaining({ id: 'force-graph-3d', packageName: '3d-force-graph' }),
      expect.objectContaining({ id: 'codemirror', category: 'code-viewing' }),
      expect.objectContaining({ id: 'pdfjs', category: 'document-viewing' }),
    ]));
    expect(response.body.guidance).toContain('CodeMirror');
    expect(response.body.guidance).toContain('Mammoth');
  });

  test('returns 404 for unknown libraries and unavailable assets', async () => {
    await request(buildApp())
      .get('/api/sandbox-libraries/unknown/missing.js')
      .expect(404);

    await request(buildApp())
      .get('/api/sandbox-libraries/chartjs/missing.js')
      .expect(404);
  });

  test('serves installed browser library assets with script content type', async () => {
    const response = await request(buildApp()).get('/api/sandbox-libraries/chartjs/chart.umd.js');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/javascript');
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.text).toContain('Chart');
  });
});
