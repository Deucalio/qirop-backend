/**
 * Tests for how an upload is compressed.
 *
 * The failure this guards against is silent and unrecoverable: a scanned B-Form
 * squeezed to the photo bound lands at roughly 68 DPI, too coarse to read, and
 * the original is gone. Nothing errors, nothing looks wrong until someone tries
 * to read the document months later.
 *
 * Run with: npm test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { optimizeImageBuffer } from './storage';

/** An A4 page at 300 DPI — the shape of a real B-Form or transcript scan. */
const a4Scan = () =>
  sharp({ create: { width: 2480, height: 3508, channels: 3, background: 'white' } })
    .jpeg({ quality: 95 })
    .toBuffer();

/** A portrait straight off a phone. */
const phonePhoto = () =>
  sharp({ create: { width: 3000, height: 4000, channels: 3, background: '#8a6' } })
    .jpeg({ quality: 95 })
    .toBuffer();

/** DPI an image would print at across A4's long edge. */
const dpiOnA4 = (heightPx: number) => heightPx / (297 / 25.4);

describe('optimizeImageBuffer', () => {
  test('a document keeps enough resolution to be read', async () => {
    const out = await optimizeImageBuffer(await a4Scan(), 'bform.jpg', 'image/jpeg', 'document');
    const { height } = await sharp(out.buffer).metadata();
    assert.ok(dpiOnA4(height!) >= 150, `an A4 scan must stay above 150 DPI, got ${dpiOnA4(height!).toFixed(0)}`);
  });

  test('the same scan sent as a photo would NOT be readable — which is the bug', async () => {
    // Documented rather than aspirational: this asserts why the two kinds exist.
    const out = await optimizeImageBuffer(await a4Scan(), 'bform.jpg', 'image/jpeg', 'photo');
    const { height } = await sharp(out.buffer).metadata();
    assert.ok(dpiOnA4(height!) < 100, 'the photo bound is deliberately far too small for an A4 page');
  });

  test('a photo is still squeezed hard — this is what fixed the slow pages', async () => {
    const out = await optimizeImageBuffer(await phonePhoto(), 'face.jpg', 'image/jpeg', 'photo');
    const { width, height } = await sharp(out.buffer).metadata();
    assert.ok(Math.max(width!, height!) <= 800, `expected the long edge under 800px, got ${width}x${height}`);
  });

  test('neither kind enlarges an image that is already small', async () => {
    const small = await sharp({ create: { width: 120, height: 120, channels: 3, background: 'red' } }).jpeg().toBuffer();
    for (const kind of ['photo', 'document'] as const) {
      const out = await optimizeImageBuffer(small, 'tiny.jpg', 'image/jpeg', kind);
      const { width } = await sharp(out.buffer).metadata();
      assert.equal(width, 120, `${kind} must not upscale`);
    }
  });

  test('a PNG document stays a PNG', async () => {
    // Line art and small print re-encoded as JPEG gain ringing around exactly
    // the strokes that carry the meaning.
    const png = await sharp({ create: { width: 1200, height: 1600, channels: 4, background: '#fff' } }).png().toBuffer();
    const out = await optimizeImageBuffer(png, 'cnic.png', 'image/png', 'document');
    assert.equal(out.contentType, 'image/png');
    assert.match(out.name, /\.png$/);
  });

  test('a PNG photo is still converted to JPEG', async () => {
    const png = await sharp({ create: { width: 1600, height: 1600, channels: 3, background: '#123' } }).png().toBuffer();
    const out = await optimizeImageBuffer(png, 'avatar.png', 'image/png', 'photo');
    assert.equal(out.contentType, 'image/jpeg');
  });

  test('a PDF is stored exactly as it arrived', async () => {
    const pdf = Buffer.from('%PDF-1.4 not really a pdf');
    const out = await optimizeImageBuffer(pdf, 'challan.pdf', 'application/pdf', 'document');
    assert.equal(out.buffer, pdf, 'a non-image must pass straight through');
    assert.equal(out.name, 'challan.pdf');
    assert.equal(out.contentType, 'application/pdf');
  });

  test('a corrupt image is stored rather than rejected', async () => {
    // Refusing the upload would be a worse outcome than storing it unshrunk.
    const junk = Buffer.from('this claims to be a jpeg but is not');
    const out = await optimizeImageBuffer(junk, 'broken.jpg', 'image/jpeg', 'photo');
    assert.equal(out.buffer, junk);
  });
});
